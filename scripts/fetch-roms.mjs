#!/usr/bin/env node
// Downloads the Commodore 64 firmware images alloldos needs to boot a real C64.
//
// The images come from the VICE distribution. They are Commodore/Cloanto property:
// they are NOT redistributed with alloldos, you fetch them yourself for your own
// machine. If you would rather use free replacements, see MEGA65's open-roms.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DEST = join(ROOT, 'roms', 'c64');
const BASE = 'https://raw.githubusercontent.com/VICE-Team/svn-mirror/main/vice/data/C64';

const ROMS = [
  { file: 'kernal.bin', from: 'kernal-901227-03.bin', size: 8192 },
  { file: 'basic.bin', from: 'basic-901226-01.bin', size: 8192 },
  { file: 'chargen.bin', from: 'chargen-901225-01.bin', size: 4096 },
];

await mkdir(DEST, { recursive: true });

for (const rom of ROMS) {
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

  const url = `${BASE}/${rom.from}`;
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
