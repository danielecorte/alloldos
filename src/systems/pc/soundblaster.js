// La Sound Blaster 2.0, che è la scheda che ha dato il suono al PC.
//
// Creative la vende nel 1989 e fa una cosa furba: ci mette sopra, identico e
// alle stesse porte, il chip FM della AdLib, così che tutti i giochi già
// scritti per quella suonino anche su questa. Poi ci aggiunge quello che la
// AdLib non aveva, cioè il **DSP**: un piccolo microcontrollore che prende
// byte dalla memoria e li manda a un convertitore a otto bit. Voci, spari,
// esplosioni, e "Sound Blaster!" detto all'accensione dal programma di prova.
//
// Il DSP si parla da quattro porte: una per riavviarlo, una per mandargli
// comandi e dati, una per leggere le risposte e una per sapere se ce ne sono.
// Il suono non passa dal processore: il programma mette i campioni in un buffer,
// programma il canale 1 del DMA perché li porti al DSP, dice al DSP quanto
// veloce e quanti, e va a fare altro. Quando il blocco è finito il DSP alza la
// IRQ 7, e il programma — che nel frattempo ha preparato il blocco dopo — gli
// dice di continuare. È lo stesso gioco a due del disco, girato verso l'uscita.
//
// Le impostazioni sono quelle di fabbrica: porta 220h, IRQ 7, DMA 1. Sono i
// ponticelli con cui la scheda usciva dalla scatola, e sono quelli che dice la
// variabile BLASTER nell'AUTOEXEC, che è dove i programmi li vanno a leggere.

import { OPL2, OPL_RATE } from './opl2.js';

export const SB_BASE = 0x220;
export const SB_IRQ = 7;
export const SB_DMA = 1;
/** Le porte della AdLib, dove il chip FM risponde anche su questa scheda. */
export const ADLIB_BASE = 0x388;
/** La riga dell'AUTOEXEC: porta, interruzione, DMA e tipo — il 3 è la Sound Blaster 2.0. */
export const BLASTER = 'A220 I7 D1 T3';

/** La versione del DSP: 2.01, quella della Sound Blaster 2.0. */
const VERSION = [2, 1];

/** Quanti byte di parametri si porta dietro ogni comando. */
const PARAMETERS = {
  0x10: 1, 0x14: 2, 0x16: 2, 0x17: 2, 0x24: 2, 0x38: 1, 0x40: 1, 0x48: 2,
  0x74: 2, 0x75: 2, 0x76: 2, 0x77: 2, 0x80: 2, 0xe0: 1, 0xe4: 1,
};

/** Quanto pesano le due voci nel suono che esce: il DSP a piena scala copre il chip FM. */
const DSP_GAIN = 0.5;
const FM_GAIN = 1.5;

export class SoundBlaster {
  /**
   * @param {object} hooks
   * @param {{transfer:(channel:number, value?:number|null)=>number}} hooks.dma
   * @param {(active:boolean)=>void} hooks.setIRQ il filo della IRQ 7
   * @param {number} hooks.clock i cicli al secondo del processore
   * @param {number} [hooks.sampleRate] i campioni al secondo che vuole chi ascolta
   */
  constructor({ dma, setIRQ, clock, sampleRate = 44100 }) {
    this.dma = dma;
    this.setIRQ = setIRQ;
    this.clock = clock;
    this.sampleRate = sampleRate;
    this.opl = new OPL2();
    /** Dove si accumulano i campioni in attesa che qualcuno li prenda: al più un secondo. */
    this.buffer = new Float32Array(sampleRate);
    this.count = 0;
    this.reset();
  }

  setSampleRate(rate) {
    this.sampleRate = rate;
    this.buffer = new Float32Array(rate);
    this.count = 0;
  }

  reset() {
    this.opl.reset();
    this.resetDSP();
    this.oplTime = 0;
    this.hostTime = 0;
    this.fmSum = 0;
    this.fmCount = 0;
    this.fmLast = 0;
  }

  resetDSP() {
    this.dsp = {
      /** Le risposte che aspettano di essere lette dalla porta 2xAh. */
      output: [],
      /** L'ultima risposta letta, che il bus ridà se non ce ne sono altre. */
      last: 0xff,
      command: -1,
      parameters: [],
      /** Il livello del convertitore, 128 è lo zero. */
      dac: 128,
      speaker: false,
      timeConstant: 0,
      rate: 22050 / 4,
      blockSize: 0x800,
      test: 0,
      resetLine: false,
      // Il trasferimento in corso: che cosa, quanto ne manca, e se ricomincia.
      mode: null,
      remaining: 0,
      autoInit: false,
      paused: false,
      samplesPerByte: 1,
      subSample: 0,
      time: 0,
      irq: false,
      /** Quante interruzioni ha alzato: serve a chi lo guarda da fuori. */
      interrupts: 0,
    };
    this.setIRQ(false);
  }

  // ------------------------------------------------------------ le porte

  /** Le porte che questa scheda occupa, per la scheda madre che deve smistarle. */
  static claims(port) {
    return (port >= SB_BASE && port < SB_BASE + 0x10) || port === ADLIB_BASE || port === ADLIB_BASE + 1;
  }

  read(port) {
    if (port === ADLIB_BASE || port === ADLIB_BASE + 1) return this.opl.status;
    switch (port - SB_BASE) {
      case 0x08:
      case 0x09:
        return this.opl.status;
      case 0x0a: {
        // La risposta del DSP. Se non ce n'è, il bus ridà l'ultima.
        const dsp = this.dsp;
        if (dsp.output.length) dsp.last = dsp.output.shift();
        return dsp.last;
      }
      case 0x0c:
        // Il DSP è sempre pronto: il bit 7 spento dice "scrivimi pure".
        return 0x7f;
      case 0x0e: {
        // Due mestieri in una lettura: dice se c'è una risposta, e se c'era
        // un'interruzione la chiude. Un programma che se ne dimentica non ne
        // riceve un'altra, perché il filo resta alzato e il PIC scatta sul fronte.
        const dsp = this.dsp;
        if (dsp.irq) {
          dsp.irq = false;
          this.setIRQ(false);
        }
        return (dsp.output.length ? 0x80 : 0) | 0x7f;
      }
      default:
        return 0xff;
    }
  }

  write(port, value) {
    value &= 0xff;
    if (port === ADLIB_BASE) return this.opl.writeAddress(value);
    if (port === ADLIB_BASE + 1) return this.opl.writeData(value);
    switch (port - SB_BASE) {
      case 0x06:
        // Il reset si fa a mano: uno, e poi zero. Sul fronte di discesa il DSP
        // si riavvia e dice AAh, che è il modo in cui ogni programma scopre che
        // la scheda c'è e a che porta sta.
        if (value & 1) {
          this.dsp.resetLine = true;
        } else if (this.dsp.resetLine) {
          this.resetDSP();
          this.dsp.output.push(0xaa);
        }
        return undefined;
      case 0x08:
        return this.opl.writeAddress(value);
      case 0x09:
        return this.opl.writeData(value);
      case 0x0c:
        return this.dspWrite(value);
      default:
        return undefined;
    }
  }

  // --------------------------------------------------------------- il DSP

  dspWrite(value) {
    const dsp = this.dsp;
    if (dsp.command < 0) {
      dsp.command = value;
      dsp.parameters = [];
    } else {
      dsp.parameters.push(value);
    }
    if (dsp.parameters.length < (PARAMETERS[dsp.command] ?? 0)) return;
    const command = dsp.command;
    const p = dsp.parameters;
    dsp.command = -1;
    const length = () => (p[0] | (p[1] << 8)) + 1;

    switch (command) {
      case 0x10: // un campione dritto al convertitore, senza DMA
        dsp.dac = p[0];
        break;
      case 0x14: // otto bit, un blocco
      case 0x91: // alta velocità, un blocco
        this.start('output', command === 0x14 ? length() : dsp.blockSize, false, 1);
        break;
      case 0x1c: // otto bit, blocchi uno dietro l'altro
      case 0x90: // alta velocità, blocchi uno dietro l'altro
        this.start('output', dsp.blockSize, true, 1);
        break;
      // L'ADPCM: due, tre o quattro campioni per byte, compressi. Qui i byte
      // si consumano alla velocità giusta e l'interruzione arriva quando deve,
      // ma quello che si sente è silenzio.
      case 0x74:
      case 0x75:
        this.start('adpcm', length(), false, 2);
        break;
      case 0x76:
      case 0x77:
        this.start('adpcm', length(), false, 3);
        break;
      case 0x16:
      case 0x17:
        this.start('adpcm', length(), false, 4);
        break;
      case 0x7d:
        this.start('adpcm', dsp.blockSize, true, 2);
        break;
      case 0x7f:
        this.start('adpcm', dsp.blockSize, true, 3);
        break;
      case 0x1f:
        this.start('adpcm', dsp.blockSize, true, 4);
        break;
      case 0x20: // un campione dal microfono: che qui non c'è, quindi silenzio
        dsp.output.push(0x80);
        break;
      case 0x24:
      case 0x99:
        this.start('input', command === 0x24 ? length() : dsp.blockSize, false, 1);
        break;
      case 0x2c:
      case 0x98:
        this.start('input', dsp.blockSize, true, 1);
        break;
      case 0x40:
        // La velocità non si dice in hertz: si dice quanti microsecondi fra un
        // campione e l'altro, tolti da 256. È un contatore del DSP, e si vede.
        dsp.timeConstant = p[0];
        dsp.rate = 1000000 / (256 - p[0]);
        break;
      case 0x48:
        dsp.blockSize = length();
        break;
      case 0x80: // un blocco di silenzio, che costa zero byte e finisce con un'interruzione
        this.start('silence', length(), false, 1);
        break;
      case 0xd0:
        dsp.paused = true;
        break;
      case 0xd4:
        dsp.paused = false;
        break;
      case 0xd1:
        dsp.speaker = true;
        break;
      case 0xd3:
        dsp.speaker = false;
        break;
      case 0xd8:
        dsp.output.push(dsp.speaker ? 0xff : 0x00);
        break;
      case 0xda: // finisci il blocco e fermati
        dsp.autoInit = false;
        break;
      case 0xe0: // la prova di identità: il DSP ridà il byte rovesciato
        dsp.output.push(~p[0] & 0xff);
        break;
      case 0xe1:
        dsp.output.push(...VERSION);
        break;
      case 0xe4:
        dsp.test = p[0];
        break;
      case 0xe8:
        dsp.output.push(dsp.test);
        break;
      case 0xf2: // alza l'interruzione e basta: è così che un programma scopre quale IRQ ha la scheda
        this.interrupt();
        break;
      case 0xf8:
        dsp.output.push(0);
        break;
      default:
        // Le MIDI, i comandi dei DSP dopo, quelli che nessuno ha documentato:
        // il DSP li ascolta e non fa niente, come quello vero con un comando
        // che non conosce.
    }
  }

  start(mode, length, autoInit, samplesPerByte) {
    const dsp = this.dsp;
    dsp.mode = mode;
    dsp.remaining = length;
    dsp.autoInit = autoInit;
    dsp.paused = false;
    dsp.samplesPerByte = samplesPerByte;
    dsp.subSample = 0;
    dsp.time = 0;
  }

  interrupt() {
    const dsp = this.dsp;
    dsp.interrupts++;
    dsp.irq = true;
    this.setIRQ(true);
  }

  /**
   * Un campione del trasferimento in corso. Per l'uscita il byte arriva dal
   * DMA; se il canale è fermo — mascherato, o non ancora programmato — il DSP
   * aspetta, come quello vero con la sua richiesta alzata e nessuno che
   * risponde.
   */
  step() {
    const dsp = this.dsp;
    if (dsp.mode === 'output' || dsp.mode === 'adpcm') {
      if (dsp.subSample === 0) {
        const byte = this.dma.transfer(SB_DMA);
        if (byte < 0) return;
        if (dsp.mode === 'output') dsp.dac = byte;
        dsp.remaining--;
      }
      dsp.subSample = (dsp.subSample + 1) % dsp.samplesPerByte;
      if (dsp.subSample !== 0) return;
    } else if (dsp.mode === 'input') {
      if (this.dma.transfer(SB_DMA, 0x80) < 0) return;
      dsp.remaining--;
    } else {
      dsp.remaining--;
    }
    if (dsp.remaining > 0) return;
    this.interrupt();
    if (dsp.autoInit) dsp.remaining = dsp.blockSize;
    else dsp.mode = null;
  }

  // ------------------------------------------------------------ il tempo

  /**
   * Manda avanti la scheda di un certo numero di cicli del processore: il chip
   * FM calcola i suoi campioni, il DSP prende i suoi dal DMA, e in fondo esce
   * il suono alla velocità che vuole chi ascolta.
   */
  advance(cycles) {
    const seconds = cycles / this.clock;

    this.oplTime += seconds * OPL_RATE;
    while (this.oplTime >= 1) {
      this.oplTime -= 1;
      const value = this.opl.sample();
      this.fmSum += value;
      this.fmCount++;
    }

    const dsp = this.dsp;
    if (dsp.mode && !dsp.paused) {
      dsp.time += seconds * dsp.rate;
      while (dsp.time >= 1 && dsp.mode) {
        dsp.time -= 1;
        this.step();
      }
    }

    this.hostTime += seconds * this.sampleRate;
    while (this.hostTime >= 1) {
      this.hostTime -= 1;
      // Il chip FM corre più veloce di chi ascolta: la media dei suoi campioni
      // nell'intervallo, che è quello che farebbe un filtro.
      if (this.fmCount) {
        this.fmLast = this.fmSum / this.fmCount;
        this.fmSum = 0;
        this.fmCount = 0;
      }
      const voice = dsp.speaker ? ((dsp.dac - 128) / 128) * DSP_GAIN : 0;
      let sample = voice + (this.fmLast / 32768) * FM_GAIN;
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      if (this.count < this.buffer.length) this.buffer[this.count++] = sample;
    }
  }

  /** I campioni pronti, e da qui in poi non più della scheda. */
  takeSamples() {
    const samples = this.buffer.slice(0, this.count);
    this.count = 0;
    return samples;
  }
}
