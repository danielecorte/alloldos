// Lo Zilog Z80, che è un 8080 con dentro il senno di poi.
//
// Federico Faggin aveva progettato l'8080 per Intel e se n'era andato a farne
// uno suo. Il risultato è un processore che esegue tutto il codice dell'8080 e
// in più ha: un secondo banco di registri che si scambia con il primo in
// quattro cicli, due registri indice, le istruzioni di blocco che copiano
// mezza memoria in una riga sola, e i bit — provare, mettere e togliere un
// singolo bit, che su una macchina che disegna a schermo per pixel è metà del
// lavoro.
//
// Tutto questo sta in un modo di codificare le istruzioni che sembra un
// disastro e non lo è. Ogni opcode si legge a fette di bit — due in cima, tre
// in mezzo, tre in fondo — e quelle fette dicono sempre la stessa cosa: quale
// registro, quale condizione, quale operazione dell'unità aritmetica. Le
// istruzioni non sono 252 casi separati, sono un paio di dozzine di regole che
// si incrociano, ed è per questo che questo file decodifica invece di
// consultare una tabella: è più corto, e soprattutto è quello che il chip fa.
//
// Le quattro istruzioni che stanno fuori dalle regole si prendono un prefisso:
// CB per i bit, ED per le istruzioni di blocco e le stranezze, DD e FD per
// dire "dove c'era HL leggi IX" oppure IY. Prefissi che si sommano: DD CB è
// "l'operazione sui bit, ma sul byte all'indirizzo IX più uno spostamento".
//
// Il tempo si conta in T-state, e va contato bene: sullo Spectrum il
// caricamento da nastro misura la durata degli impulsi contando cicli, e il
// video è appeso agli stessi cicli. Qui i cicli non stanno in una tabella ma
// si sommano dai giri sul bus, che è come nascono davvero: quattro per andare
// a prendere l'istruzione, tre per ogni byte letto o scritto, quattro per una
// porta, più i giri interni che ogni istruzione si aggiunge da sé.

/** I flag, nella posizione in cui stanno dentro F. */
export const FLAG_C = 0x01;
export const FLAG_N = 0x02;
export const FLAG_P = 0x04; // parità, e anche overflow: lo stesso bit
export const FLAG_3 = 0x08; // copia del bit 3 del risultato: non documentato
export const FLAG_H = 0x10;
export const FLAG_5 = 0x20; // copia del bit 5 del risultato: non documentato
export const FLAG_Z = 0x40;
export const FLAG_S = 0x80;

/** Segno, zero e i due bit non documentati, per ogni byte possibile. */
const SZ53 = new Uint8Array(256);
const SZ53P = new Uint8Array(256);
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let bits = 0;
  for (let bit = 0; bit < 8; bit++) if (i & (1 << bit)) bits++;
  PARITY[i] = bits & 1 ? 0 : FLAG_P;
  SZ53[i] = (i & (FLAG_3 | FLAG_5 | FLAG_S)) | (i === 0 ? FLAG_Z : 0);
  SZ53P[i] = SZ53[i] | PARITY[i];
}

/** I nomi dei registri a otto bit nell'ordine in cui li numera l'opcode. */
export const B = 0, C = 1, D = 2, E = 3, H = 4, L = 5, A = 7;

export class Z80 {
  /**
   * @param {object} bus
   * @param {(addr:number)=>number} bus.read8
   * @param {(addr:number,value:number)=>void} bus.write8
   * @param {(port:number)=>number} bus.inb
   * @param {(port:number,value:number)=>void} bus.outb
   * @param {(addr:number)=>number} [bus.fetch8] la lettura dell'istruzione, se
   *   la macchina vuole contare i cicli rubati dal video in modo diverso
   */
  constructor(bus) {
    this.bus = bus;
    this.reset();
  }

  reset() {
    /** I sette registri più F, nell'ordine dell'opcode: B C D E H L (HL) A. */
    this.r = new Uint8Array(8);
    this.f = 0;
    /** Il banco alternativo, quello che EXX e EX AF,AF' tirano fuori. */
    this.alt = { r: new Uint8Array(8), f: 0 };
    this.ix = 0;
    this.iy = 0;
    this.sp = 0xffff;
    this.pc = 0;
    /** Il registro di rinfresco, che conta da sé e che i giochi guardano. */
    this.i = 0;
    this.rReg = 0;
    /** Le due copie del permesso di interruzione, e il modo. */
    this.iff1 = false;
    this.iff2 = false;
    this.im = 1;
    this.halted = false;
    /** Vero subito dopo una EI: un'interruzione non passa fino all'istruzione dopo. */
    this.eiPending = false;
    /** I T-state consumati dall'ultima istruzione. */
    this.t = 0;
    /** Quanti in tutto da quando è acceso: il tempo della macchina. */
    this.cycles = 0;
  }

  // ------------------------------------------------------------ le coppie

  get bc() { return (this.r[B] << 8) | this.r[C]; }
  set bc(v) { this.r[B] = (v >> 8) & 0xff; this.r[C] = v & 0xff; }
  get de() { return (this.r[D] << 8) | this.r[E]; }
  set de(v) { this.r[D] = (v >> 8) & 0xff; this.r[E] = v & 0xff; }
  get hl() { return (this.r[H] << 8) | this.r[L]; }
  set hl(v) { this.r[H] = (v >> 8) & 0xff; this.r[L] = v & 0xff; }
  get af() { return (this.r[A] << 8) | this.f; }
  set af(v) { this.r[A] = (v >> 8) & 0xff; this.f = v & 0xff; }

  // --------------------------------------------------------------- il bus
  //
  // Ogni giro sul bus costa, e il costo si somma qui invece che in una
  // tabella: è il modo in cui i T-state vengono fuori davvero.

  read8(addr) {
    this.t += 3;
    return this.bus.read8(addr & 0xffff);
  }

  write8(addr, value) {
    this.t += 3;
    this.bus.write8(addr & 0xffff, value & 0xff);
  }

  read16(addr) {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  write16(addr, value) {
    this.write8(addr, value & 0xff);
    this.write8(addr + 1, (value >> 8) & 0xff);
  }

  /** Il byte dell'istruzione: quattro cicli, e il rinfresco avanza di uno. */
  fetch() {
    this.t += 4;
    this.rReg = (this.rReg & 0x80) | ((this.rReg + 1) & 0x7f);
    const byte = this.bus.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return byte;
  }

  /** Un byte immediato, che non fa avanzare il rinfresco. */
  immediate() {
    const byte = this.read8(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return byte;
  }

  immediate16() {
    const low = this.immediate();
    return low | (this.immediate() << 8);
  }

  push(value) {
    this.sp = (this.sp - 1) & 0xffff;
    this.write8(this.sp, (value >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.write8(this.sp, value & 0xff);
  }

  pop() {
    const low = this.read8(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const high = this.read8(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return low | (high << 8);
  }

  in(port) {
    this.t += 4;
    return this.bus.inb(port & 0xffff);
  }

  out(port, value) {
    this.t += 4;
    this.bus.outb(port & 0xffff, value & 0xff);
  }

  // ------------------------------------------------- registri e prefissi
  //
  // Un prefisso DD o FD non cambia l'istruzione: cambia il significato della
  // parola "HL" dentro l'istruzione. Tutto il resto resta identico, ed è per
  // questo che qui c'è un solo decodificatore e non tre.

  /** Il registro indice in uso: HL, IX o IY. */
  index(prefix) {
    if (prefix === 0xdd) return this.ix;
    if (prefix === 0xfd) return this.iy;
    return this.hl;
  }

  setIndex(prefix, value) {
    if (prefix === 0xdd) this.ix = value & 0xffff;
    else if (prefix === 0xfd) this.iy = value & 0xffff;
    else this.hl = value & 0xffff;
  }

  /**
   * L'indirizzo su cui lavora un'istruzione che parla di (HL). Senza prefisso
   * è HL; con un prefisso è l'indice più uno spostamento con segno, e leggere
   * quello spostamento costa cinque cicli interni in più.
   */
  address(prefix, forDisplacement = true) {
    if (!prefix) return this.hl;
    const displacement = (this.immediate() << 24) >> 24;
    if (forDisplacement) this.t += 5;
    return (this.index(prefix) + displacement) & 0xffff;
  }

  /**
   * Legge il registro numero `index`. Il 6 non è un registro: è la memoria a
   * (HL), che con un prefisso diventa (IX+d) — e in quel caso H e L sono le
   * due metà dell'indice, tranne quando l'istruzione è già su (IX+d), perché
   * un'istruzione sola non può usare l'indice in due modi diversi.
   */
  get8(index, prefix, addr) {
    if (index === 6) return this.read8(addr);
    if (prefix && index === H) return (this.index(prefix) >> 8) & 0xff;
    if (prefix && index === L) return this.index(prefix) & 0xff;
    return this.r[index];
  }

  set8(index, value, prefix, addr) {
    if (index === 6) return this.write8(addr, value);
    if (prefix && index === H) {
      return this.setIndex(prefix, (this.index(prefix) & 0x00ff) | ((value & 0xff) << 8));
    }
    if (prefix && index === L) {
      return this.setIndex(prefix, (this.index(prefix) & 0xff00) | (value & 0xff));
    }
    this.r[index] = value & 0xff;
    return undefined;
  }

  /** Le coppie come le numera l'opcode: BC, DE, HL/indice, SP. */
  getPair(index, prefix) {
    switch (index) {
      case 0: return this.bc;
      case 1: return this.de;
      case 2: return this.index(prefix);
      default: return this.sp;
    }
  }

  setPair(index, value, prefix) {
    switch (index) {
      case 0: this.bc = value & 0xffff; return;
      case 1: this.de = value & 0xffff; return;
      case 2: this.setIndex(prefix, value); return;
      default: this.sp = value & 0xffff;
    }
  }

  /** Le otto condizioni: NZ, Z, NC, C, PO, PE, P, M. */
  condition(index) {
    switch (index) {
      case 0: return (this.f & FLAG_Z) === 0;
      case 1: return (this.f & FLAG_Z) !== 0;
      case 2: return (this.f & FLAG_C) === 0;
      case 3: return (this.f & FLAG_C) !== 0;
      case 4: return (this.f & FLAG_P) === 0;
      case 5: return (this.f & FLAG_P) !== 0;
      case 6: return (this.f & FLAG_S) === 0;
      default: return (this.f & FLAG_S) !== 0;
    }
  }

  // ------------------------------------------------------- l'aritmetica

  add8(value, carry = 0) {
    const a = this.r[A];
    const result = a + value + carry;
    const byte = result & 0xff;
    this.f =
      SZ53[byte] |
      (result > 0xff ? FLAG_C : 0) |
      (((a ^ ~value) & (a ^ byte) & 0x80) ? FLAG_P : 0) |
      (((a & 0x0f) + (value & 0x0f) + carry) & 0x10 ? FLAG_H : 0);
    this.r[A] = byte;
  }

  sub8(value, carry = 0) {
    const a = this.r[A];
    const result = a - value - carry;
    const byte = result & 0xff;
    this.f =
      SZ53[byte] |
      FLAG_N |
      (result < 0 ? FLAG_C : 0) |
      (((a ^ value) & (a ^ byte) & 0x80) ? FLAG_P : 0) |
      (((a & 0x0f) - (value & 0x0f) - carry) & 0x10 ? FLAG_H : 0);
    this.r[A] = byte;
  }

  /**
   * Il confronto. È una sottrazione che butta via il risultato, e con una
   * stranezza che non ha nessun'altra istruzione: i due bit non documentati
   * non vengono dal risultato ma dal valore con cui si confronta. Serve a
   * qualche protezione di quegli anni per riconoscere il chip.
   */
  cp8(value) {
    const a = this.r[A];
    const result = a - value;
    const byte = result & 0xff;
    this.f =
      (byte === 0 ? FLAG_Z : 0) |
      (byte & FLAG_S) |
      (value & (FLAG_3 | FLAG_5)) |
      FLAG_N |
      (result < 0 ? FLAG_C : 0) |
      (((a ^ value) & (a ^ byte) & 0x80) ? FLAG_P : 0) |
      (((a & 0x0f) - (value & 0x0f)) & 0x10 ? FLAG_H : 0);
  }

  and8(value) {
    this.r[A] &= value;
    this.f = SZ53P[this.r[A]] | FLAG_H;
  }

  or8(value) {
    this.r[A] |= value;
    this.f = SZ53P[this.r[A]];
  }

  xor8(value) {
    this.r[A] ^= value;
    this.f = SZ53P[this.r[A]];
  }

  inc8(value) {
    const byte = (value + 1) & 0xff;
    this.f =
      (this.f & FLAG_C) |
      SZ53[byte] |
      ((byte & 0x0f) === 0 ? FLAG_H : 0) |
      (byte === 0x80 ? FLAG_P : 0);
    return byte;
  }

  dec8(value) {
    const byte = (value - 1) & 0xff;
    this.f =
      (this.f & FLAG_C) |
      FLAG_N |
      SZ53[byte] |
      ((byte & 0x0f) === 0x0f ? FLAG_H : 0) |
      (byte === 0x7f ? FLAG_P : 0);
    return byte;
  }

  add16(a, b) {
    const result = a + b;
    this.f =
      (this.f & (FLAG_S | FLAG_Z | FLAG_P)) |
      ((result >> 8) & (FLAG_3 | FLAG_5)) |
      (result > 0xffff ? FLAG_C : 0) |
      (((a & 0x0fff) + (b & 0x0fff)) & 0x1000 ? FLAG_H : 0);
    this.t += 7; // sette giri interni: la somma a sedici bit passa due volte
    return result & 0xffff;
  }

  adc16(value) {
    const hl = this.hl;
    const carry = this.f & FLAG_C ? 1 : 0;
    const result = hl + value + carry;
    const word = result & 0xffff;
    this.f =
      ((word >> 8) & (FLAG_S | FLAG_3 | FLAG_5)) |
      (word === 0 ? FLAG_Z : 0) |
      (result > 0xffff ? FLAG_C : 0) |
      (((hl ^ ~value) & (hl ^ word) & 0x8000) ? FLAG_P : 0) |
      (((hl & 0x0fff) + (value & 0x0fff) + carry) & 0x1000 ? FLAG_H : 0);
    this.hl = word;
    this.t += 7;
  }

  sbc16(value) {
    const hl = this.hl;
    const carry = this.f & FLAG_C ? 1 : 0;
    const result = hl - value - carry;
    const word = result & 0xffff;
    this.f =
      ((word >> 8) & (FLAG_S | FLAG_3 | FLAG_5)) |
      (word === 0 ? FLAG_Z : 0) |
      FLAG_N |
      (result < 0 ? FLAG_C : 0) |
      (((hl ^ value) & (hl ^ word) & 0x8000) ? FLAG_P : 0) |
      (((hl & 0x0fff) - (value & 0x0fff) - carry) & 0x1000 ? FLAG_H : 0);
    this.hl = word;
    this.t += 7;
  }

  /**
   * L'aggiustamento decimale, che è l'istruzione più strana del chip: guarda
   * cosa è appena successo — somma o sottrazione, con o senza riporto di
   * mezzo byte — e rimette A in una forma dove ogni mezzo byte è una cifra.
   */
  daa() {
    let add = 0;
    let carry = this.f & FLAG_C;
    const a = this.r[A];
    if (this.f & FLAG_H || (a & 0x0f) > 9) add = 6;
    if (carry || a > 0x99) add |= 0x60;
    if (a > 0x99) carry = FLAG_C;
    if (this.f & FLAG_N) this.sub8(add);
    else this.add8(add);
    this.f = (this.f & ~(FLAG_C | FLAG_P)) | carry | PARITY[this.r[A]];
  }

  // ---------------------------------------------------- rotazioni e bit

  rotate(operation, value) {
    let result;
    let carry;
    switch (operation) {
      case 0: // RLC
        carry = (value >> 7) & 1;
        result = ((value << 1) | carry) & 0xff;
        break;
      case 1: // RRC
        carry = value & 1;
        result = ((value >> 1) | (carry << 7)) & 0xff;
        break;
      case 2: // RL
        carry = (value >> 7) & 1;
        result = ((value << 1) | (this.f & FLAG_C ? 1 : 0)) & 0xff;
        break;
      case 3: // RR
        carry = value & 1;
        result = ((value >> 1) | (this.f & FLAG_C ? 0x80 : 0)) & 0xff;
        break;
      case 4: // SLA
        carry = (value >> 7) & 1;
        result = (value << 1) & 0xff;
        break;
      case 5: // SRA: lo scorrimento con segno, che tiene il bit 7
        carry = value & 1;
        result = ((value >> 1) | (value & 0x80)) & 0xff;
        break;
      case 6: // SLL: non documentata, e infila un uno in fondo
        carry = (value >> 7) & 1;
        result = ((value << 1) | 1) & 0xff;
        break;
      default: // SRL
        carry = value & 1;
        result = (value >> 1) & 0xff;
    }
    this.f = SZ53P[result] | (carry ? FLAG_C : 0);
    return result;
  }

  bit(number, value, hidden = value) {
    const masked = value & (1 << number);
    this.f =
      (this.f & FLAG_C) |
      FLAG_H |
      (masked ? masked & FLAG_S : FLAG_Z | FLAG_P) |
      (hidden & (FLAG_3 | FLAG_5));
  }

  // ------------------------------------------------------- le istruzioni

  /**
   * Un'istruzione, dall'inizio alla fine.
   * @returns {number} i T-state che ci sono voluti
   */
  step() {
    this.t = 0;
    // Il rinvio dopo una EI vale per una sola istruzione: questa. Se questa è
    // a sua volta una EI, il rinvio riparte.
    this.eiPending = false;

    if (this.halted) {
      // Fermo su HALT: il chip continua a prendere NOP dal bus, e infatti il
      // rinfresco della memoria non si ferma. È per questo che una macchina
      // con lo Z80 in halt non si dimentica di sé stessa.
      this.t += 4;
      this.rReg = (this.rReg & 0x80) | ((this.rReg + 1) & 0x7f);
      this.cycles += this.t;
      return this.t;
    }

    let prefix = 0;
    let opcode = this.fetch();
    while (opcode === 0xdd || opcode === 0xfd) {
      // Prefissi in fila: vale l'ultimo, e ognuno costa i suoi quattro cicli.
      prefix = opcode;
      opcode = this.fetch();
    }

    if (opcode === 0xcb) this.executeCB(prefix);
    else if (opcode === 0xed) this.executeED();
    else this.execute(opcode, prefix);

    this.cycles += this.t;
    return this.t;
  }

  execute(opcode, prefix) {
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const p = y >> 1;
    const q = y & 1;

    switch (x) {
      case 0:
        return this.executeX0(opcode, prefix, y, z, p, q);
      case 1: {
        if (y === 6 && z === 6) {
          // LD (HL),(HL) non esiste: quel posto lo occupa HALT.
          this.halted = true;
          return undefined;
        }
        // Un'istruzione sola non può usare l'indice in due modi: se uno dei
        // due estremi è la memoria, l'altro è H o L per davvero.
        const memory = y === 6 || z === 6;
        const addr = memory ? this.address(prefix) : 0;
        const value = this.get8(z, memory && z !== 6 ? 0 : prefix, addr);
        this.set8(y, value, memory && y !== 6 ? 0 : prefix, addr);
        return undefined;
      }
      case 2: {
        const addr = z === 6 ? this.address(prefix) : 0;
        this.alu(y, this.get8(z, prefix, addr));
        return undefined;
      }
      default:
        return this.executeX3(opcode, prefix, y, z, p, q);
    }
  }

  alu(operation, value) {
    switch (operation) {
      case 0: return this.add8(value);
      case 1: return this.add8(value, this.f & FLAG_C ? 1 : 0);
      case 2: return this.sub8(value);
      case 3: return this.sub8(value, this.f & FLAG_C ? 1 : 0);
      case 4: return this.and8(value);
      case 5: return this.xor8(value);
      case 6: return this.or8(value);
      default: return this.cp8(value);
    }
  }

  executeX0(opcode, prefix, y, z, p, q) {
    switch (z) {
      case 0:
        switch (y) {
          case 0: return undefined; // NOP
          case 1: { // EX AF,AF'
            const a = this.r[A];
            const f = this.f;
            this.r[A] = this.alt.r[A];
            this.f = this.alt.f;
            this.alt.r[A] = a;
            this.alt.f = f;
            return undefined;
          }
          case 2: { // DJNZ
            this.t += 1; // il conto di B costa un giro in più
            const displacement = (this.immediate() << 24) >> 24;
            this.r[B] = (this.r[B] - 1) & 0xff;
            if (this.r[B] !== 0) {
              this.t += 5;
              this.pc = (this.pc + displacement) & 0xffff;
            }
            return undefined;
          }
          case 3: { // JR d
            const displacement = (this.immediate() << 24) >> 24;
            this.t += 5;
            this.pc = (this.pc + displacement) & 0xffff;
            return undefined;
          }
          default: { // JR cc,d
            const displacement = (this.immediate() << 24) >> 24;
            if (this.condition(y - 4)) {
              this.t += 5;
              this.pc = (this.pc + displacement) & 0xffff;
            }
            return undefined;
          }
        }
      case 1:
        if (q === 0) { // LD rp,nn
          this.setPair(p, this.immediate16(), prefix);
          return undefined;
        }
        // ADD HL,rp
        this.setIndex(prefix, this.add16(this.index(prefix), this.getPair(p, prefix)));
        return undefined;
      case 2:
        // Le otto letture e scritture con indirizzo, a coppie: prima si
        // scrive e poi si legge, e i quattro posti sono (BC), (DE), (nn) per
        // la coppia indice e (nn) per A.
        switch (y) {
          case 0: this.write8(this.bc, this.r[A]); return undefined;
          case 1: this.r[A] = this.read8(this.bc); return undefined;
          case 2: this.write8(this.de, this.r[A]); return undefined;
          case 3: this.r[A] = this.read8(this.de); return undefined;
          case 4: this.write16(this.immediate16(), this.index(prefix)); return undefined;
          case 5: this.setIndex(prefix, this.read16(this.immediate16())); return undefined;
          case 6: this.write8(this.immediate16(), this.r[A]); return undefined;
          default: this.r[A] = this.read8(this.immediate16()); return undefined;
        }
      case 3: { // INC/DEC rp
        this.t += 2;
        const value = this.getPair(p, prefix);
        this.setPair(p, (value + (q === 0 ? 1 : -1)) & 0xffff, prefix);
        return undefined;
      }
      case 4:
      case 5: { // INC/DEC r
        const addr = y === 6 ? this.address(prefix) : 0;
        const value = this.get8(y, prefix, addr);
        if (y === 6) this.t += 1;
        const result = z === 4 ? this.inc8(value) : this.dec8(value);
        this.set8(y, result, prefix, addr);
        return undefined;
      }
      case 6: { // LD r,n
        // Con un prefisso l'ordine è capovolto: prima lo spostamento, poi il
        // valore, e i cinque giri interni non ci sono.
        const addr = y === 6 ? this.address(prefix, false) : 0;
        const value = this.immediate();
        if (y === 6 && prefix) this.t += 2;
        this.set8(y, value, prefix, addr);
        return undefined;
      }
      default:
        return this.rotateA(y);
    }
  }

  /** Le quattro rotazioni di A, più CPL, SCF, CCF e DAA. */
  rotateA(y) {
    const a = this.r[A];
    switch (y) {
      case 0: { // RLCA
        const carry = (a >> 7) & 1;
        this.r[A] = ((a << 1) | carry) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.r[A] & (FLAG_3 | FLAG_5)) | carry;
        return undefined;
      }
      case 1: { // RRCA
        const carry = a & 1;
        this.r[A] = ((a >> 1) | (carry << 7)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.r[A] & (FLAG_3 | FLAG_5)) | carry;
        return undefined;
      }
      case 2: { // RLA
        const carry = (a >> 7) & 1;
        this.r[A] = ((a << 1) | (this.f & FLAG_C ? 1 : 0)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.r[A] & (FLAG_3 | FLAG_5)) | carry;
        return undefined;
      }
      case 3: { // RRA
        const carry = a & 1;
        this.r[A] = ((a >> 1) | (this.f & FLAG_C ? 0x80 : 0)) & 0xff;
        this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | (this.r[A] & (FLAG_3 | FLAG_5)) | carry;
        return undefined;
      }
      case 4:
        return this.daa();
      case 5: // CPL
        this.r[A] = ~a & 0xff;
        this.f =
          (this.f & (FLAG_S | FLAG_Z | FLAG_P | FLAG_C)) |
          FLAG_H |
          FLAG_N |
          (this.r[A] & (FLAG_3 | FLAG_5));
        return undefined;
      case 6: // SCF
        this.f =
          (this.f & (FLAG_S | FLAG_Z | FLAG_P)) | FLAG_C | (this.r[A] & (FLAG_3 | FLAG_5));
        return undefined;
      default: // CCF
        this.f =
          (this.f & (FLAG_S | FLAG_Z | FLAG_P)) |
          (this.f & FLAG_C ? FLAG_H : FLAG_C) |
          (this.r[A] & (FLAG_3 | FLAG_5));
        return undefined;
    }
  }

  executeX3(opcode, prefix, y, z, p, q) {
    switch (z) {
      case 0: // RET cc
        this.t += 1;
        if (this.condition(y)) this.pc = this.pop();
        return undefined;
      case 1:
        if (q === 0) { // POP rp2
          const value = this.pop();
          if (p === 3) this.af = value;
          else this.setPair(p, value, prefix);
          return undefined;
        }
        switch (p) {
          case 0: this.pc = this.pop(); return undefined; // RET
          case 1: { // EXX
            for (let i = 0; i < 6; i++) {
              const value = this.r[i];
              this.r[i] = this.alt.r[i];
              this.alt.r[i] = value;
            }
            return undefined;
          }
          case 2: this.pc = this.index(prefix); return undefined; // JP (HL)
          default: this.t += 2; this.sp = this.index(prefix); return undefined; // LD SP,HL
        }
      case 2: { // JP cc,nn
        const target = this.immediate16();
        if (this.condition(y)) this.pc = target;
        return undefined;
      }
      case 3:
        switch (y) {
          case 0: this.pc = this.immediate16(); return undefined; // JP nn
          case 1: return undefined; // CB: già preso prima di arrivare qui
          case 2: { // OUT (n),A
            const port = this.immediate() | (this.r[A] << 8);
            this.out(port, this.r[A]);
            return undefined;
          }
          case 3: { // IN A,(n)
            const port = this.immediate() | (this.r[A] << 8);
            this.r[A] = this.in(port);
            return undefined;
          }
          case 4: { // EX (SP),HL
            const value = this.read16(this.sp);
            this.t += 1;
            this.write8(this.sp, this.index(prefix) & 0xff);
            this.write8(this.sp + 1, (this.index(prefix) >> 8) & 0xff);
            this.t += 2;
            this.setIndex(prefix, value);
            return undefined;
          }
          case 5: { // EX DE,HL — e l'indice qui non c'entra: è sempre HL
            const de = this.de;
            this.de = this.hl;
            this.hl = de;
            return undefined;
          }
          case 6: this.iff1 = false; this.iff2 = false; return undefined; // DI
          default: this.iff1 = true; this.iff2 = true; this.eiPending = true; return undefined;
        }
      case 4: { // CALL cc,nn
        const target = this.immediate16();
        if (this.condition(y)) {
          this.t += 1;
          this.push(this.pc);
          this.pc = target;
        }
        return undefined;
      }
      case 5:
        if (q === 0) { // PUSH rp2
          this.t += 1;
          this.push(p === 3 ? this.af : this.getPair(p, prefix));
          return undefined;
        }
        if (p === 0) { // CALL nn
          const target = this.immediate16();
          this.t += 1;
          this.push(this.pc);
          this.pc = target;
          return undefined;
        }
        return undefined; // DD, ED, FD: già presi prima di arrivare qui
      case 6:
        this.alu(y, this.immediate());
        return undefined;
      default: // RST
        this.t += 1;
        this.push(this.pc);
        this.pc = y * 8;
        return undefined;
    }
  }

  /**
   * Le istruzioni sui bit. Con un prefisso lo spostamento arriva prima
   * dell'opcode, e il risultato — oltre che in memoria — finisce anche in un
   * registro: è la parte non documentata che i giochi usavano per fare due
   * cose in un'istruzione sola.
   */
  executeCB(prefix) {
    let addr = 0;
    let opcode;
    if (prefix) {
      const displacement = (this.immediate() << 24) >> 24;
      addr = (this.index(prefix) + displacement) & 0xffff;
      opcode = this.immediate();
      this.t += 2;
    } else {
      opcode = this.fetch();
    }

    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const memory = z === 6 || prefix;
    const value = memory ? this.read8(prefix ? addr : this.hl) : this.r[z];

    if (x === 0) {
      const result = this.rotate(y, value);
      if (memory) {
        this.t += 1;
        this.write8(prefix ? addr : this.hl, result);
        if (prefix && z !== 6) this.r[z] = result;
      } else {
        this.r[z] = result;
      }
      return;
    }

    if (x === 1) { // BIT
      // I due bit non documentati vengono dal byte alto dell'indirizzo quando
      // si guarda la memoria: non c'è nessun risultato da cui copiarli.
      const hidden = memory ? ((prefix ? addr : this.hl) >> 8) & 0xff : value;
      this.bit(y, value, hidden);
      if (memory) this.t += 1;
      return;
    }

    const result = x === 2 ? value & ~(1 << y) : value | (1 << y);
    if (memory) {
      this.t += 1;
      this.write8(prefix ? addr : this.hl, result);
      if (prefix && z !== 6) this.r[z] = result;
    } else {
      this.r[z] = result;
    }
  }

  executeED() {
    const opcode = this.fetch();
    const x = opcode >> 6;
    const y = (opcode >> 3) & 7;
    const z = opcode & 7;
    const p = y >> 1;
    const q = y & 1;

    if (x === 1) {
      switch (z) {
        case 0: { // IN r,(C)
          const value = this.in(this.bc);
          if (y !== 6) this.r[y] = value;
          this.f = (this.f & FLAG_C) | SZ53P[value];
          return;
        }
        case 1: // OUT (C),r
          this.out(this.bc, y === 6 ? 0 : this.r[y]);
          return;
        case 2:
          if (q === 0) this.sbc16(this.getPair(p, 0));
          else this.adc16(this.getPair(p, 0));
          return;
        case 3: { // LD (nn),rp e LD rp,(nn)
          const addr = this.immediate16();
          if (q === 0) this.write16(addr, this.getPair(p, 0));
          else this.setPair(p, this.read16(addr), 0);
          return;
        }
        case 4: { // NEG
          const a = this.r[A];
          this.r[A] = 0;
          this.sub8(a);
          return;
        }
        case 5: // RETN / RETI: la stessa cosa, e rimettono a posto il permesso
          this.iff1 = this.iff2;
          this.pc = this.pop();
          return;
        case 6: // IM 0/1/2, ognuno con due opcode che lo scelgono
          this.im = [0, 0, 1, 2, 0, 0, 1, 2][y];
          return;
        default:
          return this.executeED47(y);
      }
    }

    if (x === 2 && z <= 3 && y >= 4) return this.block(y, z);

    // Tutto il resto dietro a ED non è niente: due NOP uno dietro l'altro.
  }

  /** LD I,A e LD A,I e le loro sorelle, più RRD e RLD. */
  executeED47(y) {
    switch (y) {
      case 0: this.t += 1; this.i = this.r[A]; return;
      case 1: this.t += 1; this.rReg = this.r[A]; return;
      case 2: // LD A,I
        this.t += 1;
        this.r[A] = this.i;
        this.f = (this.f & FLAG_C) | SZ53[this.i] | (this.iff2 ? FLAG_P : 0);
        return;
      case 3: // LD A,R
        this.t += 1;
        this.r[A] = this.rReg;
        this.f = (this.f & FLAG_C) | SZ53[this.rReg] | (this.iff2 ? FLAG_P : 0);
        return;
      case 4: { // RRD
        const value = this.read8(this.hl);
        this.t += 4;
        this.write8(this.hl, ((value >> 4) | (this.r[A] << 4)) & 0xff);
        this.r[A] = (this.r[A] & 0xf0) | (value & 0x0f);
        this.f = (this.f & FLAG_C) | SZ53P[this.r[A]];
        return;
      }
      case 5: { // RLD
        const value = this.read8(this.hl);
        this.t += 4;
        this.write8(this.hl, ((value << 4) | (this.r[A] & 0x0f)) & 0xff);
        this.r[A] = (this.r[A] & 0xf0) | ((value >> 4) & 0x0f);
        this.f = (this.f & FLAG_C) | SZ53P[this.r[A]];
        return;
      }
      default: // NOP
    }
  }

  /**
   * Le istruzioni di blocco: copia, confronta, leggi e scrivi una porta, in
   * quattro versi ciascuna — avanti, indietro, e con o senza ripetizione.
   * Sono la ragione per cui sullo Z80 copiare mezza memoria è una riga.
   */
  block(y, z) {
    const step = y & 1 ? -1 : 1; // le versioni "D" vanno all'indietro
    const repeat = y >= 6;

    switch (z) {
      case 0: { // LDI / LDD / LDIR / LDDR
        const value = this.read8(this.hl);
        this.write8(this.de, value);
        this.t += 2;
        this.de = (this.de + step) & 0xffff;
        this.hl = (this.hl + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const sum = (value + this.r[A]) & 0xff;
        this.f =
          (this.f & (FLAG_C | FLAG_Z | FLAG_S)) |
          (this.bc !== 0 ? FLAG_P : 0) |
          (sum & FLAG_3) |
          (sum & 0x02 ? FLAG_5 : 0);
        if (repeat && this.bc !== 0) {
          this.t += 5;
          this.pc = (this.pc - 2) & 0xffff;
        }
        return;
      }
      case 1: { // CPI / CPD / CPIR / CPDR
        const value = this.read8(this.hl);
        const carry = this.f & FLAG_C;
        const a = this.r[A];
        const result = (a - value) & 0xff;
        const half = ((a & 0x0f) - (value & 0x0f)) & 0x10;
        this.t += 5;
        this.hl = (this.hl + step) & 0xffff;
        this.bc = (this.bc - 1) & 0xffff;
        const sum = (result - (half ? 1 : 0)) & 0xff;
        this.f =
          carry |
          FLAG_N |
          (result === 0 ? FLAG_Z : 0) |
          (result & FLAG_S) |
          half |
          (this.bc !== 0 ? FLAG_P : 0) |
          (sum & FLAG_3) |
          (sum & 0x02 ? FLAG_5 : 0);
        if (repeat && this.bc !== 0 && result !== 0) {
          this.t += 5;
          this.pc = (this.pc - 2) & 0xffff;
        }
        return;
      }
      case 2: { // INI / IND / INIR / INDR
        this.t += 1;
        const value = this.in(this.bc);
        this.write8(this.hl, value);
        this.r[B] = (this.r[B] - 1) & 0xff;
        this.hl = (this.hl + step) & 0xffff;
        this.f = SZ53[this.r[B]] | (value & 0x80 ? FLAG_N : 0);
        if (repeat && this.r[B] !== 0) {
          this.t += 5;
          this.pc = (this.pc - 2) & 0xffff;
        }
        return;
      }
      default: { // OUTI / OUTD / OTIR / OTDR
        this.t += 1;
        const value = this.read8(this.hl);
        this.r[B] = (this.r[B] - 1) & 0xff;
        this.out(this.bc, value);
        this.hl = (this.hl + step) & 0xffff;
        this.f = SZ53[this.r[B]] | (value & 0x80 ? FLAG_N : 0);
        if (repeat && this.r[B] !== 0) {
          this.t += 5;
          this.pc = (this.pc - 2) & 0xffff;
        }
      }
    }
  }

  // ------------------------------------------------------ le interruzioni

  /**
   * L'interruzione mascherabile, che sullo Spectrum arriva cinquanta volte al
   * secondo dalla ULA e basta: non c'è nessun chip che metta un vettore sul
   * bus, quindi in modo 1 si va sempre a 0038h e in modo 2 si prende
   * l'indirizzo da una tabella che comincia dove dice il registro I.
   *
   * @returns {number} i T-state consumati, 0 se l'interruzione non passa
   */
  interrupt() {
    if (!this.iff1 || this.eiPending) return 0;
    this.t = 0;
    if (this.halted) {
      this.halted = false;
      this.pc = (this.pc + 1) & 0xffff;
    }
    this.iff1 = false;
    this.iff2 = false;
    this.rReg = (this.rReg & 0x80) | ((this.rReg + 1) & 0x7f);

    switch (this.im) {
      case 0:
      case 1:
        this.t += 7;
        this.push(this.pc);
        this.pc = 0x0038;
        break;
      default: {
        this.t += 7;
        this.push(this.pc);
        // Il byte basso lo mette la periferica; sullo Spectrum non c'è
        // nessuno a metterlo, e sul bus resta FF.
        this.pc = this.read16((this.i << 8) | 0xff);
      }
    }
    this.cycles += this.t;
    return this.t;
  }

  /** L'interruzione non mascherabile: sempre a 0066h, e IFF1 si mette da parte. */
  nmi() {
    this.t = 0;
    if (this.halted) {
      this.halted = false;
      this.pc = (this.pc + 1) & 0xffff;
    }
    this.iff2 = this.iff1;
    this.iff1 = false;
    this.t += 5;
    this.push(this.pc);
    this.pc = 0x0066;
    this.cycles += this.t;
    return this.t;
  }

  /** Dove sta il processore, per chi lo sta guardando. */
  get location() {
    return this.pc.toString(16).padStart(4, '0');
  }
}
