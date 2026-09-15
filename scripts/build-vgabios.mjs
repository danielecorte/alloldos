#!/usr/bin/env node
// Il VGABIOS LGPL, compilato per il 286.
//
// La VGA del 286 ha bisogno del suo BIOS, e l'unico BIOS VGA libero che esista
// è quello nato con Bochs. Il progetto lo pubblica già compilato, ma per il
// 386: il compilatore che usa, bcc, mette in testa al codice `use16 386`, e da
// lì l'assemblatore si sente libero di usare i salti condizionati lunghi che
// sono arrivati col 386. Sono una sessantina, e il primo che il 286 incontra lo
// ferma all'accensione con un'interruzione 6 dopo l'altra.
//
// Il sorgente però è scritto per l'8086 — il Makefile dice `-0` dappertutto —
// e quindi basta ricompilarlo davvero così: si dice all'assemblatore che il
// processore è un 286, e i salti lunghi diventano un salto corto rovesciato
// che scavalca un salto lungo, com'era il modo di farli prima del 386. Le
// uniche istruzioni a trentadue bit scritte a mano stanno in due posti: il
// salvataggio dello stato video, dove due `mov eax`/`stosd` si riscrivono in
// parole da sedici bit, e il codice che parla col bus PCI e con le estensioni
// VBE, che su una scheda ISA non c'entrano e si lasciano fuori.
//
// Servono gcc e i due pezzi di dev86 che bcc usa: `apt install bcc bin86`, o
// DEV86=<cartella> se li si è estratti da qualche parte (con usr/bin/as86 e
// usr/lib/bcc/bcc-cc1 dentro). Il risultato va in roms/pc, ed è sempre lo
// stesso, byte per byte: la data di compilazione non entra nella ROM.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ROMS } from './pcsession.mjs';
import { VIDEO_SPEC, VGABIOS_RELEASE, VGABIOS_SOURCE_URL, isVideoROM } from '../src/systems/pc/roms.js';

/** Dove trovare i due programmi di dev86: nel sistema, o dove dice DEV86. */
function tool(relative, fallbacks) {
  const places = [process.env.DEV86 && join(process.env.DEV86, relative), ...fallbacks].filter(Boolean);
  const found = places.find((place) => existsSync(place));
  if (!found) {
    console.error(`Non trovo ${relative.split('/').pop()}: \`apt install bcc bin86\`, o DEV86=<cartella di dev86>.`);
    process.exit(1);
  }
  return found;
}

const cc1 = tool('usr/lib/bcc/bcc-cc1', ['/usr/lib/bcc/bcc-cc1', '/usr/local/lib/bcc/bcc-cc1']);
const as86 = tool('usr/bin/as86', ['/usr/bin/as86', '/usr/local/bin/as86']);

/**
 * Le due correzioni al sorgente: il salvataggio e il ripristino dei vettori
 * delle due tabelle dei caratteri, che il sorgente copia quattro byte alla
 * volta con EAX. Qui si copiano due byte alla volta, due volte.
 */
const PATCHES = [
  [
    /mov\s+eax, 0x007c ;; INT 0x1F\s*\n\s*stosd\s*\n\s*mov\s+eax, 0x010c ;; INT 0x43\s*\n\s*stosd/,
    'mov   ax, 0x007c ;; INT 0x1F\n  stosw\n  mov   ax, 0x007e\n  stosw\n' +
      '  mov   ax, 0x010c ;; INT 0x43\n  stosw\n  mov   ax, 0x010e\n  stosw',
  ],
  [
    /lodsd\s*\n\s*seg\s+es\s*\n\s*mov\s+0x007c, eax ;; INT 0x1F\s*\n\s*lodsd\s*\n\s*seg\s+es\s*\n\s*mov\s+0x010c, eax ;; INT 0x43/,
    'lodsw\n  seg   es\n  mov   0x007c, ax ;; INT 0x1F\n  lodsw\n  seg   es\n  mov   0x007e, ax\n' +
      '  lodsw\n  seg   es\n  mov   0x010c, ax ;; INT 0x43\n  lodsw\n  seg   es\n  mov   0x010e, ax',
  ],
  // La lettura di un registro PCI, a trentadue bit. La chiama solo il codice
  // VBE, che qui non c'è, ma il sorgente la lascia fuori dalla sua condizione:
  // ce la si rimette, così che nella ROM non resti nemmeno un byte da 386.
  [
    /(\n {2}; read PCI register\n(?:.*\n){3}pci_read_reg:\n(?:.*\n)*? {2}in {2}eax, dx\n {2}ret\n)/,
    '\n#if defined(VBE) || defined(CIRRUS)$1#endif\n',
  ],
];

const work = await mkdtemp(join(tmpdir(), 'vgabios-'));
const run = (command, args) => execFileSync(command, args, { cwd: work, encoding: 'latin1', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  process.stdout.write(`↓ ${VGABIOS_SOURCE_URL} … `);
  const response = await fetch(VGABIOS_SOURCE_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  await writeFile(join(work, 'vgabios.tgz'), new Uint8Array(await response.arrayBuffer()));
  run('tar', ['xzf', 'vgabios.tgz']);
  console.log('ok');
  const tree = join(work, `vgabios-${VGABIOS_RELEASE}`);

  let source = await readFile(join(tree, 'vgabios.c'), 'latin1');
  for (const [pattern, replacement] of PATCHES) {
    if (!pattern.test(source)) throw new Error(`il sorgente non è quello atteso: ${pattern}`);
    source = source.replace(pattern, replacement);
  }
  await writeFile(join(tree, 'vgabios286.c'), source, 'latin1');

  // Il preprocessore di gcc, come fa il Makefile; senza VBE e senza PCIBIOS.
  const expanded = execFileSync(
    'gcc',
    ['-E', '-P', 'vgabios286.c', `-DVGABIOS_VERS="${VGABIOS_RELEASE}-286"`, '-DVGABIOS_DATE="alloldos"'],
    { cwd: tree, encoding: 'latin1' },
  );
  await writeFile(join(tree, 'vgabios286.i'), expanded, 'latin1');
  execFileSync(cc1, ['vgabios286.i', '-o', 'vgabios286.s', '-c', '-0'], { cwd: tree });

  // Il punto di tutto lo script: il processore è un 286, non un 386.
  const assembly = (await readFile(join(tree, 'vgabios286.s'), 'latin1'))
    .replace(/^\.text/gm, '')
    .replace(/^\.data/gm, '')
    .replace(/^use16 386$/m, 'use16 286');
  await writeFile(join(tree, 'vgabios286.asm'), assembly, 'latin1');
  try {
    execFileSync(as86, ['vgabios286.asm', '-b', 'vgabios286.bin', '-u', '-w-', '-g', '-0', '-j', '-O'], {
      cwd: tree,
      encoding: 'latin1',
    });
  } catch (error) {
    console.error(error.stdout);
    throw new Error('as86 ha trovato istruzioni che il 286 non ha');
  }

  // biossums allunga la ROM fino alla misura che dichiara e chiude il conto
  // dei byte, che il BIOS di sistema controlla prima di saltarci dentro.
  execFileSync('gcc', ['-o', 'biossums', 'biossums.c'], { cwd: tree });
  execFileSync(join(tree, 'biossums'), ['vgabios286.bin'], { cwd: tree });

  const rom = new Uint8Array(await readFile(join(tree, 'vgabios286.bin')));
  if (!isVideoROM(rom)) throw new Error('quello che è uscito non si presenta come una ROM video');
  // Trentadue KB, da C000 a C7FF: a C800 comincia la ROM della scheda del disco.
  if (rom.length > 0x8000) throw new Error(`la ROM è di ${rom.length} byte, e a C800 c'è la scheda del disco`);
  const target = join(ROMS, VIDEO_SPEC.file);
  await writeFile(target, rom);
  const sha = createHash('sha256').update(rom).digest('hex');
  console.log(`${target}: ${rom.length} byte, sha256 ${sha}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
