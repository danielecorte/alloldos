#!/usr/bin/env node
// Installare il DOS sul disco fisso, facendolo fare alla macchina.
//
// Un disco nuovo, nel 1988, non aveva niente sopra: nemmeno una partizione.
// Lo si comprava vuoto e si passava un pomeriggio a prepararlo — FDISK per
// dire dove comincia e dove finisce, un riavvio perché il DOS se ne accorga,
// FORMAT per scriverci sopra un filesystem, SYS per renderlo avviabile, e poi
// a copiare i dischetti uno per uno. Chiunque abbia avuto un PC in quegli anni
// ha fatto esattamente questa sequenza almeno una volta.
//
// Questo script la fa fare alla macchina emulata. Non c'è nessun programma
// qui dentro che scriva una tabella delle partizioni o una FAT: le scrivono
// FDISK.EXE e FORMAT.EXE di FreeDOS, girando sul 286, battuti sulla tastiera
// come li batterebbe una persona. Alla fine dei conti quello che esce è un
// disco preparato da FreeDOS e non da noi — che è l'unico modo di essere
// sicuri che sia giusto.
//
// Si esegue con `npm run make-hdd`, e ci mette meno di un minuto.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { bootPC, Session, have, ROMS } from './pcsession.mjs';
import { KB16, KB16_NAME } from './kb16.mjs';
import { HDD_SPEC } from '../src/systems/pc/media.js';
import { FREEDOS_SPEC } from '../src/systems/pc/media.js';
import { BIOS_SPEC, CARD_SPEC } from '../src/systems/pc/roms.js';
import { KEYB_PACKAGES, PROGRAMS_DIR } from '../src/systems/pc/layouts.js';
import { BLASTER } from '../src/systems/pc/soundblaster.js';
import { FAT16 } from '../src/systems/pc/fat.js';
import { readZip } from '../src/systems/pc/zip.js';

/** La data di KB16 sul disco: il giorno in cui è stato scritto, a mezzogiorno. */
const KB16_STAMP = { time: 12 << 11, date: ((2026 - 1980) << 9) | (9 << 5) | 14 };

const missing = [
  !have.bios && BIOS_SPEC.file,
  !have.card && CARD_SPEC.file,
  !have.floppy && FREEDOS_SPEC.file,
  ...KEYB_PACKAGES.filter(({ file }) => !existsSync(join(ROMS, file))).map(({ file }) => file),
].filter(Boolean);

if (missing.length) {
  console.error(`Manca ${missing.join(', ')} in roms/pc: prima \`npm run fetch-roms\`.`);
  process.exit(1);
}

const started = Date.now();
const pc = bootPC({ disk: 'blank' });
const dos = new Session(pc, (screen) => console.error(screen));

const step = (message) => {
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[${String(seconds).padStart(3)}s] ${message}`);
};

// -------------------------------------------------------------- la partizione

step('accensione dal dischetto di FreeDOS');
dos.toFloppyPrompt();

step('FDISK: una partizione sola, grande tutto il disco');
dos.command('fdisk /auto');

// FDISK scrive la tabella delle partizioni ma non il codice che ci sta davanti:
// i primi 446 byte del primo settore restano vuoti, e un disco così non parte
// nemmeno se la partizione è avviabile. È a questo che serve /MBR — e chi non
// lo sapeva, nel 1988, passava la serata a chiedersi perché.
step('FDISK: e il codice di avvio davanti alla tabella');
dos.command('fdisk /mbr');

// La tabella delle partizioni la legge il DOS quando parte, e non un momento
// dopo: finché non si riaccende la macchina, C: non esiste.
step('riavvio, perché il DOS legga la tabella');
dos.reboot('a');
dos.toFloppyPrompt();

// ------------------------------------------------------------- il filesystem

step('FORMAT C: (e sì, si vuole davvero)');
dos.type('format c: /v:alloldos\n');
dos.run(200);
dos.expect(/Proceed with [Ff]ormat/, 3000, 'FORMAT non ha chiesto conferma');
dos.type('yes\n');
dos.expect(/Format complete|allocation units on disk/i, 8000, 'FORMAT non è finito');
dos.expect(/A:\\>/, 3000);

step('SYS C: il kernel e la shell, e il settore da cui si parte');
dos.command('sys c:', { limit: 3000 });
if (!/System transferred/.test(dos.screen())) {
  throw new Error('SYS non ha detto "System transferred"');
}

// ------------------------------------------------------------------ i comandi

step('copia dei programmi in C:\\FDOS\\BIN');
dos.command('md c:\\fdos');
dos.command('md c:\\fdos\\bin');
dos.command('copy a:\\freedos\\bin\\*.* c:\\fdos\\bin', { limit: 8000 });

step('CONFIG.SYS e AUTOEXEC.BAT');
dos.command('echo FILES=20 > c:\\config.sys');
dos.command('echo LASTDRIVE=E >> c:\\config.sys');
dos.command('echo @echo off > c:\\autoexec.bat');
dos.command('echo path c:\\fdos\\bin >> c:\\autoexec.bat');
dos.command('echo prompt $p$g >> c:\\autoexec.bat');
// La riga che il programma di installazione della Sound Blaster metteva in
// ogni AUTOEXEC: porta, interruzione, DMA e modello. È da qui che i giochi
// sanno dove trovarla, senza doverla cercare porta per porta.
dos.command(`echo set blaster=${BLASTER} >> c:\\autoexec.bat`);
dos.command('echo ver >> c:\\autoexec.bat');

// ------------------------------------------------------------------ le tastiere

// KEYB e le sue tastiere non stanno sul dischetto di avvio: stanno in due
// pacchetti del repository di FreeDOS, e da lì si prendono i due file che
// servono. Accanto va KB16, il programmino che dà all'XT i due pezzi di BIOS
// da AT che KEYB si aspetta (vedi kb16.mjs). Questi tre file sono l'unico
// punto in cui questo script scrive sul filesystem da sé invece di farlo fare
// al DOS: batterli sulla tastiera un byte per volta vorrebbe dire un'ora. Si
// scrivono a DOS fermo al prompt, e subito dopo la macchina si riaccende, così
// il DOS la FAT se la rilegge da capo. Ogni file porta la data che ha nel suo
// pacchetto, e KB16 una data fissa: con l'ora di adesso il disco non verrebbe
// più identico byte per byte.

step('KEYB, le tastiere e KB16 in C:\\FDOS\\BIN');
const volume = FAT16.of(pc.hdc.disk.data);
const programs = volume.mkdirp(PROGRAMS_DIR);
for (const { file, members } of KEYB_PACKAGES) {
  const entries = await readZip(new Uint8Array(await readFile(join(ROMS, file))));
  for (const member of members) {
    const entry = entries.find(({ path }) => path.toUpperCase() === member);
    if (!entry) throw new Error(`${member} non c'è in ${file}`);
    volume.writeFile(programs, basename(member), entry.bytes, { stamp: entry.stamp });
  }
}
volume.writeFile(programs, KB16_NAME, KB16, { stamp: KB16_STAMP });

// ------------------------------------------------------------------- la prova

step('riavvio dal disco fisso');
dos.reboot('c');
if (!dos.waitFor(/C:\\>/, 4000)) {
  console.error(dos.screen());
  throw new Error('il disco fisso non arriva al prompt');
}

step(`fatto: ${pc.hdc.disk.writes} settori scritti`);
console.log(dos.screen());

const target = join(ROMS, HDD_SPEC.file);
await writeFile(target, pc.hdc.disk.data);
console.log(`\nDisco in ${target} (${(pc.hdc.disk.data.length / 1024 / 1024).toFixed(1)} MB).`);
console.log('Da qui in poi la macchina si accende su C:\\> senza dischetto.');
