#!/usr/bin/env node
// Downloads the Commodore 64 firmware images alloldos needs to boot a real C64.
//
// The images come from the VICE distribution. They are Commodore/Cloanto property:
// they are NOT redistributed with alloldos, you fetch them yourself for your own
// machine. If you would rather use free replacements, see MEGA65's open-roms.

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// The list of images, and where they come from, belongs to the emulator: the
// page offers the same three downloads to anyone arriving without them, and the
// two must not be able to drift apart.
import { ROM_SPECS, ROM_SOURCE_URL } from '../src/systems/c64/roms.js';
import { AMIGA_FOREVER_URL, AROS_URL } from '../src/systems/amiga/roms.js';
import {
  BIOS_SPEC,
  CARD_SPEC,
  GLABIOS_URL,
  XTIDE_URL,
  VIDEO_SPEC as PC_VIDEO_SPEC,
  VGABIOS_URL as PC_VGABIOS_URL,
  isVideoROM as isPCVideoROM,
  isVideoROMFor386 as isPCVideoROMFor386,
} from '../src/systems/pc/roms.js';
import { FREEDOS_SPEC, FREEDOS_URL } from '../src/systems/pc/media.js';
import { KEYB_PACKAGES } from '../src/systems/pc/layouts.js';
import { CD_PACKAGES } from '../src/systems/pc/cdrom.js';
import {
  BIOS_SPEC as PC386_BIOS,
  VIDEO_SPEC as PC386_VIDEO,
  BOCHS_URL,
  VGABIOS_URL,
  isSystemBIOS as isBochsBIOS,
  isOptionROM as isPC386OptionROM,
} from '../src/systems/pc386/roms.js';
import { ROM_SPEC as ZX_SPEC, FUSE_URL, OPENSE_URL, isSpectrumROM } from '../src/systems/zx/roms.js';
import {
  BIOS_SPEC as PENTIUM_BIOS,
  VIDEO_SPEC as PENTIUM_VIDEO,
  SEABIOS_URL,
  SEABIOS_PACKAGE_URL,
  isSystemBIOS,
  isOptionROM,
} from '../src/systems/pentium/roms.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DEST = join(ROOT, 'roms', 'c64');
const AMIGA_DEST = join(ROOT, 'roms', 'amiga');
const PC_DEST = join(ROOT, 'roms', 'pc');
const ZX_DEST = join(ROOT, 'roms', 'zx');
const PENTIUM_DEST = join(ROOT, 'roms', 'pentium');

await mkdir(DEST, { recursive: true });
await mkdir(AMIGA_DEST, { recursive: true });
await mkdir(PC_DEST, { recursive: true });
await mkdir(ZX_DEST, { recursive: true });
await mkdir(PENTIUM_DEST, { recursive: true });

for (const rom of ROM_SPECS) {
  const target = join(DEST, rom.file);
  if (!process.argv.includes('--force')) {
    try {
      await access(target);
      console.log(`· ${rom.file} already present, skipping (use --force to refetch)`);
      continue;
    } catch {
      /* not there yet, download it */
    }
  }

  const url = `${ROM_SOURCE_URL}/${rom.source}`;
  process.stdout.write(`↓ ${rom.file} … `);
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`FAILED (HTTP ${res.status})`);
    console.error(`  could not fetch ${url}`);
    process.exitCode = 1;
    continue;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== rom.size) {
    console.log(`FAILED (expected ${rom.size} bytes, got ${bytes.length})`);
    process.exitCode = 1;
    continue;
  }

  await writeFile(target, bytes);
  console.log(`ok (${bytes.length} bytes)`);
}

console.log(`\nROMs in ${DEST}`);

// ------------------------------------------------------------------- the Amiga

// The Kickstart cannot be downloaded: it is Cloanto's, and no free copy of it
// in circulation is a legal one. But AROS's replacement is free software, and
// it is already sitting on a lot of machines — FS-UAE ships it. So rather than
// fetching something it should not, this goes looking for that.

/** Places FS-UAE keeps the AROS ROM, either loose or inside its data archive. */
const AROS_PLACES = [
  '/usr/share/fs-uae',
  '/usr/local/share/fs-uae',
  '/Applications/FS-UAE.app/Contents/Resources',
  join(homedir(), 'Documents', 'FS-UAE', 'Kickstarts'),
  join(homedir(), '.local', 'share', 'fs-uae'),
];

/**
 * Pulls one file out of a zip. FS-UAE keeps its data in one, and the entries
 * are stored rather than compressed — but both cases are two lines apart.
 * @returns {?Uint8Array}
 */
function unzip(archive, wanted) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let at = 0; at < archive.length - 30; at++) {
    if (view.getUint32(at, true) !== 0x04034b50) continue; // local file header
    const method = view.getUint16(at + 8, true);
    const compressed = view.getUint32(at + 18, true);
    const original = view.getUint32(at + 22, true);
    const nameLength = view.getUint16(at + 26, true);
    const extraLength = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(archive.subarray(at + 30, at + 30 + nameLength));
    if (!name.endsWith(wanted)) continue;

    const from = at + 30 + nameLength + extraLength;
    const data = archive.subarray(from, from + (method === 0 ? original : compressed));
    return method === 0 ? data : new Uint8Array(inflateRawSync(data));
  }
  return null;
}

async function findAROS(name) {
  for (const place of AROS_PLACES) {
    try {
      return { bytes: new Uint8Array(await readFile(join(place, name))), from: join(place, name) };
    } catch {
      /* not loose in there; try the archive */
    }
    try {
      const archive = new Uint8Array(await readFile(join(place, 'fs-uae.dat')));
      const found = unzip(archive, name);
      if (found) return { bytes: found, from: `${join(place, 'fs-uae.dat')} (${name})` };
    } catch {
      /* no archive there either */
    }
  }
  return null;
}

const kickstart = join(AMIGA_DEST, 'kickstart.rom');
let haveKickstart = false;
try {
  await access(kickstart);
  haveKickstart = true;
  console.log(`\n· ${kickstart} already present, leaving it alone`);
} catch {
  const rom = await findAROS('aros-amiga-m68k-rom.bin');
  const ext = await findAROS('aros-amiga-m68k-ext.bin');
  if (rom) {
    await writeFile(kickstart, rom.bytes);
    console.log(`\n↓ AROS Kickstart from ${rom.from}`);
    console.log(`  → ${kickstart} (${rom.bytes.length} bytes)`);
    haveKickstart = true;
    if (ext) {
      await writeFile(join(AMIGA_DEST, 'extended.rom'), ext.bytes);
      console.log(`  → ${join(AMIGA_DEST, 'extended.rom')} (${ext.bytes.length} bytes)`);
    }
  }
}

if (!haveKickstart) {
  console.log(`
No Kickstart, and none to download: it is Cloanto's, and no free copy of it in
circulation is a legal one. Put a 256 KB (1.2/1.3) or 512 KB (2.0 and later)
image at ${kickstart}, or drag one onto the page — which keeps it in the browser
instead. Two honest sources:

  · ${AMIGA_FOREVER_URL}  — Cloanto's own licensed ROMs
  · ${AROS_URL}  — AROS's Kickstart replacement, which is free software

AROS's is the one alloldos is tested against, and it also travels inside FS-UAE:
installing that (\`apt install fs-uae\`, or the download from fs-uae.net) puts
aros-amiga-m68k-rom.bin somewhere this script will find on the next run.`);
}

// ---------------------------------------------------------------------- the PC

// The one machine here whose firmware is free software and can simply be
// downloaded: GLaBIOS is a PC BIOS written from scratch under the GPL, and the
// build this fetches is the 8088 one, which a 286 runs as it stands.

// Le due ROM libere di questa macchina e il dischetto da cui si avvia: il
// BIOS di sistema, la ROM della scheda del disco fisso, e FreeDOS. Nessuna
// delle tre è dentro il repository, tutte e tre si scaricano.

/**
 * @param {{file:string, size?:number, source:string, label:string}} spec
 * @param {(bytes:Uint8Array)=>boolean} [accept]
 */
async function fetchInto(spec, accept = () => true) {
  const target = join(PC_DEST, spec.file);
  if (!process.argv.includes('--force')) {
    try {
      await access(target);
      console.log(`\n\u00b7 ${spec.file} already present, skipping (use --force to refetch)`);
      return true;
    } catch {
      /* not there yet, download it */
    }
  }
  process.stdout.write(`\n\u2193 ${spec.file} \u2026 `);
  try {
    const res = await fetch(spec.source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!accept(bytes)) throw new Error(`unexpected contents (${bytes.length} bytes)`);
    await writeFile(target, bytes);
    console.log(`ok (${bytes.length} bytes)`);
    return true;
  } catch (error) {
    console.log(`FAILED (${error.message})`);
    console.error(`  could not fetch ${spec.source}`);
    process.exitCode = 1;
    return false;
  }
}

const haveBIOS = await fetchInto(BIOS_SPEC, (bytes) => bytes.length === BIOS_SPEC.size);
if (haveBIOS) console.log(`  ${GLABIOS_URL} \u2014 GPLv3, and it boots real hardware too`);

const haveCard = await fetchInto(CARD_SPEC, (bytes) => bytes[0] === 0x55 && bytes[1] === 0xaa);
if (haveCard) console.log(`  ${XTIDE_URL} \u2014 GPLv2, the BIOS of the hard disk card`);

// La ROM della VGA non si scarica: quella che il progetto pubblica \u00e8 compilata
// per il 386, e sul 286 si ferma. Quella compilata per il 286 viaggia col
// repository, e `npm run build-vgabios` la rif\u00e0 dal sorgente; senza, la
// macchina monta la CGA.
{
  const target = join(PC_DEST, PC_VIDEO_SPEC.file);
  let present = false;
  try {
    const bytes = new Uint8Array(await readFile(target));
    present = isPCVideoROM(bytes) && !isPCVideoROMFor386(bytes);
  } catch {
    /* non c'\u00e8 */
  }
  if (present) {
    console.log(`\n\u00b7 ${PC_VIDEO_SPEC.file} is in the repository (the ${PC_VIDEO_SPEC.label}, built for the 286)`);
  } else {
    console.log(`\n\u00b7 ${PC_VIDEO_SPEC.file} is missing, and the published build is for the 386:`);
    console.log('  `npm run build-vgabios` compiles it for the 286 (needs gcc, bcc and as86).');
  }
  console.log(`  ${PC_VGABIOS_URL} \u2014 LGPL, the BIOS of the VGA card`);
}

// FreeDOS non si scarica da solo: sta dentro l'archivio dell'edizione a
// dischetti, che è la sola forma in cui il progetto lo pubblica. Si prende
// quello e si tira fuori il dischetto da 720 KB, che è l'unico che questa
// macchina — un lettore da tre pollici e mezzo su una scheda XT — sa leggere.

const floppyPath = join(PC_DEST, FREEDOS_SPEC.file);
let haveFloppy = false;
if (!process.argv.includes('--force')) {
  try {
    await access(floppyPath);
    haveFloppy = true;
    console.log(`\n\u00b7 ${FREEDOS_SPEC.file} already present, skipping (use --force to refetch)`);
  } catch {
    /* not there yet */
  }
}

if (!haveFloppy) {
  process.stdout.write(`\n\u2193 ${FREEDOS_SPEC.file} \u2026 `);
  try {
    const res = await fetch(FREEDOS_SPEC.source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = new Uint8Array(await res.arrayBuffer());
    const image = extractFromZip(archive, FREEDOS_SPEC.member);
    if (!image) throw new Error(`${FREEDOS_SPEC.member} not in the archive`);
    if (image.length !== FREEDOS_SPEC.size) {
      throw new Error(`expected ${FREEDOS_SPEC.size} bytes, got ${image.length}`);
    }
    await writeFile(floppyPath, image);
    console.log(`ok (${image.length} bytes)`);
    haveFloppy = true;
  } catch (error) {
    console.log(`FAILED (${error.message})`);
    console.error(`  could not fetch ${FREEDOS_SPEC.source}`);
    process.exitCode = 1;
  }
}

if (haveFloppy) {
  console.log(`  ${FREEDOS_URL} \u2014 GPL, and it is the machine's operating system`);
}

// KEYB e le sue tastiere, e i due driver del lettore di CD: sul dischetto di
// avvio non ci sono, stanno nei pacchetti del repository di FreeDOS 1.3.
// Servono solo a `npm run make-hdd`, che li mette sul disco fisso \u2014 il disco
// che viaggia col repository li ha gi\u00e0.
for (const spec of [...KEYB_PACKAGES, ...CD_PACKAGES]) {
  await fetchInto(spec, (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b);
}

console.log('\nIl disco fisso con FreeDOS sopra \u00e8 gi\u00e0 in roms/pc: `npm run make-hdd` lo rif\u00e0.');

/**
 * Tira fuori un file da uno zip senza aprire tutto l'archivio: si cerca
 * all'indietro la fine del catalogo, si legge dove comincia il file, e si
 * scompatta solo quello.
 *
 * @param {Uint8Array} zip
 * @param {string} name
 * @returns {?Uint8Array}
 */
function extractFromZip(zip, name) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= 0 && end < 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) end = i;
  }
  if (end < 0) return null;
  let entry = view.getUint32(end + 16, true);
  const count = view.getUint16(end + 10, true);
  const wanted = new TextEncoder().encode(name);
  for (let i = 0; i < count; i++) {
    const nameLength = view.getUint16(entry + 28, true);
    const extraLength = view.getUint16(entry + 30, true);
    const commentLength = view.getUint16(entry + 32, true);
    const found = zip.subarray(entry + 46, entry + 46 + nameLength);
    if (nameLength === wanted.length && found.every((byte, at) => byte === wanted[at])) {
      const method = view.getUint16(entry + 10, true);
      const size = view.getUint32(entry + 24, true);
      const local = view.getUint32(entry + 42, true);
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const stored = zip.subarray(start, start + view.getUint32(entry + 20, true));
      const bytes = method === 0 ? stored : inflateRawSync(Buffer.from(stored));
      return new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, size);
    }
    entry += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

// --------------------------------------------------------------- il Pentium

// Il firmware della macchina del 1995, che è libero come quello del 286 ma non
// si scarica da una pagina di versioni: SeaBIOS pubblica i sorgenti, e i binari
// viaggiano dentro QEMU. Se QEMU è installato — e se si emula, prima o poi lo è
// — i due file sono già su questo computer, e questo script se li prende da lì.
// Sono l'unico firmware di alloldos che non si va a cercare in rete.

// SeaBIOS pubblica i sorgenti, e i binari già compilati stanno nel repository
// di QEMU: da lì si prendono, alla versione 9.0.0, due link diretti.
for (const [spec, accept] of [[PENTIUM_BIOS, isSystemBIOS], [PENTIUM_VIDEO, isOptionROM]]) {
  const target = join(PENTIUM_DEST, spec.file);
  if (!process.argv.includes('--force')) {
    try {
      await access(target);
      // Il bios.bin da 128 KB che si scaricava prima non ha il PCI BIOS: quello
      // si rimpiazza anche senza --force.
      const stale = spec === PENTIUM_BIOS && (await readFile(target)).length !== 262144;
      if (!stale) {
        console.log(`\n· ${spec.file} already present, skipping (use --force to refetch)`);
        continue;
      }
      console.log(`\n· ${spec.file} is the old 128 KB SeaBIOS, without the PCI BIOS: replacing it`);
    } catch {
      /* not there yet, download it */
    }
  }
  process.stdout.write(`\n↓ ${spec.file} … `);
  try {
    const res = await fetch(spec.source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!accept(bytes)) throw new Error(`unexpected contents (${bytes.length} bytes)`);
    await writeFile(target, bytes);
    console.log(`ok (${bytes.length} bytes)`);
  } catch (error) {
    console.log(`FAILED (${error.message})`);
    console.error(`  could not fetch ${spec.source}`);
    process.exitCode = 1;
  }
}
console.log(`  ${SEABIOS_URL} — LGPLv3, the BIOS of the Pentium, as QEMU ships it`);

// -------------------------------------------------------------------- il 386

// Il firmware del 386: il BIOS di Bochs nella versione legacy, tutta a sedici
// bit e compilata per il 386, e il VGABIOS LGPL. Stanno già compilati nel
// repository di Bochs, alla versione 2.7, e da lì si prendono.

{
  const dest = join(ROOT, 'roms', 'pc386');
  await mkdir(dest, { recursive: true });
  const checks = [
    [PC386_BIOS, (bytes) => isBochsBIOS(bytes)],
    [PC386_VIDEO, (bytes) => isPC386OptionROM(bytes)],
  ];
  for (const [spec, accept] of checks) {
    const target = join(dest, spec.file);
    if (!process.argv.includes('--force')) {
      try {
        await access(target);
        console.log(`\n· ${spec.file} already present, skipping (use --force to refetch)`);
        continue;
      } catch {
        /* not there yet, download it */
      }
    }
    process.stdout.write(`\n↓ ${spec.file} … `);
    try {
      const res = await fetch(spec.source, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!accept(bytes)) throw new Error(`unexpected contents (${bytes.length} bytes)`);
      await writeFile(target, bytes);
      console.log(`ok (${bytes.length} bytes)`);
    } catch (error) {
      console.log(`FAILED (${error.message})`);
      console.error(`  could not fetch ${spec.source}`);
      process.exitCode = 1;
    }
  }
  // JEMM, il programma di FreeDOS che mette il DOS in modo virtuale 8086 e gli
  // dà la memoria espansa. Alla macchina non serve: serve alla prova che il
  // 386 quel modo lo sa fare, con un sorvegliante vero invece che con uno
  // scritto per l'occasione.
  const jemm = join(dest, 'jemm.zip');
  try {
    await access(jemm);
  } catch {
    process.stdout.write('\n↓ jemm.zip … ');
    try {
      const res = await fetch(
        'https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.3/base/jemm.zip',
        { redirect: 'follow' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('not a zip');
      await writeFile(jemm, bytes);
      console.log(`ok (${bytes.length} bytes)`);
    } catch (error) {
      console.log(`FAILED (${error.message})`);
    }
  }
  console.log(`  ${BOCHS_URL} — LGPL, the BIOS of the 386`);
  console.log(`  ${VGABIOS_URL} — LGPL, the BIOS of its VGA card`);
}

// ------------------------------------------------------------- lo ZX Spectrum

// La ROM dello Spectrum è di Amstrad, che ne ha permesso la ridistribuzione
// insieme agli emulatori: sta dentro il sorgente di Fuse, e da lì si prende.
// È l'unica delle ROM proprietarie di questo progetto che si possa scaricare
// onestamente in un colpo solo.

const zxPath = join(ZX_DEST, ZX_SPEC.file);
let haveZX = false;
if (!process.argv.includes('--force')) {
  try {
    await access(zxPath);
    haveZX = true;
    console.log(`\n\u00b7 ${ZX_SPEC.file} already present, skipping (use --force to refetch)`);
  } catch {
    /* not there yet */
  }
}

if (!haveZX) {
  process.stdout.write(`\n\u2193 ${ZX_SPEC.file} \u2026 `);
  try {
    const res = await fetch(ZX_SPEC.source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const archive = new Uint8Array(await res.arrayBuffer());
    const rom = extractFromTarGz(archive, ZX_SPEC.member);
    if (!rom) throw new Error(`${ZX_SPEC.member} not in the archive`);
    if (!isSpectrumROM(rom)) throw new Error(`that is not a Spectrum ROM (${rom.length} bytes)`);
    await writeFile(zxPath, rom);
    console.log(`ok (${rom.length} bytes)`);
    haveZX = true;
  } catch (error) {
    console.log(`FAILED (${error.message})`);
    console.error(`  could not fetch ${ZX_SPEC.source}`);
    process.exitCode = 1;
  }
}

if (haveZX) {
  console.log(`  ${FUSE_URL} \u2014 Fuse, che la distribuisce col permesso di Amstrad`);
  console.log(`  ${OPENSE_URL} \u2014 OpenSE BASIC, il rimpiazzo libero, se la si preferisce`);
}

/**
 * Tira fuori un file da un tar compresso. Un tar è la cosa più semplice che
 * ci sia: un'intestazione da 512 byte con dentro il nome e la lunghezza in
 * ottale, poi il file arrotondato a 512, poi la prossima intestazione.
 *
 * @param {Uint8Array} archive
 * @param {string} name
 * @returns {?Uint8Array}
 */
function extractFromTarGz(archive, name) {
  const tar = new Uint8Array(gunzipSync(Buffer.from(archive)));
  const decoder = new TextDecoder();
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    const found = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    if (!found) break; // due blocchi vuoti: è la fine dell'archivio
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/[^0-7]/g, ''), 8) || 0;
    at += 512;
    if (found === name) return tar.subarray(at, at + size);
    at += Math.ceil(size / 512) * 512;
  }
  return null;
}
