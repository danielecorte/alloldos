// MOS 6510 / 6502 core.
//
// Instruction-stepped (not sub-cycle accurate) but it returns the exact cycle
// count of every instruction, including page-crossing and branch penalties, so
// the machine can keep the VIC-II raster in step with it. All documented
// opcodes plus the stable undocumented ones are implemented, which is what real
// C64 software actually uses.

const CYCLES = [
  /*      0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f */
  /* 0 */ 7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6,
  /* 1 */ 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  /* 2 */ 6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6,
  /* 3 */ 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  /* 4 */ 6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6,
  /* 5 */ 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  /* 6 */ 6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6,
  /* 7 */ 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  /* 8 */ 2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
  /* 9 */ 2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5,
  /* a */ 2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4,
  /* b */ 2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4,
  /* c */ 2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
  /* d */ 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
  /* e */ 2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6,
  /* f */ 2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7,
];

export class CPU6502 {
  /** @param {{read(addr:number):number, write(addr:number, value:number):void}} bus */
  constructor(bus) {
    this.bus = bus;

    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.s = 0xfd;
    this.pc = 0;

    // Status flags, kept unpacked for speed.
    this.fN = false;
    this.fV = false;
    this.fB = false;
    this.fD = false;
    this.fI = true;
    this.fZ = false;
    this.fC = false;

    this.irqLine = 0; // level triggered, bitmask of requesting devices
    this.nmiPending = false; // edge triggered, latched by the machine
    this.jammed = false;
    this.jammedAt = 0; // where an illegal opcode locked the processor up
    this.jammedOpcode = 0;
    this.cycles = 0; // cycles consumed by the instruction currently executing
  }

  reset() {
    this.a = this.x = this.y = 0;
    this.s = 0xfd;
    this.fN = this.fV = this.fB = this.fD = this.fZ = this.fC = false;
    this.fI = true;
    this.irqLine = 0;
    this.nmiPending = false;
    this.jammed = false;
    this.pc = this.read16(0xfffc);
  }

  // ---------------------------------------------------------------- bus glue

  read(addr) {
    return this.bus.read(addr & 0xffff);
  }

  write(addr, value) {
    this.bus.write(addr & 0xffff, value & 0xff);
  }

  read16(addr) {
    return this.read(addr) | (this.read(addr + 1) << 8);
  }

  /** 6502 indirect fetch, complete with the page-wrap hardware bug. */
  read16bug(addr) {
    const lo = this.read(addr);
    const hi = this.read((addr & 0xff00) | ((addr + 1) & 0xff));
    return lo | (hi << 8);
  }

  push(value) {
    this.write(0x0100 | this.s, value);
    this.s = (this.s - 1) & 0xff;
  }

  pop() {
    this.s = (this.s + 1) & 0xff;
    return this.read(0x0100 | this.s);
  }

  get p() {
    return (
      (this.fN ? 0x80 : 0) |
      (this.fV ? 0x40 : 0) |
      0x20 |
      (this.fB ? 0x10 : 0) |
      (this.fD ? 0x08 : 0) |
      (this.fI ? 0x04 : 0) |
      (this.fZ ? 0x02 : 0) |
      (this.fC ? 0x01 : 0)
    );
  }

  set p(value) {
    this.fN = (value & 0x80) !== 0;
    this.fV = (value & 0x40) !== 0;
    this.fB = (value & 0x10) !== 0;
    this.fD = (value & 0x08) !== 0;
    this.fI = (value & 0x04) !== 0;
    this.fZ = (value & 0x02) !== 0;
    this.fC = (value & 0x01) !== 0;
  }

  // ------------------------------------------------------------- interrupts

  /** Raise/lower one IRQ source. Sources are bit masks so several can share the line. */
  setIRQ(source, active) {
    if (active) this.irqLine |= source;
    else this.irqLine &= ~source;
  }

  triggerNMI() {
    this.nmiPending = true;
  }

  interrupt(vector, isBreak) {
    this.push((this.pc >> 8) & 0xff);
    this.push(this.pc & 0xff);
    this.push(isBreak ? this.p | 0x10 : this.p & ~0x10);
    this.fI = true;
    this.pc = this.read16(vector);
  }

  // ------------------------------------------------------- addressing modes

  imm() {
    return this.pc++ & 0xffff;
  }

  zp() {
    return this.read(this.pc++) & 0xff;
  }

  zpx() {
    return (this.read(this.pc++) + this.x) & 0xff;
  }

  zpy() {
    return (this.read(this.pc++) + this.y) & 0xff;
  }

  abs() {
    const addr = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    return addr;
  }

  /** @param {boolean} penalty add a cycle when the index crosses a page (read ops only) */
  abx(penalty) {
    const base = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    const addr = (base + this.x) & 0xffff;
    if (penalty && (base & 0xff00) !== (addr & 0xff00)) this.cycles++;
    return addr;
  }

  aby(penalty) {
    const base = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    const addr = (base + this.y) & 0xffff;
    if (penalty && (base & 0xff00) !== (addr & 0xff00)) this.cycles++;
    return addr;
  }

  izx() {
    const ptr = (this.read(this.pc++) + this.x) & 0xff;
    return this.read(ptr) | (this.read((ptr + 1) & 0xff) << 8);
  }

  izy(penalty) {
    const ptr = this.read(this.pc++) & 0xff;
    const base = this.read(ptr) | (this.read((ptr + 1) & 0xff) << 8);
    const addr = (base + this.y) & 0xffff;
    if (penalty && (base & 0xff00) !== (addr & 0xff00)) this.cycles++;
    return addr;
  }

  branch(taken) {
    const offset = (this.read(this.pc++) << 24) >> 24; // sign extend
    if (!taken) return;
    const target = (this.pc + offset) & 0xffff;
    this.cycles += (target & 0xff00) !== (this.pc & 0xff00) ? 2 : 1;
    this.pc = target;
  }

  // ------------------------------------------------------------- operations

  setNZ(value) {
    this.fZ = (value & 0xff) === 0;
    this.fN = (value & 0x80) !== 0;
    return value & 0xff;
  }

  adc(value) {
    if (this.fD) {
      // Decimal mode, including the 6502's quirky N/V/Z semantics.
      let lo = (this.a & 0x0f) + (value & 0x0f) + (this.fC ? 1 : 0);
      let hi = (this.a >> 4) + (value >> 4);
      if (lo > 9) {
        lo += 6;
        hi++;
      }
      this.fZ = ((this.a + value + (this.fC ? 1 : 0)) & 0xff) === 0;
      this.fN = (hi & 0x08) !== 0;
      this.fV = (((this.a ^ value) & 0x80) === 0) && (((this.a ^ (hi << 4)) & 0x80) !== 0);
      if (hi > 9) hi += 6;
      this.fC = hi > 15;
      this.a = ((hi << 4) | (lo & 0x0f)) & 0xff;
      return;
    }
    const sum = this.a + value + (this.fC ? 1 : 0);
    this.fC = sum > 0xff;
    this.fV = (((this.a ^ sum) & (value ^ sum)) & 0x80) !== 0;
    this.a = this.setNZ(sum);
  }

  sbc(value) {
    if (this.fD) {
      const borrow = this.fC ? 0 : 1;
      let lo = (this.a & 0x0f) - (value & 0x0f) - borrow;
      let hi = (this.a >> 4) - (value >> 4);
      if (lo & 0x10) {
        lo -= 6;
        hi--;
      }
      if (hi & 0x10) hi -= 6;
      const bin = this.a - value - borrow;
      this.fC = (bin & 0x100) === 0;
      this.fV = (((this.a ^ value) & (this.a ^ bin)) & 0x80) !== 0;
      this.setNZ(bin);
      this.a = ((hi << 4) | (lo & 0x0f)) & 0xff;
      return;
    }
    this.adc(value ^ 0xff);
  }

  compare(reg, value) {
    const diff = reg - value;
    this.fC = diff >= 0;
    this.setNZ(diff);
  }

  aslMem(addr) {
    const value = this.read(addr);
    this.fC = (value & 0x80) !== 0;
    const result = this.setNZ(value << 1);
    this.write(addr, result);
    return result;
  }

  lsrMem(addr) {
    const value = this.read(addr);
    this.fC = (value & 0x01) !== 0;
    const result = this.setNZ(value >> 1);
    this.write(addr, result);
    return result;
  }

  rolMem(addr) {
    const value = this.read(addr);
    const result = this.setNZ((value << 1) | (this.fC ? 1 : 0));
    this.fC = (value & 0x80) !== 0;
    this.write(addr, result);
    return result;
  }

  rorMem(addr) {
    const value = this.read(addr);
    const result = this.setNZ((value >> 1) | (this.fC ? 0x80 : 0));
    this.fC = (value & 0x01) !== 0;
    this.write(addr, result);
    return result;
  }

  // ------------------------------------------------------------------- step

  /** Executes one instruction (or takes an interrupt). @returns {number} cycles */
  step() {
    if (this.jammed) return 1;

    if (this.nmiPending) {
      this.nmiPending = false;
      this.interrupt(0xfffa, false);
      return 7;
    }
    if (this.irqLine && !this.fI) {
      this.interrupt(0xfffe, false);
      return 7;
    }

    const op = this.read(this.pc++);
    this.pc &= 0xffff;
    this.cycles = CYCLES[op];
    let addr = 0;
    let value = 0;

    switch (op) {
      // ---- load / store
      case 0xa9: this.a = this.setNZ(this.read(this.imm())); break;
      case 0xa5: this.a = this.setNZ(this.read(this.zp())); break;
      case 0xb5: this.a = this.setNZ(this.read(this.zpx())); break;
      case 0xad: this.a = this.setNZ(this.read(this.abs())); break;
      case 0xbd: this.a = this.setNZ(this.read(this.abx(true))); break;
      case 0xb9: this.a = this.setNZ(this.read(this.aby(true))); break;
      case 0xa1: this.a = this.setNZ(this.read(this.izx())); break;
      case 0xb1: this.a = this.setNZ(this.read(this.izy(true))); break;

      case 0xa2: this.x = this.setNZ(this.read(this.imm())); break;
      case 0xa6: this.x = this.setNZ(this.read(this.zp())); break;
      case 0xb6: this.x = this.setNZ(this.read(this.zpy())); break;
      case 0xae: this.x = this.setNZ(this.read(this.abs())); break;
      case 0xbe: this.x = this.setNZ(this.read(this.aby(true))); break;

      case 0xa0: this.y = this.setNZ(this.read(this.imm())); break;
      case 0xa4: this.y = this.setNZ(this.read(this.zp())); break;
      case 0xb4: this.y = this.setNZ(this.read(this.zpx())); break;
      case 0xac: this.y = this.setNZ(this.read(this.abs())); break;
      case 0xbc: this.y = this.setNZ(this.read(this.abx(true))); break;

      case 0x85: this.write(this.zp(), this.a); break;
      case 0x95: this.write(this.zpx(), this.a); break;
      case 0x8d: this.write(this.abs(), this.a); break;
      case 0x9d: this.write(this.abx(false), this.a); break;
      case 0x99: this.write(this.aby(false), this.a); break;
      case 0x81: this.write(this.izx(), this.a); break;
      case 0x91: this.write(this.izy(false), this.a); break;

      case 0x86: this.write(this.zp(), this.x); break;
      case 0x96: this.write(this.zpy(), this.x); break;
      case 0x8e: this.write(this.abs(), this.x); break;

      case 0x84: this.write(this.zp(), this.y); break;
      case 0x94: this.write(this.zpx(), this.y); break;
      case 0x8c: this.write(this.abs(), this.y); break;

      // ---- transfers
      case 0xaa: this.x = this.setNZ(this.a); break;
      case 0xa8: this.y = this.setNZ(this.a); break;
      case 0xba: this.x = this.setNZ(this.s); break;
      case 0x8a: this.a = this.setNZ(this.x); break;
      case 0x9a: this.s = this.x; break;
      case 0x98: this.a = this.setNZ(this.y); break;

      // ---- stack
      case 0x48: this.push(this.a); break;
      case 0x08: this.push(this.p | 0x10); break;
      case 0x68: this.a = this.setNZ(this.pop()); break;
      case 0x28: this.p = this.pop(); break;

      // ---- logic
      case 0x29: this.a = this.setNZ(this.a & this.read(this.imm())); break;
      case 0x25: this.a = this.setNZ(this.a & this.read(this.zp())); break;
      case 0x35: this.a = this.setNZ(this.a & this.read(this.zpx())); break;
      case 0x2d: this.a = this.setNZ(this.a & this.read(this.abs())); break;
      case 0x3d: this.a = this.setNZ(this.a & this.read(this.abx(true))); break;
      case 0x39: this.a = this.setNZ(this.a & this.read(this.aby(true))); break;
      case 0x21: this.a = this.setNZ(this.a & this.read(this.izx())); break;
      case 0x31: this.a = this.setNZ(this.a & this.read(this.izy(true))); break;

      case 0x09: this.a = this.setNZ(this.a | this.read(this.imm())); break;
      case 0x05: this.a = this.setNZ(this.a | this.read(this.zp())); break;
      case 0x15: this.a = this.setNZ(this.a | this.read(this.zpx())); break;
      case 0x0d: this.a = this.setNZ(this.a | this.read(this.abs())); break;
      case 0x1d: this.a = this.setNZ(this.a | this.read(this.abx(true))); break;
      case 0x19: this.a = this.setNZ(this.a | this.read(this.aby(true))); break;
      case 0x01: this.a = this.setNZ(this.a | this.read(this.izx())); break;
      case 0x11: this.a = this.setNZ(this.a | this.read(this.izy(true))); break;

      case 0x49: this.a = this.setNZ(this.a ^ this.read(this.imm())); break;
      case 0x45: this.a = this.setNZ(this.a ^ this.read(this.zp())); break;
      case 0x55: this.a = this.setNZ(this.a ^ this.read(this.zpx())); break;
      case 0x4d: this.a = this.setNZ(this.a ^ this.read(this.abs())); break;
      case 0x5d: this.a = this.setNZ(this.a ^ this.read(this.abx(true))); break;
      case 0x59: this.a = this.setNZ(this.a ^ this.read(this.aby(true))); break;
      case 0x41: this.a = this.setNZ(this.a ^ this.read(this.izx())); break;
      case 0x51: this.a = this.setNZ(this.a ^ this.read(this.izy(true))); break;

      case 0x24:
      case 0x2c:
        value = this.read(op === 0x24 ? this.zp() : this.abs());
        this.fZ = (this.a & value) === 0;
        this.fN = (value & 0x80) !== 0;
        this.fV = (value & 0x40) !== 0;
        break;

      // ---- arithmetic
      case 0x69: this.adc(this.read(this.imm())); break;
      case 0x65: this.adc(this.read(this.zp())); break;
      case 0x75: this.adc(this.read(this.zpx())); break;
      case 0x6d: this.adc(this.read(this.abs())); break;
      case 0x7d: this.adc(this.read(this.abx(true))); break;
      case 0x79: this.adc(this.read(this.aby(true))); break;
      case 0x61: this.adc(this.read(this.izx())); break;
      case 0x71: this.adc(this.read(this.izy(true))); break;

      case 0xe9:
      case 0xeb: this.sbc(this.read(this.imm())); break;
      case 0xe5: this.sbc(this.read(this.zp())); break;
      case 0xf5: this.sbc(this.read(this.zpx())); break;
      case 0xed: this.sbc(this.read(this.abs())); break;
      case 0xfd: this.sbc(this.read(this.abx(true))); break;
      case 0xf9: this.sbc(this.read(this.aby(true))); break;
      case 0xe1: this.sbc(this.read(this.izx())); break;
      case 0xf1: this.sbc(this.read(this.izy(true))); break;

      case 0xc9: this.compare(this.a, this.read(this.imm())); break;
      case 0xc5: this.compare(this.a, this.read(this.zp())); break;
      case 0xd5: this.compare(this.a, this.read(this.zpx())); break;
      case 0xcd: this.compare(this.a, this.read(this.abs())); break;
      case 0xdd: this.compare(this.a, this.read(this.abx(true))); break;
      case 0xd9: this.compare(this.a, this.read(this.aby(true))); break;
      case 0xc1: this.compare(this.a, this.read(this.izx())); break;
      case 0xd1: this.compare(this.a, this.read(this.izy(true))); break;

      case 0xe0: this.compare(this.x, this.read(this.imm())); break;
      case 0xe4: this.compare(this.x, this.read(this.zp())); break;
      case 0xec: this.compare(this.x, this.read(this.abs())); break;

      case 0xc0: this.compare(this.y, this.read(this.imm())); break;
      case 0xc4: this.compare(this.y, this.read(this.zp())); break;
      case 0xcc: this.compare(this.y, this.read(this.abs())); break;

      // ---- inc / dec
      case 0xe6:
      case 0xf6:
      case 0xee:
      case 0xfe:
        addr = op === 0xe6 ? this.zp() : op === 0xf6 ? this.zpx() : op === 0xee ? this.abs() : this.abx(false);
        this.write(addr, this.setNZ(this.read(addr) + 1));
        break;
      case 0xc6:
      case 0xd6:
      case 0xce:
      case 0xde:
        addr = op === 0xc6 ? this.zp() : op === 0xd6 ? this.zpx() : op === 0xce ? this.abs() : this.abx(false);
        this.write(addr, this.setNZ(this.read(addr) - 1));
        break;
      case 0xe8: this.x = this.setNZ(this.x + 1); break;
      case 0xc8: this.y = this.setNZ(this.y + 1); break;
      case 0xca: this.x = this.setNZ(this.x - 1); break;
      case 0x88: this.y = this.setNZ(this.y - 1); break;

      // ---- shifts
      case 0x0a:
        this.fC = (this.a & 0x80) !== 0;
        this.a = this.setNZ(this.a << 1);
        break;
      case 0x06: this.aslMem(this.zp()); break;
      case 0x16: this.aslMem(this.zpx()); break;
      case 0x0e: this.aslMem(this.abs()); break;
      case 0x1e: this.aslMem(this.abx(false)); break;

      case 0x4a:
        this.fC = (this.a & 0x01) !== 0;
        this.a = this.setNZ(this.a >> 1);
        break;
      case 0x46: this.lsrMem(this.zp()); break;
      case 0x56: this.lsrMem(this.zpx()); break;
      case 0x4e: this.lsrMem(this.abs()); break;
      case 0x5e: this.lsrMem(this.abx(false)); break;

      case 0x2a:
        value = (this.a << 1) | (this.fC ? 1 : 0);
        this.fC = (this.a & 0x80) !== 0;
        this.a = this.setNZ(value);
        break;
      case 0x26: this.rolMem(this.zp()); break;
      case 0x36: this.rolMem(this.zpx()); break;
      case 0x2e: this.rolMem(this.abs()); break;
      case 0x3e: this.rolMem(this.abx(false)); break;

      case 0x6a:
        value = (this.a >> 1) | (this.fC ? 0x80 : 0);
        this.fC = (this.a & 0x01) !== 0;
        this.a = this.setNZ(value);
        break;
      case 0x66: this.rorMem(this.zp()); break;
      case 0x76: this.rorMem(this.zpx()); break;
      case 0x6e: this.rorMem(this.abs()); break;
      case 0x7e: this.rorMem(this.abx(false)); break;

      // ---- jumps / branches
      case 0x4c: this.pc = this.abs(); break;
      case 0x6c: this.pc = this.read16bug(this.abs()); break;
      case 0x20:
        addr = this.read16(this.pc);
        this.pc = (this.pc + 1) & 0xffff; // JSR pushes the address of the last byte
        this.push((this.pc >> 8) & 0xff);
        this.push(this.pc & 0xff);
        this.pc = addr;
        break;
      case 0x60: this.pc = (this.pop() | (this.pop() << 8)) + 1; break;
      case 0x40:
        this.p = this.pop();
        this.pc = this.pop() | (this.pop() << 8);
        break;

      case 0x10: this.branch(!this.fN); break;
      case 0x30: this.branch(this.fN); break;
      case 0x50: this.branch(!this.fV); break;
      case 0x70: this.branch(this.fV); break;
      case 0x90: this.branch(!this.fC); break;
      case 0xb0: this.branch(this.fC); break;
      case 0xd0: this.branch(!this.fZ); break;
      case 0xf0: this.branch(this.fZ); break;

      // ---- flags / misc
      case 0x18: this.fC = false; break;
      case 0x38: this.fC = true; break;
      case 0x58: this.fI = false; break;
      case 0x78: this.fI = true; break;
      case 0xb8: this.fV = false; break;
      case 0xd8: this.fD = false; break;
      case 0xf8: this.fD = true; break;
      case 0xea: break;

      case 0x00: // BRK
        this.pc = (this.pc + 1) & 0xffff;
        this.interrupt(0xfffe, true);
        break;

      // ---- undocumented but widely used
      case 0xa7: case 0xb7: case 0xaf: case 0xbf: case 0xa3: case 0xb3: // LAX
        addr =
          op === 0xa7 ? this.zp()
          : op === 0xb7 ? this.zpy()
          : op === 0xaf ? this.abs()
          : op === 0xbf ? this.aby(true)
          : op === 0xa3 ? this.izx()
          : this.izy(true);
        this.a = this.x = this.setNZ(this.read(addr));
        break;

      case 0x87: case 0x97: case 0x8f: case 0x83: // SAX
        addr = op === 0x87 ? this.zp() : op === 0x97 ? this.zpy() : op === 0x8f ? this.abs() : this.izx();
        this.write(addr, this.a & this.x);
        break;

      case 0xc7: case 0xd7: case 0xcf: case 0xdf: case 0xdb: case 0xc3: case 0xd3: // DCP
        addr = this.rmwAddr(op, 0xc7, 0xd7, 0xcf, 0xdf, 0xdb, 0xc3, 0xd3);
        value = (this.read(addr) - 1) & 0xff;
        this.write(addr, value);
        this.compare(this.a, value);
        break;

      case 0xe7: case 0xf7: case 0xef: case 0xff: case 0xfb: case 0xe3: case 0xf3: // ISC
        addr = this.rmwAddr(op, 0xe7, 0xf7, 0xef, 0xff, 0xfb, 0xe3, 0xf3);
        value = (this.read(addr) + 1) & 0xff;
        this.write(addr, value);
        this.sbc(value);
        break;

      case 0x07: case 0x17: case 0x0f: case 0x1f: case 0x1b: case 0x03: case 0x13: // SLO
        addr = this.rmwAddr(op, 0x07, 0x17, 0x0f, 0x1f, 0x1b, 0x03, 0x13);
        this.a = this.setNZ(this.a | this.aslMem(addr));
        break;

      case 0x27: case 0x37: case 0x2f: case 0x3f: case 0x3b: case 0x23: case 0x33: // RLA
        addr = this.rmwAddr(op, 0x27, 0x37, 0x2f, 0x3f, 0x3b, 0x23, 0x33);
        this.a = this.setNZ(this.a & this.rolMem(addr));
        break;

      case 0x47: case 0x57: case 0x4f: case 0x5f: case 0x5b: case 0x43: case 0x53: // SRE
        addr = this.rmwAddr(op, 0x47, 0x57, 0x4f, 0x5f, 0x5b, 0x43, 0x53);
        this.a = this.setNZ(this.a ^ this.lsrMem(addr));
        break;

      case 0x67: case 0x77: case 0x6f: case 0x7f: case 0x7b: case 0x63: case 0x73: // RRA
        addr = this.rmwAddr(op, 0x67, 0x77, 0x6f, 0x7f, 0x7b, 0x63, 0x73);
        this.adc(this.rorMem(addr));
        break;

      case 0x0b: case 0x2b: // ANC
        this.a = this.setNZ(this.a & this.read(this.imm()));
        this.fC = this.fN;
        break;

      case 0x4b: // ALR
        this.a &= this.read(this.imm());
        this.fC = (this.a & 0x01) !== 0;
        this.a = this.setNZ(this.a >> 1);
        break;

      case 0x6b: // ARR
        this.a &= this.read(this.imm());
        this.a = this.setNZ((this.a >> 1) | (this.fC ? 0x80 : 0));
        this.fC = (this.a & 0x40) !== 0;
        this.fV = (((this.a >> 6) ^ (this.a >> 5)) & 1) !== 0;
        break;

      case 0xcb: // AXS
        value = this.read(this.imm());
        addr = (this.a & this.x) - value;
        this.fC = addr >= 0;
        this.x = this.setNZ(addr);
        break;

      case 0x9c: // SHY
        addr = this.abx(false);
        this.write(addr, this.y & (((addr >> 8) + 1) & 0xff));
        break;
      case 0x9e: // SHX
        addr = this.aby(false);
        this.write(addr, this.x & (((addr >> 8) + 1) & 0xff));
        break;

      // Undocumented NOPs, several of which still read memory.
      case 0x1a: case 0x3a: case 0x5a: case 0x7a: case 0xda: case 0xfa: break;
      case 0x80: case 0x82: case 0x89: case 0xc2: case 0xe2: this.imm(); break;
      case 0x04: case 0x44: case 0x64: this.zp(); break;
      case 0x14: case 0x34: case 0x54: case 0x74: case 0xd4: case 0xf4: this.zpx(); break;
      case 0x0c: this.abs(); break;
      case 0x1c: case 0x3c: case 0x5c: case 0x7c: case 0xdc: case 0xfc: this.abx(true); break;

      default:
        // KIL/JAM and the handful of unstable opcodes: the real chip locks up.
        this.jammed = true;
        this.pc = (this.pc - 1) & 0xffff;
        this.jammedAt = this.pc;
        this.jammedOpcode = op;
        break;
    }

    this.pc &= 0xffff;
    return this.cycles;
  }

  /** Resolves the addressing mode of the read-modify-write undocumented opcodes. */
  rmwAddr(op, zpOp, zpxOp, absOp, abxOp, abyOp, izxOp, izyOp) {
    switch (op) {
      case zpOp: return this.zp();
      case zpxOp: return this.zpx();
      case absOp: return this.abs();
      case abxOp: return this.abx(false);
      case abyOp: return this.aby(false);
      case izxOp: return this.izx();
      default: return this.izy(false);
    }
  }
}
