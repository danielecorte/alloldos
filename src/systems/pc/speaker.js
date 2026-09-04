// L'altoparlante del PC: un cono, un filo, e nessun chip sonoro.
//
// Non c'è niente qui che assomigli a un SID o a Paula. C'è un bit: acceso il
// cono va avanti, spento torna indietro. Tutto il suono che il PC ha fatto per
// dieci anni — i bip del BIOS, le musichette dei giochi, le voci digitalizzate
// di chi era davvero bravo — esce da quel bit.
//
// Il modo normale di usarlo è non toccarlo: si programma il terzo contatore
// del PIT perché faccia un'onda quadra alla frequenza che si vuole, si collega
// la sua uscita al cono con due bit della porta 61h, e il suono va avanti da
// solo mentre il processore fa altro. È quello che fa questa classe: un
// oscillatore che segue il contatore, acceso e spento dai due bit.
//
// C'è anche l'altro modo — muovere il bit a mano, tante volte al secondo, e
// tirarci fuori un campionamento — ed è quello che facevano i giochi che
// parlavano. Quello di qui non lo riproduce: vorrebbe seguire il filo
// campione per campione invece che nota per nota, e sarebbe un altro pezzo.

import { PIT_CLOCK } from './pit.js';

export class Speaker {
  constructor() {
    this.context = new (window.AudioContext ?? window.webkitAudioContext)();
    this.oscillator = null;
    this.gain = null;
    this.muted = false;
    this.frequency = 0;
    this.on = false;
  }

  /** Si accende al primo gesto dell'utente, che è quello che vogliono i browser. */
  async start() {
    if (!this.oscillator) {
      this.gain = this.context.createGain();
      this.gain.gain.value = 0;
      this.oscillator = this.context.createOscillator();
      this.oscillator.type = 'square';
      this.oscillator.frequency.value = 440;
      this.oscillator.connect(this.gain).connect(this.context.destination);
      this.oscillator.start();
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /**
   * Guarda com'è messa la macchina e regola il cono di conseguenza. Si chiama
   * una volta per quadro: l'orecchio non sente la differenza, e il contatore
   * non cambia più spesso di così se non in quei giochi lì.
   *
   * @param {{pit: object, speaker: {gate: boolean, data: boolean}}} pc
   */
  update(pc) {
    if (!this.oscillator) return;
    const divisor = pc.pit.channels[2].period || 0x10000;
    const frequency = PIT_CLOCK / divisor;
    const sounding = pc.speaker.gate && pc.speaker.data && frequency > 20 && frequency < 20000;
    const now = this.context.currentTime;

    if (frequency !== this.frequency && sounding) {
      this.oscillator.frequency.setValueAtTime(frequency, now);
      this.frequency = frequency;
    }
    if (sounding !== this.on) {
      this.on = sounding;
      // Una rampa cortissima invece di uno scatto: uno scatto si sente come
      // uno schiocco, ed è un rumore che l'altoparlante vero non fa.
      this.gain.gain.setTargetAtTime(sounding && !this.muted ? 0.12 : 0, now, 0.005);
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (!this.gain) return;
    this.gain.gain.setTargetAtTime(this.on && !muted ? 0.12 : 0, this.context.currentTime, 0.005);
  }

  close() {
    try {
      this.oscillator?.stop();
      this.context.close();
    } catch {
      /* il contesto era già chiuso: non c'è niente da spegnere */
    }
  }
}
