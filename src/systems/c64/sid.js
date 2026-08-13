// MOS 6581 SID.
//
// Three oscillators with the real waveform generators and the real envelope
// rate tables, plus an approximation of the analogue filter. Samples are
// produced at the host audio rate and handed to an AudioWorklet by the caller.

const ATTACK = 0;
const DECAY_SUSTAIN = 1;
const RELEASE = 2;

/** Envelope rate periods in phi2 cycles, indexed by the ADSR nibble. */
const RATE_PERIODS = [
  9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11719, 19531, 31251,
];

/** The envelope's piecewise-exponential decay: level -> extra division. */
function exponentialPeriod(level) {
  if (level >= 0xff) return 1;
  if (level >= 0x5d) return 2;
  if (level >= 0x36) return 4;
  if (level >= 0x1a) return 8;
  if (level >= 0x0e) return 16;
  if (level >= 0x06) return 30;
  return 1;
}

class Voice {
  constructor() {
    this.frequency = 0;
    this.pulseWidth = 0;
    this.control = 0;
    this.attack = 0;
    this.decay = 0;
    this.sustain = 0;
    this.release = 0;

    this.accumulator = 0; // 24 bit
    this.shiftRegister = 0x7ffff8;
    this.msbRising = false;
    this.previousMsb = 0;

    this.state = RELEASE;
    this.envelope = 0;
    this.rateCounter = 0;
    this.ratePeriod = RATE_PERIODS[0];
    this.exponentialCounter = 0;
    this.exponentialPeriod = 1;
    this.holdZero = true;
  }

  get gate() {
    return (this.control & 0x01) !== 0;
  }

  setControl(value) {
    const wasGated = this.gate;
    this.control = value;
    const nowGated = (value & 0x01) !== 0;

    if (!wasGated && nowGated) {
      this.state = ATTACK;
      this.ratePeriod = RATE_PERIODS[this.attack];
      this.holdZero = false;
    } else if (wasGated && !nowGated) {
      this.state = RELEASE;
      this.ratePeriod = RATE_PERIODS[this.release];
    }
    if (value & 0x08) {
      // TEST bit resets the oscillator.
      this.accumulator = 0;
      this.shiftRegister = 0x7ffff8;
    }
  }

  clockEnvelope(cycles) {
    for (let i = 0; i < cycles; i++) {
      if (++this.rateCounter < this.ratePeriod) continue;
      this.rateCounter = 0;

      if (this.state !== ATTACK && ++this.exponentialCounter < this.exponentialPeriod) continue;
      this.exponentialCounter = 0;
      if (this.holdZero) continue;

      switch (this.state) {
        case ATTACK:
          this.envelope++;
          if (this.envelope >= 0xff) {
            this.envelope = 0xff;
            this.state = DECAY_SUSTAIN;
            this.ratePeriod = RATE_PERIODS[this.decay];
          }
          break;
        case DECAY_SUSTAIN: {
          const sustainLevel = this.sustain * 0x11;
          if (this.envelope > sustainLevel) this.envelope--;
          break;
        }
        default:
          if (this.envelope > 0) this.envelope--;
          if (this.envelope === 0) this.holdZero = true;
          break;
      }
      this.exponentialPeriod = exponentialPeriod(this.envelope);
    }
  }

  clockOscillator(cycles, syncSource) {
    if (this.control & 0x08) return; // TEST holds the oscillator at zero

    const previous = this.accumulator;
    const advanced = previous + this.frequency * cycles;
    this.accumulator = advanced % 0x1000000;

    this.msbRising = (previous & 0x800000) === 0 && (this.accumulator & 0x800000) !== 0;
    if (this.control & 0x02 && syncSource.msbRising) this.accumulator = 0; // hard sync

    if (this.control & 0x80) {
      // Noise: the LFSR shifts every time accumulator bit 19 goes high.
      const shifts = Math.floor(advanced / 0x100000) - Math.floor(previous / 0x100000);
      for (let i = 0; i < shifts && i < 64; i++) {
        const bit = ((this.shiftRegister >> 22) ^ (this.shiftRegister >> 17)) & 0x01;
        this.shiftRegister = ((this.shiftRegister << 1) | bit) & 0x7fffff;
      }
    }
  }

  /** @returns {number} 12-bit unsigned oscillator output */
  output(ringSource) {
    const wave = (this.control >> 4) & 0x0f;
    if (wave === 0) return 0;

    let value = 0xfff;
    if (wave & 0x01) {
      // Triangle, optionally ring modulated by the previous voice.
      let msb = this.accumulator & 0x800000;
      if (this.control & 0x04) msb ^= ringSource.accumulator & 0x800000;
      const shifted = (this.accumulator >> 11) & 0xfff;
      value &= msb ? ~shifted & 0xfff : shifted;
    }
    if (wave & 0x02) value &= (this.accumulator >> 12) & 0xfff; // sawtooth
    if (wave & 0x04) {
      // Pulse.
      value &= (this.accumulator >> 12) >= this.pulseWidth ? 0xfff : 0x000;
    }
    if (wave & 0x08) {
      // Noise, taken from the usual scattered bits of the shift register.
      const noise =
        (((this.shiftRegister >> 22) & 1) << 11) |
        (((this.shiftRegister >> 20) & 1) << 10) |
        (((this.shiftRegister >> 16) & 1) << 9) |
        (((this.shiftRegister >> 13) & 1) << 8) |
        (((this.shiftRegister >> 11) & 1) << 7) |
        (((this.shiftRegister >> 7) & 1) << 6) |
        (((this.shiftRegister >> 4) & 1) << 5) |
        (((this.shiftRegister >> 2) & 1) << 4);
      value &= noise;
    }
    return value;
  }
}

export class SID {
  /**
   * @param {number} clockRate phi2 frequency in Hz
   * @param {number} sampleRate host audio sample rate
   */
  constructor(clockRate, sampleRate) {
    this.clockRate = clockRate;
    this.sampleRate = sampleRate;
    this.cyclesPerSample = clockRate / sampleRate;

    this.voices = [new Voice(), new Voice(), new Voice()];
    this.filterCutoff = 0;
    this.filterResonance = 0;
    this.filterRouting = 0;
    this.filterMode = 0;
    this.volume = 15;

    this.cycleDebt = 0;
    this.cycleCarry = 0;
    this.lowpass = 0;
    this.bandpass = 0;

    // Ring buffer of generated samples, drained by the audio backend.
    this.buffer = new Float32Array(1 << 15);
    this.writeIndex = 0;
    this.readIndex = 0;
  }

  reset() {
    for (const voice of this.voices) Object.assign(voice, new Voice());
    this.volume = 15;
    this.filterCutoff = 0;
    this.filterRouting = 0;
    this.filterMode = 0;
    this.lowpass = this.bandpass = 0;
    this.writeIndex = this.readIndex = 0;
  }

  write(reg, value) {
    reg &= 0x1f;
    value &= 0xff;

    if (reg < 0x15) {
      const voice = this.voices[Math.floor(reg / 7)];
      switch (reg % 7) {
        case 0: voice.frequency = (voice.frequency & 0xff00) | value; break;
        case 1: voice.frequency = (voice.frequency & 0x00ff) | (value << 8); break;
        case 2: voice.pulseWidth = (voice.pulseWidth & 0xf00) | value; break;
        case 3: voice.pulseWidth = (voice.pulseWidth & 0x0ff) | ((value & 0x0f) << 8); break;
        case 4: voice.setControl(value); break;
        case 5:
          voice.attack = (value >> 4) & 0x0f;
          voice.decay = value & 0x0f;
          if (voice.state === ATTACK) voice.ratePeriod = RATE_PERIODS[voice.attack];
          else if (voice.state === DECAY_SUSTAIN) voice.ratePeriod = RATE_PERIODS[voice.decay];
          break;
        default:
          voice.sustain = (value >> 4) & 0x0f;
          voice.release = value & 0x0f;
          if (voice.state === RELEASE) voice.ratePeriod = RATE_PERIODS[voice.release];
          break;
      }
      return;
    }

    switch (reg) {
      case 0x15: this.filterCutoff = (this.filterCutoff & 0x7f8) | (value & 0x07); break;
      case 0x16: this.filterCutoff = (this.filterCutoff & 0x007) | (value << 3); break;
      case 0x17:
        this.filterRouting = value & 0x0f;
        this.filterResonance = (value >> 4) & 0x0f;
        break;
      case 0x18:
        this.volume = value & 0x0f;
        this.filterMode = value & 0xf0;
        break;
      default:
        break;
    }
  }

  read(reg) {
    switch (reg & 0x1f) {
      case 0x1b: return (this.voices[2].output(this.voices[1]) >> 4) & 0xff;
      case 0x1c: return this.voices[2].envelope & 0xff;
      default: return 0x00;
    }
  }

  /** Advances the chip and appends any samples that fall inside this slice. */
  clock(cycles) {
    this.cycleDebt += cycles;
    while (this.cycleDebt >= this.cyclesPerSample) {
      this.cycleDebt -= this.cyclesPerSample;
      // Carry the fractional part so the oscillators keep exact pitch.
      this.cycleCarry += this.cyclesPerSample;
      const step = Math.floor(this.cycleCarry);
      this.cycleCarry -= step;
      if (step > 0) this.advance(step);
      this.pushSample(this.mix());
    }
  }

  advance(cycles) {
    const [v0, v1, v2] = this.voices;
    v0.clockOscillator(cycles, v2);
    v1.clockOscillator(cycles, v0);
    v2.clockOscillator(cycles, v1);
    v0.clockEnvelope(cycles);
    v1.clockEnvelope(cycles);
    v2.clockEnvelope(cycles);
  }

  mix() {
    const [v0, v1, v2] = this.voices;
    const outputs = [
      (v0.output(v2) - 0x800) * v0.envelope,
      (v1.output(v0) - 0x800) * v1.envelope,
      (v2.output(v1) - 0x800) * v2.envelope,
    ];

    let direct = 0;
    let filtered = 0;
    for (let i = 0; i < 3; i++) {
      if (i === 2 && this.filterMode & 0x80 && !(this.filterRouting & 0x04)) continue; // voice 3 off
      if (this.filterRouting & (1 << i)) filtered += outputs[i];
      else direct += outputs[i];
    }

    if (this.filterMode & 0x70) {
      // State-variable filter; cutoff follows the 6581's roughly exponential curve.
      const cutoffHz = 30 + (this.filterCutoff / 2047) ** 1.6 * 11970;
      const f = Math.min(0.99, (2 * Math.PI * cutoffHz) / this.sampleRate);
      const q = 1.4 - (this.filterResonance / 15) * 1.3;

      const highpass = filtered - this.lowpass - q * this.bandpass;
      this.bandpass += f * highpass;
      this.lowpass += f * this.bandpass;

      let out = 0;
      if (this.filterMode & 0x10) out += this.lowpass;
      if (this.filterMode & 0x20) out += this.bandpass;
      if (this.filterMode & 0x40) out += highpass;
      filtered = out;
    } else {
      filtered = 0;
    }

    // 3 voices * 2048 * 255 is the full-scale sum; keep some headroom.
    return ((direct + filtered) * (this.volume / 15)) / (3 * 2048 * 255);
  }

  pushSample(value) {
    const next = (this.writeIndex + 1) % this.buffer.length;
    if (next === this.readIndex) return; // buffer full: the audio thread is behind
    this.buffer[this.writeIndex] = Math.max(-1, Math.min(1, value));
    this.writeIndex = next;
  }

  /** Removes up to `count` samples for the audio backend. */
  drain(count) {
    const available = (this.writeIndex - this.readIndex + this.buffer.length) % this.buffer.length;
    const take = Math.min(count, available);
    const out = new Float32Array(take);
    for (let i = 0; i < take; i++) {
      out[i] = this.buffer[this.readIndex];
      this.readIndex = (this.readIndex + 1) % this.buffer.length;
    }
    return out;
  }

  get pendingSamples() {
    return (this.writeIndex - this.readIndex + this.buffer.length) % this.buffer.length;
  }
}
