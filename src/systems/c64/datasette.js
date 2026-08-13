// The 1530 Datasette.
//
// The tape read head is wired to CIA 1's /FLAG pin, so every falling edge on
// the tape raises an interrupt and the KERNAL measures the gaps with Timer B to
// tell a short pulse from a long one. All this device does is replay those
// edges at the right moments; the machine works out what they mean.
//
// Two lines run the other way: the 6510's port bit 4 reads the button switch
// (low when a button is down) and bit 5 drives the motor.

export const BUTTON_NONE = 'stop';
export const BUTTON_PLAY = 'play';
export const BUTTON_RECORD = 'record';

export class Datasette {
  /** @param {{onPulse:()=>void}} hooks called on every falling edge of the tape signal */
  constructor(hooks) {
    this.hooks = hooks;
    this.tape = null;
    this.name = '';
    this.button = BUTTON_NONE;
    this.motorOn = false;
    this.position = 0;
    this.cyclesToNextPulse = 0;
    this.elapsedCycles = 0;
    /** Cycle stamps of the falling edges the machine wrote, while recording. */
    this.recorded = [];
    this.writeLevel = false;
  }

  /**
   * @param {{version:number, pulses:Int32Array, cycles:number}} tape from parseTAP
   */
  insert(tape, name = '') {
    this.tape = tape;
    this.name = name;
    this.rewind();
  }

  eject() {
    this.tape = null;
    this.name = '';
    this.button = BUTTON_NONE;
    this.rewind();
  }

  rewind() {
    this.position = 0;
    this.elapsedCycles = 0;
    this.cyclesToNextPulse = this.tape?.pulses[0] ?? 0;
  }

  press(button) {
    this.button = button;
  }

  /** The switch line: low, i.e. sensed, whenever a button is down. */
  get senseClosed() {
    return this.button !== BUTTON_NONE;
  }

  /** True while tape is actually moving past the head. */
  get running() {
    return this.motorOn && this.button === BUTTON_PLAY && this.tape !== null && !this.atEnd;
  }

  get recording() {
    return this.motorOn && this.button === BUTTON_RECORD;
  }

  /**
   * The machine's own tape signal, on 6510 port bit 3. Every transition is
   * kept, because one pulse of the recorded format is two half waves: taking
   * only the falling edges samples them out of phase and turns a short pulse
   * followed by a medium one into a length that never existed.
   * @param {boolean} level
   * @param {number} cycles the machine's running cycle count
   */
  writeEdge(level, cycles) {
    if (level === this.writeLevel) return;
    this.writeLevel = level;
    if (this.recording) this.recorded.push(cycles);
  }

  /** The recording so far, as pulse lengths in cycles: one pulse per half-wave pair. */
  recordedPulses() {
    const count = Math.max(0, Math.floor((this.recorded.length - 1) / 2));
    const pulses = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      pulses[i] = this.recorded[i * 2 + 2] - this.recorded[i * 2];
    }
    return pulses;
  }

  get atEnd() {
    return this.tape === null || this.position >= this.tape.pulses.length;
  }

  /** How far through the tape we are, 0 to 1. */
  get progress() {
    if (!this.tape || this.tape.cycles === 0) return 0;
    return Math.min(1, this.elapsedCycles / this.tape.cycles);
  }

  /** The counter on the front of the real thing, near enough. */
  get counter() {
    return Math.floor(this.elapsedCycles / 98525) % 1000; // ~0.1 s per digit
  }

  setMotor(on) {
    this.motorOn = on;
  }

  /**
   * Advances the tape. Called with the cycle count of each instruction, so the
   * gaps between edges stay accurate enough for the ROM to measure them.
   */
  tick(cycles) {
    if (!this.running) return;

    this.elapsedCycles += cycles;
    this.cyclesToNextPulse -= cycles;

    // A tight loop: several pulses can fall inside one slow instruction.
    while (this.cyclesToNextPulse <= 0 && !this.atEnd) {
      this.position++;
      this.hooks.onPulse();
      if (this.atEnd) break;
      this.cyclesToNextPulse += this.tape.pulses[this.position];
    }
  }
}
