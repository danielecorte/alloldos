// Audio worklet for Paula: the same ring buffer as the C64's, in stereo.
//
// The emulator runs on the main thread in bursts of whole frames, so this side
// smooths over the gaps: on underrun it lets the last sample decay rather than
// clicking straight to silence.

class PaulaProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1 << 16); // interleaved, left first
    this.writeIndex = 0;
    this.readIndex = 0;
    this.last = [0, 0];
    this.muted = false;
    this.reports = 0;

    this.port.onmessage = (event) => {
      const { samples, muted } = event.data;
      if (muted !== undefined) this.muted = muted;
      if (!samples) return;

      for (let i = 0; i < samples.length; i++) {
        const next = (this.writeIndex + 1) % this.buffer.length;
        if (next === this.readIndex) break; // full, drop the rest
        this.buffer[this.writeIndex] = samples[i];
        this.writeIndex = next;
      }
    };
  }

  get available() {
    return (this.writeIndex - this.readIndex + this.buffer.length) % this.buffer.length;
  }

  process(inputs, outputs) {
    const left = outputs[0][0];
    const right = outputs[0][1] ?? left;
    if (!left) return true;

    if (this.muted) {
      left.fill(0);
      right.fill(0);
      return true;
    }

    for (let i = 0; i < left.length; i++) {
      if (this.available >= 2) {
        this.last[0] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
        this.last[1] = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
      } else {
        this.last[0] *= 0.98; // underrun: decay instead of clicking
        this.last[1] *= 0.98;
      }
      left[i] = this.last[0];
      right[i] = this.last[1];
    }

    if (++this.reports >= 16) {
      this.reports = 0;
      this.port.postMessage({ available: this.available >> 1 });
    }
    return true;
  }
}

registerProcessor('paula-processor', PaulaProcessor);
