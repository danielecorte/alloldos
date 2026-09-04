#!/usr/bin/env node
// Downloads the Commodore 64 firmware images alloldos needs to boot a real C64.
//
// The images come from the VICE distribution. They are Commodore/Cloanto property:
// they are NOT redistributed with alloldos, you fetch them yourself for your own
// machine. If you would rather use free replacements, see MEGA65's open-roms.

import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

// The list of images, and where they come from, belongs to the emulator: the
// page offers the same three downloads to anyone arriving without them, and the
// two must not be able to drift apart.
import { ROM_SPECS, ROM_SOURCE_URL } from '../src/systems/c64/roms.js';
import { AMIGA_FOREVER_URL, AROS_URL } from '../src/systems/amiga/roms.js';
import { BIOS_SPEC, CARD_SPEC, GLABIOS_URL, XTIDE_URL } from '../src/systems/pc/roms.js';
import { FREEDOS_SPEC, FREEDOS_URL } from '../src/systems/pc/media.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DEST = join(ROOT, 'roms', 'c64');
const AMIGA_DEST = join(ROOT, 'roms', 'amiga');
const PC_DEST = join(ROOT, 'roms', 'pc');

await mkdir(DEST, { recursive: true });
await mkdir(AMIGA_DEST, { recursive: true });
await mkdir(PC_DEST, { recursive: true });

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
  console.log('\nUn disco fisso con FreeDOS gi\u00e0 installato si fa con `npm run make-hdd`.');
}

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
