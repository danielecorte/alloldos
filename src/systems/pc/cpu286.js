// L'80286, nell'unico modo che al DOS sia mai servito.
//
// Real mode: un indirizzo è un segmento moltiplicato per sedici più un offset,
// e i venti bit che ne escono sono tutta la memoria che c'è. Il modo protetto —
// i descrittori, gli anelli, i sedici megabyte — su questa macchina non c'è, e
// non è una scorciatoia: il DOS non ci gira dentro, ci gira accanto, e i
// programmi che lo vogliono davvero (Windows 3, i DOS extender, HIMEM) sono un
// altro progetto.
//
// Del 286 resta quello che il software guarda per capire su cosa sta girando,
// e sono dettagli piccolissimi con conseguenze grandi:
//
//   - i bit 12-15 di FLAGS tornano a zero, dove un 8086 li dava tutti a uno.
//     È così che un gioco decide se può usare le istruzioni nuove.
//   - i contatori di scorrimento sono mascherati a cinque bit: `shl ax, cl` con
//     cl = 33 sposta di uno, non di trentatré. Su un 8086 quel codice bloccava
//     la macchina per un millesimo di secondo.
//   - `push sp` impila il valore di prima della decrementazione.
//   - e ci sono PUSHA, POPA, ENTER, LEAVE, BOUND, IMUL con immediato, INS e
//     OUTS: le istruzioni del 186 che il 286 si porta dietro.
//
// Il resto è l'8086 di sempre, che è la ragione per cui questa CPU ha fatto
// girare software scritto dieci anni prima di lei.

/** Gli otto registri a sedici bit, nell'ordine in cui li numera la codifica. */
export const AX = 0;
export const CX = 1;
export const DX = 2;
export const BX = 3;
export const SP = 4;
export const BP = 5;
export const SI = 6;
export const DI = 7;

/** I quattro segmenti, idem. */
export const ES = 0;
export const CS = 1;
export const SS = 2;
export const DS = 3;

/** Quanti bit di indirizzo escono dalla macchina: venti, e poi si ricomincia. */
const ADDRESS_MASK = 0xfffff;

/** La parità di un byte, che nessuno ha voglia di ricontare ogni volta. */
const PARITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let bits = 0;
  for (let bit = 0; bit < 8; bit++) bits += (i >> bit) & 1;
  PARITY[i] = bits & 1 ? 0 : 1;
}

export class CPU286 {
  /**
   * @param {object} bus
   * @param {(addr:number)=>number} bus.read8
   * @param {(addr:number,value:number)=>void} bus.write8
   * @param {(port:number)=>number} bus.inb
   * @param {(port:number,value:number)=>void} bus.outb
   * @param {(port:number)=>number} [bus.inw]
   * @param {(port:number,value:number)=>void} [bus.outw]
   */
  constructor(bus) {
    this.bus = bus;
    this.r = new Uint16Array(8);
    this.s = new Uint16Array(4);
    this.reset();
  }

  reset() {
    this.r.fill(0);
    this.s.fill(0);
    // Il 286 si sveglia a F000:FFF0, sedici byte sotto la fine della memoria:
    // là c'è il salto che porta dentro il BIOS.
    this.s[CS] = 0xf000;
    this.ip = 0xfff0;

    this.cf = 0;
    this.pf = 0;
    this.af = 0;
    this.zf = 0;
    this.sf = 0;
    this.tf = 0;
    this.if_ = 0;
    this.df = 0;
    this.of = 0;

    this.halted = false;
    this.segmentOverride = -1;
    this.repeat = 0; // 0 nessuno, 0xf2 REPNE, 0xf3 REP/REPE
    this.instructions = 0;
    this.pendingInterrupt = -1;
  }

  // ------------------------------------------------------------- i registri

  get8(index) {
    const value = this.r[index & 3];
    return index & 4 ? (value >> 8) & 0xff : value & 0xff;
  }

  set8(index, value) {
    const at = index & 3;
    if (index & 4) this.r[at] = (this.r[at] & 0x00ff) | ((value & 0xff) << 8);
    else this.r[at] = (this.r[at] & 0xff00) | (value & 0xff);
  }

  /**
   * FLAGS come lo vede il software. Il bit 1 è sempre acceso, e i quattro in
   * alto sono spenti: su un 8086 erano accesi, ed è esattamente lì che un
   * programma guarda per sapere quanti anni ha la macchina sotto di sé.
   */
  get flags() {
    return (
      0x0002 |
      this.cf |
      (this.pf << 2) |
      (this.af << 4) |
      (this.zf << 6) |
      (this.sf << 7) |
      (this.tf << 8) |
      (this.if_ << 9) |
      (this.df << 10) |
      (this.of << 11)
    );
  }

  set flags(value) {
    this.cf = value & 1;
    this.pf = (value >> 2) & 1;
    this.af = (value >> 4) & 1;
    this.zf = (value >> 6) & 1;
    this.sf = (value >> 7) & 1;
    this.tf = (value >> 8) & 1;
    this.if_ = (value >> 9) & 1;
    this.df = (value >> 10) & 1;
    this.of = (value >> 11) & 1;
  }

  // -------------------------------------------------------------- la memoria

  /** Segmento per sedici più offset, e poi si ricomincia da capo al mega. */
  physical(segment, offset) {
    return ((segment << 4) + (offset & 0xffff)) & ADDRESS_MASK;
  }

  readMem8(segment, offset) {
    return this.bus.read8(this.physical(segment, offset));
  }

  writeMem8(segment, offset, value) {
    this.bus.write8(this.physical(segment, offset), value & 0xff);
  }

  /**
   * Una parola sono due byte, e il secondo sta all'offset dopo — dentro lo
   * stesso segmento. A offset $ffff la parola non sconfina nel segmento
   * successivo: torna all'inizio di questo, che è una stranezza che qualche
   * programma ha usato apposta.
   */
  readMem16(segment, offset) {
    return (
      this.readMem8(segment, offset) | (this.readMem8(segment, (offset + 1) & 0xffff) << 8)
    );
  }

  writeMem16(segment, offset, value) {
    this.writeMem8(segment, offset, value & 0xff);
    this.writeMem8(segment, (offset + 1) & 0xffff, (value >> 8) & 0xff);
  }

  push(value) {
    this.r[SP] = (this.r[SP] - 2) & 0xffff;
    this.writeMem16(this.s[SS], this.r[SP], value);
  }

  pop() {
    const value = this.readMem16(this.s[SS], this.r[SP]);
    this.r[SP] = (this.r[SP] + 2) & 0xffff;
    return value;
  }

  // ------------------------------------------------------------ la decodifica

  fetch8() {
    const value = this.readMem8(this.s[CS], this.ip);
    this.ip = (this.ip + 1) & 0xffff;
    return value;
  }

  fetch16() {
    const value = this.readMem16(this.s[CS], this.ip);
    this.ip = (this.ip + 2) & 0xffff;
    return value;
  }

  fetchSigned8() {
    return (this.fetch8() << 24) >> 24;
  }

  /** Il segmento che tocca a questo accesso, override compresi. */
  segmentFor(preferred) {
    return this.segmentOverride >= 0 ? this.s[this.segmentOverride] : this.s[preferred];
  }

  /**
   * Il byte mod-reg-r/m, che è dove l'x86 mette quasi tutta la sua grammatica:
   * due bit dicono se l'operando è in memoria o in un registro, tre scelgono un
   * registro (o allungano il codice operativo) e tre dicono come si calcola
   * l'indirizzo. Gli indirizzi con BP dentro guardano nello stack, e gli altri
   * nei dati: è il default che rende inutile scrivere il segmento ogni volta.
   */
  modrm() {
    const byte = this.fetch8();
    this.mod = byte >> 6;
    this.reg = (byte >> 3) & 7;
    this.rm = byte & 7;

    if (this.mod === 3) {
      this.memory = false;
      return;
    }

    this.memory = true;
    let base = 0;
    let segment = DS;
    switch (this.rm) {
      case 0:
        base = this.r[BX] + this.r[SI];
        break;
      case 1:
        base = this.r[BX] + this.r[DI];
        break;
      case 2:
        base = this.r[BP] + this.r[SI];
        segment = SS;
        break;
      case 3:
        base = this.r[BP] + this.r[DI];
        segment = SS;
        break;
      case 4:
        base = this.r[SI];
        break;
      case 5:
        base = this.r[DI];
        break;
      case 6:
        if (this.mod === 0) {
          base = this.fetch16();
        } else {
          base = this.r[BP];
          segment = SS;
        }
        break;
      default:
        base = this.r[BX];
        break;
    }

    if (this.mod === 1) base += this.fetchSigned8();
    else if (this.mod === 2) base += this.fetch16();

    this.ea = base & 0xffff;
    this.eaSegment = this.segmentFor(segment);
  }

  readRM8() {
    return this.memory ? this.readMem8(this.eaSegment, this.ea) : this.get8(this.rm);
  }

  writeRM8(value) {
    if (this.memory) this.writeMem8(this.eaSegment, this.ea, value);
    else this.set8(this.rm, value);
  }

  readRM16() {
    return this.memory ? this.readMem16(this.eaSegment, this.ea) : this.r[this.rm];
  }

  writeRM16(value) {
    if (this.memory) this.writeMem16(this.eaSegment, this.ea, value);
    else this.r[this.rm] = value & 0xffff;
  }

  // ----------------------------------------------------------------- i flag

  setLogicFlags8(value) {
    this.cf = 0;
    this.of = 0;
    this.af = 0;
    this.zf = (value & 0xff) === 0 ? 1 : 0;
    this.sf = (value >> 7) & 1;
    this.pf = PARITY[value & 0xff];
    return value & 0xff;
  }

  setLogicFlags16(value) {
    this.cf = 0;
    this.of = 0;
    this.af = 0;
    this.zf = (value & 0xffff) === 0 ? 1 : 0;
    this.sf = (value >> 15) & 1;
    this.pf = PARITY[value & 0xff];
    return value & 0xffff;
  }

  add8(a, b, carry = 0) {
    const sum = a + b + carry;
    const result = sum & 0xff;
    this.cf = sum > 0xff ? 1 : 0;
    this.af = ((a ^ b ^ sum) & 0x10) !== 0 ? 1 : 0;
    this.of = ((~(a ^ b) & (a ^ sum)) & 0x80) !== 0 ? 1 : 0;
    this.zf = result === 0 ? 1 : 0;
    this.sf = (result >> 7) & 1;
    this.pf = PARITY[result];
    return result;
  }

  add16(a, b, carry = 0) {
    const sum = a + b + carry;
    const result = sum & 0xffff;
    this.cf = sum > 0xffff ? 1 : 0;
    this.af = ((a ^ b ^ sum) & 0x10) !== 0 ? 1 : 0;
    this.of = ((~(a ^ b) & (a ^ sum)) & 0x8000) !== 0 ? 1 : 0;
    this.zf = result === 0 ? 1 : 0;
    this.sf = (result >> 15) & 1;
    this.pf = PARITY[result & 0xff];
    return result;
  }

  sub8(a, b, borrow = 0) {
    const difference = a - b - borrow;
    const result = difference & 0xff;
    this.cf = difference < 0 ? 1 : 0;
    this.af = ((a ^ b ^ difference) & 0x10) !== 0 ? 1 : 0;
    this.of = (((a ^ b) & (a ^ result)) & 0x80) !== 0 ? 1 : 0;
    this.zf = result === 0 ? 1 : 0;
    this.sf = (result >> 7) & 1;
    this.pf = PARITY[result];
    return result;
  }

  sub16(a, b, borrow = 0) {
    const difference = a - b - borrow;
    const result = difference & 0xffff;
    this.cf = difference < 0 ? 1 : 0;
    this.af = ((a ^ b ^ difference) & 0x10) !== 0 ? 1 : 0;
    this.of = (((a ^ b) & (a ^ result)) & 0x8000) !== 0 ? 1 : 0;
    this.zf = result === 0 ? 1 : 0;
    this.sf = (result >> 15) & 1;
    this.pf = PARITY[result & 0xff];
    return result;
  }

  /** INC e DEC non toccano il riporto, che è il motivo per cui esistono. */
  inc8(value) {
    const carry = this.cf;
    const result = this.add8(value, 1);
    this.cf = carry;
    return result;
  }

  inc16(value) {
    const carry = this.cf;
    const result = this.add16(value, 1);
    this.cf = carry;
    return result;
  }

  dec8(value) {
    const carry = this.cf;
    const result = this.sub8(value, 1);
    this.cf = carry;
    return result;
  }

  dec16(value) {
    const carry = this.cf;
    const result = this.sub16(value, 1);
    this.cf = carry;
    return result;
  }

  // ------------------------------------------------------- gli scorrimenti

  /**
   * Scorrimenti e rotazioni, che sul 286 contano fino a trentuno e non oltre:
   * il contatore viene mascherato a cinque bit. Su un 8086 no, e `shl ax, cl`
   * con cl a 255 teneva la macchina occupata per due millesimi di secondo — un
   * modo di far perdere tempo che qualcuno usava apposta, e che qui non
   * funzionerebbe più.
   */
  shift8(op, value, count) {
    count &= 0x1f;
    if (count === 0) return value & 0xff;
    let result = value & 0xff;
    switch (op) {
      case 0: // ROL
        for (let i = 0; i < count; i++) result = ((result << 1) | (result >> 7)) & 0xff;
        this.cf = result & 1;
        break;
      case 1: // ROR
        for (let i = 0; i < count; i++) result = ((result >> 1) | (result << 7)) & 0xff;
        this.cf = (result >> 7) & 1;
        break;
      case 2: // RCL
        for (let i = 0; i < count; i++) {
          const carry = (result >> 7) & 1;
          result = ((result << 1) | this.cf) & 0xff;
          this.cf = carry;
        }
        break;
      case 3: // RCR
        for (let i = 0; i < count; i++) {
          const carry = result & 1;
          result = ((result >> 1) | (this.cf << 7)) & 0xff;
          this.cf = carry;
        }
        break;
      case 4: // SHL
      case 6:
        for (let i = 0; i < count; i++) {
          this.cf = (result >> 7) & 1;
          result = (result << 1) & 0xff;
        }
        this.setResultFlags8(result);
        break;
      case 5: // SHR
        for (let i = 0; i < count; i++) {
          this.cf = result & 1;
          result >>= 1;
        }
        this.setResultFlags8(result);
        break;
      default: // SAR: il bit di segno si ricopia, che è come si divide con segno
        for (let i = 0; i < count; i++) {
          this.cf = result & 1;
          result = (result >> 1) | (result & 0x80);
        }
        this.setResultFlags8(result);
        break;
    }
    if (count === 1) {
      if (op === 0 || op === 2) this.of = ((result >> 7) & 1) ^ this.cf;
      else if (op === 1 || op === 3) this.of = ((result >> 7) & 1) ^ ((result >> 6) & 1);
      else if (op === 4 || op === 6) this.of = ((result >> 7) & 1) ^ this.cf;
      else if (op === 5) this.of = (value >> 7) & 1;
      else this.of = 0;
    }
    return result & 0xff;
  }

  shift16(op, value, count) {
    count &= 0x1f;
    if (count === 0) return value & 0xffff;
    let result = value & 0xffff;
    switch (op) {
      case 0:
        for (let i = 0; i < count; i++) result = ((result << 1) | (result >> 15)) & 0xffff;
        this.cf = result & 1;
        break;
      case 1:
        for (let i = 0; i < count; i++) result = ((result >> 1) | (result << 15)) & 0xffff;
        this.cf = (result >> 15) & 1;
        break;
      case 2:
        for (let i = 0; i < count; i++) {
          const carry = (result >> 15) & 1;
          result = ((result << 1) | this.cf) & 0xffff;
          this.cf = carry;
        }
        break;
      case 3:
        for (let i = 0; i < count; i++) {
          const carry = result & 1;
          result = ((result >> 1) | (this.cf << 15)) & 0xffff;
          this.cf = carry;
        }
        break;
      case 4:
      case 6:
        for (let i = 0; i < count; i++) {
          this.cf = (result >> 15) & 1;
          result = (result << 1) & 0xffff;
        }
        this.setResultFlags16(result);
        break;
      case 5:
        for (let i = 0; i < count; i++) {
          this.cf = result & 1;
          result >>= 1;
        }
        this.setResultFlags16(result);
        break;
      default:
        for (let i = 0; i < count; i++) {
          this.cf = result & 1;
          result = (result >> 1) | (result & 0x8000);
        }
        this.setResultFlags16(result);
        break;
    }
    if (count === 1) {
      if (op === 0 || op === 2) this.of = ((result >> 15) & 1) ^ this.cf;
      else if (op === 1 || op === 3) this.of = ((result >> 15) & 1) ^ ((result >> 14) & 1);
      else if (op === 4 || op === 6) this.of = ((result >> 15) & 1) ^ this.cf;
      else if (op === 5) this.of = (value >> 15) & 1;
      else this.of = 0;
    }
    return result & 0xffff;
  }

  setResultFlags8(value) {
    this.zf = (value & 0xff) === 0 ? 1 : 0;
    this.sf = (value >> 7) & 1;
    this.pf = PARITY[value & 0xff];
  }

  setResultFlags16(value) {
    this.zf = (value & 0xffff) === 0 ? 1 : 0;
    this.sf = (value >> 15) & 1;
    this.pf = PARITY[value & 0xff];
  }

  // ------------------------------------------------------- l'aritmetica lunga

  group3_8(op) {
    switch (op) {
      case 0:
      case 1: {
        // TEST: un AND che butta via il risultato e tiene i flag.
        const value = this.readRM8() & this.fetch8();
        this.setLogicFlags8(value);
        return 5;
      }
      case 2:
        this.writeRM8(~this.readRM8() & 0xff);
        return 3;
      case 3: {
        const value = this.readRM8();
        this.writeRM8(this.sub8(0, value));
        this.cf = value !== 0 ? 1 : 0;
        return 3;
      }
      case 4: {
        const product = this.get8(0) * this.readRM8();
        this.r[AX] = product & 0xffff;
        this.cf = this.of = (product & 0xff00) !== 0 ? 1 : 0;
        this.zf = (product & 0xffff) === 0 ? 1 : 0;
        return 13;
      }
      case 5: {
        const product = ((this.get8(0) << 24) >> 24) * ((this.readRM8() << 24) >> 24);
        this.r[AX] = product & 0xffff;
        this.cf = this.of = product < -128 || product > 127 ? 1 : 0;
        return 13;
      }
      case 6: {
        const divisor = this.readRM8();
        if (divisor === 0) return this.divideError();
        const dividend = this.r[AX];
        const quotient = Math.floor(dividend / divisor);
        if (quotient > 0xff) return this.divideError();
        this.set8(0, quotient);
        this.set8(4, dividend % divisor);
        return 14;
      }
      default: {
        const divisor = (this.readRM8() << 24) >> 24;
        if (divisor === 0) return this.divideError();
        const dividend = (this.r[AX] << 16) >> 16;
        const quotient = Math.trunc(dividend / divisor);
        if (quotient > 127 || quotient < -128) return this.divideError();
        this.set8(0, quotient);
        this.set8(4, dividend % divisor);
        return 17;
      }
    }
  }

  group3_16(op) {
    switch (op) {
      case 0:
      case 1: {
        const value = this.readRM16() & this.fetch16();
        this.setLogicFlags16(value);
        return 5;
      }
      case 2:
        this.writeRM16(~this.readRM16() & 0xffff);
        return 3;
      case 3: {
        const value = this.readRM16();
        this.writeRM16(this.sub16(0, value));
        this.cf = value !== 0 ? 1 : 0;
        return 3;
      }
      case 4: {
        const product = this.r[AX] * this.readRM16();
        this.r[AX] = product & 0xffff;
        this.r[DX] = Math.floor(product / 0x10000) & 0xffff;
        this.cf = this.of = this.r[DX] !== 0 ? 1 : 0;
        return 21;
      }
      case 5: {
        const product = ((this.r[AX] << 16) >> 16) * ((this.readRM16() << 16) >> 16);
        this.r[AX] = product & 0xffff;
        this.r[DX] = Math.floor(product / 0x10000) & 0xffff;
        this.cf = this.of = product < -32768 || product > 32767 ? 1 : 0;
        return 21;
      }
      case 6: {
        const divisor = this.readRM16();
        if (divisor === 0) return this.divideError();
        const dividend = this.r[DX] * 0x10000 + this.r[AX];
        const quotient = Math.floor(dividend / divisor);
        if (quotient > 0xffff) return this.divideError();
        this.r[AX] = quotient & 0xffff;
        this.r[DX] = dividend % divisor;
        return 22;
      }
      default: {
        const divisor = (this.readRM16() << 16) >> 16;
        if (divisor === 0) return this.divideError();
        let dividend = this.r[DX] * 0x10000 + this.r[AX];
        if (dividend >= 0x80000000) dividend -= 0x100000000;
        const quotient = Math.trunc(dividend / divisor);
        if (quotient > 32767 || quotient < -32768) return this.divideError();
        this.r[AX] = quotient & 0xffff;
        this.r[DX] = (dividend % divisor) & 0xffff;
        return 25;
      }
    }
  }

  /**
   * Dividere per zero è l'interrupt zero, ed è il primo della tabella per un
   * motivo storico che poi è diventato una convenzione: era il primo guaio a
   * cui qualcuno avesse pensato.
   */
  divideError() {
    this.ip = this.instructionStart;
    this.interrupt(0);
    return 20;
  }

  // ------------------------------------------------------------ gli interrupt

  /**
   * Un interrupt impila i flag e l'indirizzo di ritorno, spegne le interruzioni
   * e salta dove dice la tabella dei vettori — che sta all'indirizzo zero, i
   * primi mille byte della memoria, dove chiunque può riscriverla. È tutta la
   * sicurezza che il DOS ha mai avuto, ed è anche il motivo per cui si poteva
   * fare qualunque cosa.
   */
  interrupt(vector) {
    this.push(this.flags);
    this.push(this.s[CS]);
    this.push(this.ip);
    this.if_ = 0;
    this.tf = 0;
    const table = (vector & 0xff) * 4;
    this.ip = this.bus.read8(table) | (this.bus.read8(table + 1) << 8);
    this.s[CS] = this.bus.read8(table + 2) | (this.bus.read8(table + 3) << 8);
    this.halted = false;
  }

  /** Una richiesta dal PIC, che entra solo se il programma ha detto di sì. */
  irq(vector) {
    if (!this.if_) return false;
    this.interrupt(vector);
    return true;
  }

  // ------------------------------------------------------------ un'istruzione

  /**
   * Un'istruzione, prefissi compresi.
   *
   * I prefissi sono byte a sé che modificano quella dopo: cambiano il segmento
   * da cui si legge, o dicono di ripetere l'istruzione finché CX non si svuota.
   * Se ne possono mettere più d'uno, ed è per questo che si raccolgono in un
   * ciclo invece che con un `if`.
   */
  step() {
    if (this.halted) return 1;

    this.segmentOverride = -1;
    this.repeat = 0;
    this.instructionStart = this.ip;
    const delay = this.stiDelay;

    let opcode = this.fetch8();
    for (;;) {
      if (opcode === 0x26) this.segmentOverride = ES;
      else if (opcode === 0x2e) this.segmentOverride = CS;
      else if (opcode === 0x36) this.segmentOverride = SS;
      else if (opcode === 0x3e) this.segmentOverride = DS;
      else if (opcode === 0xf2 || opcode === 0xf3) this.repeat = opcode;
      else if (opcode !== 0xf0) break; // LOCK: qui non c'è nessuno da chiudere fuori
      opcode = this.fetch8();
    }

    this.instructions++;
    const cost = this.execute(opcode);
    if (delay && this.stiDelay === delay) this.stiDelay = delay - 1;
    return cost;
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

  /** Le otto operazioni aritmetiche di base, che stanno tutte nella stessa griglia. */
  alu8(op, a, b) {
    switch (op) {
      case 0:
        return this.add8(a, b);
      case 1:
        return this.setLogicFlags8(a | b);
      case 2:
        return this.add8(a, b, this.cf);
      case 3:
        return this.sub8(a, b, this.cf);
      case 4:
        return this.setLogicFlags8(a & b);
      case 5:
        return this.sub8(a, b);
      case 6:
        return this.setLogicFlags8(a ^ b);
      default:
        this.sub8(a, b); // CMP: fa la sottrazione e tiene solo i flag
        return a;
    }
  }

  alu16(op, a, b) {
    switch (op) {
      case 0:
        return this.add16(a, b);
      case 1:
        return this.setLogicFlags16(a | b);
      case 2:
        return this.add16(a, b, this.cf);
      case 3:
        return this.sub16(a, b, this.cf);
      case 4:
        return this.setLogicFlags16(a & b);
      case 5:
        return this.sub16(a, b);
      case 6:
        return this.setLogicFlags16(a ^ b);
      default:
        this.sub16(a, b);
        return a;
    }
  }

  /**
   * Un'istruzione di stringa, una volta sola — e se c'è un prefisso di
   * ripetizione, si rimette indietro il puntatore invece di girare qui dentro.
   *
   * Non è pigrizia: è l'unico modo di restare interrompibili. Un REP MOVSW che
   * sposta sessantaquattro kilobyte in un colpo terrebbe fuori l'interrupt del
   * timer per il tempo che ci vuole, e l'orologio del DOS resterebbe indietro.
   * L'hardware fa esattamente questo, e infatti un interrupt in mezzo a un REP
   * torna sull'istruzione, prefissi compresi.
   */
  repeatable(callback, checkZero = false) {
    if (!this.repeat) {
      callback();
      return 9;
    }
    if (this.r[CX] === 0) return 2;
    this.r[CX] = (this.r[CX] - 1) & 0xffff;
    callback();
    let again = this.r[CX] !== 0;
    if (again && checkZero) again = this.repeat === 0xf3 ? this.zf === 1 : this.zf === 0;
    if (again) this.ip = this.instructionStart;
    return 9;
  }

  get stringDelta() {
    return this.df ? -1 : 1;
  }

  execute(opcode) {
    // Le operazioni aritmetiche occupano tutta la prima parte della tabella,
    // otto per otto: l'operazione sta nei bit alti e la forma degli operandi
    // in quelli bassi.
    if (opcode < 0x40 && (opcode & 7) < 6) {
      const op = (opcode >> 3) & 7;
      switch (opcode & 7) {
        case 0: {
          this.modrm();
          this.writeRM8(this.alu8(op, this.readRM8(), this.get8(this.reg)));
          return 3;
        }
        case 1: {
          this.modrm();
          this.writeRM16(this.alu16(op, this.readRM16(), this.r[this.reg]));
          return 3;
        }
        case 2: {
          this.modrm();
          this.set8(this.reg, this.alu8(op, this.get8(this.reg), this.readRM8()));
          return 3;
        }
        case 3: {
          this.modrm();
          this.r[this.reg] = this.alu16(op, this.r[this.reg], this.readRM16());
          return 3;
        }
        case 4:
          this.set8(0, this.alu8(op, this.get8(0), this.fetch8()));
          return 3;
        default:
          this.r[AX] = this.alu16(op, this.r[AX], this.fetch16());
          return 3;
      }
    }

    if (opcode >= 0x40 && opcode <= 0x47) {
      this.r[opcode & 7] = this.inc16(this.r[opcode & 7]);
      return 2;
    }
    if (opcode >= 0x48 && opcode <= 0x4f) {
      this.r[opcode & 7] = this.dec16(this.r[opcode & 7]);
      return 2;
    }
    if (opcode >= 0x50 && opcode <= 0x57) {
      // PUSH SP impila quello che SP era prima: sull'8086 impilava il valore
      // già decrementato, ed è un'altra delle differenze che si controllano.
      this.push(this.r[opcode & 7]);
      return 3;
    }
    if (opcode >= 0x58 && opcode <= 0x5f) {
      this.r[opcode & 7] = this.pop();
      return 5;
    }
    if (opcode >= 0x70 && opcode <= 0x7f) {
      const offset = this.fetchSigned8();
      if (this.condition(opcode & 0x0f)) {
        this.ip = (this.ip + offset) & 0xffff;
        return 7;
      }
      return 3;
    }
    if (opcode >= 0x91 && opcode <= 0x97) {
      const index = opcode & 7;
      const value = this.r[AX];
      this.r[AX] = this.r[index];
      this.r[index] = value;
      return 3;
    }
    if (opcode >= 0xb0 && opcode <= 0xb7) {
      this.set8(opcode & 7, this.fetch8());
      return 2;
    }
    if (opcode >= 0xb8 && opcode <= 0xbf) {
      this.r[opcode & 7] = this.fetch16();
      return 2;
    }

    switch (opcode) {
      // ---- i segmenti, che si impilano e si spilano da soli
      case 0x06:
        this.push(this.s[ES]);
        return 3;
      case 0x07:
        this.s[ES] = this.pop();
        return 5;
      case 0x0e:
        this.push(this.s[CS]);
        return 3;
      case 0x16:
        this.push(this.s[SS]);
        return 3;
      case 0x17:
        this.s[SS] = this.pop();
        this.stiDelay = 2; // caricare SS tiene fuori gli interrupt per un'istruzione
        return 5;
      case 0x1e:
        this.push(this.s[DS]);
        return 3;
      case 0x1f:
        this.s[DS] = this.pop();
        return 5;

      // ---- l'aritmetica decimale, che serviva quando i soldi si contavano in BCD
      case 0x27: {
        const before = this.get8(0);
        let value = before;
        if ((value & 0x0f) > 9 || this.af) {
          value += 6;
          this.af = 1;
        } else this.af = 0;
        if (before > 0x99 || this.cf) {
          value += 0x60;
          this.cf = 1;
        } else this.cf = 0;
        this.set8(0, value);
        this.setResultFlags8(value & 0xff);
        return 3;
      }
      case 0x2f: {
        const before = this.get8(0);
        let value = before;
        if ((value & 0x0f) > 9 || this.af) {
          value -= 6;
          this.af = 1;
        } else this.af = 0;
        if (before > 0x99 || this.cf) {
          value -= 0x60;
          this.cf = 1;
        } else this.cf = 0;
        this.set8(0, value);
        this.setResultFlags8(value & 0xff);
        return 3;
      }
      case 0x37: {
        if ((this.get8(0) & 0x0f) > 9 || this.af) {
          this.set8(0, this.get8(0) + 6);
          this.set8(4, this.get8(4) + 1);
          this.af = 1;
          this.cf = 1;
        } else {
          this.af = 0;
          this.cf = 0;
        }
        this.set8(0, this.get8(0) & 0x0f);
        return 3;
      }
      case 0x3f: {
        if ((this.get8(0) & 0x0f) > 9 || this.af) {
          this.set8(0, this.get8(0) - 6);
          this.set8(4, this.get8(4) - 1);
          this.af = 1;
          this.cf = 1;
        } else {
          this.af = 0;
          this.cf = 0;
        }
        this.set8(0, this.get8(0) & 0x0f);
        return 3;
      }

      // ---- le istruzioni che il 186 ha aggiunto e il 286 si porta dietro
      case 0x60: {
        const sp = this.r[SP];
        for (let i = 0; i <= 7; i++) this.push(i === SP ? sp : this.r[i]);
        return 17;
      }
      case 0x61: {
        for (let i = 7; i >= 0; i--) {
          const value = this.pop();
          if (i !== SP) this.r[i] = value; // SP si rimette da sé, spilando
        }
        return 19;
      }
      case 0x62: {
        // BOUND: l'indice sta fra i due limiti, o è interrupt cinque.
        this.modrm();
        const index = (this.r[this.reg] << 16) >> 16;
        const low = (this.readMem16(this.eaSegment, this.ea) << 16) >> 16;
        const high = (this.readMem16(this.eaSegment, (this.ea + 2) & 0xffff) << 16) >> 16;
        if (index < low || index > high) {
          this.ip = this.instructionStart;
          this.interrupt(5);
        }
        return 13;
      }
      case 0x68:
        this.push(this.fetch16());
        return 3;
      case 0x69: {
        this.modrm();
        const value = (this.readRM16() << 16) >> 16;
        const immediate = (this.fetch16() << 16) >> 16;
        const product = value * immediate;
        this.r[this.reg] = product & 0xffff;
        this.cf = this.of = product < -32768 || product > 32767 ? 1 : 0;
        return 21;
      }
      case 0x6a:
        this.push(this.fetchSigned8() & 0xffff);
        return 3;
      case 0x6b: {
        this.modrm();
        const value = (this.readRM16() << 16) >> 16;
        const immediate = this.fetchSigned8();
        const product = value * immediate;
        this.r[this.reg] = product & 0xffff;
        this.cf = this.of = product < -32768 || product > 32767 ? 1 : 0;
        return 21;
      }
      case 0x6c:
        return this.repeatable(() => {
          this.writeMem8(this.s[ES], this.r[DI], this.bus.inb(this.r[DX]));
          this.r[DI] = (this.r[DI] + this.stringDelta) & 0xffff;
        });
      case 0x6d:
        return this.repeatable(() => {
          this.writeMem16(this.s[ES], this.r[DI], this.inw(this.r[DX]));
          this.r[DI] = (this.r[DI] + this.stringDelta * 2) & 0xffff;
        });
      case 0x6e:
        return this.repeatable(() => {
          this.bus.outb(this.r[DX], this.readMem8(this.segmentFor(DS), this.r[SI]));
          this.r[SI] = (this.r[SI] + this.stringDelta) & 0xffff;
        });
      case 0x6f:
        return this.repeatable(() => {
          this.outw(this.r[DX], this.readMem16(this.segmentFor(DS), this.r[SI]));
          this.r[SI] = (this.r[SI] + this.stringDelta * 2) & 0xffff;
        });

      // ---- immediati contro registro o memoria
      case 0x80: {
        this.modrm();
        const op = this.reg;
        this.writeRM8(this.alu8(op, this.readRM8(), this.fetch8()));
        return 4;
      }
      case 0x81: {
        this.modrm();
        const op = this.reg;
        this.writeRM16(this.alu16(op, this.readRM16(), this.fetch16()));
        return 4;
      }
      case 0x82: {
        this.modrm();
        const op = this.reg;
        this.writeRM8(this.alu8(op, this.readRM8(), this.fetch8()));
        return 4;
      }
      case 0x83: {
        // L'immediato è un byte con segno, allargato a sedici bit: è così che
        // `add ax, -1` sta in tre byte invece che in quattro.
        this.modrm();
        const op = this.reg;
        this.writeRM16(this.alu16(op, this.readRM16(), this.fetchSigned8() & 0xffff));
        return 4;
      }
      case 0x84: {
        this.modrm();
        this.setLogicFlags8(this.readRM8() & this.get8(this.reg));
        return 3;
      }
      case 0x85: {
        this.modrm();
        this.setLogicFlags16(this.readRM16() & this.r[this.reg]);
        return 3;
      }
      case 0x86: {
        this.modrm();
        const value = this.readRM8();
        this.writeRM8(this.get8(this.reg));
        this.set8(this.reg, value);
        return 4;
      }
      case 0x87: {
        this.modrm();
        const value = this.readRM16();
        this.writeRM16(this.r[this.reg]);
        this.r[this.reg] = value;
        return 4;
      }

      // ---- MOV, in tutte le sue forme
      case 0x88:
        this.modrm();
        this.writeRM8(this.get8(this.reg));
        return 2;
      case 0x89:
        this.modrm();
        this.writeRM16(this.r[this.reg]);
        return 2;
      case 0x8a:
        this.modrm();
        this.set8(this.reg, this.readRM8());
        return 2;
      case 0x8b:
        this.modrm();
        this.r[this.reg] = this.readRM16();
        return 2;
      case 0x8c:
        this.modrm();
        this.writeRM16(this.s[this.reg & 3]);
        return 2;
      case 0x8d: {
        // LEA non legge niente: calcola l'indirizzo e lo consegna.
        this.modrm();
        this.r[this.reg] = this.ea;
        return 2;
      }
      case 0x8e: {
        this.modrm();
        const value = this.readRM16();
        this.s[this.reg & 3] = value;
        if ((this.reg & 3) === SS) this.stiDelay = 2;
        return 2;
      }
      case 0x8f:
        this.modrm();
        this.writeRM16(this.pop());
        return 5;

      case 0x90:
        return 3; // NOP, che è XCHG AX, AX

      case 0x98: {
        // CBW: il byte diventa una parola portandosi dietro il segno.
        const value = this.get8(0);
        this.set8(4, value & 0x80 ? 0xff : 0x00);
        return 2;
      }
      case 0x99:
        this.r[DX] = this.r[AX] & 0x8000 ? 0xffff : 0x0000;
        return 2;
      case 0x9a: {
        const offset = this.fetch16();
        const segment = this.fetch16();
        this.push(this.s[CS]);
        this.push(this.ip);
        this.s[CS] = segment;
        this.ip = offset;
        return 13;
      }
      case 0x9b:
        return 2; // WAIT: aspetta un coprocessore che qui non c'è
      case 0x9c:
        this.push(this.flags);
        return 3;
      case 0x9d:
        this.flags = this.pop();
        return 5;
      case 0x9e: {
        const value = this.get8(4);
        this.cf = value & 1;
        this.pf = (value >> 2) & 1;
        this.af = (value >> 4) & 1;
        this.zf = (value >> 6) & 1;
        this.sf = (value >> 7) & 1;
        return 2;
      }
      case 0x9f:
        this.set8(4, this.flags & 0xd5);
        return 2;

      // ---- accumulatore contro memoria assoluta
      case 0xa0:
        this.set8(0, this.readMem8(this.segmentFor(DS), this.fetch16()));
        return 5;
      case 0xa1:
        this.r[AX] = this.readMem16(this.segmentFor(DS), this.fetch16());
        return 5;
      case 0xa2:
        this.writeMem8(this.segmentFor(DS), this.fetch16(), this.get8(0));
        return 3;
      case 0xa3:
        this.writeMem16(this.segmentFor(DS), this.fetch16(), this.r[AX]);
        return 3;

      // ---- le istruzioni di stringa
      case 0xa4:
        return this.repeatable(() => {
          this.writeMem8(this.s[ES], this.r[DI], this.readMem8(this.segmentFor(DS), this.r[SI]));
          this.r[SI] = (this.r[SI] + this.stringDelta) & 0xffff;
          this.r[DI] = (this.r[DI] + this.stringDelta) & 0xffff;
        });
      case 0xa5:
        return this.repeatable(() => {
          this.writeMem16(this.s[ES], this.r[DI], this.readMem16(this.segmentFor(DS), this.r[SI]));
          this.r[SI] = (this.r[SI] + this.stringDelta * 2) & 0xffff;
          this.r[DI] = (this.r[DI] + this.stringDelta * 2) & 0xffff;
        });
      case 0xa6:
        return this.repeatable(() => {
          this.sub8(
            this.readMem8(this.segmentFor(DS), this.r[SI]),
            this.readMem8(this.s[ES], this.r[DI]),
          );
          this.r[SI] = (this.r[SI] + this.stringDelta) & 0xffff;
          this.r[DI] = (this.r[DI] + this.stringDelta) & 0xffff;
        }, true);
      case 0xa7:
        return this.repeatable(() => {
          this.sub16(
            this.readMem16(this.segmentFor(DS), this.r[SI]),
            this.readMem16(this.s[ES], this.r[DI]),
          );
          this.r[SI] = (this.r[SI] + this.stringDelta * 2) & 0xffff;
          this.r[DI] = (this.r[DI] + this.stringDelta * 2) & 0xffff;
        }, true);
      case 0xa8:
        this.setLogicFlags8(this.get8(0) & this.fetch8());
        return 2;
      case 0xa9:
        this.setLogicFlags16(this.r[AX] & this.fetch16());
        return 2;
      case 0xaa:
        return this.repeatable(() => {
          this.writeMem8(this.s[ES], this.r[DI], this.get8(0));
          this.r[DI] = (this.r[DI] + this.stringDelta) & 0xffff;
        });
      case 0xab:
        return this.repeatable(() => {
          this.writeMem16(this.s[ES], this.r[DI], this.r[AX]);
          this.r[DI] = (this.r[DI] + this.stringDelta * 2) & 0xffff;
        });
      case 0xac:
        return this.repeatable(() => {
          this.set8(0, this.readMem8(this.segmentFor(DS), this.r[SI]));
          this.r[SI] = (this.r[SI] + this.stringDelta) & 0xffff;
        });
      case 0xad:
        return this.repeatable(() => {
          this.r[AX] = this.readMem16(this.segmentFor(DS), this.r[SI]);
          this.r[SI] = (this.r[SI] + this.stringDelta * 2) & 0xffff;
        });
      case 0xae:
        return this.repeatable(() => {
          this.sub8(this.get8(0), this.readMem8(this.s[ES], this.r[DI]));
          this.r[DI] = (this.r[DI] + this.stringDelta) & 0xffff;
        }, true);
      case 0xaf:
        return this.repeatable(() => {
          this.sub16(this.r[AX], this.readMem16(this.s[ES], this.r[DI]));
          this.r[DI] = (this.r[DI] + this.stringDelta * 2) & 0xffff;
        }, true);

      // ---- scorrimenti, ritorni, e il resto
      case 0xc0: {
        this.modrm();
        const op = this.reg;
        this.writeRM8(this.shift8(op, this.readRM8(), this.fetch8()));
        return 5;
      }
      case 0xc1: {
        this.modrm();
        const op = this.reg;
        this.writeRM16(this.shift16(op, this.readRM16(), this.fetch8()));
        return 5;
      }
      case 0xc2: {
        const bytes = this.fetch16();
        this.ip = this.pop();
        this.r[SP] = (this.r[SP] + bytes) & 0xffff;
        return 11;
      }
      case 0xc3:
        this.ip = this.pop();
        return 11;
      case 0xc4: {
        this.modrm();
        this.r[this.reg] = this.readMem16(this.eaSegment, this.ea);
        this.s[ES] = this.readMem16(this.eaSegment, (this.ea + 2) & 0xffff);
        return 7;
      }
      case 0xc5: {
        this.modrm();
        this.r[this.reg] = this.readMem16(this.eaSegment, this.ea);
        this.s[DS] = this.readMem16(this.eaSegment, (this.ea + 2) & 0xffff);
        return 7;
      }
      case 0xc6:
        this.modrm();
        this.writeRM8(this.fetch8());
        return 3;
      case 0xc7:
        this.modrm();
        this.writeRM16(this.fetch16());
        return 3;
      case 0xc8: {
        // ENTER: la cornice di stack di un linguaggio con le procedure annidate,
        // fatta in hardware perché il Pascal andava di moda.
        const size = this.fetch16();
        const level = this.fetch8() & 0x1f;
        this.push(this.r[BP]);
        const frame = this.r[SP];
        for (let i = 1; i < level; i++) {
          this.r[BP] = (this.r[BP] - 2) & 0xffff;
          this.push(this.readMem16(this.s[SS], this.r[BP]));
        }
        if (level > 0) this.push(frame);
        this.r[BP] = frame;
        this.r[SP] = (this.r[SP] - size) & 0xffff;
        return 11;
      }
      case 0xc9:
        this.r[SP] = this.r[BP];
        this.r[BP] = this.pop();
        return 5;
      case 0xca: {
        const bytes = this.fetch16();
        this.ip = this.pop();
        this.s[CS] = this.pop();
        this.r[SP] = (this.r[SP] + bytes) & 0xffff;
        return 15;
      }
      case 0xcb:
        this.ip = this.pop();
        this.s[CS] = this.pop();
        return 15;
      case 0xcc:
        this.interrupt(3);
        return 23;
      case 0xcd:
        this.interrupt(this.fetch8());
        return 23;
      case 0xce:
        if (this.of) {
          this.interrupt(4);
          return 24;
        }
        return 3;
      case 0xcf: {
        this.ip = this.pop();
        this.s[CS] = this.pop();
        this.flags = this.pop();
        return 17;
      }
      case 0xd0: {
        this.modrm();
        const op = this.reg;
        this.writeRM8(this.shift8(op, this.readRM8(), 1));
        return 2;
      }
      case 0xd1: {
        this.modrm();
        const op = this.reg;
        this.writeRM16(this.shift16(op, this.readRM16(), 1));
        return 2;
      }
      case 0xd2: {
        this.modrm();
        const op = this.reg;
        this.writeRM8(this.shift8(op, this.readRM8(), this.get8(1)));
        return 5;
      }
      case 0xd3: {
        this.modrm();
        const op = this.reg;
        this.writeRM16(this.shift16(op, this.readRM16(), this.get8(1)));
        return 5;
      }
      case 0xd4: {
        // AAM è una divisione per dieci travestita, e l'immediato è la base:
        // qualcuno l'ha usata per dividere per otto in un byte solo.
        const base = this.fetch8();
        if (base === 0) return this.divideError();
        const value = this.get8(0);
        this.set8(4, Math.floor(value / base));
        this.set8(0, value % base);
        this.setResultFlags8(this.get8(0));
        return 16;
      }
      case 0xd5: {
        const base = this.fetch8();
        const value = (this.get8(4) * base + this.get8(0)) & 0xff;
        this.set8(0, value);
        this.set8(4, 0);
        this.setResultFlags8(value);
        return 14;
      }
      case 0xd6:
        this.set8(0, this.cf ? 0xff : 0x00); // SALC, che nei manuali non c'è
        return 2;
      case 0xd7:
        this.set8(0, this.readMem8(this.segmentFor(DS), (this.r[BX] + this.get8(0)) & 0xffff));
        return 5;

      // ---- i cicli e i salti
      case 0xe0:
      case 0xe1:
      case 0xe2: {
        const offset = this.fetchSigned8();
        this.r[CX] = (this.r[CX] - 1) & 0xffff;
        let take = this.r[CX] !== 0;
        if (opcode === 0xe0) take = take && this.zf === 0;
        if (opcode === 0xe1) take = take && this.zf === 1;
        if (take) {
          this.ip = (this.ip + offset) & 0xffff;
          return 8;
        }
        return 4;
      }
      case 0xe3: {
        const offset = this.fetchSigned8();
        if (this.r[CX] === 0) {
          this.ip = (this.ip + offset) & 0xffff;
          return 8;
        }
        return 4;
      }
      case 0xe4:
        this.set8(0, this.bus.inb(this.fetch8()));
        return 5;
      case 0xe5:
        this.r[AX] = this.inw(this.fetch8());
        return 5;
      case 0xe6:
        this.bus.outb(this.fetch8(), this.get8(0));
        return 3;
      case 0xe7:
        this.outw(this.fetch8(), this.r[AX]);
        return 3;
      case 0xe8: {
        const offset = (this.fetch16() << 16) >> 16;
        this.push(this.ip);
        this.ip = (this.ip + offset) & 0xffff;
        return 7;
      }
      case 0xe9: {
        const offset = (this.fetch16() << 16) >> 16;
        this.ip = (this.ip + offset) & 0xffff;
        return 7;
      }
      case 0xea: {
        const offset = this.fetch16();
        this.s[CS] = this.fetch16();
        this.ip = offset;
        return 11;
      }
      case 0xeb: {
        const offset = this.fetchSigned8();
        this.ip = (this.ip + offset) & 0xffff;
        return 7;
      }
      case 0xec:
        this.set8(0, this.bus.inb(this.r[DX]));
        return 5;
      case 0xed:
        this.r[AX] = this.inw(this.r[DX]);
        return 5;
      case 0xee:
        this.bus.outb(this.r[DX], this.get8(0));
        return 3;
      case 0xef:
        this.outw(this.r[DX], this.r[AX]);
        return 3;

      // ---- il governo della macchina
      case 0xf4:
        this.halted = true;
        return 2;
      case 0xf5:
        this.cf ^= 1;
        return 2;
      case 0xf6:
        this.modrm();
        return this.group3_8(this.reg);
      case 0xf7:
        this.modrm();
        return this.group3_16(this.reg);
      case 0xf8:
        this.cf = 0;
        return 2;
      case 0xf9:
        this.cf = 1;
        return 2;
      case 0xfa:
        this.if_ = 0;
        return 2;
      case 0xfb:
        // Le interruzioni rientrano dall'istruzione dopo la prossima: è quel
        // rinvio che fa funzionare `sti` seguito da `hlt` senza perdere niente.
        this.if_ = 1;
        this.stiDelay = 2;
        return 2;
      case 0xfc:
        this.df = 0;
        return 2;
      case 0xfd:
        this.df = 1;
        return 2;
      case 0xfe: {
        this.modrm();
        const value = this.readRM8();
        this.writeRM8(this.reg === 0 ? this.inc8(value) : this.dec8(value));
        return 3;
      }
      case 0xff: {
        this.modrm();
        switch (this.reg) {
          case 0:
            this.writeRM16(this.inc16(this.readRM16()));
            return 3;
          case 1:
            this.writeRM16(this.dec16(this.readRM16()));
            return 3;
          case 2: {
            const target = this.readRM16();
            this.push(this.ip);
            this.ip = target;
            return 7;
          }
          case 3: {
            const offset = this.readMem16(this.eaSegment, this.ea);
            const segment = this.readMem16(this.eaSegment, (this.ea + 2) & 0xffff);
            this.push(this.s[CS]);
            this.push(this.ip);
            this.s[CS] = segment;
            this.ip = offset;
            return 16;
          }
          case 4:
            this.ip = this.readRM16();
            return 7;
          case 5: {
            const offset = this.readMem16(this.eaSegment, this.ea);
            const segment = this.readMem16(this.eaSegment, (this.ea + 2) & 0xffff);
            this.s[CS] = segment;
            this.ip = offset;
            return 11;
          }
          default:
            this.push(this.readRM16());
            return 3;
        }
      }

      case 0x0f: {
        // Sul 286 questo byte apre una seconda tabella. Quasi tutto quello che
        // c'è dentro riguarda il modo protetto, che qui non esiste: si risponde
        // solo a chi chiede com'è messa la macchina, e la risposta è "in modo
        // reale, e ci resta".
        const second = this.fetch8();
        if (second === 0x01) {
          this.modrm();
          if (this.reg === 4) {
            this.writeRM16(0xfff0); // SMSW: il bit di modo protetto è spento
            return 3;
          }
          if (this.reg === 6) {
            this.readRM16(); // LMSW: si legge e si ignora
            return 3;
          }
        }
        this.ip = this.instructionStart;
        this.interrupt(6);
        return 23;
      }

      default:
        if (opcode >= 0xd8 && opcode <= 0xdf) {
          // Le istruzioni del coprocessore matematico. Nello zoccolo non c'è
          // niente, quindi si consuma l'operando e si tira avanti.
          this.modrm();
          return 2;
        }
        // Tutto il resto non esiste su questa macchina: interrupt sei, che è
        // quello che il 286 ha inventato per dire "questa non la conosco".
        this.ip = this.instructionStart;
        this.interrupt(6);
        return 23;
    }
  }

  /** Una parola dalla porta, che sul bus a otto bit sono due byte di fila. */
  inw(port) {
    if (this.bus.inw) return this.bus.inw(port);
    return this.bus.inb(port) | (this.bus.inb((port + 1) & 0xffff) << 8);
  }

  outw(port, value) {
    if (this.bus.outw) {
      this.bus.outw(port, value & 0xffff);
      return;
    }
    this.bus.outb(port, value & 0xff);
    this.bus.outb((port + 1) & 0xffff, (value >> 8) & 0xff);
  }
}
