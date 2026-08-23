// Paula: interrupts, and four channels of sound.
//
// Every interrupt in the machine arrives here — the CIAs' included — is masked
// against INTENA, and comes out as one of the 68000's seven levels. The audio
// side is four DMA channels playing signed bytes straight out of chip RAM, two
// of them into the left speaker and two into the right, which is where the
// Amiga's stereo comes from.

/** INTREQ/INTENA bits. */
export const INT_TBE = 0x0001;
export const INT_DSKBLK = 0x0002;
export const INT_SOFT = 0x0004;
export const INT_PORTS = 0x0008; // CIA-A
export const INT_COPER = 0x0010;
export const INT_VERTB = 0x0020;
export const INT_BLIT = 0x0040;
export const INT_AUD0 = 0x0080;
export const INT_RBF = 0x0800;
export const INT_DSKSYNC = 0x1000;
export const INT_EXTER = 0x2000; // CIA-B
export const INT_MASTER = 0x4000;

const COLOR_CLOCK = 3546895; // PAL, in Hz

/** Which of the seven interrupt levels each INTREQ bit comes out on. */
const LEVELS = [1, 1, 1, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 6, 0, 0];

export class Paula {
  /**
   * @param {object} hooks
   * @param {(addr:number)=>number} hooks.read chip RAM
   * @param {(level:number)=>void} hooks.onInterruptLevel
   * @param {(channel:number)=>boolean} hooks.audioDMA
   * @param {number} sampleRate the host's, not the Amiga's
   */
  constructor(hooks, sampleRate = 44100) {
    this.hooks = hooks;
    this.sampleRate = sampleRate;
    this.channels = Array.from({ length: 4 }, () => ({
      lc: 0,
      len: 1,
      period: 1,
      volume: 0,
      pointer: 0,
      count: 0,
      word: 0,
      phase: 0,
      output: 0,
      clock: 0,
      running: false,
    }));

    // Room for a quarter of a second, which is far more than a frame.
    this.buffer = new Float32Array(sampleRate >> 1);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.sampleDebt = 0;
    this.reset();
  }

  reset() {
    this.intena = 0;
    this.intreq = 0;
    this.adkcon = 0;
    this.serdat = 0;
    for (const channel of this.channels) {
      channel.running = false;
      channel.output = 0;
      channel.volume = 0;
      channel.period = 1;
      channel.clock = 0;
    }
    this.writeIndex = 0;
    this.readIndex = 0;
    this.updateInterrupts();
  }

  // ------------------------------------------------------------- interrupts

  raise(bits) {
    this.intreq |= bits;
    this.updateInterrupts();
  }

  clear(bits) {
    this.intreq &= ~bits;
    this.updateInterrupts();
  }

  /** Works out the highest pending level and hands it to the CPU. */
  updateInterrupts() {
    let level = 0;
    if (this.intena & INT_MASTER) {
      const pending = this.intreq & this.intena & 0x3fff;
      for (let bit = 13; bit >= 0; bit--) {
        if (pending & (1 << bit)) {
          level = LEVELS[bit];
          break;
        }
      }
    }
    this.hooks.onInterruptLevel(level);
  }

  // ------------------------------------------------------------------ audio

  /**
   * The DMA switch for a channel is edge-triggered: turning it on is what makes
   * the channel go back to the start of its sample and begin again.
   */
  updateAudioDMA() {
    for (let index = 0; index < 4; index++) {
      const enabled = this.hooks.audioDMA(index);
      const channel = this.channels[index];
      if (enabled && !channel.running) {
        channel.pointer = channel.lc;
        channel.count = channel.len;
        channel.phase = 0;
        channel.clock = 0;
        channel.word = this.hooks.read(channel.pointer);
        channel.pointer = (channel.pointer + 2) & 0x1ffffe;
        channel.running = true;
      } else if (!enabled && channel.running) {
        channel.running = false;
        channel.output = 0;
      }
    }
  }

  /**
   * Runs the sound for a stretch of the frame and leaves host-rate samples in
   * the ring buffer. Channels are stepped between output samples rather than
   * on every colour clock: at 44 kHz that is still finer than any period the
   * hardware can play.
   * @param {number} colorClocks
   */
  clock(colorClocks) {
    this.sampleDebt += (colorClocks * this.sampleRate) / COLOR_CLOCK;
    const due = Math.floor(this.sampleDebt);
    if (due <= 0) return;
    this.sampleDebt -= due;
    const step = colorClocks / due;

    for (let i = 0; i < due; i++) {
      let left = 0;
      let right = 0;
      for (let index = 0; index < 4; index++) {
        const channel = this.channels[index];
        if (!channel.running) continue;
        channel.clock += step;
        while (channel.clock >= channel.period) {
          channel.clock -= Math.max(channel.period, 1);
          this.advance(index, channel);
        }
        const value = (channel.output * channel.volume) / (128 * 64);
        // Channels 0 and 3 are the left speaker, 1 and 2 the right.
        if (index === 0 || index === 3) left += value;
        else right += value;
      }
      this.pushSample(left / 2, right / 2);
    }
  }

  /** One byte further into the sample; a word further every other time. */
  advance(index, channel) {
    if (channel.phase === 0) {
      channel.output = (channel.word >> 8) & 0xff;
      channel.phase = 1;
    } else {
      channel.output = channel.word & 0xff;
      channel.phase = 0;
      channel.word = this.hooks.read(channel.pointer);
      channel.pointer = (channel.pointer + 2) & 0x1ffffe;
      channel.count--;
      if (channel.count <= 0) {
        // The end of the sample: back to the start, and tell the program — this
        // is the interrupt that lets it swap in the next buffer in time.
        channel.pointer = channel.lc;
        channel.count = channel.len || 1;
        this.raise(INT_AUD0 << index);
      }
    }
    if (channel.output > 127) channel.output -= 256; // the bytes are signed
  }

  pushSample(left, right) {
    const next = (this.writeIndex + 2) % this.buffer.length;
    if (next === this.readIndex) return; // nobody is listening fast enough
    this.buffer[this.writeIndex] = Math.max(-1, Math.min(1, left));
    this.buffer[this.writeIndex + 1] = Math.max(-1, Math.min(1, right));
    this.writeIndex = next;
  }

  get pendingSamples() {
    return (this.writeIndex - this.readIndex + this.buffer.length) % this.buffer.length;
  }

  /**
   * Takes samples out of the ring buffer, interleaved left and right.
   * @returns {Float32Array}
   */
  drain(count) {
    const available = Math.min(count, this.pendingSamples);
    const out = new Float32Array(available);
    for (let i = 0; i < available; i++) {
      out[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.buffer.length;
    }
    return out;
  }

  // --------------------------------------------------------------- registers

  readRegister(offset) {
    switch (offset) {
      case 0x010: // ADKCONR
        return this.adkcon;
      case 0x018: // SERDATR — nothing is plugged into the serial port
        return 0x2000; // transmit buffer empty
      case 0x01c:
        return this.intena;
      case 0x01e:
        return this.intreq;
      default:
        return 0xffff;
    }
  }

  writeRegister(offset, value) {
    if (offset >= 0x0a0 && offset < 0x0e0) {
      const channel = this.channels[(offset - 0x0a0) >> 4];
      switch (offset & 0x0e) {
        case 0x0:
          channel.lc = (channel.lc & 0xfffe) | ((value & 0x1f) << 16);
          return true;
        case 0x2:
          channel.lc = (channel.lc & 0x1f0000) | (value & 0xfffe);
          return true;
        case 0x4:
          channel.len = value || 1;
          return true;
        case 0x6:
          channel.period = value || 1;
          return true;
        case 0x8:
          channel.volume = Math.min(value & 0x7f, 64);
          return true;
        default:
          channel.word = value;
          return true;
      }
    }

    switch (offset) {
      case 0x09a: {
        if (value & 0x8000) this.intena |= value & 0x7fff;
        else this.intena &= ~(value & 0x7fff);
        this.updateInterrupts();
        return true;
      }
      case 0x09c: {
        if (value & 0x8000) this.intreq |= value & 0x7fff;
        else this.intreq &= ~(value & 0x7fff);
        this.updateInterrupts();
        return true;
      }
      case 0x09e:
        if (value & 0x8000) this.adkcon |= value & 0x7fff;
        else this.adkcon &= ~(value & 0x7fff);
        return true;
      case 0x030: // SERDAT: a byte out of the serial port, straight into the void
        this.serdat = value;
        this.raise(INT_TBE);
        return true;
      default:
        return false;
    }
  }
}
