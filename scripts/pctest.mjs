#!/usr/bin/env node
// Prove per l'x86: piccoli programmi assemblati a mano, eseguiti sul core.
//
// Un processore non si prova guardandolo: si prova facendogli fare qualcosa e
// controllando dov'è finito. Ogni prova qui è un pugno di byte — gli stessi che
// avrebbe sputato un assemblatore del 1985 — caricati a 1000:0000 e lasciati
// correre fino a HLT.  Si esegue con `node scripts/pctest.mjs`.

import { CPU286, AX, CX, DX, BX, SP, BP, SI, DI, ES, CS, SS, DS } from '../src/systems/pc/cpu286.js';

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

console.log(failures === 0 ? '\nPC OK.' : `\n${failures} problema/i.`);
process.exit(failures === 0 ? 0 : 1);
