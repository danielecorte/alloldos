// Motorola 68000.
//
// A plain interpreter: fetch a word, decode it by hand, execute it. The whole
// user and supervisor instruction set is here, including the exception
// machinery — address error, privilege violation, TRAP, the autovectored
// interrupts Paula raises — because an operating system in ROM uses all of it
// long before it ever draws anything.
//
// Cycle counts are the manual's figures for the common cases plus the
// addressing-mode table, which is close enough to keep the chipset and the CPU
// in step; it is not a cycle-exact 68000, and nothing here pretends otherwise.

const MASK = [0, 0xff, 0xffff, 0, 0xffffffff];
const SIGN = [0, 0x80, 0x8000, 0, 0x80000000];

const BYTE = 1;
const WORD = 2;
const LONG = 4;

/** Extra cycles for working out an effective address, by mode and size. */
const EA_CYCLES = [
  // .b/.w                              .l
  [0, 0, 4, 4, 6, 8, 10, 8, 12, 8, 10, 0],
  [0, 0, 8, 8, 10, 12, 14, 12, 16, 12, 14, 0],
];

export const VECTOR_BUS_ERROR = 2;
export const VECTOR_ADDRESS_ERROR = 3;
export const VECTOR_ILLEGAL = 4;
export const VECTOR_DIVIDE_BY_ZERO = 5;
export const VECTOR_CHK = 6;
export const VECTOR_TRAPV = 7;
export const VECTOR_PRIVILEGE = 8;
export const VECTOR_TRACE = 9;
export const VECTOR_LINE_A = 10;
export const VECTOR_LINE_F = 11;

/** Thrown internally to abandon an instruction that faulted half way through. */
class Fault {
  constructor(vector, address, write, instruction) {
    this.vector = vector;
    this.address = address;
    this.write = write;
    this.instruction = instruction;
  }
}

export class CPU68000 {
  /**
   * @param {object} bus read8/read16/read32 and write8/write16/write32, all
   *   taking a 24-bit address
   */
  constructor(bus) {
    this.bus = bus;
    this.d = new Uint32Array(8);
    this.a = new Uint32Array(8);
    this.reset(true);
  }

  /**
   * @param {boolean} hard true for power-on, which reloads the vectors; the
   *   RESET instruction only pulses the reset line to the chips.
   */
  reset(hard = true) {
    this.pc = 0;
    this.usp = 0;
    this.ssp = 0;
    this.supervisor = true;
    this.traceFlag = false;
    this.interruptMask = 7;
    this.n = false;
    this.z = false;
    this.v = false;
    this.c = false;
    this.x = false;

    this.ipl = 0; // interrupt level asserted by the chipset
    this.stopped = false;
    this.halted = false; // double fault: the 68000 stops until someone hits reset
    this.cycles = 0;
    this.instructions = 0;

    if (!hard) return;
    this.d.fill(0);
    this.a.fill(0);
    this.a[7] = this.ssp = this.read32(0);
    this.pc = this.read32(4);
  }

  // ------------------------------------------------------------------ status

  getSR() {
    return (
      (this.traceFlag ? 0x8000 : 0) |
      (this.supervisor ? 0x2000 : 0) |
      (this.interruptMask << 8) |
      this.getCCR()
    );
  }

  getCCR() {
    return (
      (this.x ? 0x10 : 0) |
      (this.n ? 0x08 : 0) |
      (this.z ? 0x04 : 0) |
      (this.v ? 0x02 : 0) |
      (this.c ? 0x01 : 0)
    );
  }

  setCCR(value) {
    this.x = (value & 0x10) !== 0;
    this.n = (value & 0x08) !== 0;
    this.z = (value & 0x04) !== 0;
    this.v = (value & 0x02) !== 0;
    this.c = (value & 0x01) !== 0;
  }

  /** Writing the status register can swap the stack pointer under our feet. */
  setSR(value) {
    this.setCCR(value);
    this.traceFlag = (value & 0x8000) !== 0;
    this.interruptMask = (value >> 8) & 7;
    this.setSupervisor((value & 0x2000) !== 0);
  }

  setSupervisor(on) {
    if (on === this.supervisor) return;
    if (this.supervisor) {
      this.ssp = this.a[7];
      this.a[7] = this.usp;
    } else {
      this.usp = this.a[7];
      this.a[7] = this.ssp;
    }
    this.supervisor = on;
  }

  /** The chipset drives this with the highest pending interrupt, 0 for none. */
  setInterruptLevel(level) {
    this.ipl = level & 7;
  }

  // -------------------------------------------------------------------- bus

  read8(addr) {
    return this.bus.read8(addr & 0xffffff);
  }

  read16(addr) {
    if (addr & 1) throw new Fault(VECTOR_ADDRESS_ERROR, addr, false, this.opcode);
    return this.bus.read16(addr & 0xffffff);
  }

  read32(addr) {
    if (addr & 1) throw new Fault(VECTOR_ADDRESS_ERROR, addr, false, this.opcode);
    return this.bus.read32(addr & 0xffffff);
  }

  write8(addr, value) {
    this.bus.write8(addr & 0xffffff, value & 0xff);
  }

  write16(addr, value) {
    if (addr & 1) throw new Fault(VECTOR_ADDRESS_ERROR, addr, true, this.opcode);
    this.bus.write16(addr & 0xffffff, value & 0xffff);
  }

  write32(addr, value) {
    if (addr & 1) throw new Fault(VECTOR_ADDRESS_ERROR, addr, true, this.opcode);
    this.bus.write32(addr & 0xffffff, value >>> 0);
  }

  read(addr, size) {
    if (size === BYTE) return this.read8(addr);
    if (size === WORD) return this.read16(addr);
    return this.read32(addr);
  }

  write(addr, size, value) {
    if (size === BYTE) this.write8(addr, value);
    else if (size === WORD) this.write16(addr, value);
    else this.write32(addr, value);
  }

  fetch16() {
    const value = this.read16(this.pc);
    this.pc = (this.pc + 2) >>> 0;
    return value;
  }

  fetchSigned16() {
    return (this.fetch16() << 16) >> 16;
  }

  fetch32() {
    const value = this.read32(this.pc);
    this.pc = (this.pc + 4) >>> 0;
    return value;
  }

  push16(value) {
    this.a[7] = (this.a[7] - 2) >>> 0;
    this.write16(this.a[7], value);
  }

  push32(value) {
    this.a[7] = (this.a[7] - 4) >>> 0;
    this.write32(this.a[7], value);
  }

  pop16() {
    const value = this.read16(this.a[7]);
    this.a[7] = (this.a[7] + 2) >>> 0;
    return value;
  }

  pop32() {
    const value = this.read32(this.a[7]);
    this.a[7] = (this.a[7] + 4) >>> 0;
    return value;
  }

  // ------------------------------------------------------------- addressing

  /**
   * Works out the effective address, applying the side effects of the
   * increment and decrement modes exactly once — which is why read-modify-write
   * instructions ask for the address first and go through it twice, rather than
   * evaluating the operand twice.
   */
  address(mode, reg, size) {
    switch (mode) {
      case 2:
        return this.a[reg];
      case 3: {
        const addr = this.a[reg];
        // A7 always moves in twos: the stack may not be left odd.
        this.a[reg] = (addr + (reg === 7 && size === BYTE ? 2 : size)) >>> 0;
        return addr;
      }
      case 4: {
        const step = reg === 7 && size === BYTE ? 2 : size;
        const addr = (this.a[reg] - step) >>> 0;
        this.a[reg] = addr;
        return addr;
      }
      case 5:
        return (this.a[reg] + this.fetchSigned16()) >>> 0;
      case 6:
        return this.indexed(this.a[reg]);
      default:
        switch (reg) {
          case 0:
            return this.fetchSigned16() >>> 0;
          case 1:
            return this.fetch32();
          case 2: {
            const base = this.pc;
            return (base + this.fetchSigned16()) >>> 0;
          }
          case 3: {
            const base = this.pc;
            return this.indexed(base);
          }
          default: {
            // Immediate: the operand sits in the instruction stream, and a byte
            // lives in the low half of its extension word.
            const addr = this.pc;
            this.pc = (this.pc + (size === BYTE ? 2 : size)) >>> 0;
            return size === BYTE ? addr + 1 : addr;
          }
        }
    }
  }

  /** Address register indirect with index — the brief extension word only. */
  indexed(base) {
    const ext = this.fetch16();
    const reg = (ext >> 12) & 7;
    const raw = ext & 0x8000 ? this.a[reg] : this.d[reg];
    const index = ext & 0x0800 ? raw | 0 : (raw << 16) >> 16;
    const displacement = (ext << 24) >> 24;
    return (base + index + displacement) >>> 0;
  }

  eaCycles(mode, reg, size) {
    const row = size === LONG ? 1 : 0;
    const column = mode === 7 ? 7 + reg : mode;
    this.cycles += EA_CYCLES[row][column] ?? 0;
  }

  /** Reads a source operand from any addressing mode. */
  readSource(mode, reg, size) {
    if (mode === 0) return this.d[reg] & MASK[size];
    if (mode === 1) return size === LONG ? this.a[reg] : this.a[reg] & MASK[size];
    this.eaCycles(mode, reg, size);
    return this.read(this.address(mode, reg, size), size);
  }

  /**
   * Reads an operand that is about to be written back to the same place.
   * `writeBack` finishes the job without re-evaluating the addressing mode.
   */
  readModify(mode, reg, size) {
    if (mode === 0) {
      this.eaAddress = -1;
      this.eaRegister = reg;
      return this.d[reg] & MASK[size];
    }
    this.eaCycles(mode, reg, size);
    this.eaAddress = this.address(mode, reg, size);
    return this.read(this.eaAddress, size);
  }

  writeBack(size, value) {
    if (this.eaAddress < 0) this.setDataRegister(this.eaRegister, size, value);
    else this.write(this.eaAddress, size, value);
  }

  /** Writes to a data register leave the bits above the operand alone. */
  setDataRegister(reg, size, value) {
    if (size === LONG) this.d[reg] = value >>> 0;
    else this.d[reg] = ((this.d[reg] & ~MASK[size]) | (value & MASK[size])) >>> 0;
  }

  // ------------------------------------------------------------------- flags

  setLogicFlags(result, size) {
    this.n = (result & SIGN[size]) !== 0;
    this.z = (result & MASK[size]) === 0;
    this.v = false;
    this.c = false;
  }

  add(src, dst, size, withExtend = false) {
    const mask = MASK[size];
    const sign = SIGN[size];
    const carryIn = withExtend && this.x ? 1 : 0;
    const sum = (dst >>> 0) + (src >>> 0) + carryIn;
    const result = size === LONG ? sum >>> 0 : sum & mask;

    this.c = this.x = sum > mask;
    this.v = ((src ^ result) & (dst ^ result) & sign) !== 0;
    this.n = (result & sign) !== 0;
    // ADDX only ever clears Z, so a multi-word zero stays zero.
    if (withExtend) this.z = this.z && (result & mask) === 0;
    else this.z = (result & mask) === 0;
    return result;
  }

  sub(src, dst, size, withExtend = false) {
    const mask = MASK[size];
    const sign = SIGN[size];
    const borrowIn = withExtend && this.x ? 1 : 0;
    const difference = (dst >>> 0) - (src >>> 0) - borrowIn;
    const result = size === LONG ? difference >>> 0 : difference & mask;

    this.c = this.x = difference < 0;
    this.v = ((src ^ dst) & (dst ^ result) & sign) !== 0;
    this.n = (result & sign) !== 0;
    if (withExtend) this.z = this.z && (result & mask) === 0;
    else this.z = (result & mask) === 0;
    return result;
  }

  /** CMP: a subtraction that keeps its flags and throws the answer away. */
  compare(src, dst, size) {
    const mask = MASK[size];
    const sign = SIGN[size];
    const difference = (dst >>> 0) - (src >>> 0);
    const result = size === LONG ? difference >>> 0 : difference & mask;
    this.c = difference < 0;
    this.v = ((src ^ dst) & (dst ^ result) & sign) !== 0;
    this.n = (result & sign) !== 0;
    this.z = (result & mask) === 0;
  }

  testCondition(code) {
    switch (code) {
      case 0:
        return true;
      case 1:
        return false;
      case 2:
        return !this.c && !this.z; // HI
      case 3:
        return this.c || this.z; // LS
      case 4:
        return !this.c; // CC
      case 5:
        return this.c; // CS
      case 6:
        return !this.z; // NE
      case 7:
        return this.z; // EQ
      case 8:
        return !this.v; // VC
      case 9:
        return this.v; // VS
      case 10:
        return !this.n; // PL
      case 11:
        return this.n; // MI
      case 12:
        return this.n === this.v; // GE
      case 13:
        return this.n !== this.v; // LT
      case 14:
        return !this.z && this.n === this.v; // GT
      default:
        return this.z || this.n !== this.v; // LE
    }
  }

  // -------------------------------------------------------------- exceptions

  /**
   * @param {number} vector
   * @param {?{address:number, write:boolean, instruction:number}} fault set for
   *   the two group 0 exceptions, which push a longer frame
   */
  exception(vector, fault = null) {
    const oldSR = this.getSR();
    const oldPC = this.pc;
    this.setSupervisor(true);
    this.traceFlag = false;

    // A fault while pushing a fault frame is the double bus fault: the real
    // 68000 gives up and asserts HALT until someone presses reset.
    try {
      // The stack grows down, so the deepest push is the last: a group 0 frame
      // reads, from the stack pointer up, status word / address / instruction /
      // SR / PC.
      this.push32(oldPC);
      this.push16(oldSR);
      if (fault) {
        this.push16(fault.instruction ?? 0);
        this.push32(fault.address >>> 0);
        // Function code bits: read or write, supervisor or user.
        this.push16((fault.write ? 0 : 0x10) | (this.supervisor ? 0x04 : 0) | 0x01);
      }
      this.pc = this.read32(vector * 4);
    } catch {
      this.halted = true;
      return;
    }
    this.cycles += fault ? 50 : 34;
  }

  takeInterrupt(level) {
    this.stopped = false;
    const oldSR = this.getSR();
    this.setSupervisor(true);
    this.traceFlag = false;
    this.interruptMask = level;
    this.push32(this.pc);
    this.push16(oldSR);
    // Everything on the Amiga is autovectored: level n comes in through
    // vector 24 + n, which is where exec puts its own handlers.
    this.pc = this.read32((24 + level) * 4);
    this.cycles += 44;
  }

  privilegeCheck() {
    if (this.supervisor) return false;
    this.pc = this.instructionPC;
    this.exception(VECTOR_PRIVILEGE);
    return true;
  }

  // -------------------------------------------------------------------- step

  /**
   * Runs one instruction, or takes one interrupt.
   * @returns {number} cycles it cost
   */
  step() {
    if (this.halted) return 4;

    const before = this.cycles;
    const level = this.ipl;
    if (level === 7 || (level > 0 && level > this.interruptMask)) {
      this.takeInterrupt(level);
      return this.cycles - before;
    }
    if (this.stopped) {
      this.cycles += 4;
      return 4;
    }

    const traced = this.traceFlag;
    this.instructionPC = this.pc;
    try {
      this.opcode = this.fetch16();
      this.execute(this.opcode);
    } catch (error) {
      if (!(error instanceof Fault)) throw error;
      this.pc = this.instructionPC;
      this.exception(error.vector, error);
      return this.cycles - before;
    }
    this.instructions++;

    if (traced && !this.halted) this.exception(VECTOR_TRACE);
    return this.cycles - before;
  }

  // ----------------------------------------------------------------- decoder

  execute(op) {
    switch (op >> 12) {
      case 0x0:
        return this.immediateGroup(op);
      case 0x1:
        return this.move(op, BYTE);
      case 0x2:
        return this.move(op, LONG);
      case 0x3:
        return this.move(op, WORD);
      case 0x4:
        return this.miscGroup(op);
      case 0x5:
        return this.quickGroup(op);
      case 0x6:
        return this.branch(op);
      case 0x7:
        return this.moveq(op);
      case 0x8:
        return this.orGroup(op);
      case 0x9:
        return this.subGroup(op);
      case 0xa:
        return this.exception(VECTOR_LINE_A);
      case 0xb:
        return this.cmpGroup(op);
      case 0xc:
        return this.andGroup(op);
      case 0xd:
        return this.addGroup(op);
      case 0xe:
        return this.shiftGroup(op);
      default:
        // Line F is where the 68881 and the 68020's coprocessors would answer.
        return this.exception(VECTOR_LINE_F);
    }
  }

  /** Turns the two size bits most instructions carry into a byte count. */
  static sizeOf(bits) {
    return bits === 0 ? BYTE : bits === 1 ? WORD : bits === 2 ? LONG : 0;
  }

  // ------------------------------------------------------- $0: immediate ops

  immediateGroup(op) {
    const mode = (op >> 3) & 7;
    const reg = op & 7;

    if (op & 0x0100) {
      // BTST/BCHG/BCLR/BSET with the bit number in a data register, and MOVEP.
      if (mode === 1) return this.movep(op);
      return this.bitOperation(op, this.d[(op >> 9) & 7]);
    }

    const type = (op >> 9) & 7;
    if (type === 4) return this.bitOperation(op, this.fetch16());

    const size = CPU68000.sizeOf((op >> 6) & 3);
    if (size === 0) return this.exception(VECTOR_ILLEGAL);

    const immediate = size === LONG ? this.fetch32() : this.fetch16() & MASK[size];

    // ORI/ANDI/EORI to CCR and SR: mode 7 reg 4 as the destination.
    if (mode === 7 && reg === 4 && (type === 0 || type === 1 || type === 5)) {
      if (size === WORD) {
        if (this.privilegeCheck()) return;
        const sr = this.getSR();
        const value = type === 0 ? sr | immediate : type === 1 ? sr & immediate : sr ^ immediate;
        this.setSR(value);
        this.cycles += 20;
        return;
      }
      const ccr = this.getCCR();
      const value = type === 0 ? ccr | immediate : type === 1 ? ccr & immediate : ccr ^ immediate;
      this.setCCR(value);
      this.cycles += 20;
      return;
    }

    if (type === 6) {
      // CMPI never writes anything back.
      const value = this.readSource(mode, reg, size);
      this.compare(immediate, value, size);
      this.cycles += mode === 0 ? (size === LONG ? 14 : 8) : size === LONG ? 12 : 8;
      return;
    }

    const value = this.readModify(mode, reg, size);
    let result;
    switch (type) {
      case 0:
        result = value | immediate;
        this.setLogicFlags(result, size);
        break;
      case 1:
        result = value & immediate;
        this.setLogicFlags(result, size);
        break;
      case 2:
        result = this.sub(immediate, value, size);
        break;
      case 3:
        result = this.add(immediate, value, size);
        break;
      default:
        result = value ^ immediate;
        this.setLogicFlags(result, size);
        break;
    }
    this.writeBack(size, result);
    this.cycles += mode === 0 ? (size === LONG ? 16 : 8) : size === LONG ? 20 : 12;
  }

  /** BTST, BCHG, BCLR, BSET. Long on a register, byte everywhere else. */
  bitOperation(op, bitNumber) {
    const type = (op >> 6) & 3;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const size = mode === 0 ? LONG : BYTE;
    const bit = bitNumber & (size === LONG ? 31 : 7);
    const mask = size === LONG ? (1 << bit) >>> 0 : 1 << bit;

    if (type === 0) {
      const value = this.readSource(mode, reg, size);
      this.z = ((value >>> 0) & mask) === 0;
      this.cycles += mode === 0 ? 6 : 4;
      return;
    }

    const value = this.readModify(mode, reg, size);
    this.z = ((value >>> 0) & mask) === 0;
    const result = type === 1 ? value ^ mask : type === 2 ? value & ~mask : value | mask;
    this.writeBack(size, result >>> 0);
    this.cycles += mode === 0 ? 8 : 8;
  }

  /** MOVEP: a byte at a time, every other address — how the 8-bit ports wire up. */
  movep(op) {
    const dataReg = (op >> 9) & 7;
    const addressReg = op & 7;
    const size = op & 0x0040 ? LONG : WORD;
    const toMemory = (op & 0x0080) !== 0;
    let addr = (this.a[addressReg] + this.fetchSigned16()) >>> 0;

    if (toMemory) {
      const value = this.d[dataReg];
      for (let shift = size === LONG ? 24 : 8; shift >= 0; shift -= 8) {
        this.write8(addr, (value >>> shift) & 0xff);
        addr = (addr + 2) >>> 0;
      }
    } else {
      let value = 0;
      for (let i = 0; i < size; i++) {
        value = ((value << 8) | this.read8(addr)) >>> 0;
        addr = (addr + 2) >>> 0;
      }
      this.setDataRegister(dataReg, size, value);
    }
    this.cycles += size === LONG ? 24 : 16;
  }

  // -------------------------------------------------------- $1/$2/$3: MOVE

  move(op, size) {
    const srcMode = (op >> 3) & 7;
    const srcReg = op & 7;
    const dstMode = (op >> 6) & 7;
    const dstReg = (op >> 9) & 7;

    if (srcMode === 1 && size === BYTE) return this.exception(VECTOR_ILLEGAL);
    const value = this.readSource(srcMode, srcReg, size);

    if (dstMode === 1) {
      // MOVEA: sign-extended into the whole register, and never touches a flag.
      this.a[dstReg] = (size === WORD ? (value << 16) >> 16 : value) >>> 0;
      this.cycles += 4;
      return;
    }

    this.setLogicFlags(value, size);
    if (dstMode === 0) this.setDataRegister(dstReg, size, value);
    else {
      this.eaCycles(dstMode, dstReg, size);
      this.write(this.address(dstMode, dstReg, size), size, value);
    }
    this.cycles += 4;
  }

  // ------------------------------------------------------------ $4: the rest

  miscGroup(op) {
    const mode = (op >> 3) & 7;
    const reg = op & 7;

    if ((op & 0x01c0) === 0x01c0) return this.lea(op);
    if ((op & 0x01c0) === 0x0180) return this.chk(op);

    switch (op & 0xffc0) {
      case 0x40c0: // MOVE from SR
        this.writeSR(mode, reg);
        return;
      case 0x44c0: // MOVE to CCR
        this.setCCR(this.readSource(mode, reg, WORD));
        this.cycles += 12;
        return;
      case 0x46c0: // MOVE to SR
        if (this.privilegeCheck()) return;
        this.setSR(this.readSource(mode, reg, WORD));
        this.cycles += 12;
        return;
      case 0x4800: // NBCD
        return this.nbcd(mode, reg);
      case 0x4840: // SWAP / PEA
        if (mode === 0) {
          const value = this.d[reg];
          const swapped = ((value >>> 16) | (value << 16)) >>> 0;
          this.d[reg] = swapped;
          this.setLogicFlags(swapped, LONG);
          this.cycles += 4;
          return;
        }
        this.eaCycles(mode, reg, LONG);
        this.push32(this.address(mode, reg, LONG));
        this.cycles += 12;
        return;
      case 0x4ac0: // TAS, and the one encoding of it reserved as ILLEGAL
        if (op === 0x4afc) return this.exception(VECTOR_ILLEGAL);
        return this.tas(mode, reg);
      default:
        break;
    }

    // EXT lives in the mode-0 corner of the MOVEM encoding.
    if ((op & 0xfff8) === 0x4880 || (op & 0xfff8) === 0x48c0) return this.ext(op);
    if ((op & 0xfb80) === 0x4880) return this.movem(op);

    const size = CPU68000.sizeOf((op >> 6) & 3);
    switch ((op >> 8) & 0xf) {
      case 0x0: // NEGX
        if (size) return this.unaryOperation(op, size, 'negx');
        break;
      case 0x2: // CLR
        if (size) return this.unaryOperation(op, size, 'clr');
        break;
      case 0x4: // NEG
        if (size) return this.unaryOperation(op, size, 'neg');
        break;
      case 0x6: // NOT
        if (size) return this.unaryOperation(op, size, 'not');
        break;
      case 0xa: // TST
        if (size) {
          const value = this.readSource(mode, reg, size);
          this.setLogicFlags(value, size);
          this.cycles += 4;
          return;
        }
        break;
      default:
        break;
    }

    if ((op & 0xfff0) === 0x4e40) {
      // TRAP #n: vectors 32 to 47.
      this.exception(32 + (op & 0x0f));
      return;
    }
    if ((op & 0xfff8) === 0x4e50) return this.link(op);
    if ((op & 0xfff8) === 0x4e58) return this.unlk(op);
    if ((op & 0xfff0) === 0x4e60) return this.moveUSP(op);

    switch (op) {
      case 0x4afc:
        return this.exception(VECTOR_ILLEGAL);
      case 0x4e70: // RESET
        if (this.privilegeCheck()) return;
        this.bus.resetDevices?.();
        this.cycles += 132;
        return;
      case 0x4e71: // NOP
        this.cycles += 4;
        return;
      case 0x4e72: {
        // STOP
        if (this.privilegeCheck()) return;
        this.setSR(this.fetch16());
        this.stopped = true;
        this.cycles += 4;
        return;
      }
      case 0x4e73: {
        // RTE
        if (this.privilegeCheck()) return;
        const sr = this.pop16();
        const pc = this.pop32();
        this.setSR(sr);
        this.pc = pc;
        this.cycles += 20;
        return;
      }
      case 0x4e75: // RTS
        this.pc = this.pop32();
        this.cycles += 16;
        return;
      case 0x4e76: // TRAPV
        if (this.v) this.exception(VECTOR_TRAPV);
        else this.cycles += 4;
        return;
      case 0x4e77: {
        // RTR
        this.setCCR(this.pop16());
        this.pc = this.pop32();
        this.cycles += 20;
        return;
      }
      default:
        break;
    }

    if ((op & 0xffc0) === 0x4e80) {
      // JSR
      this.eaCycles(mode, reg, LONG);
      const target = this.address(mode, reg, LONG);
      this.push32(this.pc);
      this.pc = target;
      this.cycles += 12;
      return;
    }
    if ((op & 0xffc0) === 0x4ec0) {
      // JMP
      this.eaCycles(mode, reg, LONG);
      this.pc = this.address(mode, reg, LONG);
      this.cycles += 4;
      return;
    }

    return this.exception(VECTOR_ILLEGAL);
  }

  writeSR(mode, reg) {
    // On a 68000 this one is not privileged; the 68010 changed its mind.
    const value = this.getSR();
    if (mode === 0) this.setDataRegister(reg, WORD, value);
    else {
      this.eaCycles(mode, reg, WORD);
      this.write16(this.address(mode, reg, WORD), value);
    }
    this.cycles += 6;
  }

  unaryOperation(op, size, kind) {
    const mode = (op >> 3) & 7;
    const reg = op & 7;

    if (kind === 'clr') {
      // CLR still reads the operand first on a 68000; the bus cycle is real.
      this.readModify(mode, reg, size);
      this.writeBack(size, 0);
      this.n = false;
      this.z = true;
      this.v = false;
      this.c = false;
      this.cycles += mode === 0 ? 4 : 8;
      return;
    }

    const value = this.readModify(mode, reg, size);
    let result;
    if (kind === 'neg') result = this.sub(value, 0, size);
    else if (kind === 'negx') result = this.sub(value, 0, size, true);
    else {
      result = ~value;
      this.setLogicFlags(result, size);
    }
    this.writeBack(size, result);
    this.cycles += mode === 0 ? 4 : 8;
  }

  nbcd(mode, reg) {
    const value = this.readModify(mode, reg, BYTE);
    const borrow = this.x ? 1 : 0;
    let low = 0 - (value & 0x0f) - borrow;
    let high = 0 - (value >> 4);
    let adjust = 0;
    if (low < 0) {
      low += 10;
      high -= 1;
    }
    if (high < 0) {
      high += 10;
      adjust = 1;
    }
    const result = ((high & 0x0f) << 4) | (low & 0x0f);
    this.c = this.x = adjust === 1;
    if (result !== 0) this.z = false;
    this.n = (result & 0x80) !== 0;
    this.writeBack(BYTE, result);
    this.cycles += 6;
  }

  tas(mode, reg) {
    const value = this.readModify(mode, reg, BYTE);
    this.n = (value & 0x80) !== 0;
    this.z = (value & 0xff) === 0;
    this.v = false;
    this.c = false;
    this.writeBack(BYTE, value | 0x80);
    this.cycles += mode === 0 ? 4 : 14;
  }

  ext(op) {
    const reg = op & 7;
    if (op & 0x0040) {
      const value = (this.d[reg] << 16) >> 16;
      this.d[reg] = value >>> 0;
      this.setLogicFlags(value, LONG);
    } else {
      const value = (this.d[reg] << 24) >> 24;
      this.setDataRegister(reg, WORD, value);
      this.setLogicFlags(value & 0xffff, WORD);
    }
    this.cycles += 4;
  }

  lea(op) {
    const reg = (op >> 9) & 7;
    const mode = (op >> 3) & 7;
    if (mode < 2 || mode === 3 || mode === 4) return this.exception(VECTOR_ILLEGAL);
    this.a[reg] = this.address(mode, op & 7, LONG);
    this.cycles += 4;
  }

  chk(op) {
    const reg = (op >> 9) & 7;
    const bound = this.readSource((op >> 3) & 7, op & 7, WORD);
    const value = (this.d[reg] << 16) >> 16;
    const limit = (bound << 16) >> 16;
    this.cycles += 10;
    if (value < 0 || value > limit) {
      this.n = value < 0;
      this.exception(VECTOR_CHK);
    }
  }

  /**
   * MOVEM. The predecrement form stores the registers backwards, A7 first,
   * which is exactly what makes it the register-saving instruction.
   */
  movem(op) {
    const size = op & 0x0040 ? LONG : WORD;
    const toRegisters = (op & 0x0400) !== 0;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const list = this.fetch16();
    let moved = 0;

    if (!toRegisters && mode === 4) {
      let addr = this.a[reg];
      for (let bit = 0; bit < 16; bit++) {
        if (!(list & (1 << bit))) continue;
        const index = 15 - bit;
        const value = index < 8 ? this.d[index] : this.a[index - 8];
        addr = (addr - size) >>> 0;
        this.write(addr, size, value);
        moved++;
      }
      this.a[reg] = addr;
    } else {
      let addr = mode === 3 ? this.a[reg] : this.address(mode, reg, size);
      for (let bit = 0; bit < 16; bit++) {
        if (!(list & (1 << bit))) continue;
        if (toRegisters) {
          // Loads are always sign-extended to the full 32 bits, even for words.
          const raw = this.read(addr, size);
          const value = size === WORD ? (raw << 16) >> 16 : raw;
          if (bit < 8) this.d[bit] = value >>> 0;
          else this.a[bit - 8] = value >>> 0;
        } else {
          this.write(addr, size, bit < 8 ? this.d[bit] : this.a[bit - 8]);
        }
        addr = (addr + size) >>> 0;
        moved++;
      }
      if (mode === 3) this.a[reg] = addr;
    }
    this.cycles += 12 + moved * (size === LONG ? 8 : 4);
  }

  link(op) {
    const reg = op & 7;
    this.push32(this.a[reg]);
    this.a[reg] = this.a[7];
    this.a[7] = (this.a[7] + this.fetchSigned16()) >>> 0;
    this.cycles += 16;
  }

  unlk(op) {
    const reg = op & 7;
    this.a[7] = this.a[reg];
    this.a[reg] = this.pop32();
    this.cycles += 12;
  }

  moveUSP(op) {
    if (this.privilegeCheck()) return;
    const reg = op & 7;
    if (op & 0x0008) this.a[reg] = this.usp;
    else this.usp = this.a[reg];
    this.cycles += 4;
  }

  // -------------------------------------------- $5: ADDQ/SUBQ, Scc and DBcc

  quickGroup(op) {
    const sizeBits = (op >> 6) & 3;
    const mode = (op >> 3) & 7;
    const reg = op & 7;

    if (sizeBits === 3) {
      const condition = (op >> 8) & 0xf;
      if (mode === 1) {
        // DBcc: fall through when the condition is true, else count down.
        const displacement = this.fetchSigned16();
        if (this.testCondition(condition)) {
          this.cycles += 12;
          return;
        }
        const counter = ((this.d[reg] & 0xffff) - 1) & 0xffff;
        this.setDataRegister(reg, WORD, counter);
        if (counter !== 0xffff) {
          this.pc = (this.pc - 2 + displacement) >>> 0;
          this.cycles += 10;
        } else this.cycles += 14;
        return;
      }
      // Scc
      const value = this.testCondition(condition) ? 0xff : 0x00;
      this.readModify(mode, reg, BYTE);
      this.writeBack(BYTE, value);
      this.cycles += mode === 0 ? (value ? 6 : 4) : 8;
      return;
    }

    const size = CPU68000.sizeOf(sizeBits);
    const data = ((op >> 9) & 7) || 8;

    if (mode === 1) {
      // Quick maths on an address register is always a full 32-bit add.
      this.a[reg] = (op & 0x0100 ? this.a[reg] - data : this.a[reg] + data) >>> 0;
      this.cycles += 8;
      return;
    }

    const value = this.readModify(mode, reg, size);
    const result = op & 0x0100 ? this.sub(data, value, size) : this.add(data, value, size);
    this.writeBack(size, result);
    this.cycles += mode === 0 ? (size === LONG ? 8 : 4) : 8;
  }

  // ---------------------------------------------------- $6: Bcc, BSR and BRA

  branch(op) {
    const condition = (op >> 8) & 0xf;
    let displacement = (op << 24) >> 24;
    const base = this.pc;
    if (displacement === 0) displacement = this.fetchSigned16();

    if (condition === 1) {
      // BSR
      this.push32(this.pc);
      this.pc = (base + displacement) >>> 0;
      this.cycles += 18;
      return;
    }
    if (this.testCondition(condition)) {
      this.pc = (base + displacement) >>> 0;
      this.cycles += 10;
    } else this.cycles += 8;
  }

  moveq(op) {
    const value = (op << 24) >> 24;
    this.d[(op >> 9) & 7] = value >>> 0;
    this.setLogicFlags(value >>> 0, LONG);
    this.cycles += 4;
  }

  // --------------------------------------------------- $8: OR, DIV and SBCD

  orGroup(op) {
    const reg = (op >> 9) & 7;
    const mode = (op >> 3) & 7;
    const earg = op & 7;
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) return this.divide(op, (op & 0x0100) !== 0);
    if ((op & 0x01f0) === 0x0100) return this.bcd(op, false);

    const size = CPU68000.sizeOf(sizeBits);
    if (op & 0x0100) {
      const value = this.readModify(mode, earg, size);
      const result = value | (this.d[reg] & MASK[size]);
      this.setLogicFlags(result, size);
      this.writeBack(size, result);
      this.cycles += size === LONG ? 12 : 8;
      return;
    }
    const result = (this.d[reg] | this.readSource(mode, earg, size)) & MASK[size];
    this.setLogicFlags(result, size);
    this.setDataRegister(reg, size, result);
    this.cycles += size === LONG ? 6 : 4;
  }

  divide(op, signed) {
    const reg = (op >> 9) & 7;
    const raw = this.readSource((op >> 3) & 7, op & 7, WORD);
    const divisor = signed ? (raw << 16) >> 16 : raw;
    this.cycles += signed ? 158 : 140;

    if (divisor === 0) {
      this.pc = this.instructionPC;
      this.exception(VECTOR_DIVIDE_BY_ZERO);
      return;
    }

    const dividend = signed ? this.d[reg] | 0 : this.d[reg] >>> 0;
    const quotient = Math.trunc(dividend / divisor);
    const remainder = dividend % divisor;

    // A quotient that will not fit in 16 bits leaves the register untouched.
    const overflow = signed ? quotient > 32767 || quotient < -32768 : quotient > 0xffff;
    if (overflow) {
      this.v = true;
      this.n = true;
      return;
    }
    this.v = false;
    this.c = false;
    this.n = (quotient & 0x8000) !== 0;
    this.z = (quotient & 0xffff) === 0;
    this.d[reg] = (((remainder & 0xffff) << 16) | (quotient & 0xffff)) >>> 0;
  }

  /** ABCD and SBCD, in both their register and their -(An),-(An) forms. */
  bcd(op, isAdd) {
    const dstReg = (op >> 9) & 7;
    const srcReg = op & 7;
    const memory = (op & 0x0008) !== 0;

    let src;
    let dst;
    let dstAddr = -1;
    if (memory) {
      const srcAddr = (this.a[srcReg] - (srcReg === 7 ? 2 : 1)) >>> 0;
      this.a[srcReg] = srcAddr;
      src = this.read8(srcAddr);
      dstAddr = (this.a[dstReg] - (dstReg === 7 ? 2 : 1)) >>> 0;
      this.a[dstReg] = dstAddr;
      dst = this.read8(dstAddr);
    } else {
      src = this.d[srcReg] & 0xff;
      dst = this.d[dstReg] & 0xff;
    }

    const extend = this.x ? 1 : 0;
    let result;
    let carry;
    if (isAdd) {
      let low = (dst & 0x0f) + (src & 0x0f) + extend;
      let high = (dst >> 4) + (src >> 4);
      if (low > 9) {
        low -= 10;
        high += 1;
      }
      carry = high > 9;
      if (carry) high -= 10;
      result = ((high & 0x0f) << 4) | (low & 0x0f);
    } else {
      let low = (dst & 0x0f) - (src & 0x0f) - extend;
      let high = (dst >> 4) - (src >> 4);
      if (low < 0) {
        low += 10;
        high -= 1;
      }
      carry = high < 0;
      if (carry) high += 10;
      result = ((high & 0x0f) << 4) | (low & 0x0f);
    }

    this.c = this.x = carry;
    if (result !== 0) this.z = false; // BCD only ever clears Z
    this.n = (result & 0x80) !== 0;

    if (memory) this.write8(dstAddr, result);
    else this.setDataRegister(dstReg, BYTE, result);
    this.cycles += memory ? 18 : 6;
  }

  // ------------------------------------------------------------- $9: SUB(X)

  subGroup(op) {
    const reg = (op >> 9) & 7;
    const mode = (op >> 3) & 7;
    const earg = op & 7;
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) {
      // SUBA
      const size = op & 0x0100 ? LONG : WORD;
      const raw = this.readSource(mode, earg, size);
      const value = size === WORD ? (raw << 16) >> 16 : raw;
      this.a[reg] = (this.a[reg] - value) >>> 0;
      this.cycles += 8;
      return;
    }

    const size = CPU68000.sizeOf(sizeBits);
    if ((op & 0x0130) === 0x0100) return this.extended(op, false, size);

    if (op & 0x0100) {
      const value = this.readModify(mode, earg, size);
      const result = this.sub(this.d[reg] & MASK[size], value, size);
      this.writeBack(size, result);
      this.cycles += size === LONG ? 12 : 8;
      return;
    }
    const result = this.sub(this.readSource(mode, earg, size), this.d[reg] & MASK[size], size);
    this.setDataRegister(reg, size, result);
    this.cycles += size === LONG ? 6 : 4;
  }

  /** ADDX and SUBX: the same two shapes as the BCD pair. */
  extended(op, isAdd, size) {
    const dstReg = (op >> 9) & 7;
    const srcReg = op & 7;
    const memory = (op & 0x0008) !== 0;

    let src;
    let dst;
    let dstAddr = -1;
    if (memory) {
      const step = size === BYTE && srcReg === 7 ? 2 : size;
      const srcAddr = (this.a[srcReg] - step) >>> 0;
      this.a[srcReg] = srcAddr;
      src = this.read(srcAddr, size);
      const dstStep = size === BYTE && dstReg === 7 ? 2 : size;
      dstAddr = (this.a[dstReg] - dstStep) >>> 0;
      this.a[dstReg] = dstAddr;
      dst = this.read(dstAddr, size);
    } else {
      src = this.d[srcReg] & MASK[size];
      dst = this.d[dstReg] & MASK[size];
    }

    const result = isAdd ? this.add(src, dst, size, true) : this.sub(src, dst, size, true);
    if (memory) this.write(dstAddr, size, result);
    else this.setDataRegister(dstReg, size, result);
    this.cycles += memory ? (size === LONG ? 30 : 18) : size === LONG ? 8 : 4;
  }

  // ---------------------------------------------------- $b: CMP, CMPM, EOR

  cmpGroup(op) {
    const reg = (op >> 9) & 7;
    const mode = (op >> 3) & 7;
    const earg = op & 7;
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) {
      // CMPA
      const size = op & 0x0100 ? LONG : WORD;
      const raw = this.readSource(mode, earg, size);
      const value = size === WORD ? (raw << 16) >> 16 : raw;
      this.compare(value >>> 0, this.a[reg], LONG);
      this.cycles += 6;
      return;
    }

    const size = CPU68000.sizeOf(sizeBits);
    if (op & 0x0100) {
      if (mode === 1) {
        // CMPM (An)+,(An)+
        const srcAddr = this.address(3, earg, size);
        const dstAddr = this.address(3, reg, size);
        this.compare(this.read(srcAddr, size), this.read(dstAddr, size), size);
        this.cycles += size === LONG ? 20 : 12;
        return;
      }
      const value = this.readModify(mode, earg, size);
      const result = (value ^ this.d[reg]) & MASK[size];
      this.setLogicFlags(result, size);
      this.writeBack(size, result);
      this.cycles += size === LONG ? 12 : 8;
      return;
    }

    this.compare(this.readSource(mode, earg, size), this.d[reg] & MASK[size], size);
    this.cycles += size === LONG ? 6 : 4;
  }

  // ------------------------------------------- $c: AND, MUL, ABCD and EXG

  andGroup(op) {
    const reg = (op >> 9) & 7;
    const mode = (op >> 3) & 7;
    const earg = op & 7;
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) return this.multiply(op, (op & 0x0100) !== 0);
    if ((op & 0x01f0) === 0x0100) return this.bcd(op, true);
    if ((op & 0x0130) === 0x0100) return this.exg(op);

    const size = CPU68000.sizeOf(sizeBits);
    if (op & 0x0100) {
      const value = this.readModify(mode, earg, size);
      const result = value & this.d[reg];
      this.setLogicFlags(result, size);
      this.writeBack(size, result);
      this.cycles += size === LONG ? 12 : 8;
      return;
    }
    const result = this.d[reg] & this.readSource(mode, earg, size);
    this.setLogicFlags(result, size);
    this.setDataRegister(reg, size, result);
    this.cycles += size === LONG ? 6 : 4;
  }

  multiply(op, signed) {
    const reg = (op >> 9) & 7;
    const raw = this.readSource((op >> 3) & 7, op & 7, WORD);
    const source = signed ? (raw << 16) >> 16 : raw;
    const value = signed ? (this.d[reg] << 16) >> 16 : this.d[reg] & 0xffff;
    const result = (source * value) >>> 0;
    this.d[reg] = result;
    this.n = (result & 0x80000000) !== 0;
    this.z = result === 0;
    this.v = false;
    this.c = false;
    this.cycles += 70;
  }

  exg(op) {
    const x = (op >> 9) & 7;
    const y = op & 7;
    const kind = (op >> 3) & 0x1f;
    if (kind === 0x08) {
      const t = this.d[x];
      this.d[x] = this.d[y];
      this.d[y] = t;
    } else if (kind === 0x09) {
      const t = this.a[x];
      this.a[x] = this.a[y];
      this.a[y] = t;
    } else {
      const t = this.d[x];
      this.d[x] = this.a[y];
      this.a[y] = t;
    }
    this.cycles += 6;
  }

  // -------------------------------------------------------------- $d: ADD(X)

  addGroup(op) {
    const reg = (op >> 9) & 7;
    const mode = (op >> 3) & 7;
    const earg = op & 7;
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) {
      const size = op & 0x0100 ? LONG : WORD;
      const raw = this.readSource(mode, earg, size);
      const value = size === WORD ? (raw << 16) >> 16 : raw;
      this.a[reg] = (this.a[reg] + value) >>> 0;
      this.cycles += 8;
      return;
    }

    const size = CPU68000.sizeOf(sizeBits);
    if ((op & 0x0130) === 0x0100) return this.extended(op, true, size);

    if (op & 0x0100) {
      const value = this.readModify(mode, earg, size);
      const result = this.add(this.d[reg] & MASK[size], value, size);
      this.writeBack(size, result);
      this.cycles += size === LONG ? 12 : 8;
      return;
    }
    const result = this.add(this.readSource(mode, earg, size), this.d[reg] & MASK[size], size);
    this.setDataRegister(reg, size, result);
    this.cycles += size === LONG ? 6 : 4;
  }

  // ------------------------------------------------------------- $e: shifts

  shiftGroup(op) {
    const sizeBits = (op >> 6) & 3;

    if (sizeBits === 3) {
      // One bit, straight through memory.
      const kind = (op >> 9) & 3;
      const left = (op & 0x0100) !== 0;
      const value = this.readModify((op >> 3) & 7, op & 7, WORD);
      this.writeBack(WORD, this.shift(kind, left, value, 1, WORD));
      this.cycles += 8;
      return;
    }

    const size = CPU68000.sizeOf(sizeBits);
    const reg = op & 7;
    const left = (op & 0x0100) !== 0;
    const kind = (op >> 3) & 3;
    const count = op & 0x0020 ? this.d[(op >> 9) & 7] & 63 : ((op >> 9) & 7) || 8;

    const result = this.shift(kind, left, this.d[reg] & MASK[size], count, size);
    this.setDataRegister(reg, size, result);
    this.cycles += (size === LONG ? 8 : 6) + 2 * count;
  }

  /**
   * @param {number} kind 0 = arithmetic, 1 = logical, 2 = through X, 3 = rotate
   */
  shift(kind, left, value, count, size) {
    const mask = MASK[size];
    const sign = SIGN[size];
    const bits = size * 8;
    let result = value & mask;

    this.v = false;
    if (count === 0) {
      // A zero shift leaves everything alone but still reports the sign. Only
      // the through-X rotates carry anything out of it: they show X in C.
      this.c = kind === 2 ? this.x : false;
      this.n = (result & sign) !== 0;
      this.z = result === 0;
      return result;
    }
    this.c = false;

    for (let i = 0; i < count; i++) {
      const msb = (result & sign) !== 0;
      const lsb = (result & 1) !== 0;
      if (left) {
        result = (result << 1) & mask;
        switch (kind) {
          case 0: // ASL sets V if the sign ever changes
            this.c = this.x = msb;
            if (msb !== ((result & sign) !== 0)) this.v = true;
            break;
          case 1:
            this.c = this.x = msb;
            break;
          case 2: {
            const extend = this.x;
            if (extend) result |= 1;
            this.c = this.x = msb;
            break;
          }
          default:
            if (msb) result |= 1;
            this.c = msb;
            break;
        }
      } else {
        const shifted = (result >>> 1) & (mask >>> 1);
        switch (kind) {
          case 0: // ASR keeps the sign bit
            result = msb ? shifted | sign : shifted;
            this.c = this.x = lsb;
            break;
          case 1:
            result = shifted;
            this.c = this.x = lsb;
            break;
          case 2: {
            result = this.x ? shifted | sign : shifted;
            this.c = this.x = lsb;
            break;
          }
          default:
            result = lsb ? shifted | sign : shifted;
            this.c = lsb;
            break;
        }
      }
      result &= mask;
    }

    // A rotate by a multiple of the operand width is a no-op with a live carry.
    if (kind === 3 && count % bits === 0 && count !== 0) {
      this.c = left ? (result & 1) !== 0 : (result & sign) !== 0;
    }

    this.n = (result & sign) !== 0;
    this.z = result === 0;
    return result;
  }
}
