// Il suono dello Spectrum, che è un bit.
//
// Non c'è nessun chip sonoro: c'è un piezoelettrico attaccato al bit 4 della
// porta FEh, e tutto quello che si sente è quel bit che va su e giù. Una nota
// si fa muovendolo alla frequenza giusta contando cicli — e siccome il
// processore mentre conta non può fare altro, sullo Spectrum la musica ferma
// il gioco. È per quello che nei giochi la musica c'è nei menu e non mentre si
// gioca, e che l'unico effetto sonoro durante il gioco è un tonfo cortissimo.
//
// Chi era bravo faceva molto di più: muovendo quel bit qualche migliaio di
// volte al secondo con distanze variabili si ottiene un'onda a più voci, o un
// campionamento. Qui non c'è niente da riprodurre in modo speciale, perché
// non si riproducono note: si prende il filo com'era, istante per istante, e
// si trasforma in campioni. Quello che ne esce è quello che si sarebbe
// sentito, comprese le voci multiple di chi sapeva farle.

const WORKLET_URL = new URL('./beeper-worklet.js', import.meta.url);

/**
 * I campioni di un quadro, dal filo dell'altoparlante.
 *
 * Ogni campione è la media del livello del filo nel suo intervallo, non il
 * livello in un istante: campionare a punti un'onda quadra da qualche kHz
 * darebbe fischi che non ci sono: la media invece è quello che sente un cono,
 * che ha una sua inerzia.
 *
 * @param {{t:number, level:number}[]} events i cambi, in ordine di tempo
 * @param {number} frameCycles quanto dura il quadro in T-state
 * @param {number} count quanti campioni servono
 * @returns {Float32Array}
 */
export function beeperSamples(events, frameCycles, count) {
  const samples = new Float32Array(count);
  const step = frameCycles / count;
  let index = 0;
  let level = events.length ? events[0].level : 0;
  let at = 0;

  for (let i = 0; i < count; i++) {
    const end = (i + 1) * step;
    let area = 0;
    let from = at;
    while (index + 1 < events.length && events[index + 1].t < end) {
      index++;
      const change = events[index];
      area += level * (change.t - from);
      from = change.t;
      level = change.level;
    }
    area += level * (end - from);
    at = end;
    // Il filo va da 0 a 1; il campione da -0,4 a 0,4, che è forte abbastanza
    // senza far male.
    samples[i] = (area / step) * 0.8 - 0.4;
  }
  return samples;
}

export class AudioOutput {
  constructor() {
    this.context = new (window.AudioContext ?? window.webkitAudioContext)();
    this.node = null;
    this.gain = null;
    this.muted = false;
    this.available = 0;
    this.ready = null;
  }

  get sampleRate() {
    return this.context.sampleRate;
  }

  /** Si accende al primo gesto dell'utente, come vogliono i browser. */
  async start() {
    if (!this.ready) this.ready = this.createGraph();
    await this.ready;
    if (this.context.state === 'suspended') await this.context.resume();
  }

  async createGraph() {
    await this.context.audioWorklet.addModule(WORKLET_URL);
    this.node = new AudioWorkletNode(this.context, 'beeper-processor', {
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (event) => {
      if (event.data.available !== undefined) this.available = event.data.available;
    };
    this.gain = this.context.createGain();
    this.gain.gain.value = 0.5;
    this.node.connect(this.gain).connect(this.context.destination);
  }

  /** @param {Float32Array} samples */
  push(samples) {
    if (!this.node || samples.length === 0) return;
    this.available += samples.length;
    this.node.port.postMessage({ samples }, [samples.buffer]);
  }

  setMuted(muted) {
    this.muted = muted;
    this.node?.port.postMessage({ muted });
  }

  close() {
    try {
      this.context.close();
    } catch {
      /* era già chiuso */
    }
  }
}
