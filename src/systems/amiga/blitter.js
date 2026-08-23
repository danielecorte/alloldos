// The blitter.
//
// Four channels — three in, one out — a 256-entry truth table that says what
// to do with them, a barrel shifter on two of the inputs, and an area fill.
// It is the reason an Amiga could drag a whole Workbench screen around without
// the CPU noticing, and the reason its line drawing is a blit too.
//
// Blits finish the instant they are started rather than stealing DMA slots for
// as long as the real one would. Software waits on BBUSY or on the blitter
// interrupt, and both are honest about a blit that is already over.

const USEA = 0x0800;
const USEB = 0x0400;
const USEC = 0x0200;
const USED = 0x0100;

const LINE = 0x0001;
const DESC = 0x0002;
const IFE = 0x0008;
const EFE = 0x0010;
const FCI = 0x0004;
const SING = 0x0002; // in line mode, the same bit as DESC
const SIGN = 0x0040;
const SUD = 0x0010;
const SUL = 0x0008;
const AUL = 0x0004;

export class Blitter {
  /**
   * @param {object} hooks
   * @param {(addr:number)=>number} hooks.read
   * @param {(addr:number,value:number)=>void} hooks.write
   * @param {()=>void} hooks.onFinished raises the blitter interrupt
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.bltcon0 = 0;
    this.bltcon1 = 0;
    this.afwm = 0xffff;
    this.alwm = 0xffff;
    this.apt = 0;
    this.bpt = 0;
    this.cpt = 0;
    this.dpt = 0;
    this.amod = 0;
    this.bmod = 0;
    this.cmod = 0;
    this.dmod = 0;
    this.adat = 0;
    this.bdat = 0;
    this.cdat = 0;
    this.zero = true;
    this.busy = false;
  }

  /** The two status bits DMACONR reports back. */
  get statusBits() {
    return (this.busy ? 0x4000 : 0) | (this.zero ? 0x2000 : 0);
  }

  writeRegister(offset, value) {
    switch (offset) {
      case 0x040:
        this.bltcon0 = value;
        return true;
      case 0x042:
        this.bltcon1 = value;
        return true;
      case 0x044:
        this.afwm = value;
        return true;
      case 0x046:
        this.alwm = value;
        return true;
      case 0x048:
        this.cpt = (this.cpt & 0xfffe) | ((value & 0x1f) << 16);
        return true;
      case 0x04a:
        this.cpt = (this.cpt & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x04c:
        this.bpt = (this.bpt & 0xfffe) | ((value & 0x1f) << 16);
        return true;
      case 0x04e:
        this.bpt = (this.bpt & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x050:
        this.apt = (this.apt & 0xfffe) | ((value & 0x1f) << 16);
        return true;
      case 0x052:
        this.apt = (this.apt & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x054:
        this.dpt = (this.dpt & 0xfffe) | ((value & 0x1f) << 16);
        return true;
      case 0x056:
        this.dpt = (this.dpt & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x058:
        this.start(value);
        return true;
      case 0x060:
        this.cmod = (value << 16) >> 16;
        return true;
      case 0x062:
        this.bmod = (value << 16) >> 16;
        return true;
      case 0x064:
        this.amod = (value << 16) >> 16;
        return true;
      case 0x066:
        this.dmod = (value << 16) >> 16;
        return true;
      case 0x070:
        this.cdat = value;
        return true;
      case 0x072:
        this.bdat = value;
        return true;
      case 0x074:
        this.adat = value;
        return true;
      default:
        return false;
    }
  }

  /** BLTSIZE is the trigger: writing it is what starts the blit. */
  start(size) {
    const height = (size >> 6) & 0x3ff || 1024;
    const width = (size & 0x3f) || 64;
    this.busy = true;
    this.zero = true;
    if (this.bltcon1 & LINE) this.drawLine(height);
    else this.copyBlit(width, height);
    this.busy = false;
    this.hooks.onFinished();
  }

  /** The 256 minterms, evaluated a word at a time. */
  combine(a, b, c) {
    const lf = this.bltcon0 & 0xff;
    let d = 0;
    if (lf & 0x80) d |= a & b & c;
    if (lf & 0x40) d |= a & b & ~c;
    if (lf & 0x20) d |= a & ~b & c;
    if (lf & 0x10) d |= a & ~b & ~c;
    if (lf & 0x08) d |= ~a & b & c;
    if (lf & 0x04) d |= ~a & b & ~c;
    if (lf & 0x02) d |= ~a & ~b & c;
    if (lf & 0x01) d |= ~a & ~b & ~c;
    return d & 0xffff;
  }

  copyBlit(width, height) {
    const con0 = this.bltcon0;
    const con1 = this.bltcon1;
    const descending = (con1 & DESC) !== 0;
    const step = descending ? -2 : 2;
    const ash = (con0 >> 12) & 0x0f;
    const bsh = (con1 >> 12) & 0x0f;
    const fillMode = con1 & (IFE | EFE);

    let previousA = 0;
    let previousB = 0;
    let anyNonZero = false;

    for (let y = 0; y < height; y++) {
      let fillCarry = (con1 & FCI) !== 0 ? 1 : 0;
      // A whole line is built before it is written when filling, because the
      // fill runs along the line and the carry has to travel with it.
      for (let x = 0; x < width; x++) {
        let a = this.adat;
        if (con0 & USEA) {
          a = this.hooks.read(this.apt);
          this.apt = (this.apt + step) & 0x1ffffe;
        }
        let b = this.bdat;
        if (con0 & USEB) {
          b = this.hooks.read(this.bpt);
          this.bpt = (this.bpt + step) & 0x1ffffe;
        }
        let c = this.cdat;
        if (con0 & USEC) {
          c = this.hooks.read(this.cpt);
          this.cpt = (this.cpt + step) & 0x1ffffe;
        }

        // The first and last words of every line can be masked, which is how a
        // blit lands on a rectangle that does not start on a word boundary.
        let masked = a;
        if (x === 0) masked &= this.afwm;
        if (x === width - 1) masked &= this.alwm;

        const aShifted = descending
          ? (((masked << 16) | previousA) << ash) >>> 16
          : ((previousA << 16) | masked) >>> ash;
        previousA = masked;
        const bShifted = descending
          ? (((b << 16) | previousB) << bsh) >>> 16
          : ((previousB << 16) | b) >>> bsh;
        previousB = b;

        let d = this.combine(aShifted & 0xffff, bShifted & 0xffff, c & 0xffff);
        if (fillMode) {
          const filled = this.fill(d, fillCarry, (con1 & IFE) !== 0);
          d = filled.value;
          fillCarry = filled.carry;
        }

        if (d !== 0) anyNonZero = true;
        if (con0 & USED) {
          this.hooks.write(this.dpt, d);
          this.dpt = (this.dpt + step) & 0x1ffffe;
        }
      }

      const lineStep = descending ? -1 : 1;
      if (con0 & USEA) this.apt = (this.apt + lineStep * this.amod) & 0x1ffffe;
      if (con0 & USEB) this.bpt = (this.bpt + lineStep * this.bmod) & 0x1ffffe;
      if (con0 & USEC) this.cpt = (this.cpt + lineStep * this.cmod) & 0x1ffffe;
      if (con0 & USED) this.dpt = (this.dpt + lineStep * this.dmod) & 0x1ffffe;
    }

    this.zero = !anyNonZero;
  }

  /**
   * Area fill: a carry runs along the word from the bottom bit up, flipping
   * every time it meets a set bit, and everything it passes over while it is
   * set becomes solid. Inclusive fill keeps the edges, exclusive fill does not.
   */
  fill(value, carry, inclusive) {
    let out = 0;
    let running = carry;
    for (let bit = 0; bit < 16; bit++) {
      const set = (value >> bit) & 1;
      if (set) running ^= 1;
      const result = inclusive ? set | running : running;
      out |= result << bit;
    }
    return { value: out & 0xffff, carry: running };
  }

  /**
   * Line mode. The blitter walks a Bresenham line, one pixel per "row" of the
   * blit: A carries a single set bit at the pixel's position in the word, B
   * carries the dotted-line pattern, C and D are the bitmap.
   *
   * The error term lives in the A pointer and the two moduli are the Bresenham
   * increments — which is why setting a line up looks nothing like drawing one.
   */
  drawLine(length) {
    const con0 = this.bltcon0;
    const con1 = this.bltcon1;
    let bit = (con0 >> 12) & 0x0f; // ASH: which pixel of the word we are on
    let pattern = this.bdat;
    let error = (this.apt << 16) >> 16; // the low word of BLTAPT, signed
    let sign = (con1 & SIGN) !== 0;
    const single = (con1 & SING) !== 0;
    const sometimesVertical = (con1 & SUD) !== 0;
    const sometimesBackwards = (con1 & SUL) !== 0;
    const alwaysBackwards = (con1 & AUL) !== 0;

    let address = this.cpt;
    let plotted = false;
    let anyNonZero = false;

    for (let i = 0; i < length; i++) {
      const c = this.hooks.read(address);
      const a = (0x8000 >>> bit) & this.afwm;
      const b = pattern & 0x8000 ? 0xffff : 0x0000;
      const d = this.combine(a, b, c);
      if (d !== 0) anyNonZero = true;
      // A single-dot line never puts two pixels in the same word position,
      // which is what keeps a shallow line from looking twice as thick.
      if (!single || !plotted) this.hooks.write(address, d);
      plotted = true;
      pattern = ((pattern << 1) | (pattern >>> 15)) & 0xffff;

      // The always-step happens every pixel; the sometimes-step only when the
      // error term has not gone negative.
      let dx = 0;
      let dy = 0;
      if (sometimesVertical) dx = alwaysBackwards ? -1 : 1;
      else dy = alwaysBackwards ? -1 : 1;

      if (!sign) {
        if (sometimesVertical) dy = sometimesBackwards ? -1 : 1;
        else dx = sometimesBackwards ? -1 : 1;
        error = (error + this.bmod) | 0;
      } else {
        error = (error + this.amod) | 0;
      }
      sign = ((error << 16) >> 16) < 0;

      if (dx) {
        bit += dx;
        if (bit < 0) {
          bit = 15;
          address = (address - 2) & 0x1ffffe;
          plotted = false;
        } else if (bit > 15) {
          bit = 0;
          address = (address + 2) & 0x1ffffe;
          plotted = false;
        }
      }
      if (dy) {
        address = (address + dy * this.cmod) & 0x1ffffe;
        plotted = false;
      }
    }

    this.cpt = address;
    this.dpt = address;
    this.zero = !anyNonZero;
  }
}
