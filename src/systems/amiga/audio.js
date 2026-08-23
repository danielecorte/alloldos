// Bridge between Paula on the main thread and the browser's audio hardware.
//
// Built the same way as the C64's: a suspended AudioContext up front so the
// emulation knows its sample rate, resumed on the first click, because that is
// what browsers ask for.

const WORKLET_URL = new URL('./audio-worklet.js', import.meta.url);

export class AudioOutput {
  constructor() {
    this.context = new (window.AudioContext ?? window.webkitAudioContext)();
    this.node = null;
    this.gain = null;
    this.muted = false;
    this.available = 0; // stereo frames still queued in the worklet
    this.ready = null;
  }

  get sampleRate() {
    return this.context.sampleRate;
  }

  /** Sets up the worklet. Safe to call more than once. */
  async start() {
    if (!this.ready) this.ready = this.createGraph();
    await this.ready;
    if (this.context.state === 'suspended') await this.context.resume();
  }

  async createGraph() {
    await this.context.audioWorklet.addModule(WORKLET_URL);
    this.node = new AudioWorkletNode(this.context, 'paula-processor', {
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (event) => {
      if (event.data.available !== undefined) this.available = event.data.available;
    };
    this.gain = this.context.createGain();
    this.gain.gain.value = 0.7;
    this.node.connect(this.gain).connect(this.context.destination);
  }

  /** @param {Float32Array} samples interleaved, transferred to the audio thread */
  push(samples) {
    if (!this.node || samples.length === 0) return;
    this.node.port.postMessage({ samples }, [samples.buffer]);
  }

  setMuted(muted) {
    this.muted = muted;
    this.node?.port.postMessage({ muted });
  }

  async close() {
    this.node?.disconnect();
    this.gain?.disconnect();
    await this.context.close().catch(() => {});
  }
}
