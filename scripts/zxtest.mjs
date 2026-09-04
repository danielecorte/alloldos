#!/usr/bin/env node
// Prove per lo ZX Spectrum: prima lo Z80, poi la ULA, poi la macchina intera
// con dentro la sua ROM.
//
// Un processore non si prova guardandolo: gli si fa fare qualcosa e si guarda
// dove è finito. Ogni prova della prima metà è un pugno di byte caricati a
// 8000h e lasciati correre fino a HALT — gli stessi byte che avrebbe sputato
// un assemblatore del 1982. La seconda metà accende la macchina vera e ci fa
// girare i sedici KB della ROM Sinclair, che di questo emulatore non sa
// niente: se arriva al suo BASIC, la macchina è quella che si aspettava.
//
// Si esegue con `node scripts/zxtest.mjs`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Z80, FLAG_C, FLAG_Z, FLAG_S, FLAG_P, FLAG_H, FLAG_N } from '../src/systems/zx/cpuz80.js';
import { ULA, KEY_ROWS, FRAME_CYCLES } from '../src/systems/zx/ula.js';
import { Spectrum } from '../src/systems/zx/machine.js';
import { Tape, parseTAP, encodeTAP, tapeName, PILOT_PULSE, BIT_ONE } from '../src/systems/zx/tape.js';
import { loadSNA, saveSNA } from '../src/systems/zx/snapshot.js';
import { keysFor, positionOf, keysForCharacter } from '../src/systems/zx/keyboard.js';
import { beeperSamples } from '../src/systems/zx/audio.js';

let failures = 0;

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

function check(label, condition, detail = '') {
  if (condition) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const hex = (value, digits = 4) => `$${(value >>> 0).toString(16).padStart(digits, '0')}`;

const CODE = 0x8000;

/** Carica un programma a 8000h e lo esegue fino a HALT. */
function run(code, prepare = () => {}, limit = 200000) {
  const memory = new Uint8Array(0x10000);
  const ports = new Map();
  const written = [];
  const bus = {
    read8: (addr) => memory[addr & 0xffff],
    write8: (addr, value) => {
      memory[addr & 0xffff] = value & 0xff;
    },
    inb: (port) => ports.get(port & 0xff) ?? 0xff,
    outb: (port, value) => written.push([port & 0xffff, value & 0xff]),
  };
  const cpu = new Z80(bus);
  memory.set(Uint8Array.from(code), CODE);
  cpu.pc = CODE;
  cpu.sp = 0x7ff0;
  const box = { cpu, memory, ports, written };
  prepare(box);
  let steps = 0;
  let cycles = 0;
  while (!cpu.halted && steps < limit) {
    cycles += cpu.step();
    steps++;
  }
  box.steps = steps;
  box.cycles = cycles;
  return box;
}

const HALT = 0x76;

// ------------------------------------------------------------------ le basi

section('Le basi');

{
  // LD A,$12 / LD B,$34 / ADD A,B / HALT
  const box = run([0x3e, 0x12, 0x06, 0x34, 0x80, HALT]);
  check('un immediato entra nel registro e una somma somma', box.cpu.r[7] === 0x46, hex(box.cpu.r[7], 2));
  check('e la macchina si ferma su HALT', box.cpu.halted);
}

{
  // Il riporto di mezzo byte, che è l'unico modo per cui esiste il flag H:
  // LD A,$0f / INC A / HALT
  const box = run([0x3e, 0x0f, 0x3c, HALT]);
  check('il riporto di mezzo byte si accende dove serve', (box.cpu.f & FLAG_H) !== 0);
  check('e la sottrazione si distingue dalla somma', (box.cpu.f & FLAG_N) === 0);
}

{
  // LD A,$80 / SUB $01: l'overflow con segno, che non è il riporto
  const box = run([0x3e, 0x80, 0xd6, 0x01, HALT]);
  check('il traboccamento con segno è un\'altra cosa dal riporto', (box.cpu.f & FLAG_P) !== 0);
  check('e il riporto qui non c\'è', (box.cpu.f & FLAG_C) === 0);
  check('il risultato è quello', box.cpu.r[7] === 0x7f, hex(box.cpu.r[7], 2));
}

{
  // La parità, che sullo Z80 divide il bit con l'overflow: LD A,$03 / OR A
  const box = run([0x3e, 0x03, 0xb7, HALT]);
  check('due bit accesi fanno parità pari', (box.cpu.f & FLAG_P) !== 0);
  const odd = run([0x3e, 0x07, 0xb7, HALT]);
  check('e tre no', (odd.cpu.f & FLAG_P) === 0);
}

{
  // Il confronto prende i due bit non documentati dall'operando e non dal
  // risultato: è la stranezza con cui si riconosce uno Z80 vero.
  const box = run([0x3e, 0x00, 0xfe, 0x28, HALT]); // LD A,0 / CP $28
  check('CP copia i bit nascosti dall\'operando', (box.cpu.f & 0x28) === 0x28, hex(box.cpu.f, 2));
}

{
  // I due banchi di registri, che sono la ragione per cui le interruzioni
  // dello Spectrum costano niente: EXX invece di sedici push.
  const box = run([0x01, 0x34, 0x12, 0xd9, 0x01, 0x78, 0x56, 0xd9, HALT]);
  check('EXX scambia i registri con il loro doppio', box.cpu.bc === 0x1234, hex(box.cpu.bc));
  check('e l\'altro banco tiene quello che aveva', box.cpu.alt.r[0] === 0x56);
}

{
  // Gli indici: LD IX,$9000 / LD (IX+2),$7f / LD A,(IX+2) / HALT
  const box = run([0xdd, 0x21, 0x00, 0x90, 0xdd, 0x36, 0x02, 0x7f, 0xdd, 0x7e, 0x02, HALT]);
  check('un registro indice scrive dove dice lo spostamento', box.memory[0x9002] === 0x7f);
  check('e lo rilegge', box.cpu.r[7] === 0x7f);
  const negative = run([0xdd, 0x21, 0x00, 0x90, 0xdd, 0x7e, 0xfe, HALT], (box) => {
    box.memory[0x8ffe] = 0x5a;
  });
  check('lo spostamento ha il segno', negative.cpu.r[7] === 0x5a, hex(negative.cpu.r[7], 2));
}

{
  // I bit, che su una macchina che disegna per pixel sono metà del lavoro.
  const box = run([0x3e, 0x10, 0xcb, 0x67, HALT]); // LD A,$10 / BIT 4,A
  check('BIT su un bit acceso non alza lo zero', (box.cpu.f & FLAG_Z) === 0);
  const clear = run([0x3e, 0x10, 0xcb, 0x6f, HALT]); // BIT 5,A
  check('e su uno spento sì', (clear.cpu.f & FLAG_Z) !== 0);
  const set = run([0x3e, 0x00, 0xcb, 0xff, 0xcb, 0x87, HALT]); // SET 7,A / RES 0,A
  check('SET accende e RES spegne', set.cpu.r[7] === 0x80, hex(set.cpu.r[7], 2));
}

{
  // LDIR: copiare mezza memoria in una riga sola.
  const box = run(
    [0x21, 0x00, 0x90, 0x11, 0x00, 0x91, 0x01, 0x10, 0x00, 0xed, 0xb0, HALT],
    (b) => {
      for (let i = 0; i < 16; i++) b.memory[0x9000 + i] = i + 1;
    },
  );
  check('LDIR copia il blocco', box.memory[0x9100] === 1 && box.memory[0x910f] === 16);
  check('e finisce con il conteggio a zero', box.cpu.bc === 0);
  check('e con la parità spenta, che è come si sa che ha finito', (box.cpu.f & FLAG_P) === 0);
}

{
  // CPIR: cerca un byte e si ferma quando lo trova.
  const box = run(
    [0x21, 0x00, 0x90, 0x01, 0x10, 0x00, 0x3e, 0x07, 0xed, 0xb1, HALT],
    (b) => {
      for (let i = 0; i < 16; i++) b.memory[0x9000 + i] = i + 1;
    },
  );
  check('CPIR si ferma dove ha trovato', box.cpu.hl === 0x9007, hex(box.cpu.hl));
  check('e lo dice con lo zero', (box.cpu.f & FLAG_Z) !== 0);
}

section('Il tempo');

{
  // I T-state non sono un dettaglio: il caricamento da nastro misura la
  // durata degli impulsi contandoli, e il video ci è appeso.
  const cases = [
    [[0x00, HALT], 4, 'NOP'],
    [[0x78, HALT], 4, 'LD A,B'],
    [[0x7e, HALT], 7, 'LD A,(HL)'],
    [[0x36, 0x00, HALT], 10, 'LD (HL),n'],
    [[0x09, HALT], 11, 'ADD HL,BC'],
    [[0x03, HALT], 6, 'INC BC'],
    [[0xcd, 0x0a, 0x80, HALT, 0, 0, 0, 0, 0, 0, 0xc9], 17 + 10, 'CALL nn e RET'],
    [[0xe3, HALT], 19, 'EX (SP),HL'],
    [[0xdd, 0x7e, 0x00, HALT], 19, 'LD A,(IX+d)'],
    [[0x01, 0x01, 0x00, 0xed, 0xb0, HALT], 10 + 16, 'LD BC,1 e LDIR di un byte solo'],
  ];
  for (const [code, expected, name] of cases) {
    const box = run(code);
    check(`${name} dura ${expected} cicli`, box.cycles - 4 === expected, `${box.cycles - 4}`);
  }
}

{
  // Il salto relativo costa cinque cicli in più solo se salta davvero: è la
  // ragione per cui i cicli stretti si scrivono al contrario.
  const taken = run([0x18, 0x00, HALT]);
  const skipped = run([0x20, 0x00, HALT], (b) => {
    b.cpu.f = FLAG_Z;
  });
  check('un salto preso costa più di uno saltato', taken.cycles - 4 === 12 && skipped.cycles - 4 === 7);
}

section('Le interruzioni');

{
  // EI non apre le interruzioni subito: apre dopo l'istruzione successiva.
  // Senza quel rinvio, `ei / halt` non si sveglierebbe mai, ed è esattamente
  // come lo Spectrum aspetta il quadro dopo.
  const box = run([0xfb, HALT], () => {});
  check('dopo una EI il rinvio è alzato', box.cpu.eiPending === false, 'consumato dall\'istruzione dopo');

  const memory = new Uint8Array(0x10000);
  const cpu = new Z80({
    read8: (a) => memory[a],
    write8: (a, v) => {
      memory[a] = v;
    },
    inb: () => 0xff,
    outb: () => {},
  });
  memory.set([0xfb, 0x76], CODE); // EI / HALT
  memory[0x0038] = 0xc9; // la routine di interruzione: RET e basta
  cpu.pc = CODE;
  cpu.sp = 0x7ff0;
  cpu.step();
  check('subito dopo la EI l\'interruzione non passa', cpu.interrupt() === 0);
  cpu.step(); // HALT
  check('la macchina si è fermata ad aspettare', cpu.halted);
  const taken = cpu.interrupt();
  check('e l\'interruzione la sveglia', !cpu.halted && cpu.pc === 0x0038, hex(cpu.pc));
  check('costa tredici cicli, come sul chip vero', taken === 13, `${taken}`);
  check('e chiude le interruzioni dietro di sé', !cpu.iff1);
}

section('La ULA');

{
  const memory = new Uint8Array(0x10000);
  const ula = new ULA(memory);

  // Il rimescolamento dei bit dell'indirizzo video, che è la cosa più famosa
  // di questa macchina: la riga 1 non sta sotto la riga 0.
  check('la prima riga comincia a 4000h', ULA.pixelAddress(0, 0) === 0x4000);
  check('la seconda sta 256 byte più in là', ULA.pixelAddress(1, 0) === 0x4100);
  check('e la nona torna indietro, a 4020h', ULA.pixelAddress(8, 0) === 0x4020);
  check('il secondo terzo comincia a 4800h', ULA.pixelAddress(64, 0) === 0x4800);

  // Un carattere bianco su nero in alto a sinistra.
  memory[0x4000] = 0xff;
  memory[0x5800] = 0x47; // inchiostro bianco, fondo nero, brillante
  const pixels = ula.render();
  const width = 256 + 64;
  const first = pixels[24 * width + 32];
  check('un byte di pixel accesi diventa una riga bianca', first === 0xffffffff, hex(first, 8));
  check('e accanto, dove non c\'è niente, resta il fondo', pixels[24 * width + 32 + 8] === 0xff000000);

  // La tastiera: una riga per volta, e i bit a zero sono i tasti premuti.
  const [row, bit] = [3, 0]; // il tasto "1"
  ula.setKey(row, bit, true);
  check('un tasto premuto porta a zero il suo bit', (ula.read(0xf7fe) & 1) === 0, hex(ula.read(0xf7fe), 2));
  check('ma solo nella sua mezza riga', (ula.read(0xfefe) & 1) === 1);
  check('e le righe si possono guardare tutte insieme', (ula.read(0x00fe) & 1) === 0);
  ula.setKey(row, bit, false);
  check('lasciandolo, il bit torna su', (ula.read(0xf7fe) & 1) === 1);

  // Il bordo, e il fatto che può cambiare a metà quadro.
  ula.startFrame();
  ula.write(0x02, 0); // rosso
  ula.write(0x05, 40000); // ciano, a metà quadro
  check('il bordo si ricorda quando è cambiato', ula.borderAt(0) === 2 && ula.borderAt(50000) === 5);

  // L'altoparlante è un bit, e il suono è la sua storia dentro il quadro.
  ula.startFrame();
  ula.write(0x10, 0);
  ula.write(0x00, FRAME_CYCLES / 2);
  const samples = beeperSamples(ula.audioEvents, FRAME_CYCLES, 800);
  check('la prima metà del quadro suona', samples[100] > 0.3, samples[100].toFixed(2));
  check('e la seconda no', samples[700] < -0.3, samples[700].toFixed(2));
}

section('La tastiera');

{
  check('la A sta dove la mise Sinclair', String(positionOf('A')) === '1,0');
  check('e lo spazio in fondo a destra', String(positionOf('Space')) === '7,0');
  check('la freccia a sinistra è caps shift più 5', keysFor('ArrowLeft').join('+') === 'Shift+5');
  check('la virgola è symbol shift più N', keysFor('Comma').join('+') === 'SymbolShift+N');
  check('e le lettere sono lettere', keysFor('KeyQ').join('') === 'Q');
  check('le virgolette si battono con symbol shift e P', keysForCharacter('"')[0].join('+') === 'SymbolShift+P');
}

section('Il nastro');

{
  // Un `.tap` non contiene il suono, contiene i byte: il suono si rifà con i
  // tempi standard della ROM, ed è quello che la ROM va a misurare.
  const blocks = [new Uint8Array([0x00, 0x03, 65, 66]), new Uint8Array([0xff, 1, 2, 3])];
  const tap = encodeTAP(blocks);
  const parsed = parseTAP(tap);
  check('un .tap si scrive e si rilegge', parsed.length === 2 && parsed[1][3] === 3);

  const tape = new Tape(parsed, 'prova');
  tape.play(0);
  check('appena parte il filo si muove', tape.levelAt(0) === 1);
  check('e il primo impulso di guida dura 2168 cicli', tape.nextEdge === PILOT_PULSE, `${tape.nextEdge}`);
  check('poi torna giù', tape.levelAt(PILOT_PULSE) === 0);

  // Il tono di guida di un'intestazione è più lungo di quello dei dati: sono
  // otto secondi contro due, e servivano al motore del registratore.
  let edges = 0;
  let t = 0;
  while (tape.phase === 'pilot' && edges < 20000) {
    t += PILOT_PULSE;
    tape.levelAt(t);
    edges++;
  }
  check('il tono di guida di un\'intestazione sono ottomila impulsi', edges > 8000 && edges < 8100, `${edges}`);
}

// -------------------------------------------------------- l'avvio vero

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const romPath = join(ROOT, 'roms', 'zx', '48.rom');

if (!existsSync(romPath)) {
  console.log(`
Nessuna ROM in roms/zx: le prove di avvio vero sono state saltate.
Si prende con \`npm run fetch-roms\`.`);
} else {
  section('Avvio vero');

  const zx = new Spectrum(new Uint8Array(readFileSync(romPath)));
  const frames = (n) => {
    for (let i = 0; i < n; i++) zx.runFrame();
  };
  const screen = () => zx.text().join('\n');

  frames(150);
  check(
    'la ROM si accende e si presenta',
    /1982 Sinclair Research Ltd/.test(screen()),
    zx.text()[23],
  );
  check('e sta aspettando un tasto', zx.cpu.pc >= 0x1200 && zx.cpu.pc < 0x1700, hex(zx.cpu.pc));
  check('con le interruzioni aperte, in modo 1', zx.cpu.iff1 && zx.cpu.im === 1);

  // Battere sui tasti veri, attraverso la stessa matrice che usa il browser.
  const press = (names, held = 8) => {
    for (const name of names) {
      const position = positionOf(name);
      if (position) zx.ula.setKey(position[0], position[1], true);
    }
    frames(held);
    for (const name of names) {
      const position = positionOf(name);
      if (position) zx.ula.setKey(position[0], position[1], false);
    }
    frames(held);
  };

  press(['P']); // in modo comando la P è tutta la parola PRINT
  press(['SymbolShift', 'P']); // le virgolette
  for (const char of 'CIAO') press([char]);
  press(['SymbolShift', 'P']);
  press(['Enter']);
  frames(25);
  // Minuscole: dopo una parola chiave lo Spectrum passa in modo L, ed è lì
  // che le lettere sono lettere invece che comandi.
  check('quello che si batte arriva al BASIC', screen().includes('ciao'), zx.text()[0]);
  check('e il BASIC dice che è andata bene', /0 OK/.test(screen()), zx.text()[23]);

  // L'aritmetica in virgola mobile della ROM: cinque byte per numero, scritta
  // da Jim Westwood in un'epoca in cui nessuno aveva un coprocessore. È il
  // pezzo di codice più esigente che ci sia dentro questa macchina, e farlo
  // girare giusto vuol dire aver preso bene mezzo processore.
  press(['P']);
  for (const char of '355') press([char]);
  press(['SymbolShift', 'V']); // la barra
  for (const char of '113') press([char]);
  press(['Enter']);
  frames(30);
  check(
    'e la ROM sa fare i conti in virgola mobile',
    screen().includes('3.1415929'),
    zx.text().find((row) => row.includes('3.14')) ?? zx.text()[0],
  );

  // Il giro completo del nastro: un programma BASIC vero, in blocchi veri,
  // rifatto in impulsi e rimisurato dalla ROM.
  const text = 'DAL NASTRO';
  const line = [0xf5, 0x22, ...[...text].map((c) => c.charCodeAt(0)), 0x22, 0x0d];
  const program = [0x00, 0x0a, line.length & 0xff, line.length >> 8, ...line];
  const header = [0x00, 0x00, ...[...'prova     '].map((c) => c.charCodeAt(0))];
  header.push(program.length & 0xff, program.length >> 8);
  header.push(10, 0); // la riga da cui parte da solo appena finito di caricare
  header.push(program.length & 0xff, program.length >> 8);
  const checksum = (bytes) => {
    let value = 0;
    for (const byte of bytes) value ^= byte;
    return new Uint8Array([...bytes, value]);
  };
  const blocks = [checksum(header), checksum([0xff, ...program])];
  const tap = encodeTAP(blocks);
  check('l\'intestazione dice come si chiama', tapeName(parseTAP(tap)) === 'prova');

  zx.reset();
  frames(150);
  press(['J']); // LOAD
  press(['SymbolShift', 'P']);
  press(['SymbolShift', 'P']);
  press(['Enter']);
  frames(20);

  zx.tape = new Tape(parseTAP(tap), 'prova');
  zx.tape.play(zx.time);
  for (let i = 0; i < 2000 && !zx.tape.finished; i++) zx.runFrame();
  check('il nastro arriva in fondo', zx.tape.finished, `blocco ${zx.tape.block}`);
  frames(60);
  check('la ROM ha riconosciuto il blocco', screen().includes('Program: prova'), zx.text()[1]);
  check(
    'il programma è entrato in memoria ed è partito da solo',
    screen().includes('DAL NASTRO'),
    zx.text()[2],
  );

  // Un'istantanea: si salva e si rimette, e la macchina riparte da lì.
  const snapshot = saveSNA(zx);
  check('un\'istantanea sono 49179 byte', snapshot.length === 49179, `${snapshot.length}`);
  const before = zx.cpu.pc;
  const other = new Spectrum(new Uint8Array(readFileSync(romPath)));
  loadSNA(other, snapshot);
  check('e rimessa dentro riporta la macchina dov\'era', other.cpu.pc === before, hex(other.cpu.pc));
  check('con lo schermo che aveva', other.text().join('\n').includes('DAL NASTRO'));
  other.runFrame();
  check('e riparte senza inciampare', other.cpu.pc !== before);

  // Il quadro deve durare quello che dura, o tutto il resto va a rotoli.
  const start = zx.cpu.cycles;
  frames(50);
  const perFrame = (zx.cpu.cycles - start) / 50;
  check(
    'un quadro dura 69888 cicli, cioè cinquanta al secondo',
    Math.abs(perFrame - FRAME_CYCLES) < 40,
    `${perFrame.toFixed(0)} cicli`,
  );

  // E lo schermo deve avere dentro dei pixel, non solo dei byte.
  // E quello che c'è scritto deve essere fatto di pixel, non di byte: qui
  // non esiste una memoria di caratteri, il testo è disegnato.
  const pixels = zx.ula.render();
  let lit = 0;
  for (let i = 0; i < pixels.length; i++) if (pixels[i] !== pixels[0]) lit++;
  check('e quello che c\'è scritto è fatto di pixel accesi', lit > 200, `${lit} punti d\'inchiostro`);
}

console.log(failures === 0 ? '\nZX OK.' : `\n${failures} problema/i.`);
process.exit(failures === 0 ? 0 : 1);
