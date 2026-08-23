// MOS 8520 CIA, twice over.
//
// The same part as the C64's 6526 with one real difference: the time-of-day
// counter is a plain 24-bit binary counter instead of a BCD clock, and it is
// clocked by the video signal — CIA-A counts vertical blanks, CIA-B counts
// horizontal lines. Its timers run off the E clock, a tenth of the CPU's.
//
// CIA-A owns the keyboard's serial line, the disk drive's status pins, the
// power LED and the ROM overlay; CIA-B owns the drive's motor and stepper, the
// parallel port and the serial handshake lines.

export const CIA_CLOCK_DIVIDER = 10; // E clock = CPU clock / 10

const ICR_TA = 0x01;
const ICR_TB = 0x02;
const ICR_ALARM = 0x04;
const ICR_SP = 0x08;
const ICR_FLAG = 0x10;

export class CIA8520 {
  /**
   * @param {object} hooks
   * @param {(active:boolean)=>void} hooks.onInterrupt drives /INT, which on the
   *   Amiga reaches the CPU through Paula rather than directly
   * @param {()=>number} [hooks.readPortA] the value on the port A pins
   * @param {()=>number} [hooks.readPortB]
   * @param {(value:number)=>void} [hooks.writePortA]
   * @param {(value:number)=>void} [hooks.writePortB]
   */
  constructor(name, hooks) {
    this.name = name;
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.pra = 0;
    this.prb = 0;
    this.ddra = 0;
    this.ddrb = 0;

    this.timerA = 0xffff;
    this.timerB = 0xffff;
    this.latchA = 0xffff;
    this.latchB = 0xffff;
    this.cra = 0;
    this.crb = 0;

    this.icrData = 0;
    this.icrMask = 0;
    this.irqActive = false;

    this.sdr = 0;

    this.tod = 0;
    this.todLatched = -1;
    this.todAlarm = 0;
    this.todStopped = false; // it counts from the moment it is clocked
    this.eclock = 0;
  }

  get portAOutput() {
    return (this.pra & this.ddra) | (~this.ddra & 0xff);
  }

  get portBOutput() {
    return (this.prb & this.ddrb) | (~this.ddrb & 0xff);
  }

  requestInterrupt(flag) {
    this.icrData |= flag;
    if (this.icrMask & flag) {
      this.icrData |= 0x80;
      if (!this.irqActive) {
        this.irqActive = true;
        this.hooks.onInterrupt(true);
      }
    }
  }

  /** A falling edge on /FLAG. On CIA-B that pin is the parallel port's ACK. */
  triggerFlag() {
    this.requestInterrupt(ICR_FLAG);
  }

  /**
   * Hands the CIA a byte arriving on the serial pin — which, on CIA-A, is the
   * keyboard sending a key code. The 8520 raises SP once all eight bits are in.
   */
  receiveSerial(byte) {
    this.sdr = byte & 0xff;
    this.requestInterrupt(ICR_SP);
  }

  // ------------------------------------------------------------------ timers

  /** @param {number} cpuCycles cycles of the 7 MHz clock that just went past */
  tick(cpuCycles) {
    this.eclock += cpuCycles;
    const ticks = Math.floor(this.eclock / CIA_CLOCK_DIVIDER);
    if (ticks === 0) return;
    this.eclock -= ticks * CIA_CLOCK_DIVIDER;

    if (this.cra & 0x01 && !(this.cra & 0x20)) {
      this.timerA -= ticks;
      while (this.timerA <= 0) {
        this.timerA += this.latchA + 1;
        this.onTimerAUnderflow();
      }
    }

    const inmode = (this.crb >> 5) & 0x03;
    if (this.crb & 0x01 && inmode === 0) {
      this.timerB -= ticks;
      while (this.timerB <= 0) {
        this.timerB += this.latchB + 1;
        this.onTimerBUnderflow();
      }
    }
  }

  onTimerAUnderflow() {
    this.requestInterrupt(ICR_TA);
    if (this.cra & 0x08) this.cra &= ~0x01; // one-shot
    if (this.crb & 0x01 && ((this.crb >> 5) & 0x03) === 2) {
      this.timerB--;
      if (this.timerB <= 0) {
        this.timerB += this.latchB + 1;
        this.onTimerBUnderflow();
      }
    }
  }

  onTimerBUnderflow() {
    this.requestInterrupt(ICR_TB);
    if (this.crb & 0x08) this.crb &= ~0x01;
  }

  /**
   * One tick of whatever video signal this CIA's counter is wired to. Twenty
   * four bits of it, counting up — AmigaDOS turns it into the clock in the
   * corner of the Workbench screen.
   */
  tickTOD() {
    if (this.todStopped) return;
    this.tod = (this.tod + 1) & 0xffffff;
    if (this.tod === this.todAlarm) this.requestInterrupt(ICR_ALARM);
  }

  // --------------------------------------------------------------- registers

  read(reg) {
    switch (reg & 0x0f) {
      case 0x0:
        return this.hooks.readPortA ? this.hooks.readPortA() & 0xff : this.portAOutput;
      case 0x1:
        return this.hooks.readPortB ? this.hooks.readPortB() & 0xff : this.portBOutput;
      case 0x2:
        return this.ddra;
      case 0x3:
        return this.ddrb;
      case 0x4:
        return this.timerA & 0xff;
      case 0x5:
        return (this.timerA >> 8) & 0xff;
      case 0x6:
        return this.timerB & 0xff;
      case 0x7:
        return (this.timerB >> 8) & 0xff;
      case 0x8: {
        // Reading the low byte releases the latch the high byte took.
        const value = this.todLatched >= 0 ? this.todLatched : this.tod;
        this.todLatched = -1;
        return value & 0xff;
      }
      case 0x9:
        return ((this.todLatched >= 0 ? this.todLatched : this.tod) >> 8) & 0xff;
      case 0xa:
        // Reading the high byte freezes the whole counter until the low byte
        // is read, so a program can never catch it half way through carrying.
        this.todLatched = this.tod;
        return (this.tod >> 16) & 0xff;
      case 0xb:
        return 0;
      case 0xc:
        return this.sdr;
      case 0xd: {
        const value = this.icrData;
        this.icrData = 0;
        if (this.irqActive) {
          this.irqActive = false;
          this.hooks.onInterrupt(false);
        }
        return value;
      }
      case 0xe:
        return this.cra;
      default:
        return this.crb;
    }
  }

  write(reg, value) {
    value &= 0xff;
    switch (reg & 0x0f) {
      case 0x0:
        this.pra = value;
        this.hooks.writePortA?.(this.portAOutput);
        break;
      case 0x1:
        this.prb = value;
        this.hooks.writePortB?.(this.portBOutput);
        break;
      case 0x2:
        this.ddra = value;
        this.hooks.writePortA?.(this.portAOutput);
        break;
      case 0x3:
        this.ddrb = value;
        this.hooks.writePortB?.(this.portBOutput);
        break;
      case 0x4:
        this.latchA = (this.latchA & 0xff00) | value;
        break;
      case 0x5:
        this.latchA = (this.latchA & 0x00ff) | (value << 8);
        // Writing the high byte of a stopped timer loads it — and if the timer
        // is in one-shot mode, that write also starts it. Nothing sets the run
        // bit afterwards, which is why a one-shot delay written this way is a
        // single store and not two: the keyboard handshake is one of them.
        if (!(this.cra & 0x01)) {
          this.timerA = this.latchA;
          if (this.cra & 0x08) this.cra |= 0x01;
        }
        break;
      case 0x6:
        this.latchB = (this.latchB & 0xff00) | value;
        break;
      case 0x7:
        this.latchB = (this.latchB & 0x00ff) | (value << 8);
        if (!(this.crb & 0x01)) {
          this.timerB = this.latchB;
          if (this.crb & 0x08) this.crb |= 0x01;
        }
        break;
      case 0x8:
        if (this.crb & 0x80) this.todAlarm = (this.todAlarm & 0xffff00) | value;
        else {
          this.tod = (this.tod & 0xffff00) | value;
          this.todStopped = false; // writing the low byte starts it again
        }
        break;
      case 0x9:
        if (this.crb & 0x80) this.todAlarm = (this.todAlarm & 0xff00ff) | (value << 8);
        else this.tod = (this.tod & 0xff00ff) | (value << 8);
        break;
      case 0xa:
        if (this.crb & 0x80) this.todAlarm = (this.todAlarm & 0x00ffff) | (value << 16);
        else {
          this.tod = (this.tod & 0x00ffff) | (value << 16);
          this.todStopped = true; // and writing the high byte stops it
        }
        break;
      case 0xb:
        break;
      case 0xc:
        this.sdr = value;
        // Output mode shifts the byte straight out; nothing here listens, but
        // the interrupt that says "sent" still has to arrive.
        if (this.cra & 0x40) this.requestInterrupt(ICR_SP);
        break;
      case 0xd:
        if (value & 0x80) this.icrMask |= value & 0x1f;
        else this.icrMask &= ~(value & 0x1f);
        if (this.icrData & this.icrMask & 0x1f) {
          this.icrData |= 0x80;
          if (!this.irqActive) {
            this.irqActive = true;
            this.hooks.onInterrupt(true);
          }
        }
        break;
      case 0xe:
        this.cra = value & 0xef;
        if (value & 0x10) this.timerA = this.latchA;
        break;
      default:
        this.crb = value & 0xef;
        if (value & 0x10) this.timerB = this.latchB;
        break;
    }
  }
}
