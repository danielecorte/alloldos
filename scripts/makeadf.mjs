#!/usr/bin/env node
// Fabbrica un floppy Amiga con dentro dei file, per avere un .adf da provare.
//
//   node scripts/makeadf.mjs [file...] [-o disco.adf] [-n Nome]
//
// Serve perché un .adf legalmente distribuibile non è una cosa che si trova:
// i dischi dei giochi sono di chi li ha fatti. Questo se lo formatta da sé, in
// OFS — il filesystem che la Kickstart 1.3 monta senza bisogno di niente — e ci
// mette dentro quello che gli si dà.
//
// Il disco si legge e si scrive, ma non si avvia: il codice del blocco di boot
// di AmigaOS è di Commodore. Da qui esce un floppy dati, come quelli che si
// formattavano per tenerci i propri programmi.

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDisk, listFiles, readFile, checkDisk } from './ofs.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

const args = process.argv.slice(2);
const sources = [];
let output = join(ROOT, 'ciao.adf');
let name = 'Ciao';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') output = args[++i];
  else if (args[i] === '-n') name = args[++i];
  else sources.push(args[i]);
}
if (sources.length === 0) sources.push(join(ROOT, 'programs', 'ciao-amiga.bas'));

const files = sources.map((path) => ({ name: basename(path), data: new Uint8Array(readFileSync(path)) }));
const image = makeDisk({ name, files });

// Riletto prima di scriverlo: un disco che non si rilegge non è un disco.
const bad = checkDisk(image);
if (bad.length) {
  console.error(`somme di controllo sbagliate nei blocchi ${bad.join(', ')}`);
  process.exit(1);
}
for (const file of files) {
  const back = readFile(image, file.name);
  if (!back || back.length !== file.data.length || back.some((byte, i) => byte !== file.data[i])) {
    console.error(`${file.name} non si rilegge uguale`);
    process.exit(1);
  }
}

writeFileSync(output, image);
console.log(`${output}  —  ${image.length} byte, volume "${name}"`);
for (const file of listFiles(image)) console.log(`  ${file}`);
console.log('Trascinalo sulla finestra dell\'Amiga: il drive lo riconosce e lo legge.');
