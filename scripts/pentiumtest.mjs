#!/usr/bin/env node
// Prove per il Pentium, cioè per il processore che sa fare tre mondi.
//
// Un 286 si prova in un modo solo: si caricano dei byte in memoria, si lascia
// correre, si guarda dove è finito. Questo processore invece va provato tre
// volte, perché è tre macchine diverse — l'8086 di quando si accende, il 386 a
// trentadue bit di quando il firmware ha fatto il suo lavoro, e la macchina con
// la memoria paginata di quando c'è un sistema operativo sopra — e la parte più
// delicata è il passaggio dall'una all'altra.
//
// Ogni prova è un pugno di byte, gli stessi che avrebbe sputato un assemblatore,
// lasciati correre fino a HLT. Dove serve, la prova si costruisce a mano anche
// le tabelle: una GDT con due descrittori, una IDT con una porta, una directory
// di pagine con la sua tabella. Sono le stesse tabelle che scrive un sistema
// operativo, e scriverle a mano è l'unico modo di sapere se il processore le
// legge come dice il manuale.
//
// Si esegue con `node scripts/pentiumtest.mjs`.

import {
  CPU586,
  Fault,
  Unsupported,
  EAX,
  ECX,
  EDX,
  EBX,
  ESP,
  EBP,
  ESI,
  EDI,
  ES,
  CS,
  SS,
  DS,
  FS,
  GS,
  CR0_PE,
  CR0_PG,
  CR4_PSE,
  GENERAL_PROTECTION,
  PAGE_FAULT,
} from '../src/systems/pentium/cpu586.js';

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

const hex = (value, digits = 8) => `$${(value >>> 0).toString(16).padStart(digits, '0')}`;

/** Sedici mega di memoria e un pugno di porte: quanto basta per un processore. */
function board(megabytes = 16) {
  const memory = new Uint8Array(megabytes * 1024 * 1024);
  const ports = new Map();
  const written = [];
  return {
    memory,
    ports,
    written,
    read8: (addr) => memory[addr >>> 0] ?? 0xff,
    write8: (addr, value) => {
      memory[addr >>> 0] = value & 0xff;
    },
    inb: (port) => ports.get(port) ?? 0xff,
    outb: (port, value) => {
      ports.set(port, value & 0xff);
      written.push([port, value & 0xff]);
    },
  };
}

/**
 * Una macchina in real mode con il codice a 1000:0000, che è dove lo mettevano
 * tutti perché è il primo posto comodo sopra la tabella degli interrupt.
 */
function realMode(code, { segment = 0x1000, offset = 0, memory = 16 } = {}) {
  const bus = board(memory);
  const cpu = new CPU586(bus);
  cpu.loadSegment(CS, segment);
  cpu.eip = offset;
  cpu.loadSegment(DS, segment);
  cpu.loadSegment(ES, segment);
  cpu.loadSegment(SS, segment);
  cpu.set32(ESP, 0xfff0);
  bus.memory.set(Uint8Array.from(code), segment * 16 + offset);
  return { cpu, bus };
}

/** Lascia correre fino a HLT, e non per sempre. */
function run(cpu, limit = 10000) {
  let steps = 0;
  while (!cpu.halted && steps < limit) {
    cpu.step();
    steps++;
  }
  if (!cpu.halted) throw new Error(`non si è fermata in ${limit} passi (${hex(cpu.eip)})`);
  return steps;
}

const HLT = 0xf4;
/** I byte di un numero, dal meno significativo: è l'ordine di Intel. */
const dw = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
const dh = (value) => [value & 0xff, (value >>> 8) & 0xff];

section('Come si sveglia');

{
  const bus = board();
  const cpu = new CPU586(bus);
  // Il Pentium non parte da F000:FFF0 come l'8086: parte *sopra* il megabyte,
  // a FFFFFFF0, perché la base di CS gliela mette il processore e non il
  // selettore. È il trucco che permette a un BIOS di essere grande più di
  // 64 KB prima che ci sia un modo protetto in cui girare.
  check('CS vale f000 ma la sua base è in cima a quattro giga',
    cpu.s[CS] === 0xf000 && cpu.seg[CS].base === 0xffff0000, hex(cpu.seg[CS].base));
  check('e la prima istruzione si legge da fffffff0', (cpu.seg[CS].base + cpu.eip) >>> 0 === 0xfffffff0);
  check('in real mode, che è l\'8086 del 1978', cpu.protectedMode === false);
  check('con gli operandi a sedici bit', cpu.opsize === 2 && cpu.addrsize === 2);
}

section('I trentadue bit, in real mode');

{
  // Il prefisso 66h non vuol dire "sedici bit": vuol dire *l'altra* misura. In
  // real mode fa lavorare a trentadue, ed è così che un BIOS carica un registro
  // intero prima di accendere il modo protetto.
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(0x12345678), // mov eax, 12345678h
    0x66, 0x05, ...dw(0x11111111), // add eax, 11111111h
    0xb8, ...dh(0xabcd), // mov ax, abcdh  (senza prefisso: sedici bit)
    HLT,
  ]);
  run(cpu);
  check('un immediato da trentadue bit entra tutto', (cpu.get32(EAX) & 0xffff0000) === 0x23450000, hex(cpu.get32(EAX)));
  check('e scrivere in AX non tocca la metà alta', (cpu.get32(EAX) & 0xffff) === 0xabcd, hex(cpu.get32(EAX)));
}

{
  // La moltiplicazione a trentadue bit: il risultato è lungo sessantaquattro, e
  // un `number` di JavaScript non li tiene. Questa è la prova che il conto passa
  // dai BigInt e non dalla virgola mobile.
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(0xffffffff),
    0x66, 0xba, ...dw(0xffffffff),
    0x66, 0xf7, 0xe2, // mul edx
    HLT,
  ]);
  run(cpu);
  check('due volte quattro miliardi fanno il numero giusto',
    cpu.get32(EAX) === 0x00000001 && cpu.get32(EDX) === 0xfffffffe,
    `${hex(cpu.get32(EDX))}:${hex(cpu.get32(EAX))}`);
}

{
  // E la divisione, che parte da sessantaquattro bit: otto miliardi e mezzo
  // diviso tre, con un resto che una divisione in virgola mobile non saprebbe
  // dire.
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(0x00000000), // eax = 0
    0x66, 0xba, ...dw(2), // edx = 2  →  il dividendo è 2^33
    0x66, 0xb9, ...dw(3), // ecx = 3
    0x66, 0xf7, 0xf1, // div ecx
    HLT,
  ]);
  run(cpu);
  check('e la divisione a sessantaquattro bit non perde l\'ultima cifra',
    cpu.get32(EAX) === 0xaaaaaaaa && cpu.get32(EDX) === 2,
    `${hex(cpu.get32(EAX))} resto ${cpu.get32(EDX)}`);
}

{
  // Il quoziente che non ci sta nel registro non è un numero troncato: è
  // l'eccezione 0, la stessa della divisione per zero. Qui si mette un gestore
  // nella tabella degli interrupt e si guarda se il processore ci arriva.
  const { cpu, bus } = realMode([
    0x66, 0xb8, ...dw(0),
    0x66, 0xba, ...dw(0x80000000), // un dividendo da sessantatré bit
    0x66, 0xb9, ...dw(3),
    0x66, 0xf7, 0xf1, // div ecx: il quoziente non ci sta
    HLT,
  ]);
  // Il gestore sta a 2000:0000 e non fa altro che fermarsi.
  bus.memory.set(Uint8Array.from([...dh(0x0000), ...dh(0x2000)]), 0);
  bus.memory[0x2000 * 16] = HLT;
  run(cpu);
  check('un quoziente troppo grande è un\'eccezione, non un numero sbagliato',
    cpu.s[CS] === 0x2000 && cpu.eip === 1, `${hex(cpu.s[CS], 4)}:${hex(cpu.eip, 4)}`);
  // E sullo stack c'è l'indirizzo dell'istruzione che ha fallito, non di quella
  // dopo: un fault si può riprendere, e per riprenderlo bisogna sapere dov'era.
  const back = cpu.read(2, SS, cpu.get32(ESP));
  check('con sullo stack l\'istruzione che ha fallito, non quella dopo', back === 18, String(back));
}

section('Gli indirizzi con la formula');

{
  // A trentadue bit gli indirizzi non sono più una tabella chiusa: sono base più
  // indice per uno, due, quattro o otto, più uno spostamento. È il modo in cui
  // si indicizza un array di strutture in un colpo solo, e il byte in più che ci
  // vuole si chiama SIB.
  const { cpu, bus } = realMode([
    0x66, 0xbb, ...dw(0x2000), // mov ebx, 2000h
    0x66, 0xb9, ...dw(4), // mov ecx, 4
    // mov eax, [ebx + ecx*8 + 16]  →  67h per gli indirizzi a 32 bit
    0x67, 0x66, 0x8b, 0x44, 0xcb, 0x10,
    HLT,
  ]);
  // Il valore sta a 1000:2030, cioè trentadue byte oltre 2000h più sedici.
  bus.memory.set(Uint8Array.from(dw(0xcafebabe)), 0x1000 * 16 + 0x2000 + 4 * 8 + 16);
  run(cpu);
  check('base più indice per otto più spostamento', cpu.get32(EAX) === 0xcafebabe, hex(cpu.get32(EAX)));
}

section('Le istruzioni che il 286 non aveva');

{
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(0x00000080), // eax = 80h
    0x0f, 0xbe, 0xd8, // movsx bl, al   → bl = 80h con il segno
    0x66, 0x0f, 0xb6, 0xc8, // movzx ecx, al  → 80h senza segno
    0x66, 0xb8, ...dw(0x11223344),
    0x0f, 0xc8, // bswap eax
    HLT,
  ]);
  run(cpu);
  check('MOVSX allunga col segno', cpu.get8(3) === 0x80 && cpu.get32(EBX) !== 0);
  check('MOVZX allunga senza', cpu.get32(ECX) === 0x80, hex(cpu.get32(ECX)));
  check('BSWAP gira i byte, che è l\'ordine della rete', cpu.get32(EAX) === 0x44332211, hex(cpu.get32(EAX)));
}

{
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(0x00001000), // eax = 1000h: il bit 12
    0x66, 0x0f, 0xbc, 0xd8, // bsf ebx, eax
    0x66, 0xb8, ...dw(0x80000001),
    0x66, 0x0f, 0xbd, 0xc8, // bsr ecx, eax
    0x66, 0x0f, 0xba, 0xe8, 0x1f, // bts eax, 31 → era già acceso
    HLT,
  ]);
  run(cpu);
  check('BSF trova il primo bit acceso da sotto', cpu.get32(EBX) === 12, String(cpu.get32(EBX)));
  check('BSR lo trova da sopra', cpu.get32(ECX) === 31, String(cpu.get32(ECX)));
  check('e BT lo dice nel riporto', cpu.cf === 1);
}

{
  // CMPXCHG e XADD, che arrivano col Pentium perché è il primo x86 pensato per
  // andare in coppia: sono i mattoni di un lucchetto.
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(7), // eax = 7 (quello che mi aspetto)
    0x66, 0xbb, ...dw(9), // ebx = 9 (quello che ci metto)
    0x66, 0xb9, ...dw(7), // ecx = 7 (il valore che c'è)
    0x66, 0x0f, 0xb1, 0xd9, // cmpxchg ecx, ebx → combacia, ecx = 9
    0x0f, 0x94, 0xc0, // sete al: il verdetto, tenuto prima che altri flag lo coprano
    0x66, 0xba, ...dw(5),
    0x66, 0xbe, ...dw(3),
    0x66, 0x0f, 0xc1, 0xf2, // xadd edx, esi → edx = 8, esi = 5
    HLT,
  ]);
  run(cpu);
  check('CMPXCHG scambia se il valore era quello che si credeva',
    cpu.get32(ECX) === 9 && cpu.get8(0) === 1, hex(cpu.get32(ECX)));
  check('XADD somma e restituisce quello che c\'era',
    cpu.get32(EDX) === 8 && cpu.get32(ESI) === 5,
    `${cpu.get32(EDX)} e ${cpu.get32(ESI)}`);
}

{
  const { cpu } = realMode([
    0x66, 0xb8, ...dw(0xf0000000), // eax
    0x66, 0xbb, ...dw(0x0000000f), // ebx: i bit che entrano
    0x66, 0x0f, 0xa4, 0xd8, 0x04, // shld eax, ebx, 4
    0x31, 0xd2, // xor dx, dx → zf = 1
    0x0f, 0x94, 0xc1, // sete cl
    HLT,
  ]);
  run(cpu);
  check('SHLD pesca i bit da un altro registro', cpu.get32(EAX) === 0x00000000, hex(cpu.get32(EAX)));
  check('e SETcc fa di una condizione un numero', cpu.get8(1) === 1);
}

section('CPUID, cioè la fine degli indovinelli');

{
  const { cpu } = realMode([
    0x66, 0x31, 0xc0, // xor eax, eax
    0x0f, 0xa2, // cpuid
    HLT,
  ]);
  run(cpu);
  const name = [cpu.get32(EBX), cpu.get32(EDX), cpu.get32(ECX)]
    .map((value) => String.fromCharCode(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff))
    .join('');
  check('il processore dice come si chiama', name === 'GenuineIntel', name);

  const { cpu: second } = realMode([
    0x66, 0xb8, ...dw(1),
    0x0f, 0xa2,
    HLT,
  ]);
  run(second);
  check('e che famiglia è: la quinta, cioè un Pentium', ((second.get32(EAX) >> 8) & 0xf) === 5, hex(second.get32(EAX)));
  check('con il contatore di cicli e le pagine grandi fra quello che sa fare',
    (second.get32(EDX) & 0x10) !== 0 && (second.get32(EDX) & 0x08) !== 0, hex(second.get32(EDX)));
  check('e senza mentire sulla virgola mobile, che non c\'è', (second.get32(EDX) & 1) === 0);
}

{
  const { cpu } = realMode([0x0f, 0x31, HLT]); // rdtsc
  cpu.tsc = 1234567;
  run(cpu);
  check('RDTSC consegna il contatore in EDX:EAX', cpu.get32(EAX) >= 1234567, String(cpu.get32(EAX)));
}


// ---------------------------------------------------------- il modo protetto

/**
 * Un descrittore di segmento, cioè gli otto byte con cui il modo protetto
 * racconta un segmento. Si scrive a mano, come lo scriverebbe un sistema
 * operativo, perché è l'unico modo di sapere se il processore li legge come
 * dice il manuale — base e limite sono sparsi in cinque pezzi non contigui.
 */
function descriptor({ base = 0, limit = 0xfffff, code = false, big = true, dpl = 0, pages = true }) {
  const access = 0x80 | (dpl << 5) | 0x10 | (code ? 0x0a : 0x02);
  const flags = (pages ? 0x80 : 0) | (big ? 0x40 : 0) | ((limit >>> 16) & 0x0f);
  return [
    limit & 0xff,
    (limit >>> 8) & 0xff,
    base & 0xff,
    (base >>> 8) & 0xff,
    (base >>> 16) & 0xff,
    access,
    flags,
    (base >>> 24) & 0xff,
  ];
}

/** Una porta di interruzione a trentadue bit: dove andare, e con che diritti. */
function gate(offset, selector = 0x08, type = 0x8e) {
  return [
    offset & 0xff,
    (offset >>> 8) & 0xff,
    selector & 0xff,
    (selector >>> 8) & 0xff,
    0,
    type,
    (offset >>> 16) & 0xff,
    (offset >>> 24) & 0xff,
  ];
}

const GDT_AT = 0x8000;
const IDT_AT = 0x9000;
const CODE_AT = 0x10000; // 1000:0000, dove comincia il codice in real mode
const WIDE_AT = 0x10200; // e dove continua a trentadue bit
const HANDLER_AT = 0x11000;

/**
 * Una macchina che fa il passaggio: si accende in real mode, carica una tabella
 * di descrittori, accende il bit 0 di CR0 e salta dentro un segmento a
 * trentadue bit. Sono le sei istruzioni con cui comincia ogni sistema operativo
 * dal 1986 a oggi, e sotto di loro non c'è niente che si possa saltare.
 *
 * @param {number[]} wide il codice a trentadue bit, che gira dopo il salto
 * @param {object} [options]
 * @param {number[][]} [options.extra] altri descrittori dopo i due di rito
 * @param {number[][]} [options.gates] le porte della IDT, una per vettore
 * @param {number[]} [options.handler] il codice del gestore, a HANDLER_AT
 */
function crossOver(wide, { extra = [], gates = [], handler = [] } = {}) {
  const { cpu, bus } = realMode([
    0xfa, // cli: da qui in poi non si vuole essere interrotti
    0x0f, 0x01, 0x16, ...dh(0x100), // lgdt [100h]
    0x0f, 0x01, 0x1e, ...dh(0x108), // lidt [108h]
    0x0f, 0x20, 0xc0, // mov eax, cr0
    0x0c, 0x01, // or al, 1 — il bit del modo protetto
    0x0f, 0x22, 0xc0, // mov cr0, eax
    // E il salto lontano, che è l'unica cosa che ricarica CS: finché non si
    // salta, il processore è in modo protetto ma sta ancora eseguendo con la
    // base di prima. Il prefisso 66h serve perché l'indirizzo di arrivo non sta
    // in sedici bit.
    0x66, 0xea, ...dw(WIDE_AT), ...dh(0x08),
  ]);

  // I due puntatori che LGDT e LIDT vanno a leggere: sei byte, limite e base.
  bus.memory.set(Uint8Array.from([...dh(0x7f), ...dw(GDT_AT)]), CODE_AT + 0x100);
  bus.memory.set(Uint8Array.from([...dh(0x7ff), ...dw(IDT_AT)]), CODE_AT + 0x108);

  const table = [
    ...descriptor({ base: 0, limit: 0 }), // il descrittore nullo, che non si usa
    ...descriptor({ code: true }), // selettore 08: codice piatto a trentadue bit
    ...descriptor({}), // selettore 10: dati, tutti i quattro giga
    ...extra.flat(),
  ];
  bus.memory.set(Uint8Array.from(table), GDT_AT);
  for (const [vector, bytes] of gates) bus.memory.set(Uint8Array.from(bytes), IDT_AT + vector * 8);
  if (handler.length) bus.memory.set(Uint8Array.from(handler), HANDLER_AT);

  // Il codice a trentadue bit comincia dandosi i dati e uno stack: prima del
  // salto quei registri contengono selettori che in modo protetto non vogliono
  // dire niente.
  bus.memory.set(
    Uint8Array.from([
      0xb8, ...dw(0x10), // mov eax, 10h
      0x8e, 0xd8, // mov ds, ax
      0x8e, 0xc0, // mov es, ax
      0x8e, 0xd0, // mov ss, ax
      0xbc, ...dw(0x7000), // mov esp, 7000h
      ...wide,
    ]),
    WIDE_AT,
  );
  return { cpu, bus };
}

const read32 = (bus, at) =>
  (bus.memory[at] | (bus.memory[at + 1] << 8) | (bus.memory[at + 2] << 16) | (bus.memory[at + 3] << 24)) >>> 0;
const write32 = (bus, at, value) => bus.memory.set(Uint8Array.from(dw(value)), at);

section('Il passaggio al modo protetto');

{
  const { cpu, bus } = crossOver([
    0xb8, ...dw(0xdeadbeef), // mov eax, deadbeefh
    0xa3, ...dw(0x3000), // mov [3000h], eax
    HLT,
  ]);
  run(cpu);
  check('il modo protetto è acceso', cpu.protectedMode === true);
  check('e il codice gira in un segmento a trentadue bit', cpu.seg[CS].big === true);
  check('con la base a zero, cioè la memoria tutta di seguito', cpu.seg[CS].base === 0);
  check('nell\'anello zero, che è dove sta il sistema operativo', cpu.cpl === 0);
  check('gli operandi sono a trentadue bit senza bisogno di prefissi', cpu.opsize === 4);
  check('e un indirizzo da quattro giga si scrive per intero',
    read32(bus, 0x3000) === 0xdeadbeef, hex(read32(bus, 0x3000)));
}

{
  // Il limite di un segmento non è un suggerimento: è la fine. Qui il
  // descrittore in più è lungo quattro KB, e la scrittura oltre la fine deve
  // diventare un #GP — che è il meccanismo su cui poggia tutta la protezione fra
  // programmi, prima che ci fosse la paginazione.
  const { cpu, bus } = crossOver(
    [
      0xb8, ...dw(0x18), // mov eax, 18h: il segmento corto
      0x8e, 0xc0, // mov es, ax
      0x26, 0xa3, ...dw(0x0800), // mov [es:800h], eax → dentro
      0x26, 0xa3, ...dw(0x2000), // mov [es:2000h], eax → fuori: #GP
      HLT,
    ],
    {
      extra: [descriptor({ base: 0x40000, limit: 0x0fff, pages: false })],
      gates: [[GENERAL_PROTECTION, gate(HANDLER_AT)]],
      handler: [
        0xbb, ...dw(0x600d), // mov ebx, 600dh: «ci sono arrivato»
        HLT,
      ],
    },
  );
  run(cpu);
  check('una scrittura dentro il limite passa', read32(bus, 0x40800) === 0x18, hex(read32(bus, 0x40800)));
  check('una oltre il limite diventa un\'eccezione di protezione',
    cpu.get32(EBX) === 0x600d, hex(cpu.get32(EBX)));
  check('e fuori dal segmento non è stato scritto niente', read32(bus, 0x42000) === 0);
  // Sullo stack del gestore c'è il codice di errore, poi l'indirizzo a cui
  // tornare: è quello che permette a un sistema operativo di raccontare che
  // cos'è andato storto e dove.
  const code = cpu.read(4, SS, cpu.get32(ESP));
  check('con un codice di errore in testa allo stack', code === 0, hex(code));
}

{
  // Il bit D di un segmento di codice, che è la cosa più facile da sbagliare di
  // tutta l'architettura. Lo stesso byte 66h in un segmento a sedici bit fa
  // lavorare a trentadue, e in uno a trentadue fa lavorare a sedici: non è un
  // prefisso "a sedici bit", è un prefisso "l'altra misura". Qui si salta in un
  // segmento a sedici bit *dentro* il modo protetto — che è esattamente dove
  // gira un driver del DOS caricato da un sistema operativo a trentadue bit — e
  // si guarda se la regola si gira.
  const { cpu, bus } = crossOver(
    [
      // jmp far 0018h:0000h, restando in modo protetto
      0xea, ...dw(0), ...dh(0x18),
    ],
    { extra: [descriptor({ base: 0x12000, limit: 0xffff, code: true, big: false, pages: false })] },
  );
  bus.memory.set(
    Uint8Array.from([
      0xb8, ...dh(0x1111), // mov ax, 1111h: sedici bit, senza prefissi
      0x66, 0xbb, ...dw(0x22223333), // mov ebx, 22223333h: col prefisso, trentadue
      HLT,
    ]),
    0x12000,
  );
  run(cpu);
  check('in un segmento a sedici bit gli operandi tornano a sedici', cpu.seg[CS].big === false);
  check('e il prefisso 66h lì vuol dire trentadue',
    cpu.get32(EBX) === 0x22223333 && (cpu.get32(EAX) & 0xffff) === 0x1111,
    hex(cpu.get32(EBX)));
  check('con la base del segmento che sposta tutto', cpu.seg[CS].base === 0x12000, hex(cpu.seg[CS].base));
}

{
  // Un selettore che non sta nella tabella. Il codice di errore dell'eccezione è
  // il selettore stesso: è così che un sistema operativo può dire *quale*
  // descrittore gli è stato chiesto, e non solo che qualcosa è andato storto.
  const { cpu } = crossOver(
    [
      0xb8, ...dw(0x88), // mov eax, 88h: oltre la fine della GDT
      0x8e, 0xd8, // mov ds, ax
      HLT,
    ],
    {
      gates: [[GENERAL_PROTECTION, gate(HANDLER_AT)]],
      handler: [
        0x5b, // pop ebx: il codice di errore
        HLT,
      ],
    },
  );
  run(cpu);
  check('un selettore fuori tabella è un\'eccezione col selettore come codice',
    cpu.get32(EBX) === 0x88, hex(cpu.get32(EBX)));
}

section('La paginazione');

{
  // La mappa: una directory, due tabelle. La prima tiene i primi quattro mega
  // uno per uno — il codice, lo stack e le tabelle stesse devono continuare a
  // stare dove stanno, o l'istruzione dopo non si legge più. La seconda mappa un
  // indirizzo alto su una pagina fisica qualunque, che è il trucco su cui poggia
  // tutta la memoria virtuale.
  const PD = 0x20000;
  const PT0 = 0x21000;
  const PT1 = 0x22000;
  const { cpu, bus } = crossOver(
    [
      0xb8, ...dw(PD),
      0x0f, 0x22, 0xd8, // mov cr3, eax
      0x0f, 0x20, 0xc0, // mov eax, cr0
      0x0d, ...dw(0x80000000), // or eax, 80000000h: il bit della paginazione
      0x0f, 0x22, 0xc0, // mov cr0, eax
      0xb8, ...dw(0x12345678),
      0xa3, ...dw(0x400000), // mov [400000h], eax: un indirizzo che non esiste
      HLT,
    ],
    { gates: [[PAGE_FAULT, gate(HANDLER_AT)]], handler: [HLT] },
  );
  for (let i = 0; i < 1024; i++) write32(bus, PT0 + i * 4, (i * 0x1000) | 3);
  write32(bus, PT1, 0x30000 | 3); // il virtuale 400000h sta al fisico 30000h
  write32(bus, PD, PT0 | 3);
  write32(bus, PD + 4, PT1 | 3);

  run(cpu);
  check('la paginazione è accesa', (cpu.cr0 & CR0_PG) !== 0);
  check('e quello che il programma scrive a 400000h finisce a 30000h',
    read32(bus, 0x30000) === 0x12345678, hex(read32(bus, 0x30000)));
  check('senza che a 400000h ci sia niente', read32(bus, 0x400000) === 0);
  // I due bit che il processore scrive da sé: «usata» e «cambiata». Sono quelli
  // con cui un sistema operativo decide che pagina mandare sul disco.
  const entry = read32(bus, PT1);
  check('con i bit di «usata» e «cambiata» messi dal processore',
    (entry & 0x60) === 0x60, hex(entry));
}

{
  // E la pagina che non c'è, che è il punto di tutto: il processore si ferma, dice
  // *quale* indirizzo mancava, e lascia al sistema operativo il compito di
  // andarlo a prendere. Senza questa eccezione non esistono né la memoria
  // virtuale né i file mappati né i processi che si credono soli al mondo.
  const PD = 0x20000;
  const PT0 = 0x21000;
  const { cpu, bus } = crossOver(
    [
      0xb8, ...dw(PD),
      0x0f, 0x22, 0xd8,
      0x0f, 0x20, 0xc0,
      0x0d, ...dw(0x80000000),
      0x0f, 0x22, 0xc0,
      0xa1, ...dw(0x800000), // mov eax, [800000h]: nessuna tabella per quei quattro mega
      HLT,
    ],
    {
      gates: [[PAGE_FAULT, gate(HANDLER_AT)]],
      handler: [
        0xbb, ...dw(0xfa17), // mov ebx, fa17h
        HLT,
      ],
    },
  );
  for (let i = 0; i < 1024; i++) write32(bus, PT0 + i * 4, (i * 0x1000) | 3);
  write32(bus, PD, PT0 | 3);

  run(cpu);
  check('una pagina che non c\'è ferma l\'istruzione', cpu.get32(EBX) === 0xfa17, hex(cpu.get32(EBX)));
  check('e il processore dice quale indirizzo mancava', cpu.cr2 === 0x800000, hex(cpu.cr2));
  const code = cpu.read(4, SS, cpu.get32(ESP));
  check('con un codice che dice «non c\'era», in lettura, da dentro il sistema',
    code === 0, hex(code));
}

{
  // Le pagine da quattro mega, che il Pentium aggiunge: una voce di directory e
  // niente tabella sotto. È come ogni sistema operativo mappa se stesso, perché
  // costa una voce invece di mille.
  const PD = 0x20000;
  const PT0 = 0x21000;
  const { cpu, bus } = crossOver([
    0x0f, 0x20, 0xe0, // mov eax, cr4
    0x0c, 0x10, // or al, 10h: le pagine grandi
    0x0f, 0x22, 0xe0, // mov cr4, eax
    0xb8, ...dw(PD),
    0x0f, 0x22, 0xd8,
    0x0f, 0x20, 0xc0,
    0x0d, ...dw(0x80000000),
    0x0f, 0x22, 0xc0,
    0xb8, ...dw(0x0badf00d),
    0xa3, ...dw(0xc01000), // mov [c01000h], eax
    HLT,
  ]);
  for (let i = 0; i < 1024; i++) write32(bus, PT0 + i * 4, (i * 0x1000) | 3);
  write32(bus, PD, PT0 | 3);
  write32(bus, PD + 3 * 4, 0x800000 | 0x83); // quattro mega interi, in una voce sola

  run(cpu);
  check('le pagine grandi sono accese', (cpu.cr4 & CR4_PSE) !== 0);
  check('e una voce sola mappa quattro mega di seguito',
    read32(bus, 0x801000) === 0x0badf00d, hex(read32(bus, 0x801000)));
}

section('Le interruzioni in modo protetto');

{
  // Un INT scritto dal programma, una porta della IDT, e il ritorno. In real mode
  // sarebbero tre push; qui in mezzo c'è una porta che dice chi ha il diritto di
  // passare, e IRET deve rimettere tutto come stava.
  const { cpu } = crossOver(
    [
      0xb8, ...dw(0x11111111),
      0xcd, 0x40, // int 40h
      0x05, ...dw(0x22222222), // add eax, 22222222h: si esegue dopo il ritorno
      HLT,
    ],
    {
      gates: [[0x40, gate(HANDLER_AT, 0x08, 0x8f)]], // una porta di trappola
      handler: [
        0xbb, ...dw(0x1234), // mov ebx, 1234h
        0xcf, // iret
      ],
    },
  );
  run(cpu);
  check('il gestore gira', cpu.get32(EBX) === 0x1234, hex(cpu.get32(EBX)));
  check('e IRET riporta il programma dove era, non un\'istruzione più in là',
    cpu.get32(EAX) === 0x33333333, hex(cpu.get32(EAX)));
  check('con lo stack come l\'aveva lasciato', cpu.get32(ESP) === 0x7000, hex(cpu.get32(ESP)));
}

{
  // REP MOVSD: la copia di memoria che ogni sistema operativo fa un milione di
  // volte. A trentadue bit sposta quattro byte per giro, e si deve poter
  // interrompere a metà — il processore che non torna sull'istruzione tiene fuori
  // l'orologio per tutta la copia.
  const { cpu, bus } = crossOver([
    0xbe, ...dw(0x50000), // mov esi, 50000h
    0xbf, ...dw(0x60000), // mov edi, 60000h
    0xb9, ...dw(64), // mov ecx, 64
    0xfc, // cld
    0xf3, 0xa5, // rep movsd
    HLT,
  ]);
  for (let i = 0; i < 256; i++) bus.memory[0x50000 + i] = (i * 3) & 0xff;
  const steps = run(cpu);
  let same = true;
  for (let i = 0; i < 256; i++) if (bus.memory[0x60000 + i] !== ((i * 3) & 0xff)) same = false;
  check('duecentocinquantasei byte copiati quattro per volta', same);
  check('e il contatore è a zero', cpu.get32(ECX) === 0);
  check('un giro per passo, perché in mezzo si deve poter entrare', steps > 64, `${steps} passi`);
}


section('Quanto va');

{
  // Non è una prova, è una misura: serve a sapere se sopra questo processore ci
  // si potrà mettere una macchina che gira a velocità onesta. Un ciclo stretto in
  // real mode, e lo stesso ciclo con la paginazione accesa — che costa, perché
  // ogni byte letto passa da una traduzione.
  const measure = (cpu, count) => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < count; i++) cpu.step();
    return count / (Number(process.hrtime.bigint() - start) / 1e9) / 1e6;
  };

  const { cpu } = realMode([
    0x66, 0xb9, ...dw(0x7fffffff), // mov ecx, un numero grande
    0x66, 0x49, // dec ecx
    0x75, 0xfc, // jnz
  ]);
  const flat = measure(cpu, 2_000_000);
  check('in real mode va più di due milioni di istruzioni al secondo', flat > 2,
    `${flat.toFixed(1)} milioni`);

  const PD = 0x20000;
  const PT0 = 0x21000;
  const { cpu: paged, bus } = crossOver([
    0xb8, ...dw(PD),
    0x0f, 0x22, 0xd8,
    0x0f, 0x20, 0xc0,
    0x0d, ...dw(0x80000000),
    0x0f, 0x22, 0xc0,
    0xb9, ...dw(0x7fffffff),
    0x49, // dec ecx
    0x75, 0xfd,
  ]);
  for (let i = 0; i < 1024; i++) write32(bus, PT0 + i * 4, (i * 0x1000) | 3);
  write32(bus, PD, PT0 | 3);
  for (let i = 0; i < 200; i++) paged.step(); // il tempo di accendere tutto
  const virtual = measure(paged, 2_000_000);
  check('e con la paginazione accesa più di uno', virtual > 1, `${virtual.toFixed(1)} milioni`);
}

console.log(failures === 0 ? '\nPentium OK.' : `\n${failures} problema/i.`);
process.exit(failures === 0 ? 0 : 1);
