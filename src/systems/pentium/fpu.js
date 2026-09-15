// Il coprocessore matematico: il 387 accanto al 386, e dentro il Pentium.
//
// Fino al 486 la virgola mobile era un chip a parte, in uno zoccolo vuoto sulla
// scheda madre che si riempiva pagando: l'8087, l'80287, l'80387. Senza, un
// programma che voleva fare una radice quadrata se la calcolava da sé, con
// centinaia di istruzioni intere; con, era una istruzione sola. Il processore e
// il coprocessore si dividono il lavoro in un modo semplice: tutte le istruzioni
// che cominciano con un byte da D8h a DFh — gli "escape" — il processore le
// lascia al vicino, e si limita a calcolargli l'indirizzo dell'operando.
//
// Dentro il 387 non ci sono registri con un nome: c'è una **pila** di otto, e ogni
// istruzione lavora sulla cima. `FLD` spinge un numero, `FADD` somma i due in
// cima, `FSTP` toglie il risultato e lo scrive in memoria. È il modo in cui
// funzionano le calcolatrici HP, ed è per questo che il codice x87 si legge
// come la notazione polacca inversa. I numeri dentro sono lunghi ottanta bit —
// sessantaquattro di mantissa, quindici di esponente, uno di segno — più di
// quanto serva a qualunque programma, perché i risultati intermedi non perdano
// niente per strada.
//
// Qui dentro i numeri sono double di JavaScript, cioè sessantaquattro bit: si
// perdono undici bit di mantissa rispetto al chip, che è molto meno di quanto
// un programma del 1990 potesse accorgersene. Da e verso la memoria però il
// formato a ottanta bit è quello vero, byte per byte, perché è lì che i
// programmi guardano.

/** La parola di controllo all'accensione: tutte le eccezioni mascherate, precisione piena. */
const CONTROL_DEFAULT = 0x037f;

/** I bit delle eccezioni nella parola di stato, nello stesso ordine della maschera. */
const INVALID = 0x01;
const ZERO_DIVIDE = 0x04;
const STACK_FAULT = 0x40;
const ERROR_SUMMARY = 0x80;
const BUSY = 0x8000;
const C0 = 0x0100;
const C1 = 0x0200;
const C2 = 0x0400;
const C3 = 0x4000;

/** I quattro valori della parola dei tag: valido, zero, speciale, vuoto. */
const TAG_VALID = 0;
const TAG_ZERO = 1;
const TAG_SPECIAL = 2;
const TAG_EMPTY = 3;

/** Le sette costanti che il chip sa a memoria, con tutti i loro bit. */
const CONSTANTS = [1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0];

/** Un posto dove convertire fra i bit e i numeri, che JavaScript fa solo così. */
const scratch = new DataView(new ArrayBuffer(8));

/** x per due alla e, senza che il fattore da solo trabocchi o sparisca. */
function ldexp(x, e) {
  while (e > 1023) {
    x *= 2 ** 1023;
    e -= 1023;
  }
  while (e < -1022) {
    x *= 2 ** -1022;
    e += 1022;
  }
  return x * 2 ** e;
}

/** La mantissa fra uno e due, e l'esponente: la scomposizione che fa FXTRACT. */
function frexp(value) {
  if (value === 0 || !Number.isFinite(value)) return { significand: value, exponent: 0 };
  let exponent = Math.floor(Math.log2(Math.abs(value)));
  let significand = ldexp(value, -exponent);
  // log2 sbaglia di un'unità attorno alle potenze di due: si corregge a mano.
  if (Math.abs(significand) >= 2) {
    significand /= 2;
    exponent++;
  } else if (Math.abs(significand) < 1) {
    significand *= 2;
    exponent--;
  }
  return { significand, exponent };
}

/**
 * Da double a ottanta bit, come li scrive il 387 in memoria: otto byte di
 * mantissa con l'uno davanti *scritto* — è l'unico formato Intel che non lo
 * sottintende — e poi segno ed esponente in due byte.
 *
 * @param {number} value
 * @returns {Uint8Array}
 */
export function toExtended(value) {
  const out = new Uint8Array(10);
  const negative = value < 0 || Object.is(value, -0);
  let exponent;
  let mantissa;
  if (value === 0) {
    exponent = 0;
    mantissa = 0n;
  } else if (Number.isNaN(value)) {
    exponent = 0x7fff;
    mantissa = 0xc000000000000000n;
  } else if (!Number.isFinite(value)) {
    exponent = 0x7fff;
    mantissa = 0x8000000000000000n;
  } else {
    scratch.setFloat64(0, value, true);
    const high = scratch.getUint32(4, true);
    let biased = (high >>> 20) & 0x7ff;
    let bits = (BigInt(high & 0xfffff) << 32n) | BigInt(scratch.getUint32(0, true));
    if (biased === 0) {
      // Un double denormale diventa un numero normale nel formato lungo: si
      // sposta la mantissa finché l'uno non arriva in cima.
      biased = 1;
      while (!(bits & (1n << 52n))) {
        bits <<= 1n;
        biased--;
      }
    } else {
      bits |= 1n << 52n;
    }
    exponent = biased - 1023 + 16383;
    mantissa = bits << 11n;
  }
  for (let i = 0; i < 8; i++) out[i] = Number((mantissa >> BigInt(i * 8)) & 0xffn);
  const top = exponent | (negative ? 0x8000 : 0);
  out[8] = top & 0xff;
  out[9] = top >> 8;
  return out;
}

/** Da ottanta bit a double: quello che non ci sta si arrotonda. */
export function fromExtended(bytes) {
  let mantissa = 0n;
  for (let i = 7; i >= 0; i--) mantissa = (mantissa << 8n) | BigInt(bytes[i]);
  const top = bytes[8] | (bytes[9] << 8);
  const negative = (top & 0x8000) !== 0;
  const exponent = top & 0x7fff;
  let value;
  if (exponent === 0 && mantissa === 0n) value = 0;
  else if (exponent === 0x7fff) value = mantissa & 0x7fffffffffffffffn ? NaN : Infinity;
  else value = ldexp(Number(mantissa), exponent - 16383 - 63);
  return negative ? -value : value;
}

export class FPU {
  /**
   * @param {object} cpu il processore, a cui si chiede l'operando e la memoria
   */
  constructor(cpu) {
    this.cpu = cpu;
    this.st = new Float64Array(8);
    this.tags = new Uint8Array(8);
    /** Chi avvisare quando c'è un'eccezione non mascherata: la IRQ 13, su un PC. */
    this.onError = null;
    this.reset();
  }

  /** FNINIT, che è anche come si sveglia. */
  reset() {
    this.control = CONTROL_DEFAULT;
    this.statusBits = 0;
    this.top = 0;
    this.tags.fill(TAG_EMPTY);
    this.st.fill(0);
  }

  // ------------------------------------------------------------ la pila

  /** La parola di stato: le eccezioni, i quattro codici di condizione, e dov'è la cima. */
  get status() {
    return ((this.statusBits & ~0x3800) | (this.top << 11)) & 0xffff;
  }

  set status(value) {
    this.statusBits = value & ~0x3800;
    this.top = (value >> 11) & 7;
  }

  /** La parola dei tag, due bit per registro fisico. */
  get tagWord() {
    let word = 0;
    for (let i = 0; i < 8; i++) word |= this.tags[i] << (i * 2);
    return word;
  }

  set tagWord(value) {
    for (let i = 0; i < 8; i++) {
      const tag = (value >> (i * 2)) & 3;
      this.tags[i] = tag === TAG_EMPTY ? TAG_EMPTY : this.tagOf(this.st[i]);
    }
  }

  tagOf(value) {
    if (value === 0) return TAG_ZERO;
    return Number.isFinite(value) ? TAG_VALID : TAG_SPECIAL;
  }

  physical(i) {
    return (this.top + i) & 7;
  }

  /** ST(i). Leggere un registro vuoto è un errore di pila, e dà l'indefinito. */
  get(i) {
    const at = this.physical(i);
    if (this.tags[at] === TAG_EMPTY) {
      this.exception(INVALID | STACK_FAULT);
      this.statusBits &= ~C1;
      return NaN;
    }
    return this.st[at];
  }

  set(i, value) {
    const at = this.physical(i);
    this.st[at] = value;
    this.tags[at] = this.tagOf(value);
  }

  push(value) {
    this.top = (this.top - 1) & 7;
    if (this.tags[this.top] !== TAG_EMPTY) {
      // Otto numeri e un nono: la pila trabocca, e il chip lo dice con il bit
      // C1 acceso — sotto era un traboccamento, spento uno svuotamento.
      this.exception(INVALID | STACK_FAULT);
      this.statusBits |= C1;
      value = NaN;
    }
    this.st[this.top] = value;
    this.tags[this.top] = this.tagOf(value);
  }

  pop() {
    this.tags[this.top] = TAG_EMPTY;
    this.top = (this.top + 1) & 7;
  }

  /**
   * Un'eccezione. Quasi sempre è mascherata — la parola di controllo di default
   * le maschera tutte — e allora il chip mette il risultato di ripiego e va
   * avanti: un infinito, o l'"indefinito", che è un NaN. Se non è mascherata,
   * alza il bit di riepilogo e il suo filo verso la scheda madre.
   */
  exception(bits) {
    this.statusBits |= bits;
    if (bits & ~this.control & 0x3f) {
      this.statusBits |= ERROR_SUMMARY | BUSY;
      this.onError?.();
    }
  }

  // ------------------------------------------------------- gli arrotondamenti

  /** Da numero a intero, come dice la parola di controllo: al pari, giù, su, verso lo zero. */
  roundInteger(value) {
    switch ((this.control >> 10) & 3) {
      case 0: {
        const floor = Math.floor(value);
        const rest = value - floor;
        if (rest > 0.5) return floor + 1;
        if (rest < 0.5) return floor;
        return floor % 2 === 0 ? floor : floor + 1;
      }
      case 1:
        return Math.floor(value);
      case 2:
        return Math.ceil(value);
      default:
        return Math.trunc(value);
    }
  }

  // ------------------------------------------------------------ la memoria

  address(offset) {
    const cpu = this.cpu;
    const at = cpu.opOffset + offset;
    return cpu.addrsize === 4 ? at >>> 0 : at & 0xffff;
  }

  readBytes(count) {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) bytes[i] = this.cpu.read(1, this.cpu.opSegment, this.address(i));
    return bytes;
  }

  writeBytes(bytes, offset = 0) {
    for (let i = 0; i < bytes.length; i++) this.cpu.write(1, this.cpu.opSegment, this.address(offset + i), bytes[i]);
  }

  read16(offset = 0) {
    return this.cpu.read(2, this.cpu.opSegment, this.address(offset));
  }

  write16(value, offset = 0) {
    this.cpu.write(2, this.cpu.opSegment, this.address(offset), value & 0xffff);
  }

  write32(value, offset = 0) {
    this.cpu.write(4, this.cpu.opSegment, this.address(offset), value >>> 0);
  }

  readReal32() {
    scratch.setUint32(0, this.cpu.read(4, this.cpu.opSegment, this.address(0)), true);
    return scratch.getFloat32(0, true);
  }

  readReal64() {
    scratch.setUint32(0, this.cpu.read(4, this.cpu.opSegment, this.address(0)), true);
    scratch.setUint32(4, this.cpu.read(4, this.cpu.opSegment, this.address(4)), true);
    return scratch.getFloat64(0, true);
  }

  readInteger(bytes) {
    let value = 0n;
    const raw = this.readBytes(bytes);
    for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(raw[i]);
    return Number(BigInt.asIntN(bytes * 8, value));
  }

  writeReal32(value) {
    scratch.setFloat32(0, value, true);
    this.write32(scratch.getUint32(0, true));
  }

  writeReal64(value) {
    scratch.setFloat64(0, value, true);
    this.write32(scratch.getUint32(0, true));
    this.write32(scratch.getUint32(4, true), 4);
  }

  /**
   * Un intero in memoria, arrotondato come vuole la parola di controllo. Se non
   * ci sta, il chip scrive l'"intero indefinito" — il più negativo che esista —
   * che è il modo in cui un programma si accorge di aver sbagliato conto.
   */
  writeInteger(value, bytes) {
    const bits = bytes * 8;
    const limit = 2 ** (bits - 1);
    let integer;
    const rounded = this.roundInteger(value);
    if (!Number.isFinite(rounded) || rounded >= limit || rounded < -limit) {
      this.exception(INVALID);
      integer = -(1n << BigInt(bits - 1));
    } else {
      integer = BigInt(rounded);
    }
    const unsigned = BigInt.asUintN(bits, integer);
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = Number((unsigned >> BigInt(i * 8)) & 0xffn);
    this.writeBytes(out);
  }

  /** Il BCD impaccato: diciotto cifre decimali, due per byte, e il segno in fondo. */
  readBCD() {
    const raw = this.readBytes(10);
    let value = 0;
    for (let i = 8; i >= 0; i--) value = value * 100 + (raw[i] >> 4) * 10 + (raw[i] & 0x0f);
    return raw[9] & 0x80 ? -value : value;
  }

  writeBCD(value) {
    let integer = Math.abs(this.roundInteger(value));
    const out = new Uint8Array(10);
    if (!Number.isFinite(integer) || integer >= 1e18) {
      this.exception(INVALID);
      out.set([0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0xff], 0);
      this.writeBytes(out);
      return;
    }
    for (let i = 0; i < 9; i++) {
      const pair = integer % 100;
      integer = Math.floor(integer / 100);
      out[i] = ((Math.floor(pair / 10)) << 4) | (pair % 10);
    }
    out[9] = value < 0 || Object.is(value, -0) ? 0x80 : 0;
    this.writeBytes(out);
  }

  // ------------------------------------------------- l'ambiente e lo stato

  /**
   * FSTENV: le tre parole che contano — controllo, stato e tag — e i puntatori
   * all'ultima istruzione e all'ultimo operando, che qui sono zero. Quattordici
   * byte con gli operandi a sedici bit, ventotto a trentadue.
   */
  storeEnvironment() {
    const wide = this.cpu.opsize === 4;
    const step = wide ? 4 : 2;
    const words = [this.control, this.status, this.tagWord, 0, 0, 0, 0];
    words.forEach((word, i) => (wide ? this.write32(word, i * step) : this.write16(word, i * step)));
    return wide ? 28 : 14;
  }

  loadEnvironment() {
    const step = this.cpu.opsize === 4 ? 4 : 2;
    this.control = this.read16(0);
    this.status = this.read16(step);
    this.tagWord = this.read16(step * 2);
    return step * 7;
  }

  /** FSAVE: l'ambiente e poi gli otto registri, dalla cima in giù, e poi FNINIT. */
  save() {
    const at = this.storeEnvironment();
    for (let i = 0; i < 8; i++) this.writeBytes(toExtended(this.st[this.physical(i)]), at + i * 10);
    this.reset();
  }

  restore() {
    const at = this.loadEnvironment();
    const tags = this.tagWord;
    for (let i = 0; i < 8; i++) {
      const bytes = new Uint8Array(10);
      for (let b = 0; b < 10; b++) bytes[b] = this.cpu.read(1, this.cpu.opSegment, this.address(at + i * 10 + b));
      this.st[this.physical(i)] = fromExtended(bytes);
    }
    this.tagWord = tags;
  }

  // ------------------------------------------------------- le operazioni

  /** Il risultato di un'operazione, con le due eccezioni che si vedono da fuori. */
  result(value, a, b, division = false) {
    if (Number.isNaN(value) && !Number.isNaN(a) && !Number.isNaN(b)) this.exception(INVALID);
    else if (division && b === 0 && Number.isFinite(a) && a !== 0) this.exception(ZERO_DIVIDE);
    return value;
  }

  /** Le otto operazioni della riga: il campo reg sceglie quale. */
  operate(op, a, b) {
    switch (op) {
      case 0:
        return this.result(a + b, a, b);
      case 1:
        return this.result(a * b, a, b);
      case 4:
        return this.result(a - b, a, b);
      case 5:
        return this.result(b - a, a, b);
      case 6:
        return this.result(a / b, a, b, true);
      default:
        return this.result(b / a, b, a, true);
    }
  }

  /**
   * Un confronto non lascia un numero: accende i codici di condizione. C3 dice
   * uguale, C0 dice minore, e se uno dei due non è un numero si accendono tutti
   * e tre — "non confrontabili", che nessun intero ha mai dovuto dire.
   */
  compare(a, b, unordered = false) {
    this.statusBits &= ~(C0 | C1 | C2 | C3);
    if (Number.isNaN(a) || Number.isNaN(b)) {
      if (!unordered) this.exception(INVALID);
      this.statusBits |= C0 | C2 | C3;
    } else if (a < b) this.statusBits |= C0;
    else if (a === b) this.statusBits |= C3;
  }

  /** FXAM: che cosa c'è nella cima, detto con i quattro codici. */
  examine() {
    const at = this.physical(0);
    const value = this.st[at];
    let code;
    if (this.tags[at] === TAG_EMPTY) code = C3 | C0;
    else if (Number.isNaN(value)) code = C0;
    else if (!Number.isFinite(value)) code = C2 | C0;
    else if (value === 0) code = C3;
    else code = C2;
    const negative = value < 0 || Object.is(value, -0);
    this.statusBits = (this.statusBits & ~(C0 | C1 | C2 | C3)) | code | (negative ? C1 : 0);
  }

  /** Il resto parziale, e i tre bit bassi del quoziente sparsi nei codici di condizione. */
  remainder(nearest) {
    const x = this.get(0);
    const y = this.get(1);
    const ratio = x / y;
    const quotient = nearest ? this.roundEven(ratio) : Math.trunc(ratio);
    const value = nearest ? x - y * quotient : x % y;
    this.set(0, this.result(value, x, y));
    const q = Math.abs(quotient) % 8;
    this.statusBits &= ~(C0 | C1 | C2 | C3);
    if (q & 1) this.statusBits |= C1;
    if (q & 2) this.statusBits |= C3;
    if (q & 4) this.statusBits |= C0;
  }

  roundEven(value) {
    const floor = Math.floor(value);
    const rest = value - floor;
    if (rest !== 0.5) return Math.round(value);
    return floor % 2 === 0 ? floor : floor + 1;
  }

  /** Le trigonometriche: fuori da ±2^63 il chip non ci prova, e lo dice con C2. */
  trigonometric(apply) {
    const x = this.get(0);
    this.statusBits &= ~(C1 | C2);
    if (Math.abs(x) >= 2 ** 63) {
      this.statusBits |= C2;
      return;
    }
    apply(x);
  }

  // ------------------------------------------------------- le istruzioni

  /**
   * Un'istruzione del coprocessore. Il processore ha già letto il byte D8-DF;
   * qui si legge il mod-reg-r/m, e poi dipende da tutti e due.
   *
   * @param {number} opcode
   * @returns {number} i cicli
   */
  execute(opcode) {
    const cpu = this.cpu;
    cpu.modrm();
    return cpu.memory ? this.memoryForm(opcode, cpu.reg) : this.registerForm(opcode, cpu.reg, cpu.rm);
  }

  memoryForm(opcode, reg) {
    switch (opcode) {
      case 0xd8:
        return this.arithmetic(reg, this.readReal32());
      case 0xda:
        return this.arithmetic(reg, this.readInteger(4));
      case 0xdc:
        return this.arithmetic(reg, this.readReal64());
      case 0xde:
        return this.arithmetic(reg, this.readInteger(2));
      case 0xd9:
        switch (reg) {
          case 0:
            this.push(this.readReal32());
            return 3;
          case 2:
          case 3:
            this.writeReal32(this.get(0));
            if (reg === 3) this.pop();
            return 7;
          case 4:
            this.loadEnvironment();
            return 30;
          case 5:
            this.control = this.read16();
            return 7;
          case 6:
            this.storeEnvironment();
            return 30;
          case 7:
            this.write16(this.control);
            return 3;
          default:
            return 2;
        }
      case 0xdb:
        switch (reg) {
          case 0:
            this.push(this.readInteger(4));
            return 9;
          case 2:
          case 3:
            this.writeInteger(this.get(0), 4);
            if (reg === 3) this.pop();
            return 9;
          case 5:
            this.push(fromExtended(this.readBytes(10)));
            return 6;
          case 7:
            this.writeBytes(toExtended(this.get(0)));
            this.pop();
            return 6;
          default:
            return 2;
        }
      case 0xdd:
        switch (reg) {
          case 0:
            this.push(this.readReal64());
            return 3;
          case 2:
          case 3:
            this.writeReal64(this.get(0));
            if (reg === 3) this.pop();
            return 8;
          case 4:
            this.restore();
            return 70;
          case 6:
            this.save();
            return 120;
          case 7:
            this.write16(this.status);
            return 3;
          default:
            return 2;
        }
      default: // DF
        switch (reg) {
          case 0:
            this.push(this.readInteger(2));
            return 9;
          case 2:
          case 3:
            this.writeInteger(this.get(0), 2);
            if (reg === 3) this.pop();
            return 9;
          case 4:
            this.push(this.readBCD());
            return 50;
          case 5:
            this.push(this.readInteger(8));
            return 9;
          case 6:
            this.writeBCD(this.get(0));
            this.pop();
            return 150;
          case 7:
            this.writeInteger(this.get(0), 8);
            this.pop();
            return 9;
          default:
            return 2;
        }
    }
  }

  /** ST(0) = ST(0) op operando, o il confronto: il campo reg dice quale. */
  arithmetic(reg, operand) {
    const a = this.get(0);
    if (reg === 2 || reg === 3) {
      this.compare(a, operand);
      if (reg === 3) this.pop();
      return 4;
    }
    this.set(0, this.operate(reg, a, operand));
    return reg >= 6 ? 39 : 8;
  }

  /**
   * ST(i) = ST(i) op ST(0), con in più la stranezza che tutti i disassemblatori
   * hanno sbagliato almeno una volta: in questa forma la sottrazione e la
   * divisione "rovesciate" hanno i codici scambiati rispetto alla forma su ST(0).
   */
  toRegister(reg, i, pop) {
    const a = this.get(i);
    const s = this.get(0);
    let value;
    switch (reg) {
      case 0:
        value = this.operate(0, a, s);
        break;
      case 1:
        value = this.operate(1, a, s);
        break;
      case 4:
        value = this.operate(4, s, a); // FSUBR ST(i), ST: ST(i) = ST - ST(i)
        break;
      case 5:
        value = this.operate(4, a, s); // FSUB ST(i), ST: ST(i) = ST(i) - ST
        break;
      case 6:
        value = this.operate(6, s, a); // FDIVR ST(i), ST: ST(i) = ST / ST(i)
        break;
      default:
        value = this.operate(6, a, s); // FDIV ST(i), ST: ST(i) = ST(i) / ST
    }
    this.set(i, value);
    if (pop) this.pop();
    return reg >= 6 ? 39 : 8;
  }

  registerForm(opcode, reg, i) {
    switch (opcode) {
      case 0xd8:
        return this.arithmetic(reg, this.get(i));
      case 0xd9:
        return this.groupD9(reg, i);
      case 0xda:
        if (reg === 5 && i === 1) {
          // FUCOMPP: il confronto che non protesta per un NaN tranquillo.
          this.compare(this.get(0), this.get(1), true);
          this.pop();
          this.pop();
        }
        return 5;
      case 0xdb:
        if (reg === 4) {
          if (i === 2) this.statusBits &= ~(0x80ff | BUSY); // FNCLEX
          else if (i === 3) this.reset(); // FNINIT
          // FENI, FDISI e FSETPM: comandi dell'8087 e del 287 che il 387 accetta
          // e ignora.
        }
        return 5;
      case 0xdc:
        if (reg === 2 || reg === 3) {
          this.compare(this.get(0), this.get(i));
          if (reg === 3) this.pop();
          return 4;
        }
        return this.toRegister(reg, i, false);
      case 0xdd:
        switch (reg) {
          case 0: // FFREE
            this.tags[this.physical(i)] = TAG_EMPTY;
            return 3;
          case 1: {
            const a = this.get(0);
            this.set(0, this.get(i));
            this.set(i, a);
            return 3;
          }
          case 2:
          case 3:
            this.set(i, this.get(0));
            if (reg === 3) this.pop();
            return 3;
          case 4:
          case 5:
            this.compare(this.get(0), this.get(i), true);
            if (reg === 5) this.pop();
            return 4;
          default:
            return 2;
        }
      case 0xde:
        if (reg === 3 && i === 1) {
          this.compare(this.get(0), this.get(1));
          this.pop();
          this.pop();
          return 5;
        }
        if (reg === 2) {
          this.compare(this.get(0), this.get(i));
          this.pop();
          return 4;
        }
        return this.toRegister(reg, i, true);
      default: // DF
        if (reg === 4 && i === 0) {
          // FNSTSW AX: la parola di stato dritta in un registro del processore,
          // che è come si fa un salto condizionato su un confronto del 387.
          this.cpu.set16(0, this.status);
          return 3;
        }
        if (reg === 0) {
          this.tags[this.physical(i)] = TAG_EMPTY;
          this.pop();
        }
        return 2;
    }
  }

  groupD9(reg, i) {
    switch (reg) {
      case 0: {
        const value = this.get(i);
        this.push(value);
        return 3;
      }
      case 1: {
        const a = this.get(0);
        this.set(0, this.get(i));
        this.set(i, a);
        return 3;
      }
      case 2:
        return 3; // FNOP
      case 3:
        this.set(i, this.get(0));
        this.pop();
        return 3;
      case 4:
        switch (i) {
          case 0:
            this.set(0, -this.get(0));
            return 3;
          case 1:
            this.set(0, Math.abs(this.get(0)));
            return 3;
          case 4:
            this.compare(this.get(0), 0);
            return 4;
          case 5:
            this.examine();
            return 8;
          default:
            return 2;
        }
      case 5:
        if (i < 7) this.push(CONSTANTS[i]);
        return 4;
      case 6:
        return this.transcendental6(i);
      default:
        return this.transcendental7(i);
    }
  }

  transcendental6(i) {
    switch (i) {
      case 0: {
        const x = this.get(0);
        this.set(0, Math.expm1(x * Math.LN2)); // F2XM1: due alla x, meno uno
        return 200;
      }
      case 1: {
        const x = this.get(0);
        const y = this.get(1);
        if (x === 0) this.exception(ZERO_DIVIDE);
        this.set(1, this.result(y * Math.log2(x), x, y)); // FYL2X
        this.pop();
        return 200;
      }
      case 2:
        this.trigonometric((x) => {
          this.set(0, Math.tan(x)); // FPTAN, che poi spinge un 1 per compatibilità col 287
          this.push(1);
        });
        return 200;
      case 3: {
        const x = this.get(0);
        const y = this.get(1);
        this.set(1, Math.atan2(y, x)); // FPATAN
        this.pop();
        return 200;
      }
      case 4: {
        const { significand, exponent } = frexp(this.get(0)); // FXTRACT
        this.set(0, exponent);
        this.push(significand);
        return 50;
      }
      case 5:
        this.remainder(true); // FPREM1, il resto dello standard IEEE
        return 80;
      case 6:
        this.top = (this.top - 1) & 7; // FDECSTP
        return 2;
      default:
        this.top = (this.top + 1) & 7; // FINCSTP
        return 2;
    }
  }

  transcendental7(i) {
    switch (i) {
      case 0:
        this.remainder(false); // FPREM, quello del 8087
        return 80;
      case 1: {
        const x = this.get(0);
        const y = this.get(1);
        this.set(1, this.result((y * Math.log1p(x)) / Math.LN2, x, y)); // FYL2XP1
        this.pop();
        return 200;
      }
      case 2: {
        const x = this.get(0);
        this.set(0, this.result(Math.sqrt(x), x, 0));
        return 70;
      }
      case 3:
        this.trigonometric((x) => {
          this.set(0, Math.sin(x)); // FSINCOS: il seno sotto, il coseno in cima
          this.push(Math.cos(x));
        });
        return 200;
      case 4:
        this.set(0, this.roundInteger(this.get(0))); // FRNDINT
        return 20;
      case 5: {
        const x = this.get(0);
        const scale = Math.trunc(this.get(1));
        this.set(0, ldexp(x, Math.max(-20000, Math.min(20000, scale)))); // FSCALE
        return 30;
      }
      case 6:
        this.trigonometric((x) => this.set(0, Math.sin(x)));
        return 200;
      default:
        this.trigonometric((x) => this.set(0, Math.cos(x)));
        return 200;
    }
  }
}
