// Bridge between the SID emulation on the main thread and the audio hardware.
//
// The AudioContext is created up front (suspended) so the SID can be built at
// the right sample rate; it is resumed on the first user gesture, which is what
// browsers require.

const WORKLET_URL = new URL('./sid-worklet.js', import.meta.url);

export class AudioOutput {
  constructor() {
    this.context = new (window.AudioContext ?? window.webkitAudioContext)();
    this.node = null;
    this.gain = null;
    this.muted = false;
    this.available = 0; // samples still queued in the worklet
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
    this.node = new AudioWorkletNode(this.context, 'sid-processor', { outputChannelCount: [1] });
    this.node.port.onmessage = (event) => {
      if (event.data.available !== undefined) this.available = event.data.available;
    };
    this.gain = this.context.createGain();
    this.gain.gain.value = 0.6;
    this.node.connect(this.gain).connect(this.context.destination);
  }

  /** @param {Float32Array} samples transferred to the audio thread */
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
