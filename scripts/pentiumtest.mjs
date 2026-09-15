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

{
  // La cosa che solo il firmware vero ha trovato: `mov %ss,%edi` con gli
  // operandi a trentadue bit **azzera** i sedici bit alti del registro. Sul 386
  // erano indefiniti, dal Pentium sono zero, e il software ci conta — questo è
  // il modo in cui si passa da uno stack a segmenti a uno stack piatto, e con i
  // bit alti sporchi lo stack finisce a quattro giga da dove doveva.
  const { cpu } = realMode([
    0x66, 0xbf, ...dw(0xffffffff), // edi = tutti uno
    0x8c, 0xd7, // mov di, ss     → sedici bit: i alti restano
    0x66, 0x8c, 0xd6, // mov esi, ss  → trentadue: i alti si azzerano
    HLT,
  ]);
  run(cpu);
  check('un selettore in un registro a sedici bit lascia stare i bit alti',
    cpu.get32(EDI) === 0xffff1000, hex(cpu.get32(EDI)));
  check('in uno a trentadue li azzera, e da questo dipende ogni cambio di stack',
    cpu.get32(ESI) === 0x1000, hex(cpu.get32(ESI)));
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

section('Lo stesso motore, da 386');

{
  // Il 386 si riconosce da quello che non ha. Il bit AC di EFLAGS è del 486:
  // un programma prova ad accenderlo, e se ricade sa di avere davanti un 386 —
  // è il test che fanno tutti, Windows compreso. CPUID, poi, sul 386 non è
  // un'istruzione: è un opcode non valido, e parte l'eccezione 6.
  const flags = [
    0x66, 0x9c, // pushfd
    0x66, 0x58, // pop eax
    0x66, 0x0d, ...dw(0x40000), // or eax, 40000h — il bit AC
    0x66, 0x50, // push eax
    0x66, 0x9d, // popfd
    0x66, 0x9c, // pushfd
    0x66, 0x5b, // pop ebx
    HLT,
  ];
  const acOn = (model) => {
    const { cpu } = realMode(flags);
    cpu.model = model;
    run(cpu);
    return (cpu.get32(EBX) & 0x40000) !== 0;
  };
  check('su un 386 il bit AC ricade', !acOn(386));
  check('su un 486 resta acceso', acOn(486));

  const cpuid = (model) => {
    const { cpu, bus } = realMode([0x66, 0x31, 0xc0, 0x0f, 0xa2, HLT]); // xor eax, eax; cpuid
    cpu.model = model;
    // Il gestore dell'opcode non valido, a 1000:0100: si segna e si ferma.
    bus.memory.set(Uint8Array.from([...dh(0x100), ...dh(0x1000)]), 6 * 4);
    bus.memory.set(Uint8Array.from([0xbb, ...dh(0x66), HLT]), 0x10100);
    run(cpu);
    return cpu.get16(EBX);
  };
  check('su un 386 CPUID è un opcode non valido', cpuid(386) === 0x66, hex(cpuid(386), 4));
  check('su un Pentium risponde, e dice chi è', cpuid(586) === 0x6547, hex(cpuid(586), 4));
}

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
  // Il cambio di anello. Il sistema operativo carica un TSS con lo stack
  // dell'anello 0, e con un IRET scende all'anello 3 dando al programma il
  // diritto di usare le porte. Il programma fa un INT: il gestore sta
  // all'anello 0, e non può usare lo stack del programma — il processore
  // prende quello scritto nel TSS e ci impila sopra, prima di tutto, lo stack
  // di prima. Poi IRET torna all'anello 3, su quello stack. È il giro che fa
  // Windows 3.1 ogni volta che un programma chiede qualcosa al sistema.
  const TSS_AT = 0x12000;
  const RING3_AT = 0x11800;
  const tss = [0xff, 0x00, ...dh(TSS_AT & 0xffff), TSS_AT >>> 16, 0x89, 0x00, 0x00];
  const { cpu, bus } = crossOver(
    [
      0x66, 0xb8, ...dh(0x28), // mov ax, 28h
      0x0f, 0x00, 0xd8, // ltr ax
      0x6a, 0x23, // push 23h — SS dell'anello 3
      0x68, ...dw(0x5000), // push 5000h — il suo ESP
      0x68, ...dw(0x3002), // push 3002h — EFLAGS, con IOPL 3
      0x6a, 0x1b, // push 1Bh — CS dell'anello 3
      0x68, ...dw(RING3_AT), // push l'indirizzo
      0xcf, // iret: si scende
    ],
    {
      extra: [descriptor({ code: true, dpl: 3 }), descriptor({ dpl: 3 }), tss],
      gates: [[0x40, gate(HANDLER_AT, 0x08, 0xee)], [0x41, gate(HANDLER_AT + 0x100, 0x08, 0xee)]],
      handler: [
        0x89, 0xe2, // mov edx, esp: dove si è entrati
        0x8c, 0xd3, // mov ebx, ss: con che stack
        0xcf, // iret
      ],
    },
  );
  bus.memory.set(Uint8Array.from(dw(0x6000)), TSS_AT + 4); // ESP0
  bus.memory.set(Uint8Array.from(dh(0x10)), TSS_AT + 8); // SS0
  bus.memory[HANDLER_AT + 0x100] = HLT;
  bus.memory.set(Uint8Array.from([
    0x8c, 0xde, // mov esi, ds: il segmento dell'anello 0, che deve essere sparito
    0x9c, // pushfd
    0x5d, // pop ebp
    0xcd, 0x40, // int 40h
    0xbf, ...dw(0x77), // mov edi, 77h: si torna qui
    0xcd, 0x41, // int 41h: e questo gestore si ferma
  ]), RING3_AT);
  run(cpu);
  check('il gestore entra sullo stack del TSS, con sopra lo stack di prima',
    cpu.get32(EDX) === 0x6000 - 20 && cpu.get32(EBX) === 0x10, `${hex(cpu.get32(EDX))} ${hex(cpu.get32(EBX), 4)}`);
  check('e sotto, dal primo all\'ultimo: EIP, CS, EFLAGS, ESP e SS dell\'anello 3',
    read32(bus, 0x5fec + 4) === 0x1b && read32(bus, 0x5fec + 12) === 0x5000 && read32(bus, 0x5fec + 16) === 0x23);
  check('IRET torna all\'anello 3 e il programma va avanti', cpu.get32(EDI) === 0x77);
  check('scendendo, il segmento di dati dell\'anello 0 si è svuotato', cpu.get32(ESI) === 0, hex(cpu.get32(ESI), 4));
  check('e l\'IOPL che il sistema ha dato al programma c\'è', (cpu.get32(EBP) & 0x3000) === 0x3000, hex(cpu.get32(EBP)));
  check('LTR ha segnato il TSS occupato', (bus.memory[GDT_AT + 0x28 + 5] & 0x0f) === 0x0b);
  check('e alla fine si è di nuovo all\'anello 0', cpu.cpl === 0 && cpu.halted);
}

{
  // La porta di chiamata: un programma all'anello 3 chiama il sistema con un
  // CALL lontano, e il selettore non è un segmento ma una porta. La porta dice
  // dove andare e quanti parametri portarsi dietro; lo stack cambia, come per
  // un'interruzione, e il parametro viene ricopiato sullo stack nuovo, perché il
  // sistema non deve fidarsi di quello del programma. RETF 4 torna indietro e
  // lo toglie da tutti e due. È così che Windows 3.1 chiama il suo extender.
  const TSS_AT = 0x12000;
  const RING3_AT = 0x11800;
  const tss = [0xff, 0x00, ...dh(TSS_AT & 0xffff), TSS_AT >>> 16, 0x89, 0x00, 0x00];
  const callGate = [...dh(HANDLER_AT & 0xffff), ...dh(0x08), 1, 0xec, ...dh(HANDLER_AT >>> 16)];
  const { cpu, bus } = crossOver(
    [
      0x66, 0xb8, ...dh(0x28), // mov ax, 28h
      0x0f, 0x00, 0xd8, // ltr ax
      0x6a, 0x23, // push 23h
      0x68, ...dw(0x5000), // push 5000h
      0x68, ...dw(0x0002), // push 2
      0x6a, 0x1b, // push 1Bh
      0x68, ...dw(RING3_AT),
      0xcf, // iret: all'anello 3
    ],
    {
      extra: [descriptor({ code: true, dpl: 3 }), descriptor({ dpl: 3 }), tss, callGate],
      gates: [[0x41, gate(HANDLER_AT + 0x100, 0x08, 0xee)]],
      handler: [
        0x8b, 0x44, 0x24, 0x08, // mov eax, [esp+8]: il parametro
        0x8b, 0x4c, 0x24, 0x0c, // mov ecx, [esp+12]: l'ESP dell'anello 3
        0x8b, 0x6c, 0x24, 0x10, // mov ebp, [esp+16]: e il suo SS
        0x89, 0xe2, // mov edx, esp
        0x8c, 0xd3, // mov ebx, ss
        0xca, ...dh(4), // retf 4
      ],
    },
  );
  bus.memory.set(Uint8Array.from(dw(0x6000)), TSS_AT + 4);
  bus.memory.set(Uint8Array.from(dh(0x10)), TSS_AT + 8);
  bus.memory[HANDLER_AT + 0x100] = HLT;
  bus.memory.set(Uint8Array.from([
    0x89, 0xe6, // mov esi, esp: lo stack prima
    0x68, ...dw(0xabcd1234), // push il parametro
    0x9a, ...dw(0), ...dh(0x33), // call far 33h:0 — la porta, con RPL 3
    0x89, 0xe7, // mov edi, esp: lo stack dopo
    0xcd, 0x41, // int 41h: fine
  ]), RING3_AT);
  run(cpu);
  check('la porta porta all\'anello 0 con il parametro ricopiato', cpu.get32(EAX) === 0xabcd1234, hex(cpu.get32(EAX)));
  check('sullo stack del TSS, sotto lo stack di prima e il parametro',
    cpu.get32(EDX) === 0x6000 - 20 && cpu.get32(EBX) === 0x10 &&
      cpu.get32(ECX) === cpu.get32(ESI) - 4 && cpu.get32(EBP) === 0x23,
    `${hex(cpu.get32(EDX))} ${hex(cpu.get32(EBX), 4)} ${hex(cpu.get32(ECX))} ${hex(cpu.get32(EBP), 4)}`);
  check('e RETF 4 torna all\'anello 3 con lo stack com\'era prima del parametro',
    cpu.get32(EDI) === cpu.get32(ESI), `${hex(cpu.get32(EDI))} contro ${hex(cpu.get32(ESI))}`);
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


// ============================================================ la scheda madre

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Pentium, CPU_CLOCK, RAM_SIZE } from '../src/systems/pentium/machine.js';
import { PCIFunction, VENDOR_ID, DEVICE_ID, SUBSYSTEM_VENDOR, SUBSYSTEM_ID } from '../src/systems/pentium/pci.js';
import { PAM0 } from '../src/systems/pentium/i440fx.js';
import { CMOS } from '../src/systems/pentium/cmos.js';
import { KBC8042 } from '../src/systems/pentium/kbc.js';
import { FirmwareConfig, FWCFG_SELECTOR, FWCFG_DATA } from '../src/systems/pentium/fwcfg.js';
import { VGA } from '../src/systems/pentium/vga.js';
import { BIOS_SPEC, VIDEO_SPEC, isSystemBIOS, isOptionROM } from '../src/systems/pentium/roms.js';
import { IDE, IDEChannel, PRIMARY, SECONDARY } from '../src/systems/pentium/ide.js';
import { HardDisk } from '../src/systems/pc/ata.js';
import { bootPentium, installedDisk, Session, have, ROMS } from './pentiumsession.mjs';
import { setLayout } from '../src/systems/pc/layouts.js';
import { existsSync as fileExists } from 'node:fs';
import { build386 } from '../src/systems/pc386/index.js';
import { BIOS_SPEC as PC386_BIOS, VIDEO_SPEC as PC386_VIDEO } from '../src/systems/pc386/roms.js';
import { SCANCODES, scanBytes } from '../src/systems/pc/scancodes.js';

const romPath = (spec) => join(ROMS, spec.file);

/** Una macchina spenta con dentro un BIOS finto, per provare i chip. */
function mainboard() {
  // Sedici byte di BIOS finto che cominciano con un salto lontano, come tutti.
  const bios = new Uint8Array(65536).fill(0x90);
  bios[bios.length - 16] = 0xea;
  bios[0] = 0x42; // un byte riconoscibile in testa all'immagine
  return new Pentium(bios, { ram: 8 * 1024 * 1024 });
}

/** Legge una parola dallo spazio di configurazione come lo fa un firmware. */
function pciWord(pc, device, fn, register) {
  const address = (0x80000000 | (device << 11) | (fn << 8) | (register & 0xfc)) >>> 0;
  for (let i = 0; i < 4; i++) pc.outb(0xcf8 + i, (address >>> (i * 8)) & 0xff);
  const port = 0xcfc + (register & 2);
  return pc.inb(port) | (pc.inb(port + 1) << 8);
}

function pciWriteByte(pc, device, fn, register, value) {
  const address = (0x80000000 | (device << 11) | (fn << 8) | (register & 0xfc)) >>> 0;
  for (let i = 0; i < 4; i++) pc.outb(0xcf8 + i, (address >>> (i * 8)) & 0xff);
  pc.outb(0xcfc + (register & 3), value);
}

section('Il bus PCI');

{
  const pc = mainboard();
  check('il ponte nord dice chi è', pciWord(pc, 0, 0, VENDOR_ID) === 0x8086 && pciWord(pc, 0, 0, DEVICE_ID) === 0x1237,
    hex(pciWord(pc, 0, 0, DEVICE_ID), 4));
  // I due numeri di sottosistema sono quelli con cui il firmware libero capisce
  // di essere su una macchina emulata: senza, non va nemmeno a cercare la misura
  // della memoria dove questa macchina l'ha scritta.
  check('e che è una macchina emulata, non una scheda madre vera',
    pciWord(pc, 0, 0, SUBSYSTEM_VENDOR) === 0x1af4 && pciWord(pc, 0, 0, SUBSYSTEM_ID) === 0x1100);
  check('il ponte sud è un PIIX3 con due funzioni',
    pciWord(pc, 1, 0, DEVICE_ID) === 0x7000 && pciWord(pc, 1, 1, DEVICE_ID) === 0x7010,
    hex(pciWord(pc, 1, 1, DEVICE_ID), 4));
  check('uno slot vuoto risponde «qui non c\'è nessuno»', pciWord(pc, 4, 0, VENDOR_ID) === 0xffff);

  // Metà di quei byte sono di sola lettura, e il firmware ci conta: è così che
  // riconosce una scheda invece di configurarla a caso.
  pciWriteByte(pc, 0, 0, VENDOR_ID, 0x55);
  check('chi la scheda è non si lascia riscrivere', pciWord(pc, 0, 0, VENDOR_ID) === 0x8086);

  // Una finestra di indirizzi dichiara la propria misura lasciandosi scrivere
  // solo i bit alti: il firmware scrive tutti uno e legge quanti gliene tornano.
  const card = new PCIFunction({ vendor: 0x1234, device: 0x5678, name: 'prova' });
  card.addBAR(0, 4096);
  for (let i = 0; i < 4; i++) card.write(0x10 + i, 0xff);
  check('e una finestra dice quanto è grande rifiutando i bit bassi',
    card.read32(0x10) === 0xfffff000, hex(card.read32(0x10)));
}

section('La memoria alta, e chi risponde');

{
  const pc = mainboard();
  // All'accensione la ROM risponde a tutta la memoria alta e la RAM che c'è
  // sotto non la vede nessuno: è per questo che il firmware si trova a girare
  // dalla ROM, che è lenta.
  const fromROM = pc.read8(0xf0000);
  pc.write8(0xf0000, 0x11);
  check('dove risponde la ROM una scrittura non fa niente', pc.read8(0xf0000) === fromROM, hex(pc.read8(0xf0000), 2));
  check('e la stessa ROM si affaccia anche in cima ai quattro giga',
    pc.read8(0xfffff0000 % 0x100000000) === fromROM || pc.read8(0xffff0000) === fromROM);

  // I PAM: mezzo byte per ogni pezzo da sedici KB, e due bit che contano.
  pciWriteByte(pc, 0, 0, PAM0, 0x30);
  pc.write8(0xf0000, 0x11);
  check('con il PAM aperto in lettura e scrittura la RAM prende il posto della ROM',
    pc.read8(0xf0000) === 0x11 && pc.ram[0xf0000] === 0x11);
  // E la ROM resta dove il processore l'ha letta all'accensione: è da lì che il
  // firmware rilegge sé stesso mentre si copia in memoria, perché la finestra in
  // fondo al mega è già diventata RAM vuota.
  check('mentre in cima ai quattro giga c\'è ancora la ROM',
    pc.read8(0x100000000 - 65536) === 0x42, hex(pc.read8(0x100000000 - 65536), 2));

  pciWriteByte(pc, 0, 0, PAM0, 0x00);
  check('e richiudendo il PAM torna la ROM', pc.read8(0xf0000) === fromROM);
}

section('Il ventunesimo bit');

{
  const pc = mainboard();
  pc.ram[0x000010] = 0xaa;
  pc.ram[0x100010] = 0xbb;
  check('col cancello aperto un mega più in là c\'è un altro byte', pc.read8(0x100010) === 0xbb);
  // Il comando D1h del controllore di tastiera, che è il modo in cui ogni
  // sistema operativo protetto degli anni Ottanta apriva la memoria.
  pc.outb(0x64, 0xd1);
  pc.outb(0x60, 0x00);
  check('il controllore di tastiera lo chiude', pc.a20 === false);
  check('e allora un mega più in là si riavvolge, come sull\'8086', pc.read8(0x100010) === 0xaa);
  pc.outb(0x92, 0x02);
  check('la porta 92h lo riapre, che è il modo veloce', pc.a20 === true && pc.read8(0x100010) === 0xbb);
}

section('L\'orologio che non si spegne');

{
  const cmos = new CMOS({ ram: 32 * 1024 * 1024, now: () => new Date(1995, 7, 24, 9, 30, 15) });
  const read = (at) => {
    cmos.write(0x70, at);
    return cmos.read(0x71);
  };
  // La memoria è raccontata in tre pezzi, e il terzo — quello sopra i sedici
  // mega — si conta in blocchi da 64 KB: è l'unico posto in cui il firmware la
  // va a cercare, e sbagliarlo vuol dire una macchina con un mega di RAM.
  check('i 640 KB in fondo', ((read(0x16) << 8) | read(0x15)) === 640);
  check('i quindici mega dopo il primo', ((read(0x18) << 8) | read(0x17)) === 15 * 1024);
  check('e i sedici che restano, in blocchi da 64 KB',
    (((read(0x35) << 8) | read(0x34)) * 64) / 1024 === 16, `${((read(0x35) << 8) | read(0x34)) * 64 / 1024} MB`);

  check('l\'ora è quella del computer che sta emulando', read(0x04) === 9 && read(0x00) === 15);
  // In decimale codificato in binario, che è come nascono gli orologi: si spegne
  // il bit e le cifre tornano a mezzo byte per volta.
  cmos.bytes[0x0b] &= ~0x04;
  check('e in decimale codificato in binario se glielo si chiede', read(0x04) === 0x09 && read(0x08) === 0x08);
  check('il bit «sto aggiornando» resta spento, perché l\'ora non si fa a metà',
    (read(0x0a) & 0x80) === 0);
}

section('Le due catene di interruzioni');

{
  const pc = mainboard();
  // Come le programma un BIOS: il primo chip con i vettori da 8, il secondo da
  // 70h, e la riga 2 del primo che è il filo su cui arriva il secondo.
  pc.outb(0x20, 0x11);
  pc.outb(0x21, 0x08);
  pc.outb(0x21, 0x04);
  pc.outb(0x21, 0x01);
  pc.outb(0xa0, 0x11);
  pc.outb(0xa1, 0x70);
  pc.outb(0xa1, 0x02);
  pc.outb(0xa1, 0x01);
  pc.outb(0x21, 0x00);
  pc.outb(0xa1, 0x00);

  pc.pics.pulse(0);
  check('la riga 0 diventa il vettore 8, come nel 1981', pc.pics.acknowledge() === 8);
  pc.pics.master.write(0x20, 0x20);

  // Una interruzione alta arriva raccontata due volte: il secondo chip la passa
  // al primo, e il vettore lo dà il secondo.
  pc.pics.pulse(12);
  const vector = pc.pics.acknowledge();
  check('la riga 12 passa dal secondo chip e diventa 74h', vector === 0x74, hex(vector, 2));
  check('e resta in servizio su tutti e due finché non si chiudono',
    pc.pics.master.isr === 0x04 && pc.pics.slave.isr === 0x10);
  pc.pics.slave.write(0xa0, 0x20);
  pc.pics.master.write(0x20, 0x20);
  check('dopo i due EOI la catena è libera', pc.pics.master.isr === 0 && pc.pics.slave.isr === 0);

  pc.pics.master.write(0x21, 0xff);
  pc.pics.pulse(0);
  check('e una riga mascherata non arriva', pc.pics.acknowledge() === -1);
  pc.pics.master.write(0x21, 0x00);

  // E l'orologio: il contatore 0 programmato come lo programma ogni BIOS — onda
  // quadra, divisore 65536 — batte 18,2 volte al secondo perché 1.193.182 diviso
  // 65.536 fa 18,2. Quel numero storto è il motivo per cui l'orologio del DOS
  // perdeva un secondo ogni tanto, e ogni sistema operativo del PC lo dà per
  // scontato.
  let ticks = 0;
  pc.pit.hooks.onChannel0 = () => ticks++;
  pc.outb(0x43, 0x36);
  pc.outb(0x40, 0x00);
  pc.outb(0x40, 0x00);
  const from = pc.cycles;
  while (pc.cycles - from < CPU_CLOCK) {
    pc.cycles += 1000;
    pc.catchUp();
  }
  check('il contatore 0 batte 18,2 volte al secondo', Math.abs(ticks - 18.2) < 1, `${ticks} tic`);
}

section('Il canale di configurazione');

{
  const config = new FirmwareConfig({ ram: 64 * 1024 * 1024 });
  const select = (key) => {
    config.write(FWCFG_SELECTOR, key & 0xff);
    config.write(FWCFG_SELECTOR + 1, (key >> 8) & 0xff);
  };
  const bytes = (count) => Array.from({ length: count }, () => config.read(FWCFG_DATA));

  select(0x0000);
  check('la parola d\'ordine è QEMU', String.fromCharCode(...bytes(4)) === 'QEMU');
  select(0x0005);
  check('e dice quanti processori ci sono', bytes(2)[0] === 1);

  const rom = Uint8Array.from([0x55, 0xaa, 2, 0xcb]);
  const key = config.addFile('vgaroms/prova.bin', rom);
  select(0x0019);
  const dir = bytes(4 + 64);
  // L'elenco dei file è l'unica voce scritta nell'ordine della rete, e sbagliarlo
  // vuol dire un firmware che cerca un file lungo quattro miliardi di byte.
  check('l\'elenco dei file dice quanti sono, nell\'ordine della rete', dir[3] === 1, dir.slice(0, 4).join(' '));
  check('con la misura del file', ((dir[4] << 24) | (dir[5] << 16) | (dir[6] << 8) | dir[7]) === rom.length);
  check('la chiave con cui chiederlo', ((dir[8] << 8) | dir[9]) === key);
  check('e il nome, che è quello che dice al firmware cosa farne',
    String.fromCharCode(...dir.slice(12, 12 + 18)) === 'vgaroms/prova.bin\0');

  select(key);
  check('e il file si legge dalla stessa porta', bytes(4).join(',') === [...rom].join(','));
}

section('La scheda video');

{
  const vga = new VGA(CPU_CLOCK);
  // Il modo testo come lo lascia il BIOS della scheda: 80 colonne, caratteri
  // alti sedici righi, la finestra a B8000 e i piani a coppie pari/dispari.
  vga.writePort(0x3c2, 0x67);
  vga.writePort(0x3c4, 1);
  vga.writePort(0x3c5, 0x00);
  vga.writePort(0x3c4, 2);
  vga.writePort(0x3c5, 0x03);
  vga.writePort(0x3c4, 4);
  vga.writePort(0x3c5, 0x03);
  vga.writePort(0x3ce, 6);
  vga.writePort(0x3cf, 0x0e);
  vga.writePort(0x3d4, 1);
  vga.writePort(0x3d5, 79);
  vga.writePort(0x3d4, 9);
  vga.writePort(0x3d5, 15);
  vga.writePort(0x3d4, 18);
  vga.writePort(0x3d5, 399 & 0xff);
  vga.writePort(0x3d4, 19);
  vga.writePort(0x3d5, 40);
  vga.writePort(0x3d4, 7);
  vga.writePort(0x3d5, 0x1f);

  // «CIAO» scritto come lo scrive un programma: carattere e attributo alternati
  // nella finestra a B8000, che è dove il DOS ha scritto per vent'anni.
  const text = 'CIAO';
  for (let i = 0; i < text.length; i++) {
    vga.write(0x18000 + i * 2, text.charCodeAt(i));
    vga.write(0x18000 + i * 2 + 1, 0x07);
  }
  check('80 colonne per 25 righe', vga.columns === 80 && vga.rows === 25, `${vga.columns}x${vga.rows}`);
  check('il carattere va nel primo piano e l\'attributo nel secondo',
    vga.memory[0] === 67 && vga.memory[64 * 1024] === 0x07);
  check('e lo schermo riletto come testo dice quello che c\'è scritto',
    vga.text()[0].startsWith('CIAO'), vga.text()[0].slice(0, 10));
  check('rileggere quei byte dà indietro gli stessi', vga.read(0x18000) === 67 && vga.read(0x18001) === 0x07);

  // La maschera dei piani: chiudere un piano vuol dire che quella scrittura non
  // arriva, ed è il modo in cui si scrive il disegno delle lettere senza toccare
  // i caratteri.
  vga.writePort(0x3c4, 2);
  vga.writePort(0x3c5, 0x00);
  vga.write(0x18000, 0x5a);
  check('un piano chiuso non si lascia scrivere', vga.memory[0] === 67);

  // E la grafica: il modo di scrittura 2 prende i quattro bit bassi come colore
  // e li spalma sui punti che la maschera lascia passare. È così che si disegna
  // una linea su una scheda a piani.
  const planar = new VGA(CPU_CLOCK);
  planar.writePort(0x3c4, 2);
  planar.writePort(0x3c5, 0x0f);
  planar.writePort(0x3c4, 4);
  planar.writePort(0x3c5, 0x06);
  planar.writePort(0x3ce, 6);
  planar.writePort(0x3cf, 0x05);
  planar.writePort(0x3ce, 5);
  planar.writePort(0x3cf, 0x02);
  planar.writePort(0x3ce, 8);
  planar.writePort(0x3cf, 0x80); // solo il punto più a sinistra
  planar.write(0x0000, 0x09); // colore 9: piani 0 e 3
  check('in grafica un punto solo si accende sui piani del suo colore',
    planar.memory[0] === 0x80 && planar.memory[3 * 64 * 1024] === 0x80 && planar.memory[64 * 1024] === 0,
    hex(planar.memory[0], 2));
}

section('Il disco IDE');

{
  // Un disco piccolo e riconoscibile: ogni settore è pieno di una figura che
  // dipende dal suo numero, e non si ripete. Serve a sapere non solo che i byte
  // arrivano, ma che arrivano *quelli giusti e nell'ordine giusto* — che è dove
  // si nascondono gli errori da un settore intero di scarto.
  const image = new Uint8Array(64 * 512);
  for (let lba = 0; lba < 64; lba++) {
    for (let i = 0; i < 512; i++) image[lba * 512 + i] = (lba * 31 + i * 7) & 0xff;
  }
  const disk = new HardDisk(image, { cylinders: 4, heads: 2, sectors: 8 });
  let interrupts = 0;
  const channel = new IDEChannel(PRIMARY, (active) => {
    if (active) interrupts++;
  });
  channel.attach(0, disk);

  /** Il registro delle testine, che è anche quello che sceglie il disco. */
  const REG_DRIVE = 6;
  const put = (register, value) => channel.write(PRIMARY.command + register, value);
  const get = (register) => channel.read(PRIMARY.command + register);
  const status = () => channel.status;
  /** Un settore preso dalla porta dei dati, a parole di sedici bit. */
  const sector = () => {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < 256; i++) {
      const word = channel.readData(2);
      bytes[i * 2] = word & 0xff;
      bytes[i * 2 + 1] = (word >> 8) & 0xff;
    }
    return bytes;
  };
  const onDisk = (lba) => image.subarray(lba * 512, (lba + 1) * 512);
  const same = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
  /** L'indirizzo detto in numeri: il bit 6 dice «questo non è una geometria». */
  const seek = (lba, count = 1) => {
    put(REG_DRIVE, 0xe0 | ((lba >>> 24) & 0x0f));
    put(2, count);
    put(3, lba & 0xff);
    put(4, (lba >>> 8) & 0xff);
    put(5, (lba >>> 16) & 0xff);
  };

  // Il secondo posto del cavo, dove non c'è niente. Un disco che non c'è non
  // risponde *zero* per sbaglio: risponde zero apposta, ed è così che il
  // firmware conta i dischi senza sapere quanti sono.
  put(REG_DRIVE, 0xf0);
  check('un posto vuoto del cavo non risponde', get(7) === 0 && get(1) === 0xff);
  put(REG_DRIVE, 0xe0);

  interrupts = 0;
  put(7, 0xec); // IDENTIFY DEVICE
  check('il disco si presenta quando glielo si chiede', (status() & 0x08) !== 0);
  const identity = new Uint16Array(sector().buffer);
  check('e dice quanti settori ha davvero, contati dall\'inizio',
    identity[60] + identity[61] * 65536 === 64, `${identity[60]}`);
  const text = (index, length) => {
    let out = '';
    for (let i = 0; i < length / 2; i++) {
      out += String.fromCharCode(identity[index + i] >> 8, identity[index + i] & 0xff);
    }
    return out.trim();
  };
  // Le stringhe dell'ATA sono scritte a parole rovesciate, e lo sono per una
  // ragione che nel 1986 sembrava buona: il disco è big-endian, il PC no, e
  // nessuno ha voluto cedere. Da allora ogni driver del mondo le rigira.
  check('con il suo nome, scritto a parole rovesciate come vuole l\'ATA',
    text(27, 40).startsWith('alloldos IDE'), text(27, 40));
  check('e la geometria che racconta',
    identity[1] === 4 && identity[3] === 2 && identity[6] === 8);
  check('presentandosi ha alzato il filo una volta sola', interrupts === 1 && channel.irq === true);
  get(7);
  check('e leggere lo stato vuol dire «ho visto»', channel.irq === false);

  interrupts = 0;
  seek(10);
  put(7, 0x20); // READ SECTORS
  check('un settore chiesto per numero è quello che c\'è sul disco', same(sector(), onDisk(10)));
  check('e il comando finito è un\'altra interruzione', interrupts === 1);
  get(7);

  // Lo stesso settore detto nell'altra lingua. Con otto settori per traccia e
  // due testine, il numero 10 è il terzo settore della seconda testina del
  // cilindro zero — e deve uscire lo stesso identico mezzo kilobyte.
  put(REG_DRIVE, 0xa0 | 1);
  put(2, 1);
  put(3, 3); // i settori si contano da uno: è l'ultimo residuo del 1981
  put(4, 0);
  put(5, 0);
  put(7, 0x20);
  check('e lo stesso settore detto in cilindri, testine e settori è lo stesso',
    same(sector(), onDisk(10)));
  get(7);

  const written = disk.writes;
  const payload = new Uint8Array(512).map((_, i) => (200 - i * 3) & 0xff);
  seek(20);
  put(7, 0x30); // WRITE SECTORS
  check('in scrittura il disco chiede i byte prima di dire qualunque cosa',
    (status() & 0x08) !== 0 && channel.irq === false);
  for (let i = 0; i < 256; i++) {
    channel.writeData(payload[i * 2] | (payload[i * 2 + 1] << 8), 2);
  }
  check('e quando li ha presi tutti li mette sui piatti',
    same(disk.data.subarray(20 * 512, 21 * 512), payload) && disk.writes === written + 1);
  get(7);

  interrupts = 0;
  seek(0, 2);
  put(7, 0x20);
  const first = sector();
  check('chiesti due settori, il secondo arriva dietro al primo senza altri comandi',
    same(first, onDisk(0)) && (status() & 0x08) !== 0 && get(2) === 1);
  check('e il secondo è il secondo', same(sector(), onDisk(1)));
  check('poi il disco smette di chiedere', (status() & 0x08) === 0);
  get(7);

  seek(64); // un settore oltre la fine
  put(7, 0x20);
  check('un settore che non c\'è è un errore, non mezzo kilobyte di zeri',
    (get(7) & 0x01) !== 0 && (get(1) & 0x10) !== 0);

  put(7, 0xa1); // IDENTIFY PACKET DEVICE
  check('e alla domanda «sei un lettore di CD?» un disco risponde rifiutando',
    (get(7) & 0x01) !== 0 && (get(1) & 0x04) !== 0);

  channel.write(PRIMARY.control, 0x04); // il reset del canale, che si tira a mano
  channel.write(PRIMARY.control, 0x00);
  check('dopo un reset il disco si presenta con la firma di un disco',
    get(2) === 1 && get(3) === 1 && get(4) === 0 && get(5) === 0);

  channel.write(PRIMARY.control, 0x02); // il bit che zittisce le interruzioni
  interrupts = 0;
  seek(1);
  put(7, 0x20);
  check('e col bit che le zittisce lavora senza alzare il filo',
    interrupts === 0 && (status() & 0x08) !== 0 && same(sector(), onDisk(1)));
}

{
  const both = new IDE(() => {});
  check('i due canali stanno alle porte di sempre, dal 1986',
    both.channelFor(0x1f0) === both.channels[0] &&
      both.channelFor(0x3f6) === both.channels[0] &&
      both.channelFor(0x170) === both.channels[1] &&
      both.channelFor(0x376) === both.channels[1]);
  check('e l\'unica porta larga più di un byte è quella dei dati',
    both.isData(PRIMARY.command) && both.isData(SECONDARY.command) && !both.isData(0x1f1));
}

section('Il lettore di dischetti, e il byte che lo descrive');

{
  // Il firmware non guarda che dischetto c'è: guarda com'è configurata la
  // macchina. Se il setup dice «lettore da 1,44» e dentro c'è un 720 KB, il
  // settore di avvio si legge e il resto no.
  const pc = mainboard();
  check('a macchina vuota il setup non dichiara nessun lettore',
    pc.cmos.bytes[0x10] === 0x00 && (pc.cmos.bytes[0x14] & 0x01) === 0);

  // La porta 3F7h se la dividono in due: il bit 7 è del lettore di dischetti e
  // dice che il dischetto è stato cambiato, gli altri sette sono del disco
  // fisso. Due schede diverse sullo stesso byte, perché gli indirizzi finiscono.
  check('e sulla porta che i due si dividono, il lettore vuoto lo dice',
    (pc.inb(0x3f7) & 0x80) !== 0);

  check('messo dentro un dischetto, il setup dichiara il lettore che gli serve',
    pc.insertFloppy(new Uint8Array(737280)) && pc.cmos.bytes[0x10] === 0x30);
  check('e il byte dell\'equipaggiamento conta un lettore e uno schermo VGA',
    (pc.cmos.bytes[0x14] & 0x01) !== 0 && (pc.cmos.bytes[0x14] & 0x30) === 0x00);
  // Il bit 7 è un filo che si alza quando lo sportello si apre e si abbassa
  // solo quando la testina fa un passo con un dischetto dentro: dice «qualcuno
  // ha messo le mani nel lettore», non «c'è qualcosa». Il caso che conta è
  // l'ultimo, un dischetto cambiato con un altro senza passare dal vuoto: è
  // quello che fa chi installa da sei dischetti, e se il filo restasse basso il
  // DOS continuerebbe a leggere la FAT del primo e a chiedere il secondo.
  check('appena inserito il filo del cambio disco è alzato',
    (pc.inb(0x3f7) & 0x80) !== 0);
  pc.outb(0x3f2, 0x1c); // motore di A, DMA, e il chip fuori dal reset
  pc.outb(0x3f5, 0x07); // recalibrate
  pc.outb(0x3f5, 0x00); // del lettore 0
  check('e una ricalibrazione, che muove la testina, lo abbassa',
    (pc.inb(0x3f7) & 0x80) === 0);
  pc.insertFloppy(new Uint8Array(737280).fill(1));
  check('cambiare dischetto senza passare dal vuoto lo rialza',
    (pc.inb(0x3f7) & 0x80) !== 0);
}

if (!have.bios) {
  console.log(`
Nessun SeaBIOS in roms/pentium: la prova di accensione è stata saltata.
\`npm run fetch-roms\` se lo prende da QEMU, se è installato (apt install seabios).`);
} else {
  section('Accensione vera: SeaBIOS sulla scheda madre');

  // Qui non c'è niente di finto: questo è il firmware che accende ogni macchina
  // virtuale di QEMU, e di questo emulatore non sa niente. Se arriva in fondo al
  // POST, la scheda madre è quella che si aspettava — il PCI risponde, i PAM
  // fanno la loro parte, l'orologio ha la memoria scritta dove va, e la sua ROM
  // video gira.
  const bios = new Uint8Array(readFileSync(romPath(BIOS_SPEC)));
  check('il BIOS è un\'immagine di firmware di sistema', isSystemBIOS(bios), `${bios.length} byte`);
  const videoROMs = [];
  if (have.video) {
    const video = new Uint8Array(readFileSync(romPath(VIDEO_SPEC)));
    check('e la ROM della scheda video è una ROM di espansione', isOptionROM(video), `${video.length} byte`);
    videoROMs.push({ name: VIDEO_SPEC.file, bytes: video });
  }

  const pc = new Pentium(bios, { videoROMs });
  let interrupts = 0;
  const rawInterrupt = pc.cpu.interrupt.bind(pc.cpu);
  pc.cpu.interrupt = (vector, options) => {
    if (vector === 8) interrupts++;
    return rawInterrupt(vector, options);
  };

  // Si va avanti finché il firmware non si presenta a schermo, che è la fine del
  // POST: da lì in poi aspetta un tasto per un paio di secondi e poi prova ad
  // avviare qualcosa.
  const screen = () => pc.video.text().join('\n');
  let posted = false;
  for (let i = 0; i < 600 && !posted; i++) {
    pc.runCycles(1_000_000);
    posted = /SeaBIOS \(version/.test(screen()) || /No bootable/.test(screen());
  }

  let reached = false;
  for (let i = 0; i < 400 && !reached; i++) {
    pc.runCycles(1_000_000);
    reached = /Booting from/.test(screen());
  }

  check('il firmware si racconta dalla porta di servizio', /SeaBIOS \(version/.test(pc.log), pc.log.split('\n')[0]);
  check('ed è passato per il modo protetto', pc.everProtected === true);
  // Il BIOS si è copiato in memoria e gira da lì: è il mestiere dei PAM, e si
  // vede da due cose — che la RAM sotto la finestra adesso contiene la ROM, e che
  // le letture vengono da lì.
  check('si è copiato in RAM e gira da lì',
    pc.ram[0xfff00] === bios[bios.length - 256] && pc.shadow[15].read === true);
  check('e ha richiuso la porta dietro di sé, perché nessuno ci scriva sopra',
    pc.shadow[15].write === false);

  if (have.video) {
    check('la ROM della scheda video è arrivata dal canale di configurazione e ha girato',
      /SeaVGABIOS/.test(pc.log), pc.log.split('\n').find((line) => /SeaVGABIOS/.test(line)) ?? '');
    check('la scheda è nel modo testo che il DOS si aspetta, 80 per 25',
      pc.video.columns === 80 && pc.video.rows === 25 && !pc.video.graphicsMode,
      `${pc.video.columns}x${pc.video.rows}`);
    check('e sullo schermo c\'è scritto chi ha acceso la macchina',
      /SeaBIOS \(version/.test(screen()), screen().split('\n')[0].trim());
    check('poi prova ad avviare qualcosa, che è dove finisce il POST',
      reached, screen().split('\n').find((line) => /Booting/.test(line))?.trim() ?? 'niente');
  }

  check('e le interruzioni dell\'orologio sono arrivate al processore',
    interrupts > 0, `${interrupts} tic`);
}

if (!have.bios || !have.video || !have.disk) {
  console.log(`
Manca qualcosa fra il BIOS, la sua ROM video e il disco: la prova di avvio del
DOS sul Pentium è stata saltata. \`npm run fetch-roms\` prende le prime due.`);
} else {
  section('Avvio vero: FreeDOS dal disco fisso');

  // Il giro intero, e la sola prova che conta davvero: un firmware che non sa
  // niente di questo emulatore legge un settore da un disco IDE, ci salta
  // dentro, e da lì in poi guida un sistema operativo che non sa niente
  // nemmeno lui. E il disco è **lo stesso file** che il 286 di qui accanto
  // avvia dalla sua scheda XT-CF, letto a sedici bit da un controllore diverso
  // su porte diverse: che si accenda su tutte e due le macchine non è un caso,
  // è quello che vuol dire che un disco è un disco.
  const pc = bootPentium();
  const dos = new Session(pc, (text) => console.log(text));

  check('SeaBIOS trova il disco e ci salta dentro',
    dos.waitFor(/Booting from Hard Disk/, 400), dos.lastLine());
  check('il kernel di FreeDOS si presenta', dos.waitFor(/FreeDOS kernel/, 400), dos.lastLine());
  check('poi la riga del prompt, che è dove finisce un avvio',
    dos.waitFor(/C:\\>/, 400), dos.lastLine());
  // Il kernel racconta il disco che ha trovato leggendo la tabella delle
  // partizioni: la stessa che ci ha scritto FDISK girando sul 286.
  check('e ha trovato la partizione che c\'è sul disco', /size=\s*20 MB/.test(dos.screen()));

  dos.command('dir c:\\');
  check('il DOS legge la radice del disco', /COMMAND\s+COM/.test(dos.screen()), dos.lastLine());

  // La tastiera è passata di qui: la riga di sopra non l'ha scritta nessuno a
  // mano nella memoria del BIOS, è arrivata dall'8042 un codice per volta, con
  // la sua interruzione ogni volta.
  const written = pc.disks.master.writes;
  dos.command('echo ok>c:\\p.txt');
  dos.command('type c:\\p.txt');
  check('ci si scrive sopra, e si rilegge', /^ok$/m.test(dos.screen()), dos.lastLine());
  check('e la scrittura è arrivata ai piatti', pc.disks.master.writes > written);

  // Quella che vale per tutte: spegnere e riaccendere. Se il settore fosse
  // finito nel posto sbagliato il file sarebbe ancora nella memoria del DOS ma
  // non più sul disco, e riaccendendo sparirebbe.
  dos.reboot();
  check('e sopravvive a un riavvio', dos.waitFor(/C:\\>/, 600), dos.lastLine());
  dos.command('type c:\\p.txt');
  check('il file è ancora dov\'era', /^ok$/m.test(dos.screen()), dos.lastLine());
}

if (!have.bios || !have.video || !have.disk) {
  console.log(`
Manca qualcosa fra il BIOS, la sua ROM video e il disco: la prova della tastiera
italiana sul Pentium è stata saltata.`);
} else {
  section('Avvio vero: la tastiera italiana, sullo stesso disco');

  // La tastiera si sceglie sul disco, e il disco è lo stesso del 286: la stessa
  // riga nell'AUTOEXEC, lo stesso KEYB. Qui però il BIOS è un BIOS AT, e ha già
  // tutto quello che a KEYB serve — KB16 lo chiede, se ne accorge, e se ne va.
  const disk = installedDisk();
  setLayout(disk.data, 'it');
  const pc = bootPentium({ disk });
  const dos = new Session(pc, (text) => console.log(text));
  check('KEYB parte dall\'AUTOEXEC con la tastiera italiana',
    dos.waitFor(/KEYBOARD\.SYS:IT \[437\]/, 600), dos.lastLine());
  check('e la macchina arriva al prompt', dos.waitFor(/C:\\>/, 400), dos.lastLine());
  dos.run(30);

  const segment16 = pc.ram[0x5a] | (pc.ram[0x5b] << 8);
  check('KB16 non si è installato: SeaBIOS la funzione 5 ce l\'ha', segment16 === 0xf000, hex(segment16, 4));

  // I tasti per posizione, con i byte che la tastiera manda al controllore:
  // AltGr è l'Alt con il prefisso E0, e qui a leggerlo è il BIOS.
  const send = (code, released) => {
    for (const byte of scanBytes(code, released)) pc.kbc.fromKeyboard(byte);
    dos.run(2);
  };
  for (const key of [
    'BracketLeft', 'Semicolon', 'Quote', 'Backslash', 'ShiftLeft+BracketLeft',
    'Backquote', 'Minus', 'IntlBackslash',
    'AltRight+BracketLeft', 'AltRight+Semicolon', 'AltRight+Quote',
  ]) {
    const [modifier, name] = key.includes('+') ? key.split('+') : [null, key];
    if (modifier) send(SCANCODES[modifier], false);
    send(SCANCODES[name], false);
    send(SCANCODES[name], true);
    if (modifier) send(SCANCODES[modifier], true);
  }
  dos.run(10);

  const video = pc.video;
  const row = dos.screen().split('\n').length - 1;
  const cells = [];
  for (let column = 0; column < 80; column++) {
    cells.push(video.memory[(video.startAddress + row * video.rowUnits + column) & 0xffff]);
  }
  const typed = cells.slice(cells.indexOf(0x3e) + 2);
  const shown = (from, to) => typed.slice(from, to).map((byte) => hex(byte, 2)).join(' ');
  check('le lettere accentate escono dove sono disegnate', shown(0, 5) === '$8a $95 $85 $97 $82', shown(0, 5));
  check('e così la barra rovescia, l\'apostrofo e il minore', shown(5, 8) === '$5c $27 $3c', shown(5, 8));
  check('e con AltGr le quadre, la chiocciola e il cancelletto', shown(8, 11) === '$5b $40 $23', shown(8, 11));
}

if (!have.bios || !have.video || !have.floppy) {
  console.log(`
Nessun dischetto in roms/pc: la prova di avvio dal lettore è stata saltata.`);
} else {
  section('Avvio vero: FreeDOS dal dischetto');

  // L'altra strada, quella di sempre: niente disco fisso, un dischetto nel
  // lettore, e il firmware che prova prima quello. Qui il lavoro lo fa il NEC
  // 765 — lo stesso chip del 286, dentro il ponte sud invece che su una scheda —
  // e il DMA, che di questa macchina è il pezzo più vecchio che ci sia.
  const pc = bootPentium({ disk: null, floppy: true });
  const dos = new Session(pc, (text) => console.log(text));

  check('il firmware prova prima il lettore, com\'era l\'ordine di un PC',
    dos.waitFor(/Booting from Floppy/, 400), dos.lastLine());
  // Il kernel di FreeDOS sono quarantaseimila byte: novanta settori, che stanno
  // su cinque tracce e vogliono due cambi di testina. Che arrivi a leggersi il
  // CONFIG.SYS e a disegnarne il menu vuol dire che il 765 ha cercato, letto e
  // cambiato faccia al dischetto, e che il DMA ha portato ogni settore dove
  // andava.
  check('il dischetto parte e il kernel si carica per intero',
    dos.waitFor(/FreeDOS 1\.3 Floppy Edition/, 200), dos.lastLine());
  check('e gira, fino a chiedere in che lingua vogliamo che ci parli',
    /Select from Menu \[123456\]/.test(dos.screen()));
  // E il byte del setup diceva la verità: il dischetto è un 720 KB, e il
  // lettore dichiarato è quello che ci va. Se avesse dichiarato un 1,44 il
  // settore di avvio si sarebbe letto lo stesso — è il primo della prima
  // traccia, dove le due geometrie coincidono — e il resto del kernel no.
  check('perché il setup dichiarava il lettore che serviva a questo dischetto',
    pc.cmos.bytes[0x10] === 0x30, hex(pc.cmos.bytes[0x10], 2));

  // Di qui in avanti c'è il programma di installazione di FreeDOS, che ci mette
  // due minuti di macchina emulata a caricarsi per chiedere se vogliamo davvero
  // installare. Non aggiunge niente a quello che si è già visto: gli stessi
  // settori, dallo stesso lettore. Le prove si fermano qui.
}

const PC386_ROMS = join(ROMS, '..', 'pc386');
if (!fileExists(join(PC386_ROMS, PC386_BIOS.file)) || !fileExists(join(PC386_ROMS, PC386_VIDEO.file)) || !have.disk) {
  console.log(`
Nessun BIOS di Bochs in roms/pc386: la prova del 386 è stata saltata.
\`npm run fetch-roms\` lo prende dal repository di Bochs.`);
} else {
  section('Il 386, con il BIOS di Bochs');

  // La stessa scheda, un processore di sei anni prima e un altro firmware:
  // SeaBIOS su un 386 non parte, perché usa BSWAP senza chiedere. Il BIOS di
  // Bochs sì, ed è la prova che la variante 386 del processore regge un BIOS
  // intero e un sistema operativo — senza un solo opcode che il 386 non avesse.
  const pc = build386(new Uint8Array(readFileSync(join(PC386_ROMS, PC386_BIOS.file))), {
    video: new Uint8Array(readFileSync(join(PC386_ROMS, PC386_VIDEO.file))),
    disk: installedDisk(),
  });
  let invalid = 0;
  const deliver = pc.cpu.interrupt.bind(pc.cpu);
  pc.cpu.interrupt = (vector, options) => {
    if (vector === 6) invalid++;
    return deliver(vector, options);
  };
  const dos = new Session(pc, (text) => console.log(text));
  check('il BIOS di Bochs si presenta e trova il disco IDE', dos.waitFor(/ata0 master: .*20 MBytes/, 300), dos.lastLine());
  check('e FreeDOS arriva al prompt', dos.waitFor(/C:\\>/, 600), dos.lastLine());
  check('senza una sola istruzione che il 386 non avesse', invalid === 0, `${invalid} opcode non validi`);
  check('su un processore che dice di essere un 386', pc.cpu.model === 386 && pc.clock === 33000000);
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
