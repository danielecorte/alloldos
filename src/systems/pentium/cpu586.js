// Il Pentium, cioè la prima macchina di questa collezione che sa contare a
// trentadue bit.
//
// Fra il 286 di qui accanto e questo processore ci sono sette anni e due cose
// che cambiano tutto. La prima è la misura: i registri diventano lunghi
// trentadue bit, e con loro gli indirizzi — quattro miliardi di byte invece di
// un milione, e la fine del mestiere di dividere la memoria in segmenti da 64
// KB. La seconda è che il processore comincia a difendersi: c'è un modo
// protetto vero, con una tabella di descrittori che dice dove comincia e dove
// finisce ogni segmento e chi ha il diritto di toccarlo, e c'è la paginazione,
// che mette in mezzo fra l'indirizzo che il programma scrive e il byte che
// esiste davvero una traduzione fatta a tabelle. Da lì viene tutto quello che
// un sistema operativo moderno sa fare: la memoria virtuale, i processi che non
// si pestano, il file che si comporta come se fosse in memoria.
//
// Il Pentium però non butta niente. Si accende in **real mode**, che è l'8086
// del 1978: segmento per sedici più offset, nessun controllo, venti bit di
// indirizzo e la prima istruzione a F000:FFF0. Il primo lavoro del firmware è
// uscire da lì — caricare una tabella di descrittori, accendere il bit 0 di
// CR0, saltare in un segmento a trentadue bit — e questo processore deve saper
// fare tutti e tre i mondi: il real mode, il modo protetto, e il passaggio.
//
// Di suo, il Pentium aggiunge le istruzioni con cui il software lo riconosce e
// lo usa: CPUID, che al posto dei trucchi sui bit di FLAGS dice in chiaro che
// processore è; RDTSC, il contatore di cicli da cui verrà ogni misura di
// prestazioni dei trent'anni successivi; CMPXCHG e XADD, che sono i mattoni con
// cui si fanno i lucchetti fra due processori. La virgola mobile, che qui è per
// la prima volta dentro il processore invece che in un chip a parte, non c'è
// ancora: è il pezzo dopo.

/* eslint-disable no-bitwise */

/** Gli otto registri, nell'ordine in cui li numera la codifica mod-reg-r/m. */
export const EAX = 0;
export const ECX = 1;
export const EDX = 2;
export const EBX = 3;
export const ESP = 4;
export const EBP = 5;
export const ESI = 6;
export const EDI = 7;

/** I sei segmenti. FS e GS sono i due che il 386 ha aggiunto, senza un mestiere. */
export const ES = 0;
export const CS = 1;
export const SS = 2;
export const DS = 3;
export const FS = 4;
export const GS = 5;

/** I bit di CR0 che contano qui: il modo protetto, e la paginazione. */
export const CR0_PE = 0x00000001;
export const CR0_TS = 0x00000008;
export const CR0_WP = 0x00010000;
export const CR0_PG = 0x80000000;

/** I bit di CR4 che il Pentium ha e il 486 no. */
export const CR4_VME = 0x0001;
export const CR4_PSE = 0x0010; // pagine da quattro mega

/** Le eccezioni, con il numero che gli ha dato Intel. */
export const DIVIDE_ERROR = 0;
export const DEBUG_FAULT = 1;
export const BREAKPOINT = 3;
export const OVERFLOW_TRAP = 4;
export const BOUND_FAULT = 5;
export const INVALID_OPCODE = 6;
export const DEVICE_NOT_AVAILABLE = 7;
export const DOUBLE_FAULT = 8;
export const INVALID_TSS = 10;
export const SEGMENT_NOT_PRESENT = 11;
export const STACK_FAULT = 12;
export const GENERAL_PROTECTION = 13;
export const PAGE_FAULT = 14;

/**
 * Un'eccezione del processore, che è una cosa diversa da un errore
 * dell'emulatore: vuol dire che il programma ha fatto qualcosa che non si può
 * fare, e che il processore deve *raccontarglielo* saltando dentro il suo
 * gestore. Si alza come un'eccezione di JavaScript perché è esattamente quello
 * che fa: interrompe l'istruzione a metà, dovunque sia arrivata, e la fa
 * ricominciare da capo dopo — o mai più.
 */
export class Fault {
  /**
   * @param {number} vector il numero dell'eccezione
   * @param {?number} [code] il codice di errore, per quelle che ce l'hanno
   */
  constructor(vector, code = null) {
    this.vector = vector;
    this.code = code;
  }
}

/** Quello che l'emulatore non sa ancora fare, detto forte invece che sbagliato. */
export class Unsupported extends Error {}

/** La parità di un byte, che è l'unico flag che si conta e non si calcola. */
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let bits = 0;
  for (let bit = 0; bit < 8; bit++) bits += (i >> bit) & 1;
  PARITY[i] = bits & 1 ? 0 : 1;
}

/** La maschera di una misura: un byte, una parola, una parola doppia. */
const MASK = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
/** Dov'è il bit del segno, per ogni misura. */
const SIGN = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };

/** Un valore di quella misura, senza segno e senza sorprese. */
const trim = (size, value) => (size === 4 ? value >>> 0 : value & MASK[size]);
/** Lo stesso valore letto col segno, che serve per le divisioni e i salti. */
const signed = (size, value) => {
  if (size === 1) return (value << 24) >> 24;
  if (size === 2) return (value << 16) >> 16;
  return value | 0;
};

export class CPU586 {
  /**
   * @param {object} bus la scheda madre: memoria fisica e porte
   * @param {(addr:number)=>number} bus.read8
   * @param {(addr:number,value:number)=>void} bus.write8
   * @param {(port:number)=>number} bus.inb
   * @param {(port:number,value:number)=>void} bus.outb
   */
  constructor(bus) {
    this.bus = bus;
    /** Gli otto registri, a trentadue bit: EAX è r[0], e AX e AL ci stanno dentro. */
    this.r = new Uint32Array(8);
    /** I selettori dei sei segmenti, che in modo protetto non sono indirizzi. */
    this.s = new Uint16Array(6);
    /**
     * Quello che il processore si ricorda di ogni segmento dopo averne caricato
     * il descrittore. È il pezzo che rende il modo protetto veloce: la tabella
     * si legge una volta sola, al momento del caricamento, e da lì in poi base e
     * limite stanno dentro il processore. È anche il pezzo che ha permesso tutti
     * i trucchi degli anni Novanta — l'"unreal mode" è esattamente un limite
     * grande caricato in modo protetto e portato dietro in real mode.
     */
    this.seg = Array.from({ length: 6 }, () => descriptorCache());
    this.reset();
  }

  reset() {
    this.r.fill(0);
    this.s.fill(0);
    for (const cache of this.seg) Object.assign(cache, descriptorCache());

    // Il Pentium si accende in real mode a F000:FFF0, come l'8086 — ma con un
    // trucco che l'8086 non aveva: la base di CS non è 0xf0000 perché il
    // selettore vale f000h, è 0xffff0000 perché il processore la ci mette a
    // mano. Sono i dodici byte in cima al gigabyte di indirizzi, dove la scheda
    // madre affaccia la ROM, e servono perché il BIOS possa essere grande più
    // di 64 KB prima ancora di accendere il modo protetto.
    this.s[CS] = 0xf000;
    this.seg[CS].base = 0xffff0000;
    this.seg[CS].limit = 0xffff;
    this.eip = 0xfff0;
    for (const index of [ES, SS, DS, FS, GS]) {
      this.seg[index].base = 0;
      this.seg[index].limit = 0xffff;
    }

    this.cf = 0;
    this.pf = 0;
    this.af = 0;
    this.zf = 0;
    this.sf = 0;
    this.tf = 0;
    this.if_ = 0;
    this.df = 0;
    this.of = 0;
    this.iopl = 0;
    this.nt = 0;
    this.rf = 0;
    this.ac = 0;
    this.id = 0;

    this.cr0 = 0x60000010; // ET acceso, come si sveglia un Pentium
    this.cr2 = 0;
    this.cr3 = 0;
    this.cr4 = 0;
    this.dr = new Uint32Array(8);

    /** La tabella dei descrittori globale e quella locale: base e limite. */
    this.gdt = { base: 0, limit: 0xffff };
    this.idt = { base: 0, limit: 0xffff };
    this.ldt = { selector: 0, base: 0, limit: 0 };
    this.tr = { selector: 0, base: 0, limit: 0, busy: false };

    /** Il livello di privilegio attuale, che è quello del codice in esecuzione. */
    this.cpl = 0;

    this.halted = false;
    this.stiDelay = 0;
    this.instructions = 0;
    /**
     * Il contatore di cicli, che è il primo orologio che un programma abbia
     * potuto leggere da sé: RDTSC lo consegna in EDX:EAX. Da qui in poi ogni
     * misura di prestazioni del mondo passa da questo numero.
     */
    this.tsc = 0;
    this.tlb = new Map();

    this.resetPrefixes();
  }

  /** I prefissi valgono per un'istruzione sola, e si spengono a ogni giro. */
  resetPrefixes() {
    this.segmentOverride = -1;
    this.opsizePrefix = false; // 66h: l'altra misura, non "sedici bit"
    this.addrsizePrefix = false; // 67h: idem per gli indirizzi
    this.repeat = 0; // F2h o F3h
    this.lock = false;
  }

  // ------------------------------------------------------------ le tre misure

  /**
   * La misura di default degli operandi: sedici bit in real mode e nei segmenti
   * a sedici bit, trentadue nei segmenti col bit D acceso. Il prefisso 66h non
   * vuol dire "sedici bit": vuol dire *l'altra* — lo stesso byte che in real
   * mode fa lavorare a trentadue bit, in un segmento a trentadue bit fa
   * lavorare a sedici. È la ragione per cui lo stesso codice macchina si legge
   * in due modi diversi, e per cui chi sbaglia il bit D vede istruzioni che non
   * esistono.
   */
  get opsize() {
    const big = this.seg[CS].big;
    return (big ? !this.opsizePrefix : this.opsizePrefix) ? 4 : 2;
  }

  get addrsize() {
    const big = this.seg[CS].big;
    return (big ? !this.addrsizePrefix : this.addrsizePrefix) ? 4 : 2;
  }

  /** La misura con cui si impila: quella del segmento di stack, non di CS. */
  get stacksize() {
    return this.seg[SS].big ? 4 : 2;
  }

  get protectedMode() {
    return (this.cr0 & CR0_PE) !== 0;
  }

  // --------------------------------------------------------------- i registri

  get8(index) {
    const value = this.r[index & 3];
    return index & 4 ? (value >>> 8) & 0xff : value & 0xff;
  }

  set8(index, value) {
    const at = index & 3;
    if (index & 4) this.r[at] = (this.r[at] & 0xffff00ff) | ((value & 0xff) << 8);
    else this.r[at] = (this.r[at] & 0xffffff00) | (value & 0xff);
  }

  get16(index) {
    return this.r[index] & 0xffff;
  }

  /**
   * Scrivere in AX non tocca la metà alta di EAX, e scrivere in EAX la azzera:
   * è la regola che tiene in piedi la compatibilità, perché un programma del
   * 1985 lavora dentro i sedici bit bassi di registri che non sa di avere.
   */
  set16(index, value) {
    this.r[index] = (this.r[index] & 0xffff0000) | (value & 0xffff);
  }

  get32(index) {
    return this.r[index] >>> 0;
  }

  set32(index, value) {
    this.r[index] = value >>> 0;
  }

  get(size, index) {
    if (size === 1) return this.get8(index);
    return size === 2 ? this.get16(index) : this.get32(index);
  }

  set(size, index, value) {
    if (size === 1) this.set8(index, value);
    else if (size === 2) this.set16(index, value);
    else this.set32(index, value);
  }

  // ------------------------------------------------------------------ i flag

  /**
   * EFLAGS come lo vede il software. Il bit 1 è sempre acceso e il bit 15
   * sempre spento: sono le due firme che non sono mai cambiate. Sopra ci sono i
   * bit nuovi — il livello di privilegio delle porte, il modo virtuale 8086, il
   * controllo degli allineamenti — e in cima il bit con cui si scopre se CPUID
   * c'è: se si riesce a cambiarlo, c'è.
   */
  get eflags() {
    return (
      (0x0002 |
        this.cf |
        (this.pf << 2) |
        (this.af << 4) |
        (this.zf << 6) |
        (this.sf << 7) |
        (this.tf << 8) |
        (this.if_ << 9) |
        (this.df << 10) |
        (this.of << 11) |
        (this.iopl << 12) |
        (this.nt << 14) |
        (this.rf << 16) |
        (this.ac << 18) |
        (this.id << 21)) >>>
      0
    );
  }

  set eflags(value) {
    this.cf = value & 1;
    this.pf = (value >> 2) & 1;
    this.af = (value >> 4) & 1;
    this.zf = (value >> 6) & 1;
    this.sf = (value >> 7) & 1;
    this.tf = (value >> 8) & 1;
    this.if_ = (value >> 9) & 1;
    this.df = (value >> 10) & 1;
    this.of = (value >> 11) & 1;
    this.iopl = (value >> 12) & 3;
    this.nt = (value >> 14) & 1;
    this.rf = (value >> 16) & 1;
    this.ac = (value >> 18) & 1;
    this.id = (value >> 21) & 1;
  }

  /** I flag che un'operazione logica lascia: il segno, lo zero, la parità. */
  logicFlags(size, result) {
    this.cf = 0;
    this.of = 0;
    this.af = 0;
    this.setResultFlags(size, result);
  }

  setResultFlags(size, result) {
    const value = trim(size, result);
    this.zf = value === 0 ? 1 : 0;
    this.sf = (value & SIGN[size]) !== 0 ? 1 : 0;
    this.pf = PARITY[value & 0xff];
    return value;
  }

  // ------------------------------------------------------- la memoria fisica

  readPhys8(addr) {
    return this.bus.read8(addr >>> 0) & 0xff;
  }

  writePhys8(addr, value) {
    this.bus.write8(addr >>> 0, value & 0xff);
  }

  readPhys32(addr) {
    return (
      (this.readPhys8(addr) |
        (this.readPhys8(addr + 1) << 8) |
        (this.readPhys8(addr + 2) << 16) |
        (this.readPhys8(addr + 3) << 24)) >>>
      0
    );
  }

  writePhys32(addr, value) {
    for (let i = 0; i < 4; i++) this.writePhys8(addr + i, (value >>> (i * 8)) & 0xff);
  }

  // ------------------------------------------------------ la paginazione

  /**
   * Da indirizzo lineare a indirizzo fisico.
   *
   * Questa è la cosa nuova del 386, e quella da cui viene tutto il resto. Senza
   * paginazione l'indirizzo che il programma calcola è il byte che esiste; con
   * la paginazione in mezzo c'è una traduzione a due gradini, e la mappa sta in
   * memoria: i dieci bit alti dell'indirizzo scelgono una voce nella *directory*
   * (che sta dove punta CR3), i dieci di mezzo una voce nella *tabella* che la
   * voce di directory indica, e i dodici bassi sono l'offset dentro la pagina da
   * quattro KB che ne esce.
   *
   * Il punto non è la traduzione: è che una pagina possa **non esserci**. Se il
   * bit di presenza è spento il processore alza un page fault, e il sistema
   * operativo può andare a prendere quella pagina dal disco e far ricominciare
   * l'istruzione come se niente fosse. È qui che nasce la memoria virtuale, ed è
   * per questo che la fine di questa funzione è un'eccezione e non un errore.
   *
   * @param {number} linear
   * @param {boolean} write se l'accesso è in scrittura
   * @returns {number} l'indirizzo fisico
   */
  translate(linear, write = false) {
    linear >>>= 0;
    if (!(this.cr0 & CR0_PG)) return linear;

    const page = linear >>> 12;
    const cached = this.tlb.get(page);
    if (cached && (!write || cached.dirty)) return (cached.phys | (linear & 0xfff)) >>> 0;

    const user = this.cpl === 3;
    const fail = (present) => {
      this.cr2 = linear;
      throw new Fault(PAGE_FAULT, (present ? 1 : 0) | (write ? 2 : 0) | (user ? 4 : 0));
    };

    const dirAt = ((this.cr3 & 0xfffff000) + ((linear >>> 22) << 2)) >>> 0;
    const dir = this.readPhys32(dirAt);
    if (!(dir & 1)) fail(false);

    // Una pagina da quattro mega: la voce di directory è già la traduzione, e i
    // ventidue bit bassi dell'indirizzo passano così come sono. Serve a mappare
    // molta memoria senza spendere una tabella per ogni quattro mega, ed è come
    // ogni sistema operativo mappa se stesso da quando il Pentium esiste.
    let entry = dir;
    let entryAt = dirAt;
    let phys;
    const huge = (this.cr4 & CR4_PSE) !== 0 && (dir & 0x80) !== 0;
    if (huge) {
      phys = ((dir & 0xffc00000) | (linear & 0x003ff000)) >>> 0;
    } else {
      entryAt = ((dir & 0xfffff000) + (((linear >>> 12) & 0x3ff) << 2)) >>> 0;
      entry = this.readPhys32(entryAt);
      if (!(entry & 1)) fail(false);
      phys = (entry & 0xfffff000) >>> 0;
    }

    // I diritti sono l'AND dei due gradini: una tabella di sola lettura rende di
    // sola lettura tutto quello che c'è sotto.
    const writable = (dir & 2) !== 0 && (entry & 2) !== 0;
    const supervisor = (dir & 4) === 0 || (entry & 4) === 0;
    if (user && supervisor) fail(true);
    if (write && !writable && (user || this.cr0 & CR0_WP)) fail(true);

    // I due bit che il processore scrive da sé nella tabella: "questa pagina è
    // stata usata" e "questa pagina è stata cambiata". Sono quelli con cui il
    // sistema operativo decide chi mandare sul disco e chi può buttare via.
    const touched = write ? 0x60 : 0x20;
    if ((entry & touched) !== touched) this.writePhys32(entryAt, (entry | touched) >>> 0);
    if (!huge && (dir & 0x20) === 0) this.writePhys32(dirAt, (dir | 0x20) >>> 0);

    this.tlb.set(page, { phys, dirty: write });
    return (phys | (linear & 0xfff)) >>> 0;
  }

  /**
   * Svuotare la memoria delle traduzioni. Su un processore vero è un pezzo di
   * silicio associativo; qui è una mappa, e la regola è la stessa: cambiare la
   * tabella senza svuotarla vuol dire leggere la mappa di prima.
   */
  flushTLB(page = -1) {
    if (page < 0) this.tlb.clear();
    else this.tlb.delete(page >>> 0);
  }

  // ---------------------------------------------------- la memoria lineare

  readLinear8(linear) {
    return this.readPhys8(this.translate(linear, false));
  }

  writeLinear8(linear, value) {
    this.writePhys8(this.translate(linear, true), value);
  }

  /**
   * Un valore di più byte, letto un byte per volta. Sembra uno spreco, e su una
   * macchina vera lo sarebbe; qui è l'unico modo di essere giusti, perché una
   * parola doppia può stare a cavallo di due pagine — e la seconda può non
   * esserci, e allora il page fault deve arrivare nel mezzo.
   */
  readLinear(size, linear) {
    let value = 0;
    for (let i = 0; i < size; i++) value |= this.readLinear8(linear + i) << (i * 8);
    return trim(size, value);
  }

  writeLinear(size, linear, value) {
    for (let i = 0; i < size; i++) this.writeLinear8(linear + i, (value >>> (i * 8)) & 0xff);
  }

  // ---------------------------------------------------- la memoria a segmenti

  /**
   * L'indirizzo lineare di `segmento:offset`, con i controlli che il modo
   * protetto vuole. In real mode è una somma e nient'altro; in modo protetto è
   * qui che un programma scopre di aver sbagliato, e lo scopre con un #GP.
   *
   * @param {number} index quale segmento
   * @param {number} offset
   * @param {number} size quanti byte si toccano
   * @param {boolean} write se è una scrittura
   */
  linear(index, offset, size = 1, write = false) {
    const seg = this.seg[index];
    // L'offset arriva già della misura giusta: chi lo calcola sa se sta
    // lavorando a sedici o a trentadue bit, e lo stack lo sa meglio di tutti —
    // la sua misura è quella del suo segmento, non quella dell'istruzione.
    offset >>>= 0;
    if (this.protectedMode) {
      if (!seg.present) throw new Fault(index === SS ? STACK_FAULT : GENERAL_PROTECTION, 0);
      if (write && seg.code) throw new Fault(GENERAL_PROTECTION, 0);
      if (write && !seg.writable) throw new Fault(GENERAL_PROTECTION, 0);
      if (!write && seg.code && !seg.readable) throw new Fault(GENERAL_PROTECTION, 0);
      // Il limite è l'ultimo byte che si può toccare, e un segmento che cresce
      // all'ingiù lo conta dall'altra parte: è così che uno stack che sfonda dà
      // errore in fondo e non in cima.
      const last = offset + size - 1;
      const outside = seg.expandDown
        ? offset <= seg.limit || last > (seg.big ? 0xffffffff : 0xffff)
        : last > seg.limit || last < offset;
      if (outside) throw new Fault(index === SS ? STACK_FAULT : GENERAL_PROTECTION, 0);
    }
    return (seg.base + offset) >>> 0;
  }

  read(size, index, offset) {
    return this.readLinear(size, this.linear(index, offset, size, false));
  }

  write(size, index, offset, value) {
    this.writeLinear(size, this.linear(index, offset, size, true), value);
  }

  /** Il segmento da usare: quello che dice l'istruzione, o quello di default. */
  segmentFor(preferred) {
    return this.segmentOverride < 0 ? preferred : this.segmentOverride;
  }

  // ----------------------------------------------------- leggere l'istruzione

  fetch8() {
    const byte = this.readLinear8(this.seg[CS].base + this.eip);
    this.eip = (this.eip + 1) >>> 0;
    if (!this.seg[CS].big) this.eip &= 0xffff;
    return byte;
  }

  fetch16() {
    return this.fetch8() | (this.fetch8() << 8);
  }

  fetch32() {
    return (this.fetch16() | (this.fetch16() << 16)) >>> 0;
  }

  fetch(size) {
    if (size === 1) return this.fetch8();
    return size === 2 ? this.fetch16() : this.fetch32();
  }

  fetchSigned8() {
    return (this.fetch8() << 24) >> 24;
  }

  /** Un immediato della misura dell'operando, letto col segno se è corto. */
  fetchImmediate(size, extend = false) {
    if (extend) return trim(size, this.fetchSigned8());
    return this.fetch(size);
  }

  // --------------------------------------------------------- i descrittori

  /**
   * Un descrittore, cioè gli otto byte con cui il modo protetto racconta un
   * segmento: dove comincia, quanto è lungo, di chi è, e che cosa si può farci.
   *
   * La disposizione di quegli otto byte è la cosa più contorta dell'intera
   * architettura, e ha una ragione storica esatta: il 286 aveva un descrittore
   * con base da 24 bit e limite da 16, e quando il 386 ha dovuto allungare
   * entrambi non poteva spostare niente — c'era già del software che li
   * scriveva. Quindi i byte in più sono stati infilati nei buchi: gli ultimi
   * otto bit della base stanno in cima, i quattro bit alti del limite in mezzo
   * ai flag, e il limite si conta in pagine invece che in byte se c'è un bit
   * acceso. Trent'anni di documentazione a partire da qui.
   *
   * @param {number} selector
   * @returns {object}
   */
  descriptorAt(selector) {
    const table = selector & 4 ? this.ldt : this.gdt;
    const offset = selector & 0xfff8;
    // Un selettore fuori tabella non è un errore dell'emulatore: è un #GP col
    // selettore stesso come codice di errore, che è come il processore dice
    // "quello che hai chiesto non c'è".
    if (offset + 7 > table.limit) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
    const at = (table.base + offset) >>> 0;
    const low = this.readPhys32(this.translate(at, false));
    const high = this.readPhys32(this.translate(at + 4, false));

    const granularity = (high & 0x00800000) !== 0;
    let limit = ((high & 0x000f0000) | (low & 0xffff)) >>> 0;
    if (granularity) limit = ((limit << 12) | 0xfff) >>> 0;
    const type = (high >>> 8) & 0x1f; // i cinque bit: S e i quattro del tipo

    return {
      selector,
      base: (((high & 0xff000000) | ((high & 0xff) << 16)) | ((low >>> 16) & 0xffff)) >>> 0,
      limit,
      type: type & 0x0f,
      system: (type & 0x10) === 0,
      dpl: (high >>> 13) & 3,
      present: (high & 0x8000) !== 0,
      big: (high & 0x00400000) !== 0,
      low,
      high,
    };
  }

  /**
   * Caricare un segmento. In real mode è una moltiplicazione per sedici; in
   * modo protetto è l'unico momento in cui si legge la tabella, e quindi l'unico
   * in cui si può dire di no.
   *
   * @param {number} index quale dei sei
   * @param {number} selector
   */
  loadSegment(index, selector) {
    selector &= 0xffff;
    if (!this.protectedMode) {
      this.s[index] = selector;
      const cache = this.seg[index];
      cache.base = (selector << 4) >>> 0;
      cache.limit = 0xffff;
      cache.big = false;
      cache.code = false;
      cache.writable = true;
      cache.readable = true;
      cache.expandDown = false;
      cache.present = true;
      cache.dpl = 0;
      return;
    }

    // Il selettore nullo si può caricare nei segmenti di dati, e vuol dire
    // "questo segmento non c'è": l'errore arriva quando si prova a usarlo, non
    // quando lo si carica. Nello stack no: uno stack che non c'è è un #GP subito.
    if ((selector & 0xfffc) === 0) {
      if (index === SS || index === CS) throw new Fault(GENERAL_PROTECTION, 0);
      this.s[index] = selector;
      this.seg[index].present = false;
      return;
    }

    const d = this.descriptorAt(selector);
    const rpl = selector & 3;
    if (d.system) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
    const code = (d.type & 0x08) !== 0;

    if (index === SS) {
      if (code || (d.type & 0x02) === 0) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
      if (d.dpl !== this.cpl || rpl !== this.cpl) {
        throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
      }
    } else if (index === CS) {
      if (!code) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
      const conforming = (d.type & 0x04) !== 0;
      if (!conforming && d.dpl !== rpl) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
      if (conforming && d.dpl > rpl) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
    } else if (code && (d.type & 0x02) === 0) {
      // Un segmento di codice che non si lascia leggere non si può mettere in DS.
      throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
    } else if (Math.max(this.cpl, rpl) > d.dpl) {
      throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
    }
    if (!d.present) {
      throw new Fault(index === SS ? STACK_FAULT : SEGMENT_NOT_PRESENT, selector & 0xfffc);
    }

    this.s[index] = selector;
    const cache = this.seg[index];
    cache.base = d.base;
    cache.limit = d.limit;
    cache.big = d.big;
    cache.code = code;
    cache.dpl = d.dpl;
    cache.present = true;
    cache.writable = !code && (d.type & 0x02) !== 0;
    cache.readable = !code || (d.type & 0x02) !== 0;
    cache.expandDown = !code && (d.type & 0x04) !== 0;
    if (index === CS) this.cpl = code && (d.type & 0x04) !== 0 ? this.cpl : d.dpl;
  }

  /**
   * Un salto lontano: prima il segmento, poi l'offset — e in quest'ordine,
   * perché se il segmento non va bene l'istruzione non deve essere cominciata.
   */
  farJump(selector, offset) {
    const wasBig = this.seg[CS].big;
    this.loadSegment(CS, selector);
    this.eip = this.seg[CS].big ? offset >>> 0 : offset & 0xffff;
    return wasBig;
  }

  // -------------------------------------------------------------- lo stack

  push(value, size = this.opsize) {
    const width = this.stacksize;
    const sp = trim(width, this.get32(ESP) - size);
    this.set(width === 4 ? 4 : 2, ESP, sp);
    this.write(size, SS, sp, value);
  }

  pop(size = this.opsize) {
    const width = this.stacksize;
    const sp = trim(width, this.get32(ESP));
    const value = this.read(size, SS, sp);
    this.set(width === 4 ? 4 : 2, ESP, trim(width, sp + size));
    return value;
  }

  // ------------------------------------------------ dove sta l'altro operando

  /**
   * Il byte mod-reg-r/m, e dietro di lui il modo di calcolare gli indirizzi —
   * che sul 386 diventa due modi diversi.
   *
   * A sedici bit gli indirizzi possibili sono una tabella chiusa di otto righe:
   * BX+SI, BX+DI, BP+SI, BP+DI, SI, DI, BP, BX, e nient'altro. A trentadue bit
   * quella tabella diventa una formula — **base + indice per uno, due, quattro o
   * otto, più uno spostamento** — che è tutto quello che serve per indicizzare
   * un array di strutture in un colpo solo, e che è il motivo per cui il codice
   * compilato dal 386 in poi è così diverso da quello di prima.
   *
   * Il byte in più che ci vuole si chiama SIB, e c'è solo quando serve: si
   * infila fra il mod-reg-r/m e lo spostamento, e lo si riconosce perché il
   * campo r/m vale 100. Che è anche il numero di ESP — che quindi non si può
   * usare come indice, e non è un caso: uno stack non si indicizza.
   */
  modrm() {
    const byte = this.fetch8();
    this.mod = byte >> 6;
    this.reg = (byte >> 3) & 7;
    this.rm = byte & 7;
    this.memory = this.mod !== 3;
    if (!this.memory) return;
    if (this.addrsize === 2) this.address16();
    else this.address32();
  }

  address16() {
    let segment = DS;
    let offset = 0;
    switch (this.rm) {
      case 0:
        offset = this.get16(EBX) + this.get16(ESI);
        break;
      case 1:
        offset = this.get16(EBX) + this.get16(EDI);
        break;
      case 2:
        offset = this.get16(EBP) + this.get16(ESI);
        segment = SS;
        break;
      case 3:
        offset = this.get16(EBP) + this.get16(EDI);
        segment = SS;
        break;
      case 4:
        offset = this.get16(ESI);
        break;
      case 5:
        offset = this.get16(EDI);
        break;
      case 6:
        // Il caso che non c'è: BP da solo, senza spostamento, non è indirizzabile
        // — quel posto nella tabella è preso dall'indirizzo assoluto.
        if (this.mod === 0) offset = this.fetch16();
        else {
          offset = this.get16(EBP);
          segment = SS;
        }
        break;
      default:
        offset = this.get16(EBX);
    }
    if (this.mod === 1) offset += this.fetchSigned8();
    else if (this.mod === 2) offset += this.fetch16();
    this.opSegment = this.segmentFor(segment);
    this.opOffset = offset & 0xffff;
  }

  address32() {
    let segment = DS;
    let offset = 0;
    if (this.rm === 4) {
      const sib = this.fetch8();
      const scale = sib >> 6;
      const index = (sib >> 3) & 7;
      const base = sib & 7;
      if (index !== 4) offset += this.get32(index) << scale;
      if (base === 5 && this.mod === 0) offset += this.fetch32();
      else {
        offset += this.get32(base);
        if (base === 4 || base === 5) segment = SS;
      }
    } else if (this.rm === 5 && this.mod === 0) {
      offset = this.fetch32();
    } else {
      offset = this.get32(this.rm);
      if (this.rm === 5) segment = SS;
    }
    if (this.mod === 1) offset += this.fetchSigned8();
    else if (this.mod === 2) offset += this.fetch32();
    this.opSegment = this.segmentFor(segment);
    this.opOffset = offset >>> 0;
  }

  readRM(size) {
    return this.memory ? this.read(size, this.opSegment, this.opOffset) : this.get(size, this.rm);
  }

  writeRM(size, value) {
    if (this.memory) this.write(size, this.opSegment, this.opOffset, value);
    else this.set(size, this.rm, value);
  }

  // ------------------------------------------------------------- l'aritmetica

  /**
   * Somma e sottrazione con i loro flag, che sono il pezzo che nessun emulatore
   * può permettersi di sbagliare: ogni salto condizionato del mondo dipende da
   * questi cinque bit. Il riporto è il bit che esce dalla misura; il trabocco è
   * un'altra cosa — vuol dire che il risultato ha cambiato segno quando non
   * doveva — e la differenza fra i due è la differenza fra contare con il segno
   * e contare senza.
   */
  add(size, a, b, carry = 0) {
    const mask = MASK[size];
    const sum = size === 4 ? (a >>> 0) + (b >>> 0) + carry : (a & mask) + (b & mask) + carry;
    const result = this.setResultFlags(size, sum);
    this.cf = sum > mask ? 1 : 0;
    this.af = ((a ^ b ^ sum) & 0x10) !== 0 ? 1 : 0;
    this.of = (~(a ^ b) & (a ^ sum) & SIGN[size]) !== 0 ? 1 : 0;
    return result;
  }

  sub(size, a, b, borrow = 0) {
    const mask = MASK[size];
    const diff = size === 4 ? (a >>> 0) - (b >>> 0) - borrow : (a & mask) - (b & mask) - borrow;
    const result = this.setResultFlags(size, diff);
    this.cf = diff < 0 ? 1 : 0;
    this.af = ((a ^ b ^ diff) & 0x10) !== 0 ? 1 : 0;
    this.of = ((a ^ b) & (a ^ diff) & SIGN[size]) !== 0 ? 1 : 0;
    return result;
  }

  /** Le tre logiche, che azzerano riporto e trabocco perché non possono averne. */
  logic(operation, size, a, b) {
    const result =
      operation === 'and' ? a & b : operation === 'or' ? a | b : a ^ b;
    this.logicFlags(size, result);
    return trim(size, result);
  }

  /** INC e DEC non toccano il riporto: è la loro unica particolarità, e conta. */
  inc(size, value) {
    const carry = this.cf;
    const result = this.add(size, value, 1);
    this.cf = carry;
    return result;
  }

  dec(size, value) {
    const carry = this.cf;
    const result = this.sub(size, value, 1);
    this.cf = carry;
    return result;
  }

  /**
   * Gli scorrimenti e le rotazioni. Il conteggio è mascherato a cinque bit —
   * spostare di trentatré vuol dire spostare di uno — e uno scorrimento di zero
   * non tocca nessun flag: sono due regole piccole che il software di sistema
   * usa, e sbagliarle si vede subito.
   */
  shift(operation, size, value, rawCount) {
    const count = rawCount & 31;
    if (count === 0) return trim(size, value);
    const bits = size * 8;
    const mask = MASK[size];
    let result = trim(size, value);

    switch (operation) {
      case 'rol': {
        const n = count % bits;
        if (n) result = ((result << n) | (result >>> (bits - n))) & mask;
        this.cf = result & 1;
        this.of = ((result >>> (bits - 1)) ^ this.cf) & 1;
        return result;
      }
      case 'ror': {
        const n = count % bits;
        if (n) result = ((result >>> n) | (result << (bits - n))) & mask;
        this.cf = (result >>> (bits - 1)) & 1;
        this.of = (((result >>> (bits - 1)) ^ (result >>> (bits - 2))) & 1) || 0;
        return result;
      }
      case 'rcl': {
        // La rotazione che passa dal riporto: nove bit in un byte, e nessun
        // linguaggio di alto livello che sappia dirla.
        const n = count % (bits + 1);
        let carry = this.cf;
        for (let i = 0; i < n; i++) {
          const top = (result >>> (bits - 1)) & 1;
          result = ((result << 1) | carry) & mask;
          carry = top;
        }
        this.cf = carry;
        this.of = ((result >>> (bits - 1)) ^ carry) & 1;
        return result;
      }
      case 'rcr': {
        const n = count % (bits + 1);
        let carry = this.cf;
        for (let i = 0; i < n; i++) {
          const bottom = result & 1;
          result = ((result >>> 1) | (carry << (bits - 1))) & mask;
          carry = bottom;
        }
        this.cf = carry;
        this.of = (((result >>> (bits - 1)) ^ (result >>> (bits - 2))) & 1) || 0;
        return result;
      }
      case 'shl': {
        this.cf = count > bits ? 0 : (result >>> (bits - count)) & 1;
        result = trim(size, count >= bits ? 0 : result << count);
        this.setResultFlags(size, result);
        this.of = ((result >>> (bits - 1)) & 1) ^ this.cf;
        return result;
      }
      case 'shr': {
        this.cf = count > bits ? 0 : (result >>> (count - 1)) & 1;
        const before = result;
        result = count >= bits ? 0 : result >>> count;
        this.setResultFlags(size, result);
        this.of = (before >>> (bits - 1)) & 1;
        return result;
      }
      default: {
        // SAR: lo scorrimento che tiene il segno, cioè la divisione per due che
        // funziona anche sui numeri negativi.
        const value32 = signed(size, result);
        const n = Math.min(count, bits - 1);
        this.cf = (value32 >> (n === count ? count - 1 : bits - 1)) & 1;
        result = trim(size, value32 >> n);
        this.setResultFlags(size, result);
        this.of = 0;
        return result;
      }
    }
  }

  /**
   * SHLD e SHRD: uno scorrimento che pesca i bit che entrano da un altro
   * registro invece che dal nulla. Sono le istruzioni con cui si sposta un
   * numero più lungo della macchina, e il 386 le ha messe perché fino a lì
   * ci voleva un ciclo.
   */
  doubleShift(size, left, dest, source, rawCount) {
    const count = rawCount & 31;
    if (count === 0) return trim(size, dest);
    const bits = size * 8;
    if (count > bits) return trim(size, dest); // non definito dal manuale, e lasciato stare
    let result;
    if (left) {
      this.cf = (dest >>> (bits - count)) & 1;
      result = count === bits ? source : (dest << count) | (source >>> (bits - count));
    } else {
      this.cf = (dest >>> (count - 1)) & 1;
      result = count === bits ? source : (dest >>> count) | (source << (bits - count));
    }
    result = this.setResultFlags(size, result);
    this.of = ((result ^ dest) >>> (bits - 1)) & 1;
    return result;
  }

  /**
   * Moltiplicazione e divisione, che sono le due operazioni in cui il risultato
   * non ci sta nella misura degli operandi: due numeri da trentadue bit fanno
   * sessantaquattro, e la divisione parte da sessantaquattro e ne restituisce
   * trentadue più il resto.
   *
   * Sessantaquattro bit interi JavaScript non li ha: un `number` ne tiene
   * cinquantatré esatti, e sopra comincia a mentire. Quindi per la misura grande
   * si passa dai BigInt — lenti, ma giusti — e per le altre due bastano i numeri
   * normali. Non è un compromesso: è che un moltiplicatore sbagliato nel bit 54
   * non si troverebbe mai più.
   */
  multiply(size, a, b, withSign) {
    if (size === 4) {
      const big = withSign
        ? BigInt(signed(4, a)) * BigInt(signed(4, b))
        : BigInt(a >>> 0) * BigInt(b >>> 0);
      const low = Number(big & 0xffffffffn) >>> 0;
      const high = Number((big >> 32n) & 0xffffffffn) >>> 0;
      return { low, high, full: big };
    }
    const product = withSign ? signed(size, a) * signed(size, b) : trim(size, a) * trim(size, b);
    return {
      low: trim(size, product),
      high: trim(size, Math.floor(product / (MASK[size] + 1))),
      full: BigInt(product),
    };
  }

  divide(size, high, low, divisor, withSign) {
    if (divisor === 0) throw new Fault(DIVIDE_ERROR);
    if (size === 4) {
      const dividend = withSign
        ? (BigInt(high | 0) << 32n) | BigInt(low >>> 0)
        : (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
      const by = withSign ? BigInt(signed(4, divisor)) : BigInt(divisor >>> 0);
      let quotient = dividend / by;
      const remainder = dividend % by;
      // Il quoziente che non ci sta nel registro è un errore di divisione, non
      // un numero troncato: è la stessa eccezione della divisione per zero, e
      // sono le due cose che fanno saltare l'INT 0.
      if (withSign ? quotient > 0x7fffffffn || quotient < -0x80000000n : quotient > 0xffffffffn) {
        throw new Fault(DIVIDE_ERROR);
      }
      if (quotient < 0n) quotient += 0x100000000n;
      return { quotient: Number(quotient) >>> 0, remainder: Number(remainder & 0xffffffffn) >>> 0 };
    }
    const span = MASK[size] + 1;
    const dividend = withSign
      ? signed(size, high) * span + trim(size, low)
      : trim(size, high) * span + trim(size, low);
    const by = withSign ? signed(size, divisor) : trim(size, divisor);
    const quotient = withSign ? Math.trunc(dividend / by) : Math.floor(dividend / by);
    const limit = withSign ? SIGN[size] : span;
    if (withSign ? quotient >= limit || quotient < -limit : quotient >= limit) {
      throw new Fault(DIVIDE_ERROR);
    }
    return { quotient: trim(size, quotient), remainder: trim(size, dividend - quotient * by) };
  }

  // ------------------------------------------------------- le interruzioni

  /**
   * Entrare in un gestore. In real mode è la tabella di 256 coppie
   * segmento/offset che sta all'indirizzo zero, e il salto costa tre push.
   *
   * In modo protetto quella tabella diventa la **IDT**, e ogni voce non è un
   * indirizzo ma una *porta*: dice dove andare, ma anche chi ha il diritto di
   * passare e se le interruzioni restano aperte dall'altra parte. È la
   * differenza fra un sistema in cui qualunque programma può chiamare qualunque
   * pezzo del sistema operativo e uno in cui non può.
   *
   * @param {number} vector
   * @param {object} [options]
   * @param {?number} [options.code] il codice di errore dell'eccezione
   * @param {boolean} [options.software] se viene da un INT e non da un piedino
   */
  interrupt(vector, { code = null, software = false } = {}) {
    this.halted = false;
    if (!this.protectedMode) {
      const at = vector * 4;
      const offset = this.readLinear(2, at);
      const selector = this.readLinear(2, at + 2);
      this.push(this.eflags & 0xffff, 2);
      this.push(this.s[CS], 2);
      this.push(this.eip & 0xffff, 2);
      this.if_ = 0;
      this.tf = 0;
      this.loadSegment(CS, selector);
      this.eip = offset;
      return;
    }

    const at = (this.idt.base + vector * 8) >>> 0;
    if (vector * 8 + 7 > this.idt.limit) throw new Fault(GENERAL_PROTECTION, vector * 8 + 2);
    const low = this.readPhys32(this.translate(at, false));
    const high = this.readPhys32(this.translate(at + 4, false));
    const type = (high >>> 8) & 0x1f;
    const dpl = (high >>> 13) & 3;
    if ((high & 0x8000) === 0) throw new Fault(SEGMENT_NOT_PRESENT, vector * 8 + 2);
    // Un INT scritto da un programma passa solo se il programma è abbastanza
    // privilegiato per quella porta; un'eccezione passa sempre, perché non è il
    // programma che l'ha chiesta.
    if (software && dpl < this.cpl) throw new Fault(GENERAL_PROTECTION, vector * 8 + 2);
    if (type === 5) throw new Unsupported('le porte di task non ci sono ancora');
    if (type !== 6 && type !== 7 && type !== 14 && type !== 15) {
      throw new Fault(GENERAL_PROTECTION, vector * 8 + 2);
    }

    const wide = type === 14 || type === 15;
    const selector = (low >>> 16) & 0xffff;
    const offset = wide ? ((high & 0xffff0000) | (low & 0xffff)) >>> 0 : low & 0xffff;
    const target = this.descriptorAt(selector);
    if (target.dpl < this.cpl) {
      throw new Unsupported('il cambio di anello vuole un TSS, che non c\'è ancora');
    }

    // Quello che si impila è lo stato dell'istruzione *interrotta*, e va letto
    // prima di toccare qualunque cosa: da qui in poi CS e EIP sono già quelli
    // del gestore, e l'unico modo di tornare indietro è quello che c'è sullo
    // stack.
    const size = wide ? 4 : 2;
    const flags = this.eflags;
    const from = { cs: this.s[CS], eip: this.eip };
    this.tf = 0;
    // Una porta di interruzione chiude le interruzioni entrando; una porta di
    // trappola le lascia aperte. È tutta la differenza fra le due, e si sceglie
    // per ogni singolo vettore: il gestore della tastiera non vuole essere
    // interrotto, quello del debugger sì.
    if (type === 6 || type === 14) this.if_ = 0;
    this.loadSegment(CS, selector);
    this.eip = offset;
    this.push(flags, size);
    this.push(from.cs, size);
    this.push(size === 4 ? from.eip : from.eip & 0xffff, size);
    if (code !== null) this.push(code, size);
  }

  /**
   * Tornare da un gestore. In real mode sono tre pop. In modo protetto c'è una
   * cosa in più: se si torna a un anello esterno bisogna tirare su anche lo
   * stack di prima, perché entrando gliene era stato dato un altro.
   */
  iret(size) {
    if (!this.protectedMode) {
      const eip = this.pop(size);
      const cs = this.pop(size);
      const flags = this.pop(size);
      this.loadSegment(CS, cs);
      this.eip = size === 4 ? eip >>> 0 : eip & 0xffff;
      this.eflags = size === 4 ? flags : (this.eflags & 0xffff0000) | flags;
      return;
    }
    if (this.nt) throw new Unsupported('il ritorno da un task vuole un TSS');

    const eip = this.pop(size);
    const cs = this.pop(size);
    const flags = this.pop(size);
    const outer = (cs & 3) > this.cpl;
    let sp = 0;
    let ss = 0;
    if (outer) {
      sp = this.pop(size);
      ss = this.pop(size);
    }
    this.loadSegment(CS, cs);
    this.eip = size === 4 ? eip >>> 0 : eip & 0xffff;
    // I flag che un programma meno privilegiato non ha il diritto di cambiare
    // restano quelli di prima: è così che IRET non diventa il modo di prendersi
    // i privilegi che non si hanno.
    const before = this.eflags;
    this.eflags = size === 4 ? flags : (before & 0xffff0000) | flags;
    if (this.cpl > 0) this.iopl = (before >>> 12) & 3;
    if (outer) {
      this.loadSegment(SS, ss);
      this.set32(ESP, size === 4 ? sp >>> 0 : sp & 0xffff);
    }
  }

  // ------------------------------------------------------------- un'istruzione

  /**
   * Un'istruzione, dall'inizio alla fine, e quello che costa.
   *
   * I prefissi si leggono in testa e valgono per quella sola istruzione. Ce ne
   * sono due nuovi rispetto al 286 e sono i più importanti di tutti: 66h e 67h,
   * che scambiano la misura degli operandi e quella degli indirizzi. Sono il
   * modo in cui lo stesso codice macchina serve due mondi, e il motivo per cui
   * un disassemblatore che non sappia in che segmento si trova non può fare il
   * suo lavoro.
   */
  step() {
    if (this.halted) {
      if (this.stiDelay) this.stiDelay--;
      this.tsc += 1;
      return 1;
    }

    this.resetPrefixes();
    this.startEIP = this.eip;
    this.startCS = this.s[CS];
    this.startESP = this.get32(ESP);
    const delay = this.stiDelay;

    let cost = 1;
    try {
      let opcode = this.fetch8();
      for (;;) {
        if (opcode === 0x26) this.segmentOverride = ES;
        else if (opcode === 0x2e) this.segmentOverride = CS;
        else if (opcode === 0x36) this.segmentOverride = SS;
        else if (opcode === 0x3e) this.segmentOverride = DS;
        else if (opcode === 0x64) this.segmentOverride = FS;
        else if (opcode === 0x65) this.segmentOverride = GS;
        else if (opcode === 0x66) this.opsizePrefix = true;
        else if (opcode === 0x67) this.addrsizePrefix = true;
        else if (opcode === 0xf2 || opcode === 0xf3) this.repeat = opcode;
        else if (opcode === 0xf0) this.lock = true;
        else break;
        opcode = this.fetch8();
      }
      this.instructions++;
      cost = this.execute(opcode) || 1;
    } catch (error) {
      cost = this.serviceFault(error);
    }

    if (delay && this.stiDelay === delay) this.stiDelay = delay - 1;
    this.tsc += cost;
    return cost;
  }

  /**
   * Un'eccezione arrivata a metà istruzione.
   *
   * La differenza fra un *fault* e una *trap* è tutta qui: un fault riporta il
   * processore dove l'istruzione era cominciata, così che il gestore possa
   * sistemare le cose — mettere la pagina che mancava — e lasciarla ricominciare
   * come se niente fosse stato. È il meccanismo su cui poggia la memoria
   * virtuale: il programma non sa di essere stato interrotto.
   *
   * Se anche il gestore fallisce, il processore non ci prova all'infinito: due
   * fallimenti fanno un double fault, e tre fanno una macchina che si spegne —
   * il triple fault, che per anni è stato il modo normale di riavviare un PC.
   */
  serviceFault(error) {
    if (!(error instanceof Fault)) throw error;
    this.eip = this.startEIP;
    this.s[CS] = this.startCS;
    this.set32(ESP, this.startESP);
    this.faultDepth = (this.faultDepth ?? 0) + 1;
    if (this.faultDepth > 2) {
      this.halted = true;
      this.tripleFault = true;
      this.faultDepth = 0;
      return 1;
    }
    try {
      this.interrupt(error.vector, { code: error.code });
    } catch (nested) {
      if (!(nested instanceof Fault)) throw nested;
      this.interrupt(DOUBLE_FAULT, { code: 0 });
    }
    this.faultDepth = 0;
    return 30;
  }

  /** Se il salto condizionato salta, secondo i quattro bit della condizione. */
  condition(code) {
    let taken;
    switch (code >> 1) {
      case 0:
        taken = this.of;
        break;
      case 1:
        taken = this.cf;
        break;
      case 2:
        taken = this.zf;
        break;
      case 3:
        taken = this.cf | this.zf;
        break;
      case 4:
        taken = this.sf;
        break;
      case 5:
        taken = this.pf;
        break;
      case 6:
        taken = this.sf ^ this.of;
        break;
      default:
        taken = (this.sf ^ this.of) | this.zf;
        break;
    }
    return code & 1 ? !taken : !!taken;
  }

  /** Le otto operazioni della griglia in testa alla tabella degli opcode. */
  alu(op, size, a, b) {
    switch (op) {
      case 0:
        return this.add(size, a, b);
      case 1:
        return this.logic('or', size, a, b);
      case 2:
        return this.add(size, a, b, this.cf);
      case 3:
        return this.sub(size, a, b, this.cf);
      case 4:
        return this.logic('and', size, a, b);
      case 5:
        return this.sub(size, a, b);
      case 6:
        return this.logic('xor', size, a, b);
      default:
        this.sub(size, a, b); // CMP: la sottrazione buttata via, i flag tenuti
        return trim(size, a);
    }
  }

  /** Le otto rotazioni e scorrimenti, nello stesso ordine del byte del gruppo. */
  shiftOp(op, size, value, count) {
    const names = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'shl', 'sar'];
    return this.shift(names[op], size, value, count);
  }

  /** Il contatore delle istruzioni di stringa e di LOOP: CX o ECX. */
  get counter() {
    return this.addrsize === 4 ? this.get32(ECX) : this.get16(ECX);
  }

  set counter(value) {
    if (this.addrsize === 4) this.set32(ECX, value);
    else this.set16(ECX, value);
  }

  /** Di quanto si muovono SI e DI: avanti, o indietro se DF è acceso. */
  delta(size) {
    return this.df ? -size : size;
  }

  index(register) {
    return this.addrsize === 4 ? this.get32(register) : this.get16(register);
  }

  advance(register, by) {
    if (this.addrsize === 4) this.set32(register, this.get32(register) + by);
    else this.set16(register, this.get16(register) + by);
  }

  /**
   * Un'istruzione di stringa, una volta sola — e se c'è un prefisso di
   * ripetizione si rimette indietro EIP invece di girare qui dentro.
   *
   * Non è pigrizia: è l'unico modo di restare interrompibili. Un REP MOVSD che
   * sposta un mega in un colpo terrebbe fuori l'interrupt del timer per tutto il
   * tempo. L'hardware fa esattamente questo, e infatti un interrupt in mezzo a
   * un REP torna sull'istruzione, prefissi compresi.
   */
  repeatable(callback, checkZero = false) {
    if (!this.repeat) {
      callback();
      return 4;
    }
    if (this.counter === 0) return 2;
    this.counter = this.counter - 1;
    callback();
    let again = this.counter !== 0;
    if (again && checkZero) again = this.repeat === 0xf3 ? this.zf === 1 : this.zf === 0;
    if (again) this.eip = this.startEIP;
    return 2;
  }

  // ------------------------------------------------------------- le porte

  /**
   * Leggere e scrivere una porta, con il controllo che il modo protetto vuole:
   * un programma può parlare all'hardware solo se è abbastanza privilegiato, e
   * se non lo è prende un #GP. È il pezzo con cui Windows, negli anni Novanta,
   * riusciva a far credere a un gioco DOS di avere una scheda audio tutta sua:
   * il gioco scriveva sulla porta, il processore lo fermava, e il sistema
   * operativo rispondeva al posto del silicio.
   */
  checkIOPrivilege() {
    if (this.protectedMode && this.cpl > this.iopl) throw new Fault(GENERAL_PROTECTION, 0);
  }

  portIn(size, port) {
    this.checkIOPrivilege();
    if (size === 2 && this.bus.inw) return this.bus.inw(port) & 0xffff;
    if (size === 4 && this.bus.ind) return this.bus.ind(port) >>> 0;
    let value = 0;
    for (let i = 0; i < size; i++) value |= (this.bus.inb(port + i) & 0xff) << (i * 8);
    return trim(size, value);
  }

  portOut(size, port, value) {
    this.checkIOPrivilege();
    if (size === 2 && this.bus.outw) return this.bus.outw(port, value & 0xffff);
    if (size === 4 && this.bus.outd) return this.bus.outd(port, value >>> 0);
    for (let i = 0; i < size; i++) this.bus.outb(port + i, (value >>> (i * 8)) & 0xff);
    return undefined;
  }

  // --------------------------------------------------------- gli opcode a un byte

  execute(opcode) {
    const size = this.opsize;

    // La griglia in testa alla tabella: otto operazioni per sei forme, tutte
    // nella stessa disposizione. L'operazione sta nei bit 3-5, la forma nei tre
    // bassi — ed è la ragione per cui questi sessantaquattro opcode si scrivono
    // in dieci righe invece che in sessantaquattro.
    if (opcode < 0x40 && (opcode & 7) < 6) {
      const op = (opcode >> 3) & 7;
      switch (opcode & 7) {
        case 0:
          this.modrm();
          this.writeRM(1, this.alu(op, 1, this.readRM(1), this.get8(this.reg)));
          return 2;
        case 1:
          this.modrm();
          this.writeRM(size, this.alu(op, size, this.readRM(size), this.get(size, this.reg)));
          return 2;
        case 2:
          this.modrm();
          this.set8(this.reg, this.alu(op, 1, this.get8(this.reg), this.readRM(1)));
          return 2;
        case 3:
          this.modrm();
          this.set(size, this.reg, this.alu(op, size, this.get(size, this.reg), this.readRM(size)));
          return 2;
        case 4:
          this.set8(0, this.alu(op, 1, this.get8(0), this.fetch8()));
          return 1;
        default:
          this.set(size, EAX, this.alu(op, size, this.get(size, EAX), this.fetch(size)));
          return 1;
      }
    }

    switch (opcode) {
      // ----------------------------------------------------------- i segmenti
      case 0x06:
        this.push(this.s[ES], size);
        return 1;
      case 0x07:
        this.loadSegment(ES, this.pop(size));
        return 3;
      case 0x0e:
        this.push(this.s[CS], size);
        return 1;
      case 0x16:
        this.push(this.s[SS], size);
        return 1;
      case 0x17:
        this.loadSegment(SS, this.pop(size));
        return 3;
      case 0x1e:
        this.push(this.s[DS], size);
        return 1;
      case 0x1f:
        this.loadSegment(DS, this.pop(size));
        return 3;

      // ------------------------------------------------- il decimale a mano
      case 0x27:
      case 0x2f: {
        // DAA e DAS: la correzione che serviva quando i numeri si tenevano in
        // cifre decimali dentro i byte, che è come si contavano i soldi prima
        // che ci fosse una virgola mobile in ogni macchina.
        const subtract = opcode === 0x2f;
        let al = this.get8(0);
        const carry = this.cf;
        this.cf = 0;
        if ((al & 0x0f) > 9 || this.af) {
          al = subtract ? al - 6 : al + 6;
          this.cf = carry | (al > 0xff || al < 0 ? 1 : 0);
          this.af = 1;
        } else this.af = 0;
        if ((this.get8(0) > 0x99 && !subtract) || carry) {
          al = subtract ? al - 0x60 : al + 0x60;
          this.cf = 1;
        }
        this.set8(0, al & 0xff);
        this.setResultFlags(1, al & 0xff);
        return 3;
      }
      case 0x37:
      case 0x3f: {
        const subtract = opcode === 0x3f;
        if ((this.get8(0) & 0x0f) > 9 || this.af) {
          this.set16(EAX, this.get16(EAX) + (subtract ? -6 : 6) + (subtract ? -0x100 : 0x100));
          this.af = 1;
          this.cf = 1;
        } else {
          this.af = 0;
          this.cf = 0;
        }
        this.set8(0, this.get8(0) & 0x0f);
        return 3;
      }

      // -------------------------------------------------------- INC, DEC, stack
      case 0x40:
      case 0x41:
      case 0x42:
      case 0x43:
      case 0x44:
      case 0x45:
      case 0x46:
      case 0x47:
        this.set(size, opcode & 7, this.inc(size, this.get(size, opcode & 7)));
        return 1;
      case 0x48:
      case 0x49:
      case 0x4a:
      case 0x4b:
      case 0x4c:
      case 0x4d:
      case 0x4e:
      case 0x4f:
        this.set(size, opcode & 7, this.dec(size, this.get(size, opcode & 7)));
        return 1;
      case 0x50:
      case 0x51:
      case 0x52:
      case 0x53:
      case 0x54:
      case 0x55:
      case 0x56:
      case 0x57:
        this.push(this.get(size, opcode & 7), size);
        return 1;
      case 0x58:
      case 0x59:
      case 0x5a:
      case 0x5b:
      case 0x5c:
      case 0x5d:
      case 0x5e:
      case 0x5f:
        this.set(size, opcode & 7, this.pop(size));
        return 1;
      case 0x60: {
        const sp = this.get(size, ESP);
        for (const index of [EAX, ECX, EDX, EBX]) this.push(this.get(size, index), size);
        this.push(sp, size);
        for (const index of [EBP, ESI, EDI]) this.push(this.get(size, index), size);
        return 5;
      }
      case 0x61: {
        for (const index of [EDI, ESI, EBP]) this.set(size, index, this.pop(size));
        this.pop(size); // lo stack puntatore non si ripristina: si è già mosso
        for (const index of [EBX, EDX, ECX, EAX]) this.set(size, index, this.pop(size));
        return 5;
      }
      case 0x62: {
        // BOUND: controlla che un indice stia dentro due limiti in memoria, e se
        // no alza l'eccezione 5. È l'unica istruzione di controllo dei limiti
        // che l'architettura abbia mai avuto, e quasi nessun compilatore l'ha
        // usata — costava più di due confronti.
        this.modrm();
        const index = signed(size, this.get(size, this.reg));
        const low = signed(size, this.read(size, this.opSegment, this.opOffset));
        const high = signed(size, this.read(size, this.opSegment, this.opOffset + size));
        if (index < low || index > high) throw new Fault(BOUND_FAULT);
        return 7;
      }
      case 0x63: {
        // ARPL: abbassa il privilegio richiesto di un selettore a quello di chi
        // lo ha passato. Serviva ai sistemi operativi per non farsi ingannare da
        // un puntatore arrivato da un programma.
        this.modrm();
        const value = this.readRM(2);
        const from = this.get16(this.reg) & 3;
        if ((value & 3) < from) {
          this.writeRM(2, (value & 0xfffc) | from);
          this.zf = 1;
        } else this.zf = 0;
        return 3;
      }
      case 0x68:
        this.push(this.fetch(size), size);
        return 1;
      case 0x6a:
        this.push(trim(size, this.fetchSigned8()), size);
        return 1;
      case 0x69:
      case 0x6b: {
        this.modrm();
        const a = this.readRM(size);
        const b = opcode === 0x69 ? this.fetch(size) : trim(size, this.fetchSigned8());
        const { low, full } = this.multiply(size, a, b, true);
        this.set(size, this.reg, low);
        const exact = BigInt(signed(size, low)) === full;
        this.cf = exact ? 0 : 1;
        this.of = this.cf;
        this.setResultFlags(size, low);
        return 10;
      }
      case 0x6c:
      case 0x6d: {
        const width = opcode === 0x6c ? 1 : size;
        return this.repeatable(() => {
          const value = this.portIn(width, this.get16(EDX));
          this.write(width, ES, this.index(EDI), value);
          this.advance(EDI, this.delta(width));
        });
      }
      case 0x6e:
      case 0x6f: {
        const width = opcode === 0x6e ? 1 : size;
        return this.repeatable(() => {
          const from = this.segmentFor(DS);
          this.portOut(width, this.get16(EDX), this.read(width, from, this.index(ESI)));
          this.advance(ESI, this.delta(width));
        });
      }

      // ------------------------------------------------------- i salti corti
      case 0x70:
      case 0x71:
      case 0x72:
      case 0x73:
      case 0x74:
      case 0x75:
      case 0x76:
      case 0x77:
      case 0x78:
      case 0x79:
      case 0x7a:
      case 0x7b:
      case 0x7c:
      case 0x7d:
      case 0x7e:
      case 0x7f: {
        const offset = this.fetchSigned8();
        if (this.condition(opcode & 0x0f)) this.jump(offset);
        return 1;
      }

      // -------------------------------------------- i gruppi con l'immediato
      case 0x80:
      case 0x82: {
        this.modrm();
        const op = this.reg;
        this.writeRM(1, this.alu(op, 1, this.readRM(1), this.fetch8()));
        return 2;
      }
      case 0x81:
      case 0x83: {
        this.modrm();
        const op = this.reg;
        const value = opcode === 0x81 ? this.fetch(size) : trim(size, this.fetchSigned8());
        this.writeRM(size, this.alu(op, size, this.readRM(size), value));
        return 2;
      }
      case 0x84:
        this.modrm();
        this.logic('and', 1, this.readRM(1), this.get8(this.reg));
        return 2;
      case 0x85:
        this.modrm();
        this.logic('and', size, this.readRM(size), this.get(size, this.reg));
        return 2;
      case 0x86: {
        this.modrm();
        const a = this.readRM(1);
        this.writeRM(1, this.get8(this.reg));
        this.set8(this.reg, a);
        return 3;
      }
      case 0x87: {
        this.modrm();
        const a = this.readRM(size);
        this.writeRM(size, this.get(size, this.reg));
        this.set(size, this.reg, a);
        return 3;
      }
      case 0x88:
        this.modrm();
        this.writeRM(1, this.get8(this.reg));
        return 1;
      case 0x89:
        this.modrm();
        this.writeRM(size, this.get(size, this.reg));
        return 1;
      case 0x8a:
        this.modrm();
        this.set8(this.reg, this.readRM(1));
        return 1;
      case 0x8b:
        this.modrm();
        this.set(size, this.reg, this.readRM(size));
        return 1;
      case 0x8c:
        this.modrm();
        // Un selettore è sempre di sedici bit: in memoria ne scrive due, in un
        // registro a trentadue bit i sedici alti restano quello che erano.
        if (this.memory) this.write(2, this.opSegment, this.opOffset, this.s[this.reg & 7]);
        else this.set16(this.rm, this.s[this.reg & 7]);
        return 1;
      case 0x8d: {
        this.modrm();
        if (!this.memory) throw new Fault(INVALID_OPCODE);
        // LEA non tocca la memoria: calcola l'indirizzo e lo consegna. È
        // l'istruzione con cui ogni compilatore fa le moltiplicazioni per tre,
        // cinque e nove senza un moltiplicatore.
        this.set(size, this.reg, this.opOffset);
        return 1;
      }
      case 0x8e: {
        this.modrm();
        const index = this.reg & 7;
        if (index === CS) throw new Fault(INVALID_OPCODE);
        this.loadSegment(index, this.readRM(2));
        return 3;
      }
      case 0x8f:
        this.modrm();
        this.writeRM(size, this.pop(size));
        return 2;

      // --------------------------------------------------------- i registri
      case 0x90:
        return 1; // NOP, che è XCHG EAX, EAX
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97: {
        const index = opcode & 7;
        const value = this.get(size, EAX);
        this.set(size, EAX, this.get(size, index));
        this.set(size, index, value);
        return 2;
      }
      case 0x98:
        // CBW o CWDE, secondo la misura: allunga col segno la metà bassa.
        if (size === 2) this.set16(EAX, signed(1, this.get8(0)) & 0xffff);
        else this.set32(EAX, signed(2, this.get16(EAX)));
        return 1;
      case 0x99:
        // CWD o CDQ: il segno spalmato su tutto il registro alto, che è il modo
        // di preparare una divisione con segno.
        if (size === 2) this.set16(EDX, signed(2, this.get16(EAX)) < 0 ? 0xffff : 0);
        else this.set32(EDX, (this.get32(EAX) & 0x80000000) !== 0 ? 0xffffffff : 0);
        return 1;
      case 0x9a: {
        const offset = this.fetch(size);
        const selector = this.fetch16();
        this.push(this.s[CS], size);
        this.push(this.eip, size);
        this.farJump(selector, offset);
        return 6;
      }
      case 0x9b:
        return 1; // WAIT: aspetta il coprocessore, e qui non c'è nessuno
      case 0x9c:
        this.push(size === 4 ? this.eflags & 0x00fcffff : this.eflags & 0xffff, size);
        return 2;
      case 0x9d: {
        const value = this.pop(size);
        const before = this.eflags;
        this.eflags = size === 4 ? value : (before & 0xffff0000) | value;
        // Chi non è abbastanza privilegiato non cambia il livello delle porte né
        // riapre le interruzioni: POPF non è un buco.
        if (this.protectedMode && this.cpl > 0) this.iopl = (before >>> 12) & 3;
        if (this.protectedMode && this.cpl > this.iopl) this.if_ = (before >>> 9) & 1;
        return 3;
      }
      case 0x9e: {
        const ah = this.get8(4);
        this.cf = ah & 1;
        this.pf = (ah >> 2) & 1;
        this.af = (ah >> 4) & 1;
        this.zf = (ah >> 6) & 1;
        this.sf = (ah >> 7) & 1;
        return 2;
      }
      case 0x9f:
        this.set8(4, this.eflags & 0xff);
        return 2;

      // ----------------------------------------------- la memoria e le stringhe
      case 0xa0:
        this.set8(0, this.read(1, this.segmentFor(DS), this.fetch(this.addrsize)));
        return 1;
      case 0xa1:
        this.set(size, EAX, this.read(size, this.segmentFor(DS), this.fetch(this.addrsize)));
        return 1;
      case 0xa2:
        this.write(1, this.segmentFor(DS), this.fetch(this.addrsize), this.get8(0));
        return 1;
      case 0xa3:
        this.write(size, this.segmentFor(DS), this.fetch(this.addrsize), this.get(size, EAX));
        return 1;
      case 0xa4:
      case 0xa5: {
        const width = opcode === 0xa4 ? 1 : size;
        return this.repeatable(() => {
          const from = this.segmentFor(DS);
          this.write(width, ES, this.index(EDI), this.read(width, from, this.index(ESI)));
          this.advance(ESI, this.delta(width));
          this.advance(EDI, this.delta(width));
        });
      }
      case 0xa6:
      case 0xa7: {
        const width = opcode === 0xa6 ? 1 : size;
        return this.repeatable(() => {
          const from = this.segmentFor(DS);
          this.sub(width, this.read(width, from, this.index(ESI)), this.read(width, ES, this.index(EDI)));
          this.advance(ESI, this.delta(width));
          this.advance(EDI, this.delta(width));
        }, true);
      }
      case 0xa8:
        this.logic('and', 1, this.get8(0), this.fetch8());
        return 1;
      case 0xa9:
        this.logic('and', size, this.get(size, EAX), this.fetch(size));
        return 1;
      case 0xaa:
      case 0xab: {
        const width = opcode === 0xaa ? 1 : size;
        return this.repeatable(() => {
          this.write(width, ES, this.index(EDI), this.get(width, EAX));
          this.advance(EDI, this.delta(width));
        });
      }
      case 0xac:
      case 0xad: {
        const width = opcode === 0xac ? 1 : size;
        return this.repeatable(() => {
          this.set(width, EAX, this.read(width, this.segmentFor(DS), this.index(ESI)));
          this.advance(ESI, this.delta(width));
        });
      }
      case 0xae:
      case 0xaf: {
        const width = opcode === 0xae ? 1 : size;
        return this.repeatable(() => {
          this.sub(width, this.get(width, EAX), this.read(width, ES, this.index(EDI)));
          this.advance(EDI, this.delta(width));
        }, true);
      }

      // ------------------------------------------------------- gli immediati
      case 0xb0:
      case 0xb1:
      case 0xb2:
      case 0xb3:
      case 0xb4:
      case 0xb5:
      case 0xb6:
      case 0xb7:
        this.set8(opcode & 7, this.fetch8());
        return 1;
      case 0xb8:
      case 0xb9:
      case 0xba:
      case 0xbb:
      case 0xbc:
      case 0xbd:
      case 0xbe:
      case 0xbf:
        this.set(size, opcode & 7, this.fetch(size));
        return 1;

      // ------------------------------------------------ scorrimenti e ritorni
      case 0xc0:
        this.modrm();
        this.writeRM(1, this.shiftOp(this.reg, 1, this.readRM(1), this.fetch8()));
        return 2;
      case 0xc1:
        this.modrm();
        this.writeRM(size, this.shiftOp(this.reg, size, this.readRM(size), this.fetch8()));
        return 2;
      case 0xc2: {
        const extra = this.fetch16();
        const target = this.pop(size);
        this.set(this.stacksize, ESP, this.get(this.stacksize, ESP) + extra);
        this.eip = size === 4 ? target >>> 0 : target & 0xffff;
        return 2;
      }
      case 0xc3: {
        const target = this.pop(size);
        this.eip = size === 4 ? target >>> 0 : target & 0xffff;
        return 2;
      }
      case 0xc4:
      case 0xc5: {
        this.modrm();
        if (!this.memory) throw new Fault(INVALID_OPCODE);
        const offset = this.read(size, this.opSegment, this.opOffset);
        const selector = this.read(2, this.opSegment, this.opOffset + size);
        this.set(size, this.reg, offset);
        this.loadSegment(opcode === 0xc4 ? ES : DS, selector);
        return 4;
      }
      case 0xc6:
        this.modrm();
        this.writeRM(1, this.fetch8());
        return 1;
      case 0xc7:
        this.modrm();
        this.writeRM(size, this.fetch(size));
        return 1;
      case 0xc8: {
        // ENTER: lo stack frame in un'istruzione, con i livelli annidati che
        // servivano al Pascal e che il C non ha mai usato.
        const space = this.fetch16();
        const level = this.fetch8() & 0x1f;
        this.push(this.get(size, EBP), size);
        const frame = this.get(this.stacksize, ESP);
        for (let i = 1; i < level; i++) {
          this.set(size, EBP, this.get(size, EBP) - size);
          this.push(this.read(size, SS, this.get(this.stacksize, EBP)), size);
        }
        if (level > 0) this.push(frame, size);
        this.set(size, EBP, frame);
        this.set(this.stacksize, ESP, this.get(this.stacksize, ESP) - space);
        return 6;
      }
      case 0xc9:
        this.set(this.stacksize, ESP, this.get(size, EBP));
        this.set(size, EBP, this.pop(size));
        return 3;
      case 0xca:
      case 0xcb: {
        const extra = opcode === 0xca ? this.fetch16() : 0;
        const target = this.pop(size);
        const selector = this.pop(size);
        const outer = this.protectedMode && (selector & 3) > this.cpl;
        let sp = 0;
        let ss = 0;
        if (outer) {
          this.set(this.stacksize, ESP, this.get(this.stacksize, ESP) + extra);
          sp = this.pop(size);
          ss = this.pop(size);
        }
        this.farJump(selector, target);
        if (outer) {
          this.loadSegment(SS, ss);
          this.set(this.stacksize, ESP, sp);
        } else {
          this.set(this.stacksize, ESP, this.get(this.stacksize, ESP) + extra);
        }
        return 5;
      }
      case 0xcc:
        this.interrupt(BREAKPOINT, { software: true });
        return 10;
      case 0xcd:
        this.interrupt(this.fetch8(), { software: true });
        return 10;
      case 0xce:
        if (this.of) this.interrupt(OVERFLOW_TRAP, { software: true });
        return 3;
      case 0xcf:
        this.iret(size);
        return 10;

      case 0xd0:
        this.modrm();
        this.writeRM(1, this.shiftOp(this.reg, 1, this.readRM(1), 1));
        return 2;
      case 0xd1:
        this.modrm();
        this.writeRM(size, this.shiftOp(this.reg, size, this.readRM(size), 1));
        return 2;
      case 0xd2:
        this.modrm();
        this.writeRM(1, this.shiftOp(this.reg, 1, this.readRM(1), this.get8(1)));
        return 2;
      case 0xd3:
        this.modrm();
        this.writeRM(size, this.shiftOp(this.reg, size, this.readRM(size), this.get8(1)));
        return 2;
      case 0xd4: {
        const by = this.fetch8();
        if (by === 0) throw new Fault(DIVIDE_ERROR);
        const al = this.get8(0);
        this.set8(4, Math.floor(al / by));
        this.set8(0, al % by);
        this.setResultFlags(1, this.get8(0));
        return 15;
      }
      case 0xd5: {
        const by = this.fetch8();
        this.set8(0, (this.get8(4) * by + this.get8(0)) & 0xff);
        this.set8(4, 0);
        this.setResultFlags(1, this.get8(0));
        return 3;
      }
      case 0xd7:
        this.set8(0, this.read(1, this.segmentFor(DS), this.index(EBX) + this.get8(0)));
        return 3;
      case 0xd8:
      case 0xd9:
      case 0xda:
      case 0xdb:
      case 0xdc:
      case 0xdd:
      case 0xde:
      case 0xdf:
        // La virgola mobile. Sul Pentium sta dentro il processore per la prima
        // volta, e qui non c'è ancora: è il pezzo dopo, e finché non c'è è
        // meglio dirlo che eseguire qualcosa a caso.
        throw new Unsupported(`la virgola mobile non c'è ancora (opcode ${opcode.toString(16)})`);

      // ------------------------------------------------------ i cicli e i salti
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const offset = this.fetchSigned8();
        this.counter = this.counter - 1;
        const zero = opcode === 0xe1 ? this.zf === 1 : opcode === 0xe0 ? this.zf === 0 : true;
        if (this.counter !== 0 && zero) this.jump(offset);
        return 2;
      }
      case 0xe3: {
        const offset = this.fetchSigned8();
        if (this.counter === 0) this.jump(offset);
        return 2;
      }
      case 0xe4:
        this.set8(0, this.portIn(1, this.fetch8()));
        return 5;
      case 0xe5:
        this.set(size, EAX, this.portIn(size, this.fetch8()));
        return 5;
      case 0xe6:
        this.portOut(1, this.fetch8(), this.get8(0));
        return 5;
      case 0xe7:
        this.portOut(size, this.fetch8(), this.get(size, EAX));
        return 5;
      case 0xe8: {
        const offset = signed(size, this.fetch(size));
        this.push(this.eip, size);
        this.jump(offset);
        return 2;
      }
      case 0xe9:
        this.jump(signed(size, this.fetch(size)));
        return 1;
      case 0xea: {
        const offset = this.fetch(size);
        this.farJump(this.fetch16(), offset);
        return 4;
      }
      case 0xeb:
        this.jump(this.fetchSigned8());
        return 1;
      case 0xec:
        this.set8(0, this.portIn(1, this.get16(EDX)));
        return 5;
      case 0xed:
        this.set(size, EAX, this.portIn(size, this.get16(EDX)));
        return 5;
      case 0xee:
        this.portOut(1, this.get16(EDX), this.get8(0));
        return 5;
      case 0xef:
        this.portOut(size, this.get16(EDX), this.get(size, EAX));
        return 5;

      // ------------------------------------------------------- i flag e i gruppi
      case 0xf4:
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        this.halted = true;
        return 1;
      case 0xf5:
        this.cf ^= 1;
        return 1;
      case 0xf6:
      case 0xf7:
        return this.group3(opcode === 0xf6 ? 1 : size);
      case 0xf8:
        this.cf = 0;
        return 1;
      case 0xf9:
        this.cf = 1;
        return 1;
      case 0xfa:
        this.checkIOPrivilege();
        this.if_ = 0;
        return 1;
      case 0xfb:
        this.checkIOPrivilege();
        this.if_ = 1;
        // Le interruzioni entrano dopo l'istruzione *seguente*: è il rinvio che
        // fa funzionare `sti` seguito da `hlt`, e che ogni gestore di interrupt
        // del mondo dà per scontato.
        this.stiDelay = 2;
        return 1;
      case 0xfc:
        this.df = 0;
        return 1;
      case 0xfd:
        this.df = 1;
        return 1;
      case 0xfe:
      case 0xff:
        return this.group5(opcode === 0xfe ? 1 : size);
      case 0x0f:
        return this.execute0F(this.fetch8(), size);
      default:
        throw new Fault(INVALID_OPCODE);
    }
  }

  /** Un salto relativo, che si conta dall'istruzione dopo. */
  jump(offset) {
    this.eip = this.opsize === 4 ? (this.eip + offset) >>> 0 : (this.eip + offset) & 0xffff;
  }

  /** F6/F7: prova, nega, moltiplica e dividi. */
  group3(size) {
    this.modrm();
    switch (this.reg) {
      case 0:
      case 1:
        this.logic('and', size, this.readRM(size), this.fetch(size));
        return 2;
      case 2:
        this.writeRM(size, trim(size, ~this.readRM(size)));
        return 2;
      case 3: {
        const value = this.readRM(size);
        this.writeRM(size, this.sub(size, 0, value));
        this.cf = value === 0 ? 0 : 1;
        return 2;
      }
      case 4:
      case 5: {
        const withSign = this.reg === 5;
        const { low, high, full } = this.multiply(size, this.get(size, EAX), this.readRM(size), withSign);
        if (size === 1) this.set16(EAX, (high << 8) | low);
        else {
          this.set(size, EAX, low);
          this.set(size, EDX, high);
        }
        // Il riporto dice se la metà alta serve davvero: è così che si sa se il
        // risultato ci stava nella misura di partenza.
        if (withSign) {
          const fits = BigInt(signed(size, low)) === full;
          this.cf = fits ? 0 : 1;
        } else this.cf = high !== 0 ? 1 : 0;
        this.of = this.cf;
        this.setResultFlags(size, low);
        return 11;
      }
      default: {
        const withSign = this.reg === 7;
        const divisor = this.readRM(size);
        const high = size === 1 ? this.get8(4) : this.get(size, EDX);
        const low = size === 1 ? this.get8(0) : this.get(size, EAX);
        const { quotient, remainder } = this.divide(size, high, low, divisor, withSign);
        if (size === 1) {
          this.set8(0, quotient);
          this.set8(4, remainder);
        } else {
          this.set(size, EAX, quotient);
          this.set(size, EDX, remainder);
        }
        return 25;
      }
    }
  }

  /** FE/FF: incrementa, decrementa, chiama, salta, impila. */
  group5(size) {
    this.modrm();
    switch (this.reg) {
      case 0:
        this.writeRM(size, this.inc(size, this.readRM(size)));
        return 2;
      case 1:
        this.writeRM(size, this.dec(size, this.readRM(size)));
        return 2;
      case 2: {
        const target = this.readRM(size);
        this.push(this.eip, size);
        this.eip = size === 4 ? target >>> 0 : target & 0xffff;
        return 2;
      }
      case 3: {
        if (!this.memory) throw new Fault(INVALID_OPCODE);
        const offset = this.read(size, this.opSegment, this.opOffset);
        const selector = this.read(2, this.opSegment, this.opOffset + size);
        this.push(this.s[CS], size);
        this.push(this.eip, size);
        this.farJump(selector, offset);
        return 6;
      }
      case 4: {
        const target = this.readRM(size);
        this.eip = size === 4 ? target >>> 0 : target & 0xffff;
        return 1;
      }
      case 5: {
        if (!this.memory) throw new Fault(INVALID_OPCODE);
        const offset = this.read(size, this.opSegment, this.opOffset);
        const selector = this.read(2, this.opSegment, this.opOffset + size);
        this.farJump(selector, offset);
        return 4;
      }
      case 6:
        this.push(this.readRM(size), size);
        return 2;
      default:
        throw new Fault(INVALID_OPCODE);
    }
  }

  // ------------------------------------------------ gli opcode a due byte (0F)

  /**
   * La tabella che comincia con 0F, che è dove l'architettura è cresciuta.
   *
   * Nel 1978 gli opcode a un byte erano finiti quasi tutti, e ogni processore
   * nuovo ne voleva di più. La soluzione è stata prendere l'ultimo byte libero e
   * farne una porta: 0F non è un'istruzione, è "guarda nell'altra tabella". Da lì
   * in poi tutto quello che Intel ha aggiunto in quarant'anni è entrato da questa
   * porta — il modo protetto, i bit, CPUID, MMX, SSE, e tutto il resto.
   */
  execute0F(opcode, size) {
    switch (opcode) {
      case 0x00:
        return this.group6();
      case 0x01:
        return this.group7(size);
      case 0x02:
      case 0x03: {
        // LAR e LSL: chiedere alla tabella com'è fatto un segmento senza
        // caricarlo. Serve a un sistema operativo per controllare un selettore
        // che gli è arrivato da fuori.
        this.modrm();
        const selector = this.readRM(2);
        if ((selector & 0xfffc) === 0) {
          this.zf = 0;
          return 3;
        }
        const d = this.descriptorAt(selector);
        this.zf = d.present ? 1 : 0;
        if (d.present) this.set(size, this.reg, opcode === 0x02 ? d.high & 0x00ffff00 : d.limit);
        return 3;
      }
      case 0x06:
        // CLTS: spegne il bit che dice "il coprocessore ha lo stato di un altro
        // programma". Esiste solo per far cambiare contesto alla virgola mobile.
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        this.cr0 &= ~CR0_TS;
        return 2;
      case 0x08:
      case 0x09:
        // INVD e WBINVD: svuotare la cache. Qui non c'è nessuna cache da
        // svuotare, e la memoria è sempre già scritta.
        return 2;
      case 0x0b:
        throw new Fault(INVALID_OPCODE); // UD2, che serve proprio a questo
      case 0x20:
      case 0x22: {
        // I registri di controllo, che sono il quadro comandi del processore.
        this.modrm();
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        const which = this.reg;
        if (opcode === 0x20) {
          this.set32(this.rm, this.readControl(which));
          return 4;
        }
        this.writeControl(which, this.get32(this.rm));
        return 4;
      }
      case 0x21:
      case 0x23: {
        this.modrm();
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        if (opcode === 0x21) this.set32(this.rm, this.dr[this.reg]);
        else this.dr[this.reg] = this.get32(this.rm);
        return 4;
      }
      case 0x30:
      case 0x32: {
        // I registri di modello: la scatola dei bottoni che cambiano da un
        // processore all'altro, e il posto da cui si legge il contatore di cicli.
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        this.msr ??= new Map();
        const which = this.get32(ECX);
        if (opcode === 0x32) {
          const value = which === 0x10 ? BigInt(Math.floor(this.tsc)) : (this.msr.get(which) ?? 0n);
          this.set32(EAX, Number(BigInt(value) & 0xffffffffn));
          this.set32(EDX, Number((BigInt(value) >> 32n) & 0xffffffffn));
        } else {
          const value = (BigInt(this.get32(EDX)) << 32n) | BigInt(this.get32(EAX));
          if (which === 0x10) this.tsc = Number(value);
          else this.msr.set(which, value);
        }
        return 10;
      }
      case 0x31: {
        // RDTSC: il contatore dei cicli, in EDX:EAX. È la prima volta che un
        // programma può misurare il tempo con la precisione di un ciclo, e da qui
        // viene ogni benchmark dei trent'anni successivi.
        const count = Math.floor(this.tsc);
        this.set32(EAX, count % 0x100000000);
        this.set32(EDX, Math.floor(count / 0x100000000));
        return 5;
      }
      case 0xa2:
        return this.cpuid();
      case 0x80:
      case 0x81:
      case 0x82:
      case 0x83:
      case 0x84:
      case 0x85:
      case 0x86:
      case 0x87:
      case 0x88:
      case 0x89:
      case 0x8a:
      case 0x8b:
      case 0x8c:
      case 0x8d:
      case 0x8e:
      case 0x8f: {
        // I salti condizionati lunghi: sul 286 un `if` che non stesse in 127
        // byte voleva due salti, uno all'incontrario. Dal 386 non più.
        const offset = signed(size, this.fetch(size));
        if (this.condition(opcode & 0x0f)) this.jump(offset);
        return 1;
      }
      case 0x90:
      case 0x91:
      case 0x92:
      case 0x93:
      case 0x94:
      case 0x95:
      case 0x96:
      case 0x97:
      case 0x98:
      case 0x99:
      case 0x9a:
      case 0x9b:
      case 0x9c:
      case 0x9d:
      case 0x9e:
      case 0x9f:
        // SETcc: la condizione che diventa un numero invece di un salto, cioè il
        // modo di scrivere `a = b > c` senza far indovinare niente al processore.
        this.modrm();
        this.writeRM(1, this.condition(opcode & 0x0f) ? 1 : 0);
        return 1;
      case 0xa0:
        this.push(this.s[FS], size);
        return 1;
      case 0xa1:
        this.loadSegment(FS, this.pop(size));
        return 3;
      case 0xa8:
        this.push(this.s[GS], size);
        return 1;
      case 0xa9:
        this.loadSegment(GS, this.pop(size));
        return 3;
      case 0xa3:
      case 0xab:
      case 0xb3:
      case 0xbb: {
        this.modrm();
        const which = { 0xa3: 'test', 0xab: 'set', 0xb3: 'reset', 0xbb: 'complement' }[opcode];
        return this.bitOperation(size, which, this.get(size, this.reg));
      }
      case 0xba: {
        this.modrm();
        const which = ['', '', '', '', 'test', 'set', 'reset', 'complement'][this.reg];
        if (!which) throw new Fault(INVALID_OPCODE);
        return this.bitOperation(size, which, this.fetch8());
      }
      case 0xa4:
      case 0xa5:
      case 0xac:
      case 0xad: {
        const left = opcode === 0xa4 || opcode === 0xa5;
        this.modrm();
        const count = opcode === 0xa4 || opcode === 0xac ? this.fetch8() : this.get8(1);
        this.writeRM(
          size,
          this.doubleShift(size, left, this.readRM(size), this.get(size, this.reg), count),
        );
        return 3;
      }
      case 0xaf: {
        this.modrm();
        const { low, full } = this.multiply(size, this.get(size, this.reg), this.readRM(size), true);
        this.set(size, this.reg, low);
        this.cf = BigInt(signed(size, low)) === full ? 0 : 1;
        this.of = this.cf;
        this.setResultFlags(size, low);
        return 10;
      }
      case 0xb0:
      case 0xb1: {
        // CMPXCHG: confronta e scambia in un colpo solo. È il mattone con cui si
        // fa un lucchetto fra due processori, e non a caso arriva col Pentium,
        // che è il primo x86 pensato per andare in coppia.
        const width = opcode === 0xb0 ? 1 : size;
        this.modrm();
        const current = this.readRM(width);
        const expected = this.get(width, EAX);
        this.sub(width, expected, current);
        if (this.zf) this.writeRM(width, this.get(width, this.reg));
        else this.set(width, EAX, current);
        return 6;
      }
      case 0xb2:
      case 0xb4:
      case 0xb5: {
        this.modrm();
        if (!this.memory) throw new Fault(INVALID_OPCODE);
        const offset = this.read(size, this.opSegment, this.opOffset);
        const selector = this.read(2, this.opSegment, this.opOffset + size);
        this.set(size, this.reg, offset);
        this.loadSegment(opcode === 0xb2 ? SS : opcode === 0xb4 ? FS : GS, selector);
        return 4;
      }
      case 0xb6:
      case 0xb7: {
        // MOVZX: allunga senza segno. Prima del 386 ci volevano due istruzioni e
        // un registro azzerato a mano.
        this.modrm();
        const from = opcode === 0xb6 ? 1 : 2;
        this.set(size, this.reg, this.readRM(from));
        return 1;
      }
      case 0xbe:
      case 0xbf: {
        this.modrm();
        const from = opcode === 0xbe ? 1 : 2;
        this.set(size, this.reg, trim(size, signed(from, this.readRM(from))));
        return 1;
      }
      case 0xbc:
      case 0xbd: {
        // BSF e BSR: trovare il primo bit acceso, da una parte o dall'altra. È
        // l'istruzione con cui un sistema operativo cerca una pagina libera in
        // una mappa di bit.
        this.modrm();
        const value = this.readRM(size);
        if (value === 0) {
          this.zf = 1;
          return 6;
        }
        this.zf = 0;
        const bits = size * 8;
        let found = 0;
        if (opcode === 0xbc) while (((value >>> found) & 1) === 0) found++;
        else {
          found = bits - 1;
          while (((value >>> found) & 1) === 0) found--;
        }
        this.set(size, this.reg, found);
        return 6;
      }
      case 0xc0:
      case 0xc1: {
        // XADD: somma e restituisce quello che c'era. Un contatore condiviso in
        // un'istruzione.
        const width = opcode === 0xc0 ? 1 : size;
        this.modrm();
        const before = this.readRM(width);
        const sum = this.add(width, before, this.get(width, this.reg));
        this.set(width, this.reg, before);
        this.writeRM(width, sum);
        return 4;
      }
      case 0xc7: {
        this.modrm();
        if (this.reg !== 1 || !this.memory) throw new Fault(INVALID_OPCODE);
        // CMPXCHG8B: lo stesso confronta-e-scambia su otto byte, che è quanto
        // serve per scambiare un puntatore e un contatore insieme.
        const low = this.read(4, this.opSegment, this.opOffset);
        const high = this.read(4, this.opSegment, this.opOffset + 4);
        if (low === this.get32(EAX) && high === this.get32(EDX)) {
          this.zf = 1;
          this.write(4, this.opSegment, this.opOffset, this.get32(EBX));
          this.write(4, this.opSegment, this.opOffset + 4, this.get32(ECX));
        } else {
          this.zf = 0;
          this.set32(EAX, low);
          this.set32(EDX, high);
        }
        return 6;
      }
      case 0xc8:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcc:
      case 0xcd:
      case 0xce:
      case 0xcf: {
        // BSWAP: i byte all'incontrario, cioè la conversione fra l'ordine di
        // Intel e quello della rete, che prima costava quattro istruzioni.
        const index = opcode & 7;
        const value = this.get32(index);
        this.set32(
          index,
          ((value >>> 24) | ((value >>> 8) & 0xff00) | ((value << 8) & 0xff0000) | (value << 24)) >>> 0,
        );
        return 1;
      }
      default:
        throw new Fault(INVALID_OPCODE);
    }
  }

  /**
   * I bit, indirizzati uno per uno. Su un registro l'indice gira dentro la
   * misura; in memoria no — e non è un dettaglio: è quello che permette di
   * trattare la memoria come una mappa di bit lunga quanto si vuole, che è
   * esattamente come si tiene il conto dei blocchi liberi di un disco.
   */
  bitOperation(size, which, offset) {
    const bits = size * 8;
    let value;
    let at = 0;
    if (this.memory) {
      at = this.opOffset + Math.floor(signed(size, offset) / bits) * size;
      value = this.read(size, this.opSegment, at);
    } else value = this.get(size, this.rm);
    const bit = ((offset % bits) + bits) % bits;
    this.cf = (value >>> bit) & 1;
    if (which === 'test') return 3;
    const mask = 1 << bit;
    const result =
      which === 'set' ? value | mask : which === 'reset' ? value & ~mask : value ^ mask;
    if (this.memory) this.write(size, this.opSegment, at, result);
    else this.set(size, this.rm, result);
    return 3;
  }

  readControl(which) {
    if (which === 0) return this.cr0 >>> 0;
    if (which === 2) return this.cr2 >>> 0;
    if (which === 3) return this.cr3 >>> 0;
    if (which === 4) return this.cr4 >>> 0;
    return 0;
  }

  /**
   * Scrivere in CR0 è il momento in cui la macchina cambia mondo: il bit 0
   * accende il modo protetto, e il bit 31 la paginazione. Sono le due righe di
   * codice più importanti di qualunque sistema operativo, e l'istruzione dopo
   * gira in un mondo diverso da quella prima.
   */
  writeControl(which, value) {
    if (which === 0) {
      const before = this.cr0;
      this.cr0 = value >>> 0;
      if ((before & CR0_PG) !== (this.cr0 & CR0_PG)) this.flushTLB();
      if ((this.cr0 & CR0_PG) && !(this.cr0 & CR0_PE)) {
        // Paginare senza modo protetto non si può: è una combinazione che il
        // processore rifiuta, perché non ci sarebbe nessun anello da difendere.
        throw new Fault(GENERAL_PROTECTION, 0);
      }
      return;
    }
    if (which === 2) this.cr2 = value >>> 0;
    else if (which === 3) {
      this.cr3 = value >>> 0;
      this.flushTLB();
    } else if (which === 4) {
      this.cr4 = value >>> 0;
      this.flushTLB();
    }
  }

  /**
   * CPUID, che è l'istruzione con cui il software ha smesso di indovinare.
   *
   * Prima di lei si capiva che processore c'era sotto a forza di trucchi — quali
   * bit di FLAGS restavano accesi, se una divisione per zero lasciava lo stack in
   * un certo modo, quanto ci metteva un ciclo — e ogni programma lo faceva a modo
   * suo, sbagliando. Dal Pentium si chiede: in EAX si mette cosa si vuole sapere,
   * e il processore risponde. Il nome del produttore esce dai tre registri in
   * ordine sparso, dodici caratteri, che è il primo pezzo di testo che l'hardware
   * x86 abbia mai restituito.
   */
  cpuid() {
    const leaf = this.get32(EAX);
    if (leaf === 0) {
      this.set32(EAX, 1); // fin dove si può chiedere
      this.set32(EBX, 0x756e6547); // "Genu"
      this.set32(EDX, 0x49656e69); // "ineI"
      this.set32(ECX, 0x6c65746e); // "ntel"
      return 5;
    }
    if (leaf === 1) {
      // Famiglia 5, modello 2: un Pentium da 75-200 MHz, quello che c'era
      // dentro i PC del 1995.
      this.set32(EAX, 0x0000052c);
      this.set32(EBX, 0);
      this.set32(ECX, 0);
      // Quello che questa macchina sa fare davvero, e niente di più: le pagine
      // grandi, il contatore di cicli, i registri di modello, CMPXCHG8B. Il bit
      // della virgola mobile resta spento finché la virgola mobile non c'è: un
      // processore che dice di avere un coprocessore e non ce l'ha è peggio di
      // uno che dice di non averlo.
      this.set32(EDX, 0x00000138);
      return 5;
    }
    this.set32(EAX, 0);
    this.set32(EBX, 0);
    this.set32(ECX, 0);
    this.set32(EDX, 0);
    return 5;
  }

  /** 0F 00: la tabella locale e il descrittore del task. */
  group6() {
    this.modrm();
    switch (this.reg) {
      case 0:
        this.writeRM(2, this.ldt.selector);
        return 2;
      case 1:
        this.writeRM(2, this.tr.selector);
        return 2;
      case 2: {
        if (this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        const selector = this.readRM(2);
        if ((selector & 0xfffc) === 0) {
          this.ldt = { selector, base: 0, limit: 0 };
          return 3;
        }
        const d = this.descriptorAt(selector);
        if (!d.system || d.type !== 2) throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
        if (!d.present) throw new Fault(SEGMENT_NOT_PRESENT, selector & 0xfffc);
        this.ldt = { selector, base: d.base, limit: d.limit };
        return 3;
      }
      case 3: {
        if (this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        const selector = this.readRM(2);
        const d = this.descriptorAt(selector);
        if (!d.system || (d.type !== 9 && d.type !== 1)) {
          throw new Fault(GENERAL_PROTECTION, selector & 0xfffc);
        }
        if (!d.present) throw new Fault(SEGMENT_NOT_PRESENT, selector & 0xfffc);
        this.tr = { selector, base: d.base, limit: d.limit, busy: true };
        return 3;
      }
      case 4:
      case 5: {
        // VERR e VERW: si può leggere? si può scrivere? senza provarci.
        const selector = this.readRM(2);
        if ((selector & 0xfffc) === 0) {
          this.zf = 0;
          return 3;
        }
        const d = this.descriptorAt(selector);
        const code = (d.type & 8) !== 0;
        const ok =
          !d.system &&
          d.present &&
          (this.reg === 4 ? !code || (d.type & 2) !== 0 : !code && (d.type & 2) !== 0);
        this.zf = ok ? 1 : 0;
        return 3;
      }
      default:
        throw new Fault(INVALID_OPCODE);
    }
  }

  /**
   * 0F 01: le due tabelle di sistema, la parola di stato, e lo svuotamento di
   * una traduzione. Sono cinque istruzioni che un programma normale non
   * eseguirà mai, e le prime tre che esegue ogni sistema operativo.
   */
  group7(size) {
    this.modrm();
    switch (this.reg) {
      case 0:
      case 1: {
        const table = this.reg === 0 ? this.gdt : this.idt;
        this.write(2, this.opSegment, this.opOffset, table.limit);
        this.write(4, this.opSegment, this.opOffset + 2, table.base);
        return 3;
      }
      case 2:
      case 3: {
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        if (!this.memory) throw new Fault(INVALID_OPCODE);
        const limit = this.read(2, this.opSegment, this.opOffset);
        const base = this.read(4, this.opSegment, this.opOffset + 2);
        // Con gli operandi a sedici bit la base è di ventiquattro: è la forma del
        // 286, e il byte in cima si butta. Chi carica una GDT sopra i sedici mega
        // con il prefisso sbagliato passa il pomeriggio a chiedersi perché.
        const value = { base: size === 4 ? base >>> 0 : base & 0xffffff, limit };
        if (this.reg === 2) this.gdt = value;
        else this.idt = value;
        return 4;
      }
      case 4:
        this.writeRM(2, this.cr0 & 0xffff);
        return 2;
      case 6: {
        // LMSW: i sedici bit bassi di CR0, che è come si accendeva il modo
        // protetto sul 286 — e come lo accende ancora ogni BIOS, perché quel
        // codice non l'ha più riscritto nessuno.
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        const value = this.readRM(2);
        this.writeControl(0, (this.cr0 & 0xffff0000) | (value & 0xffff));
        return 3;
      }
      case 7:
        if (this.protectedMode && this.cpl !== 0) throw new Fault(GENERAL_PROTECTION, 0);
        this.flushTLB(this.memory ? this.linear(this.opSegment, this.opOffset) >>> 12 : -1);
        return 3;
      default:
        throw new Fault(INVALID_OPCODE);
    }
  }
}

/** Un segmento non ancora caricato: base zero, limite zero, e nessun diritto. */
function descriptorCache() {
  return {
    base: 0,
    limit: 0,
    /** Se il segmento è di codice, e se è a trentadue bit (il bit D o B). */
    code: false,
    big: false,
    /** Se ci si può scrivere (dati) o leggere (codice). */
    writable: true,
    readable: true,
    /** I segmenti di dati possono crescere all'ingiù: è così che si fa uno stack. */
    expandDown: false,
    /** Di chi è, e se c'è. */
    dpl: 0,
    present: true,
  };
}
