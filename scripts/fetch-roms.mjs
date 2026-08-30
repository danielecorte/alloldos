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
import { BIOS_SPEC, GLABIOS_URL } from '../src/systems/pc/roms.js';

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

const biosPath = join(PC_DEST, BIOS_SPEC.file);
let haveBIOS = false;
if (!process.argv.includes('--force')) {
  try {
    await access(biosPath);
    haveBIOS = true;
    console.log(`\n· ${BIOS_SPEC.file} already present, skipping (use --force to refetch)`);
  } catch {
    /* not there yet, download it */
  }
}

if (!haveBIOS) {
  process.stdout.write(`\n\u2193 ${BIOS_SPEC.file} \u2026 `);
  try {
    const res = await fetch(BIOS_SPEC.source, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== BIOS_SPEC.size) throw new Error(`expected ${BIOS_SPEC.size} bytes, got ${bytes.length}`);
    await writeFile(biosPath, bytes);
    console.log(`ok (${bytes.length} bytes)`);
    haveBIOS = true;
  } catch (error) {
    console.log(`FAILED (${error.message})`);
    console.error(`  could not fetch ${BIOS_SPEC.source}`);
    process.exitCode = 1;
  }
}

if (haveBIOS) console.log(`  ${GLABIOS_URL} \u2014 GPLv3, and it boots real hardware too`);
