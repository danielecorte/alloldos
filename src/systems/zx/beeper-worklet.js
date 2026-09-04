// Il pezzo che suona i campioni che la ULA tira fuori dal suo unico bit.
//
// L'emulatore gira sul filo principale a quadri interi, questo lato consuma i
// campioni uno alla volta: in mezzo ci va un anello che assorbe la differenza.
// Se resta a secco non torna al silenzio di colpo — sarebbe uno schiocco —
// ma lascia scendere l'ultimo campione.

class BeeperProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1 << 16);
    this.writeIndex = 0;
    this.readIndex = 0;
    this.lastSample = 0;
    this.muted = false;

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
    const channel = outputs[0][0];
    if (!channel) return true;

    if (this.muted) {
      channel.fill(0);
      return true;
    }

    for (let i = 0; i < channel.length; i++) {
      if (this.readIndex !== this.writeIndex) {
        this.lastSample = this.buffer[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.buffer.length;
      } else {
        this.lastSample *= 0.98; // underrun: decay instead of clicking
      }
      channel[i] = this.lastSample;
    }

    // Report the remaining runway now and then, so the main thread can throttle.
    if ((this.reports = (this.reports ?? 0) + 1) >= 16) {
      this.reports = 0;
      this.port.postMessage({ available: this.available });
    }
    return true;
  }
}

registerProcessor('beeper-processor', BeeperProcessor);
