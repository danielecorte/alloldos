#!/usr/bin/env node
// Prove per il PC: prima il processore, poi i chip intorno, poi la macchina
// intera con dentro un BIOS vero.
//
// Un processore non si prova guardandolo: si prova facendogli fare qualcosa e
// controllando dov'è finito. Ogni prova della prima metà è un pugno di byte —
// gli stessi che avrebbe sputato un assemblatore del 1985 — caricati a
// 1000:0000 e lasciati correre fino a HLT. La seconda metà accende invece la
// scheda madre e ci fa girare GLaBIOS, che di questo emulatore non sa niente:
// se il POST arriva in fondo, la scheda è quella che si aspettava.
//
// Si esegue con `node scripts/pctest.mjs`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CPU286, AX, CX, DX, BX, SP, BP, SI, DI, ES, CS, SS, DS } from '../src/systems/pc/cpu286.js';
import { PIC8259 } from '../src/systems/pc/pic.js';
import { PIT8253, PIT_CLOCK } from '../src/systems/pc/pit.js';
import { DMA8237 } from '../src/systems/pc/dma.js';
import { PPI8255, VIDEO_CGA_80 } from '../src/systems/pc/ppi.js';
import { XTKeyboard } from '../src/systems/pc/keyboard.js';
import { CGA, DOTS_PER_LINE, LINES_PER_FRAME } from '../src/systems/pc/cga.js';
import { PC, CPU_CLOCK, FPS } from '../src/systems/pc/machine.js';

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

/** Una macchina finta: un mega di memoria e due registri di porte. */
function machine() {
  const memory = new Uint8Array(0x100000);
  const ports = new Map();
  const written = [];
  const bus = {
    read8: (addr) => memory[addr & 0xfffff],
    write8: (addr, value) => {
      memory[addr & 0xfffff] = value & 0xff;
    },
    inb: (port) => ports.get(port) ?? 0xff,
    outb: (port, value) => {
      ports.set(port, value & 0xff);
      written.push([port, value & 0xff]);
    },
  };
  const cpu = new CPU286(bus);
  return { cpu, memory, ports, written };
}

const CODE_SEGMENT = 0x1000;
const CODE_BASE = CODE_SEGMENT << 4;

/**
 * Carica un programma e lo esegue fino a HLT.
 * @param {number[]} code i byte del programma
 */
function run(code, prepare = () => {}, limit = 100000) {
  const box = machine();
  box.memory.set(Uint8Array.from(code), CODE_BASE);
  box.cpu.s[CS] = CODE_SEGMENT;
  box.cpu.ip = 0;
  box.cpu.s[SS] = 0x2000;
  box.cpu.s[DS] = 0x3000;
  box.cpu.s[ES] = 0x4000;
  box.cpu.r[SP] = 0xfffe;
  prepare(box);
  let steps = 0;
  while (!box.cpu.halted && steps < limit) {
    box.cpu.step();
    steps++;
  }
  box.steps = steps;
  return box;
}

const HLT = 0xf4;

// ------------------------------------------------------------ le basi

section('Le basi');

{
  // mov ax, $1234 / mov bx, $1000 / add ax, bx / hlt
  const box = run([0xb8, 0x34, 0x12, 0xbb, 0x00, 0x10, 0x01, 0xd8, HLT]);
  check('un immediato entra nel registro e una somma somma', box.cpu.r[AX] === 0x2234, hex(box.cpu.r[AX]));
  check('e la macchina si ferma su HLT', box.cpu.halted);
}

{
  // I registri a otto bit sono le due metà di quelli a sedici, e si vede:
  // mov ax, $1234 / mov ah, $ff / mov cl, al / hlt
  const box = run([0xb8, 0x34, 0x12, 0xb4, 0xff, 0x88, 0xc1, HLT]);
  check('AH è la metà alta di AX', box.cpu.r[AX] === 0xff34, hex(box.cpu.r[AX]));
  check('e AL la metà bassa', (box.cpu.r[CX] & 0xff) === 0x34, hex(box.cpu.r[CX]));
}

{
  // I flag di una sottrazione che va sotto zero: mov al,1 / sub al,2 / hlt
  const box = run([0xb0, 0x01, 0x2c, 0x02, HLT]);
  check('sotto zero il riporto si accende', box.cpu.cf === 1);
  check('e il segno pure', box.cpu.sf === 1);
  check('il risultato è in complemento a due', (box.cpu.r[AX] & 0xff) === 0xff, hex(box.cpu.r[AX] & 0xff, 2));
  check('e lo zero no', box.cpu.zf === 0);
}

{
  // L'overflow con segno è un'altra cosa dal riporto: $7f + 1 sta nel byte,
  // ma cambia segno. mov al,$7f / add al,1 / hlt
  const box = run([0xb0, 0x7f, 0x04, 0x01, HLT]);
  check('l\'overflow con segno si accorge del cambio di segno', box.cpu.of === 1);
  check('e il riporto senza segno resta spento', box.cpu.cf === 0);
}

// -------------------------------------------------------- gli indirizzi

section('Gli indirizzi (mod-reg-r/m)');

{
  // mov word [bx+si+2], ax con DS a $3000: l'indirizzo si compone di tre pezzi.
  const box = run(
    [0xb8, 0xcd, 0xab, 0xbb, 0x10, 0x00, 0xbe, 0x20, 0x00, 0x89, 0x40, 0x02, HLT],
  );
  const at = (0x3000 << 4) + 0x32;
  check('base più indice più spiazzamento', box.memory[at] === 0xcd && box.memory[at + 1] === 0xab, hex(at, 5));
}

{
  // Lo stesso indirizzo, ma con BP dentro: il segmento di default diventa lo
  // stack, ed è la regola che rende inutile scriverlo ogni volta.
  const box = run([0xb8, 0x99, 0x88, 0xbd, 0x40, 0x00, 0x89, 0x46, 0x00, HLT]);
  const inStack = (0x2000 << 4) + 0x40;
  check('con BP si scrive nello stack e non nei dati', box.memory[inStack] === 0x99, hex(inStack, 5));
}

{
  // E con un prefisso davanti si cambia idea: es: mov [bp], ax
  const box = run([0xb8, 0x77, 0x66, 0xbd, 0x40, 0x00, 0x26, 0x89, 0x46, 0x00, HLT]);
  const inExtra = (0x4000 << 4) + 0x40;
  check('il prefisso di segmento ha l\'ultima parola', box.memory[inExtra] === 0x77, hex(inExtra, 5));
}

{
  // LEA non legge la memoria: calcola l'indirizzo e basta.
  const box = run([0xbb, 0x10, 0x00, 0xbe, 0x05, 0x00, 0x8d, 0x48, 0x03, HLT]);
  check('LEA consegna l\'indirizzo, non quello che c\'è dentro', box.cpu.r[CX] === 0x18, hex(box.cpu.r[CX]));
}

{
  // LES prende un puntatore lungo — offset e segmento — in un colpo solo.
  const box = run([0xbb, 0x00, 0x00, 0xc4, 0x0f, HLT], (box) => {
    const at = (0x3000 << 4);
    box.memory[at] = 0x34;
    box.memory[at + 1] = 0x12;
    box.memory[at + 2] = 0x00;
    box.memory[at + 3] = 0xb8;
  });
  check('LES carica offset e segmento insieme', box.cpu.r[CX] === 0x1234 && box.cpu.s[ES] === 0xb800, `${hex(box.cpu.s[ES])}:${hex(box.cpu.r[CX])}`);
}

// ------------------------------------------------------------- lo stack

section('Lo stack');

{
  // push ax / push bx / pop cx / pop dx / hlt
  const box = run([0xb8, 0x11, 0x11, 0xbb, 0x22, 0x22, 0x50, 0x53, 0x59, 0x5a, HLT]);
  check('quello che entra per ultimo esce per primo', box.cpu.r[CX] === 0x2222 && box.cpu.r[DX] === 0x1111);
  check('e lo stack torna dov\'era', box.cpu.r[SP] === 0xfffe, hex(box.cpu.r[SP]));
}

{
  // pusha / popa, che sul 186 sono arrivate per fare in due byte quello che
  // prima ne prendeva sedici.
  const box = run([0xb8, 0x01, 0x00, 0xbb, 0x02, 0x00, 0x60, 0xb8, 0xff, 0xff, 0xbb, 0xff, 0xff, 0x61, HLT]);
  check('PUSHA e POPA rimettono tutto a posto', box.cpu.r[AX] === 1 && box.cpu.r[BX] === 2);
  check('SP compreso', box.cpu.r[SP] === 0xfffe, hex(box.cpu.r[SP]));
}

// ----------------------------------------------------- che processore è

section('Che processore è');

{
  // È così che un programma lo chiede, ed è così che deve rispondere questo:
  // pushf / pop ax — sul 286 in modo reale i quattro bit alti sono spenti,
  // sull'8086 erano tutti accesi.
  const box = run([0x9c, 0x58, HLT]);
  check('i quattro bit alti di FLAGS sono spenti, come su un 286', (box.cpu.r[AX] & 0xf000) === 0, hex(box.cpu.r[AX]));
  check('e il bit uno è acceso, come su qualunque x86', (box.cpu.r[AX] & 0x0002) !== 0);
}

{
  // L'altra domanda: mov cl, 33 / mov ax, 1 / shl ax, cl.
  // Un 8086 sposta trentatré volte e lascia zero; dal 186 in poi il contatore
  // è mascherato a cinque bit, quindi sposta di uno.
  const box = run([0xb1, 0x21, 0xb8, 0x01, 0x00, 0xd3, 0xe0, HLT]);
  check('il contatore di scorrimento è mascherato a cinque bit', box.cpu.r[AX] === 2, hex(box.cpu.r[AX]));
}

{
  // E la terza: push sp impila il valore di prima, non quello già decrementato.
  const box = run([0x54, 0x58, HLT]);
  check('PUSH SP impila SP com\'era', box.cpu.r[AX] === 0xfffe, hex(box.cpu.r[AX]));
}

// --------------------------------------------------------- le stringhe

section('Le stringhe');

{
  // cld / mov cx,4 / rep movsb — quattro byte da DS:SI a ES:DI.
  const box = run([0xfc, 0xb9, 0x04, 0x00, 0xbe, 0x00, 0x00, 0xbf, 0x00, 0x00, 0xf3, 0xa4, HLT], (box) => {
    const from = 0x3000 << 4;
    for (let i = 0; i < 4; i++) box.memory[from + i] = 0xa0 + i;
  });
  const to = 0x4000 << 4;
  check('REP MOVSB copia tutti i byte', [...box.memory.slice(to, to + 4)].join() === '160,161,162,163');
  check('e svuota CX', box.cpu.r[CX] === 0);
  check('lasciando i puntatori dopo l\'ultimo byte', box.cpu.r[SI] === 4 && box.cpu.r[DI] === 4);
}

{
  // std / rep stosw all'indietro, che è come si azzera un buffer dal fondo.
  const box = run([0xfd, 0xb8, 0xff, 0x00, 0xb9, 0x03, 0x00, 0xbf, 0x08, 0x00, 0xf3, 0xab, HLT]);
  const to = 0x4000 << 4;
  check('con il flag di direzione si va all\'indietro', box.cpu.r[DI] === 2, hex(box.cpu.r[DI]));
  check('e le parole ci sono tutte', box.memory[to + 8] === 0xff && box.memory[to + 4] === 0xff);
}

{
  // repe cmpsb su due stringhe che divergono al terzo byte.
  const box = run([0xfc, 0xb9, 0x08, 0x00, 0xbe, 0x00, 0x00, 0xbf, 0x00, 0x00, 0xf3, 0xa6, HLT], (box) => {
    const a = 0x3000 << 4;
    const b = 0x4000 << 4;
    for (let i = 0; i < 8; i++) {
      box.memory[a + i] = 0x41 + i;
      box.memory[b + i] = 0x41 + i;
    }
    box.memory[b + 2] = 0x5a; // qui non sono più uguali
  });
  check('REPE CMPSB si ferma alla prima differenza', box.cpu.r[CX] === 5, `CX ${box.cpu.r[CX]}`);
  check('e lo dice con lo zero spento', box.cpu.zf === 0);
}

{
  // Una ripetizione lunga si può interrompere, ed è tutto il punto: dopo ogni
  // giro il puntatore torna sull'istruzione, prefisso compreso.
  const box = machine();
  box.memory.set(Uint8Array.from([0xfc, 0xb9, 0x00, 0x10, 0xf3, 0xaa, HLT]), CODE_BASE);
  box.cpu.s[CS] = CODE_SEGMENT;
  box.cpu.ip = 0;
  box.cpu.s[ES] = 0x4000;
  box.cpu.r[SP] = 0xfffe;
  for (let i = 0; i < 6; i++) box.cpu.step(); // cld, mov cx, e quattro giri
  check('una stringa lunga resta interrompibile', box.cpu.ip === 4, `IP ${hex(box.cpu.ip)}`);
  check('e ha fatto solo i giri che ha fatto', box.cpu.r[CX] === 0x0ffc, hex(box.cpu.r[CX]));
}

// ----------------------------------------------------- moltiplica e dividi

section('Moltiplica e dividi');

{
  // mov ax,$1000 / mov bx,$0010 / mul bx — il risultato lungo sta in DX:AX.
  const box = run([0xb8, 0x00, 0x10, 0xbb, 0x10, 0x00, 0xf7, 0xe3, HLT]);
  check('la moltiplicazione lunga finisce in DX:AX', box.cpu.r[DX] === 0x0001 && box.cpu.r[AX] === 0x0000, `${hex(box.cpu.r[DX])}:${hex(box.cpu.r[AX])}`);
  check('e il riporto dice che DX non è vuoto', box.cpu.cf === 1);
}

{
  // Con segno è un'altra istruzione: mov al,-3 / mov bl,5 / imul bl
  const box = run([0xb0, 0xfd, 0xb3, 0x05, 0xf6, 0xeb, HLT]);
  check('IMUL tiene il segno', (box.cpu.r[AX] & 0xffff) === 0xfff1, hex(box.cpu.r[AX]));
}

{
  // mov dx,0 / mov ax,100 / mov bx,7 / div bx
  const box = run([0xba, 0x00, 0x00, 0xb8, 0x64, 0x00, 0xbb, 0x07, 0x00, 0xf7, 0xf3, HLT]);
  check('la divisione dà quoziente e resto', box.cpu.r[AX] === 14 && box.cpu.r[DX] === 2, `${box.cpu.r[AX]} resto ${box.cpu.r[DX]}`);
}

{
  // Dividere per zero è l'interrupt zero, il primo della tabella.
  const box = run([0xba, 0x00, 0x00, 0xb8, 0x64, 0x00, 0xbb, 0x00, 0x00, 0xf7, 0xf3, HLT], (box) => {
    // Il gestore: mov cx,$dead / hlt, a 0000:0500
    box.memory[0] = 0x00;
    box.memory[1] = 0x05;
    box.memory[2] = 0x00;
    box.memory[3] = 0x00;
    box.memory.set(Uint8Array.from([0xb9, 0xad, 0xde, HLT]), 0x500);
  });
  check('dividere per zero salta all\'interrupt zero', box.cpu.r[CX] === 0xdead, hex(box.cpu.r[CX]));
}

// ------------------------------------------------------- gli interrupt

section('Gli interrupt');

{
  // int $21, con un gestore che cambia AX e torna.
  const box = run([0xb8, 0x00, 0x00, 0xcd, 0x21, 0xbb, 0x22, 0x22, HLT], (box) => {
    box.memory[0x21 * 4] = 0x00;
    box.memory[0x21 * 4 + 1] = 0x06;
    box.memory[0x21 * 4 + 2] = 0x00;
    box.memory[0x21 * 4 + 3] = 0x00;
    // mov ax,$4c00 / iret
    box.memory.set(Uint8Array.from([0xb8, 0x00, 0x4c, 0xcf]), 0x600);
  });
  check('INT va dove dice la tabella dei vettori', box.cpu.r[AX] === 0x4c00, hex(box.cpu.r[AX]));
  check('e IRET torna all\'istruzione dopo', box.cpu.r[BX] === 0x2222, hex(box.cpu.r[BX]));
  check('con lo stack pulito', box.cpu.r[SP] === 0xfffe, hex(box.cpu.r[SP]));
}

{
  // Un codice operativo che non esiste è l'interrupt sei, che il 286 ha
  // inventato apposta per dire "questa non la conosco".
  const box = run([0x0f, 0xff, HLT], (box) => {
    box.memory[6 * 4] = 0x00;
    box.memory[6 * 4 + 1] = 0x07;
    box.memory.set(Uint8Array.from([0xb9, 0x06, 0x00, HLT]), 0x700);
  });
  check('un\'istruzione inesistente finisce all\'interrupt sei', box.cpu.r[CX] === 6);
}

{
  // I flag tornano com'erano: stc / pushf / clc / popf.
  const box = run([0xf9, 0x9c, 0xf8, 0x9d, HLT]);
  check('PUSHF e POPF riportano indietro i flag', box.cpu.cf === 1);
}

// -------------------------------------------------------- le porte e i salti

section('Le porte, i salti e i cicli');

{
  // mov dx,$0378 / mov al,$41 / out dx,al
  const box = run([0xba, 0x78, 0x03, 0xb0, 0x41, 0xee, HLT]);
  check('OUT scrive sulla porta giusta', box.ports.get(0x378) === 0x41, `porta $378 = ${hex(box.ports.get(0x378) ?? -1, 2)}`);
}

{
  // in al, $60 — la porta della tastiera, che qui risponde quello che le si dice
  const box = run([0xe4, 0x60, HLT], (box) => box.ports.set(0x60, 0x1c));
  check('IN legge quello che la porta dice', (box.cpu.r[AX] & 0xff) === 0x1c);
}

{
  // Un ciclo vero: mov cx,10 / xor ax,ax / add ax,cx / loop -4
  const box = run([0xb9, 0x0a, 0x00, 0x31, 0xc0, 0x01, 0xc8, 0xe2, 0xfc, HLT]);
  check('LOOP gira finché CX non si svuota', box.cpu.r[AX] === 55, `${box.cpu.r[AX]}`);
  check('e CX finisce a zero', box.cpu.r[CX] === 0);
}

{
  // I salti condizionati, tutti e sedici, contro i flag che li governano:
  // cmp ax, bx con valori uguali, poi je avanti.
  const box = run([0xb8, 0x05, 0x00, 0xbb, 0x05, 0x00, 0x39, 0xd8, 0x74, 0x03, 0xb9, 0x01, 0x00, HLT]);
  check('un salto condizionato che deve saltare salta', box.cpu.r[CX] === 0);
}

// -------------------------------------------------------- il decimale

section('Il decimale, che serviva ai soldi');

{
  // mov al,$19 / add al,$01 / daa — diciannove più uno fa venti, in BCD.
  const box = run([0xb0, 0x19, 0x04, 0x01, 0x27, HLT]);
  check('DAA rimette il risultato in decimale', (box.cpu.r[AX] & 0xff) === 0x20, hex(box.cpu.r[AX] & 0xff, 2));
}

{
  // mov ax,$0007 / mov bl,3 / mul bl / aam — ventuno diventa due e uno.
  const box = run([0xb8, 0x07, 0x00, 0xb3, 0x03, 0xf6, 0xe3, 0xd4, 0x0a, HLT]);
  check('AAM divide per dieci e mette le cifre in AH e AL', box.cpu.r[AX] === 0x0201, hex(box.cpu.r[AX]));
}

// ------------------------------------------------------------- i chip

section('Il controllore delle interruzioni (8259)');

{
  const pic = new PIC8259();
  // La sequenza con cui ogni BIOS lo sveglia: ICW1 su 20h, poi vettore e modo.
  pic.write(0x20, 0x13);
  pic.write(0x21, 0x08);
  pic.write(0x21, 0x0d);
  pic.write(0x21, 0xfe); // tutto mascherato tranne la IRQ 0
  pic.pulse(0);
  check('la IRQ 0 arriva alla porta e chiede il vettore 8', pic.request() === 0);
  check('e il vettore è quello che ha detto il BIOS', pic.acknowledge(0) === 8);
  check('mentre è in servizio non passa nient\'altro', (pic.pulse(1), pic.request()) === -1);
  pic.write(0x20, 0x20); // fine interruzione
  check('la maschera lascia fuori chi non è stato aperto', pic.request() === -1, 'IRQ 1 mascherata');
  pic.write(0x21, 0xfc);
  check('e appena si apre, la richiesta rimasta in attesa passa', pic.request() === 1);
}

{
  const pic = new PIC8259();
  pic.write(0x20, 0x13);
  pic.write(0x21, 0x08);
  pic.write(0x21, 0x0d);
  pic.write(0x21, 0x00);
  pic.setLine(3, true);
  pic.acknowledge(pic.request());
  pic.setLine(3, false);
  pic.setLine(3, true);
  check('il chip scatta sul fronte, non sul livello', pic.irr === 0x08, 'una riga tenuta alta non ricarica');
}

section('I contatori (8253)');

{
  let ticks = 0;
  const pit = new PIT8253({ onChannel0: (edges) => (ticks += edges) });
  pit.write(0x43, 0x36); // contatore 0, due byte, modo 3
  pit.write(0x40, 0x00);
  pit.write(0x40, 0x00);
  pit.advance(PIT_CLOCK); // un secondo di quarzo
  check('il tic di sistema batte 18 volte al secondo', ticks === 18, `${ticks} tic`);
}

{
  const pit = new PIT8253({});
  pit.write(0x43, 0x74); // contatore 1, due byte, modo 2
  pit.write(0x41, 0x74);
  pit.write(0x41, 0x74);
  pit.write(0x43, 0x54); // e poi lo stesso contatore a un byte solo
  pit.write(0x41, 18);
  check('un carico a un byte azzera la metà alta', pit.channels[1].period === 18, `${pit.channels[1].period}`);
  pit.advance(9);
  pit.write(0x43, 0x40); // latch del contatore 1
  const low = pit.read(0x41);
  check('il latch congela il valore di quel momento', low === 9, `${low}`);
}

section('Il DMA (8237)');

{
  const memory = new Uint8Array(0x100000);
  const dma = new DMA8237({ read8: (a) => memory[a], write8: (a, v) => (memory[a] = v) });

  // La prova che il BIOS fa all'accensione: un bit che cammina su tutti e otto
  // i registri, riletto due volte perché il bistabile torni dov'era.
  dma.write(0x0d, 0);
  let walked = true;
  for (let start = 1; start < 256; start <<= 1) {
    let bit = start;
    for (let port = 0; port < 8; port++) {
      dma.write(port, bit);
      dma.write(port, bit);
      bit = ((bit << 1) | (bit >> 7)) & 0xff;
    }
    bit = start;
    for (let port = 0; port < 8; port++) {
      if (dma.read(port) !== bit || dma.read(port) !== bit) walked = false;
      bit = ((bit << 1) | (bit >> 7)) & 0xff;
    }
  }
  check('i registri di indirizzo e conteggio si rileggono come scritti', walked);

  dma.write(0x0c, 0);
  dma.writePage(0x87, 1); // pagina 1: il secondo blocco da 64 KB
  dma.write(0x00, 0xfe);
  dma.write(0x00, 0xff);
  dma.write(0x0b, 0x48); // canale 0, singolo, lettura dalla memoria
  dma.write(0x01, 1);
  dma.write(0x01, 0);
  dma.write(0x0a, 0x00); // via la maschera
  memory[0x1fffe] = 0x2a;
  memory[0x1ffff] = 0x2b;
  check('un trasferimento legge dove dicono pagina e indirizzo', dma.transfer(0) === 0x2a);
  check('e va avanti da solo', dma.transfer(0) === 0x2b);
  check('alla fine del blocco alza il fine conteggio', dma.terminalCount(0));
  check('e senza auto-inizializzazione si rimette in maschera', (dma.mask & 1) === 1);
}

{
  const dma = new DMA8237({ read8: () => 0, write8: () => {} });
  dma.write(0x0c, 0);
  dma.write(0x01, 0xff);
  dma.write(0x01, 0xff);
  dma.write(0x0b, 0x58); // canale 0, auto-inizializzazione: il rinfresco
  dma.write(0x0a, 0x00);
  dma.refresh(0x10000);
  check('il rinfresco arriva a fine conteggio dopo 65536 colpi', dma.terminalCount(0));
  check('e riparte da solo, senza che nessuno lo riprogrammi', (dma.mask & 1) === 0);
}

section('Gli interruttori e la tastiera');

{
  let speaker = null;
  const keyboard = new XTKeyboard({});
  const ppi = new PPI8255(
    {
      readKeyboard: () => keyboard.read(),
      setKeyboardLines: (held, cleared) => keyboard.setLines(held, cleared),
      timer2Output: () => 0,
      setSpeaker: (gate, data) => (speaker = { gate, data }),
    },
    { floppies: 2, video: VIDEO_CGA_80 },
  );

  ppi.write(0x61, 0x00); // bit 3 basso: la metà bassa degli interruttori
  check('la metà bassa dice quanta memoria e se c\'è un disco', ppi.read(0x62) === 0x0d, hex(ppi.read(0x62), 2));
  ppi.write(0x61, 0x08); // bit 3 alto: la metà alta
  check('la metà alta dice video e numero di lettori', ppi.read(0x62) === 0x06, hex(ppi.read(0x62), 2));

  ppi.write(0x61, 0x03);
  check('i due bit bassi della 61h sono l\'altoparlante', speaker.gate && speaker.data);

  // La sequenza di reset della tastiera: clock a terra, poi libero.
  ppi.write(0x61, 0x88); // clock a terra (bit 6 = 0), registro azzerato
  ppi.write(0x61, 0xc8); // clock libero: la tastiera riparte
  ppi.write(0x61, 0x48); // e il registro si riapre
  check('la tastiera riavviata dice che sta bene', ppi.read(0x60) === 0xaa, hex(ppi.read(0x60), 2));

  keyboard.press(0x1e);
  check('finché nessuno dice "preso", il byte di prima resta lì', ppi.read(0x60) === 0xaa);
  ppi.write(0x61, 0xc8); // "preso"
  ppi.write(0x61, 0x48);
  check('e dopo arriva il tasto', ppi.read(0x60) === 0x1e, hex(ppi.read(0x60), 2));
  keyboard.release(0x1e);
  ppi.write(0x61, 0xc8);
  ppi.write(0x61, 0x48);
  check('il rilascio è lo stesso codice con il bit alto acceso', ppi.read(0x60) === 0x9e, hex(ppi.read(0x60), 2));
}

section('Il pennello (CGA)');

{
  const cga = new CGA();
  const dotsPerFrame = DOTS_PER_LINE * LINES_PER_FRAME;
  let displaying = 0;
  let blanking = 0;
  let vsync = 0;
  for (let dot = 0; dot < dotsPerFrame; dot += 8) {
    const status = cga.status;
    if (status & 0x01) blanking++;
    else displaying++;
    if (status & 0x08) vsync++;
    cga.advance(8);
  }
  check('in un quadro il bit di ritorno cambia davvero', displaying > 0 && blanking > 0, `${displaying} dentro, ${blanking} fuori`);
  check('e il ritorno verticale dura una manciata di righi', vsync > 0 && vsync < blanking, `${vsync} letture in ritorno verticale`);
  check('dopo un quadro intero il pennello è tornato dov\'era', cga.dot === 0);

  cga.writeMemory(0, 0x41);
  cga.writeMemory(1, 0x07);
  check('la memoria è la pagina: un byte è un carattere', cga.text()[0] === 'A');
  check('e si ripete ogni sedici KB', cga.readMemory(0x4000) === 0x41);
}

section('La scheda');

{
  const bios = new Uint8Array(0x2000).fill(0xcc);
  bios[0x1ff0] = 0xea; // il salto che il 286 trova all'accensione
  const pc = new PC(bios);
  pc.ram[0x400] = 0x5a;
  check('i 640 KB stanno in fondo', pc.read8(0x400) === 0x5a);
  check('il BIOS sta in cima, a F000:E000', pc.read8(0xffff0) === 0xea);
  pc.write8(0xb8000, 0x41);
  check('la scheda video risponde a B800', pc.cga.readMemory(0) === 0x41);
  check('e riappare quattro pagine più su', pc.read8(0xbc000) === 0x41);
  check('sopra la memoria non c\'è nessuno, e il bus resta alto', pc.read8(0xa0000) === 0xff);
  check('e le porte dove non c\'è una scheda pure', pc.inb(0x3f8) === 0xff, 'la prima seriale che non c\'è');

  // Il processore parte da dove parte, e non da dove gli pare.
  check('il 286 si sveglia a F000:FFF0', pc.location === 'f000:fff0');
}

// -------------------------------------------------------- l'avvio vero

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const biosPath = join(ROOT, 'roms', 'pc', 'glabios.rom');

if (!existsSync(biosPath)) {
  console.log(`
Nessun BIOS in roms/pc: la prova di avvio vero è stata saltata.
GLaBIOS è libero e si prende con \`npm run fetch-roms\`.`);
} else {
  section('Avvio vero');

  // Tutto quello che c'è sopra dice che i chip fanno quello che dice il
  // manuale. Questo dice l'unica cosa che conta davvero: che un BIOS scritto
  // per questa macchina, da qualcuno che non ha mai visto questo emulatore,
  // ci si accende sopra e la trova come se la aspetta.
  const pc = new PC(new Uint8Array(readFileSync(biosPath)));
  for (let frame = 0; frame < 1800 && !pc.cga.text().join('\n').includes('Any Key'); frame++) {
    pc.runFrame();
  }
  const screen = pc.cga.text();
  const shown = screen.join('\n');

  check('il BIOS si presenta', shown.includes('GLaBIOS'), screen[1]);
  check('e ha contato tutti i 640 KB', /RAM\s+\[ 640 KB OK \]/.test(shown), screen[5]);
  check('ha riconosciuto la scheda video dagli interruttori', shown.includes('Video  [ CGA ]'));
  check('e il POST è arrivato in fondo', shown.includes('Any Key'));

  // Il rinfresco della memoria non è una formalità: il BIOS controlla che il
  // canale 0 del DMA sia arrivato in fondo al suo conto, che è l'unico modo
  // che ha di sapere che la RAM non si sta dimenticando di sé stessa.
  check('nessun errore di DMA: la memoria si sta rinfrescando', !shown.includes('DMA'));
  check('e nessuno di memoria', !shown.includes('MEM'));

  const timer = () => pc.ram[0x46c] | (pc.ram[0x46d] << 8);
  const before = timer();
  const from = pc.cycles;
  for (let frame = 0; frame < FPS; frame++) pc.runFrame();
  const rate = (timer() - before) / ((pc.cycles - from) / CPU_CLOCK);
  check(
    'l\'orologio del BIOS batte 18,2 volte al secondo',
    Math.abs(rate - 18.2) < 0.5,
    `${rate.toFixed(1)} tic al secondo`,
  );

  // L'unico guaio che il POST trova è il controllore del disco, che non c'è
  // ancora: è il pezzo dopo, ed è quello che porterà su un sistema operativo.
  check('l\'unico pezzo che manca è il controllore del disco', shown.includes('FDC'), screen[10]);

  pc.keyboard.press(0x39); // barra spaziatrice
  for (let frame = 0; frame < 10; frame++) pc.runFrame();
  pc.keyboard.release(0x39);
  for (let frame = 0; frame < 600; frame++) pc.runFrame();
  check(
    'un tasto arriva al BIOS, che prova ad avviare e non trova niente',
    pc.cga.text().join('\n').includes('Disk Boot Fail'),
  );
}

console.log(failures === 0 ? '\nPC OK.' : `\n${failures} problema/i.`);
process.exit(failures === 0 ? 0 : 1);
