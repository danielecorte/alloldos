// MOS 6526 CIA.
//
// CIA 1 drives the keyboard matrix, joystick port 2 and the jiffy-clock IRQ;
// CIA 2 selects the VIC bank, drives the serial bus and pulls /NMI. Both share
// this implementation; the port wiring is injected by the machine.

const ICR_TA = 0x01;
const ICR_TB = 0x02;
const ICR_ALARM = 0x04;
const ICR_SDR = 0x08;
const ICR_FLAG = 0x10;

export class CIA6526 {
  /**
   * @param {object} hooks
   * @param {(active:boolean)=>void} hooks.onInterrupt raises/lowers /IRQ or /NMI
   * @param {(cia:CIA6526)=>number} [hooks.readPortA] value seen on the port A pins
   * @param {(cia:CIA6526)=>number} [hooks.readPortB] value seen on the port B pins
   * @param {(value:number)=>void} [hooks.writePortA]
   * @param {(value:number)=>void} [hooks.writePortB]
   */
  constructor(hooks) {
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

    this.icrData = 0; // pending interrupt flags
    this.icrMask = 0; // enabled interrupt sources
    this.irqActive = false;

    this.sdr = 0;

    this.todTenths = 0;
    this.todSeconds = 0;
    this.todMinutes = 0;
    this.todHours = 1;
    this.todLatched = null;
    this.todHalted = false;
    this.todAlarm = { tenths: 0, seconds: 0, minutes: 0, hours: 0 };
    this.todAccumulator = 0;
  }

  /** Value currently driven onto the port A pins (open bits float high). */
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

  /**
   * A falling edge on the /FLAG pin. On CIA 1 that pin is the datasette's read
   * line, which is how the KERNAL is told a tape pulse just went past.
   */
  triggerFlag() {
    this.requestInterrupt(ICR_FLAG);
  }

  // ------------------------------------------------------------------ timers

  tick(cycles) {
    if (this.cra & 0x01 && !(this.cra & 0x20)) {
      this.timerA -= cycles;
      while (this.timerA <= 0) {
        this.timerA += this.latchA + 1;
        this.onTimerAUnderflow();
      }
    }

    // Timer B counts phi2 or timer A underflows; the latter is handled above.
    const inmode = (this.crb >> 5) & 0x03;
    if (this.crb & 0x01 && inmode === 0) {
      this.timerB -= cycles;
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

  /** Advances the time-of-day clock. @param {number} seconds elapsed real time */
  tickTOD(seconds) {
    if (this.todHalted) return;
    this.todAccumulator += seconds;
    while (this.todAccumulator >= 0.1) {
      this.todAccumulator -= 0.1;
      if (++this.todTenths < 10) continue;
      this.todTenths = 0;
      if (++this.todSeconds < 60) continue;
      this.todSeconds = 0;
      if (++this.todMinutes < 60) continue;
      this.todMinutes = 0;
      this.todHours = (this.todHours + 1) & 0x1f;
    }
    const alarm = this.todAlarm;
    if (
      alarm.tenths === this.todTenths &&
      alarm.seconds === this.todSeconds &&
      alarm.minutes === this.todMinutes &&
      alarm.hours === this.todHours
    ) {
      this.requestInterrupt(ICR_ALARM);
    }
  }

  // --------------------------------------------------------------- registers

  read(reg) {
    switch (reg & 0x0f) {
      case 0x0:
        return this.hooks.readPortA ? this.hooks.readPortA(this) : this.portAOutput;
      case 0x1:
        return this.hooks.readPortB ? this.hooks.readPortB(this) : this.portBOutput;
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
        const value = this.todLatched ? this.todLatched.tenths : this.todTenths;
        this.todLatched = null; // reading tenths releases the latch
        return value;
      }
      case 0x9:
        return toBCD(this.todLatched ? this.todLatched.seconds : this.todSeconds);
      case 0xa:
        return toBCD(this.todLatched ? this.todLatched.minutes : this.todMinutes);
      case 0xb: {
        // Reading hours latches the whole time until tenths is read.
        this.todLatched = {
          tenths: this.todTenths,
          seconds: this.todSeconds,
          minutes: this.todMinutes,
          hours: this.todHours,
        };
        const hours = this.todLatched.hours;
        return (hours & 0x80) | toBCD(hours & 0x1f);
      }
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
        if (!(this.cra & 0x01)) this.timerA = this.latchA; // reload while stopped
        break;
      case 0x6:
        this.latchB = (this.latchB & 0xff00) | value;
        break;
      case 0x7:
        this.latchB = (this.latchB & 0x00ff) | (value << 8);
        if (!(this.crb & 0x01)) this.timerB = this.latchB;
        break;
      case 0x8:
        if (this.crb & 0x80) this.todAlarm.tenths = value & 0x0f;
        else {
          this.todTenths = value & 0x0f;
          this.todHalted = false;
        }
        break;
      case 0x9:
        if (this.crb & 0x80) this.todAlarm.seconds = fromBCD(value & 0x7f);
        else this.todSeconds = fromBCD(value & 0x7f);
        break;
      case 0xa:
        if (this.crb & 0x80) this.todAlarm.minutes = fromBCD(value & 0x7f);
        else this.todMinutes = fromBCD(value & 0x7f);
        break;
      case 0xb:
        if (this.crb & 0x80) this.todAlarm.hours = (value & 0x80) | fromBCD(value & 0x1f);
        else {
          this.todHours = (value & 0x80) | fromBCD(value & 0x1f);
          this.todHalted = true; // writing hours stops the clock until tenths is written
        }
        break;
      case 0xc:
        this.sdr = value;
        if (this.cra & 0x40) this.requestInterrupt(ICR_SDR); // output mode: shifts out immediately
        break;
      case 0xd:
        if (value & 0x80) this.icrMask |= value & 0x1f;
        else this.icrMask &= ~(value & 0x1f);
        // Unmasking a source that is already pending fires straight away.
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
        if (value & 0x10) this.timerA = this.latchA; // force load
        break;
      default:
        this.crb = value & 0xef;
        if (value & 0x10) this.timerB = this.latchB;
        break;
    }
  }
}

function toBCD(value) {
  return ((Math.floor(value / 10) % 10) << 4) | value % 10;
}

function fromBCD(value) {
  return ((value >> 4) & 0x0f) * 10 + (value & 0x0f);
}
