// L'OPL2, cioè lo Yamaha YM3812: la musica di tutti i giochi del DOS.
//
// Nel 1987 la AdLib mette su una scheda un chip che Yamaha aveva fatto per le
// tastiere elettroniche, e due anni dopo la Sound Blaster se lo porta dietro
// uguale, alle stesse porte. Da lì in poi ogni gioco per il DOS ha la sua
// colonna sonora scritta per questo chip, e quel suono — un po' metallico, un
// po' organo, con i bassi che schioccano — è il suono del PC di quegli anni.
//
// Non è un campionatore: non suona registrazioni, le calcola. Ha nove voci, e
// ogni voce sono due **operatori**, cioè due oscillatori sinusoidali con un
// inviluppo ciascuno. Il trucco che dà il nome alla tecnica, la **modulazione
// di frequenza**, è che l'uscita del primo operatore non si sente: si somma
// alla fase del secondo. Una sinusoide che fa oscillare la fase di un'altra
// sinusoide produce armoniche, tante quante ne vuole l'inviluppo del primo, e
// così con due oscillatori e sei numeri si fanno un clarinetto, una campana o
// un basso elettrico. Con un bit si può invece farli suonare tutti e due in
// parallelo, e allora è un organo.
//
// Il chip non fa i conti come li farebbe un calcolatore: non moltiplica mai.
// Tiene le ampiezze in **logaritmo**: una tabella dà il logaritmo di un quarto
// di sinusoide, l'inviluppo e il volume sono attenuazioni che al logaritmo si
// sommano, e una seconda tabella riporta il risultato indietro con un
// esponenziale. È per questo che il volume va a scalini di tre quarti di
// decibel e che le note si spengono con quella coda lunga: dentro, il silenzio
// è un numero che cresce.
//
// Qui le tabelle sono quelle che il chip ha davvero, ricavate dalla fotografia
// del silicio da chi l'ha studiato; il resto — i tempi degli inviluppi, la
// batteria, i due contatori — segue il manuale di Yamaha.

/** Il quarzo della scheda diviso 288: il chip calcola 49716 campioni al secondo. */
export const OPL_RATE = 14318180 / 288;
const SAMPLE_US = 1e6 / OPL_RATE;

/** Il moltiplicatore della frequenza di ogni operatore, raddoppiato: 0 vuol dire un mezzo. */
const MULT = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];

/** Quanto si abbassa il volume salendo di ottava, se lo si chiede: la tabella del chip. */
const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [8, 1, 2, 0];

/**
 * Le due tabelle. LOGSIN è il logaritmo (in 1/256 di ottava) di un quarto di
 * sinusoide; EXP riporta indietro. Il chip ha solo un quarto d'onda: il resto
 * lo fa girando l'indice e cambiando segno.
 */
const LOGSIN = new Uint16Array(256);
const EXP = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  LOGSIN[i] = Math.round(-Math.log2(Math.sin(((i + 0.5) * Math.PI) / 512)) * 256);
  EXP[i] = Math.round(2 ** ((255 - i) / 256) * 1024);
}

/** Da livello logaritmico ad ampiezza: il pezzo che nel chip sta al posto del moltiplicatore. */
function exp(level) {
  if (level > 0x1fff) return 0;
  return (EXP[level & 0xff] << 1) >> (level >> 8);
}

/**
 * Le quattro forme d'onda. Sono tutte pezzi della stessa sinusoide: intera,
 * solo la metà positiva, la metà positiva due volte, e i quarti che salgono.
 * Abbastanza per passare da un flauto a un violino con un registro.
 */
function waveform(wave, phase, attenuation) {
  const level = attenuation << 3;
  const index = phase & 0xff;
  switch (wave) {
    case 0: {
      const out = exp(LOGSIN[phase & 0x100 ? index ^ 0xff : index] + level);
      return phase & 0x200 ? -out : out;
    }
    case 1:
      return phase & 0x200 ? 0 : exp(LOGSIN[phase & 0x100 ? index ^ 0xff : index] + level);
    case 2:
      return exp(LOGSIN[phase & 0x100 ? index ^ 0xff : index] + level);
    default:
      return phase & 0x100 ? 0 : exp(LOGSIN[index] + level);
  }
}

/** Le quattro fasi di un inviluppo, e il silenzio. */
const ATTACK = 0;
const DECAY = 1;
const SUSTAIN = 2;
const RELEASE = 3;

/** L'attenuazione massima: 511 passi da tre sedicesimi di decibel, cioè 96 dB. */
const SILENT = 511;

/**
 * Da scostamento nei registri a operatore. Le 22 posizioni di ogni blocco di
 * registri servono 18 operatori, e le quattro che avanzano non portano a
 * niente: è il modo in cui il chip divide in tre gruppi le sue voci.
 */
const SLOT_OF = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];

/** I due operatori di ogni voce: il primo modula, il secondo si sente. */
const FIRST_SLOT = [0, 1, 2, 6, 7, 8, 12, 13, 14];

/** Chi è chi nella batteria: le ultime tre voci diventano cinque strumenti. */
const HIHAT = 13;
const TOM = 14;
const SNARE = 16;
const CYMBAL = 17;

const KEY_CHANNEL = 1;
const KEY_RHYTHM = 2;

class Operator {
  constructor(index) {
    this.index = index;
    this.channel = null;
    this.reset();
  }

  reset() {
    this.am = false;
    this.vib = false;
    this.egt = false;
    this.ksr = false;
    this.mult = 0;
    this.ksl = 0;
    this.tl = 0;
    this.ar = 0;
    this.dr = 0;
    this.sl = 0;
    this.rr = 0;
    this.wave = 0;
    this.phase = 0;
    this.phaseOut = 0;
    this.env = SILENT;
    this.state = RELEASE;
    this.egAcc = 0;
    this.key = 0;
    this.out = 0;
    this.prev = 0;
    this.feedback = 0;
    /** Quanto il tasto premuto accorcia gli inviluppi: più alta la nota, più corti. */
    this.rateOffset = 0;
    this.kslAttenuation = 0;
    this.attenuation = SILENT;
  }

  /** Il livello di sostegno in passi dell'inviluppo: tre decibel l'uno, e 15 vuol dire tutto. */
  get sustainLevel() {
    return this.sl === 15 ? SILENT : this.sl << 4;
  }

  /**
   * La velocità effettiva di una fase. Il registro ne dà sedici, il chip ne
   * conta sessantaquattro: ogni passo del registro vale quattro, e la nota
   * suonata ne aggiunge fino a quindici — le note alte si spengono prima, come
   * su uno strumento vero.
   */
  rate(value) {
    if (value === 0) return 0;
    return Math.min(63, value * 4 + this.rateOffset);
  }

  /**
   * Quanti passi fa l'inviluppo in questo campione. Ogni quattro gradini di
   * velocità il tempo si dimezza, e i due bit bassi fanno i quarti in mezzo:
   * alla più lenta, novantasei decibel ci mettono quaranta secondi; alla più
   * veloce, un paio di millesimi.
   */
  steps(rate) {
    if (rate === 0) return 0;
    this.egAcc += (4 + (rate & 3)) << (rate >> 2);
    const steps = this.egAcc >> 15;
    this.egAcc &= 0x7fff;
    return steps;
  }

  keyOn() {
    this.phase = 0;
    this.state = ATTACK;
    if (this.rate(this.ar) >= 60) {
      this.env = 0;
      this.state = DECAY;
    }
  }

  keyOff() {
    this.state = RELEASE;
  }

  setKey(bit, on) {
    const was = this.key;
    this.key = on ? was | bit : was & ~bit;
    if (!was && this.key) this.keyOn();
    else if (was && !this.key) this.keyOff();
  }

  /** L'inviluppo, un campione avanti. */
  envelope() {
    switch (this.state) {
      case ATTACK: {
        const rate = this.rate(this.ar);
        if (rate >= 60) {
          this.env = 0;
        } else {
          // L'attacco non sale a gradini uguali: ogni passo toglie un ottavo di
          // quello che manca. È una curva esponenziale fatta con uno shift.
          for (let n = this.steps(rate); n > 0 && this.env > 0; n--) this.env -= (this.env >> 3) + 1;
          if (this.env < 0) this.env = 0;
        }
        if (this.env === 0) this.state = this.sustainLevel === 0 ? SUSTAIN : DECAY;
        break;
      }
      case DECAY: {
        this.env += this.steps(this.rate(this.dr));
        const level = this.sustainLevel;
        if (this.env >= level) {
          this.env = level;
          this.state = SUSTAIN;
        }
        break;
      }
      case SUSTAIN:
        // Con il bit EGT la nota resta dove è arrivata finché il tasto è giù;
        // senza, continua a spegnersi come se l'avessero lasciato — che è come
        // si fa un pianoforte o una chitarra.
        if (!this.egt) this.env = Math.min(SILENT, this.env + this.steps(this.rate(this.rr)));
        break;
      default:
        this.env = Math.min(SILENT, this.env + this.steps(this.rate(this.rr)));
    }
  }
}

class Channel {
  constructor(index) {
    this.index = index;
    this.reset();
  }

  reset() {
    this.fnum = 0;
    this.block = 0;
    this.on = false;
    this.fb = 0;
    this.additive = false;
  }
}

export class OPL2 {
  constructor() {
    this.operators = Array.from({ length: 18 }, (_, i) => new Operator(i));
    this.channels = Array.from({ length: 9 }, (_, i) => new Channel(i));
    for (let c = 0; c < 9; c++) {
      this.operators[FIRST_SLOT[c]].channel = this.channels[c];
      this.operators[FIRST_SLOT[c] + 3].channel = this.channels[c];
    }
    this.reset();
  }

  reset() {
    for (const op of this.operators) op.reset();
    for (const channel of this.channels) channel.reset();
    this.registers = new Uint8Array(256);
    this.address = 0;
    this.waveSelect = false;
    this.nts = false;
    this.rhythm = false;
    this.rhythmKeys = 0;
    this.deepTremolo = false;
    this.deepVibrato = false;
    this.samples = 0;
    this.tremoloPos = 0;
    this.tremolo = 0;
    this.vibratoPos = 0;
    this.noise = 1;
    this.timers = [
      { reload: 0, counter: 0, running: false, masked: false, flag: false, period: 80, time: 0 },
      { reload: 0, counter: 0, running: false, masked: false, flag: false, period: 320, time: 0 },
    ];
  }

  // ------------------------------------------------------------ le porte

  /**
   * Il registro di stato: il bit 7 dice che uno dei contatori è scaduto, i due
   * sotto quale. È l'unica cosa che il chip lascia leggere, ed è su quella che
   * ogni gioco scopriva se c'era una AdLib: fa partire un contatore, aspetta un
   * po', e guarda se il bit si è acceso. I tre bit in fondo sono sempre 110 su
   * un OPL2, ed è il modo in cui si distingue dal suo successore.
   */
  get status() {
    const [t1, t2] = this.timers;
    return (t1.flag || t2.flag ? 0x80 : 0) | (t1.flag ? 0x40 : 0) | (t2.flag ? 0x20 : 0) | 0x06;
  }

  /** Due porte: nella prima si dice quale registro, nella seconda cosa metterci. */
  writeAddress(value) {
    this.address = value & 0xff;
  }

  writeData(value) {
    this.write(this.address, value);
  }

  write(register, value) {
    register &= 0xff;
    value &= 0xff;
    this.registers[register] = value;
    const group = register & 0xe0;

    if (register === 0x01) {
      this.waveSelect = (value & 0x20) !== 0;
      return;
    }
    if (register === 0x02 || register === 0x03) {
      this.timers[register - 2].reload = value;
      return;
    }
    if (register === 0x04) {
      // Il bit 7 spegne le bandierine e basta; senza, gli altri dicono quali
      // contatori mascherare e quali far partire.
      if (value & 0x80) {
        for (const timer of this.timers) timer.flag = false;
        return;
      }
      const [t1, t2] = this.timers;
      t1.masked = (value & 0x40) !== 0;
      t2.masked = (value & 0x20) !== 0;
      for (const [timer, bit] of [[t1, 0x01], [t2, 0x02]]) {
        const start = (value & bit) !== 0;
        if (start && !timer.running) timer.counter = timer.reload;
        timer.running = start;
      }
      return;
    }
    if (register === 0x08) {
      this.nts = (value & 0x40) !== 0;
      for (const channel of this.channels) this.updateChannel(channel);
      return;
    }
    if (register === 0xbd) {
      this.deepTremolo = (value & 0x80) !== 0;
      this.deepVibrato = (value & 0x40) !== 0;
      this.rhythm = (value & 0x20) !== 0;
      this.rhythmKeys = this.rhythm ? value & 0x1f : 0;
      const keys = this.rhythmKeys;
      const ops = this.operators;
      ops[12].setKey(KEY_RHYTHM, (keys & 0x10) !== 0);
      ops[15].setKey(KEY_RHYTHM, (keys & 0x10) !== 0);
      ops[SNARE].setKey(KEY_RHYTHM, (keys & 0x08) !== 0);
      ops[TOM].setKey(KEY_RHYTHM, (keys & 0x04) !== 0);
      ops[CYMBAL].setKey(KEY_RHYTHM, (keys & 0x02) !== 0);
      ops[HIHAT].setKey(KEY_RHYTHM, (keys & 0x01) !== 0);
      return;
    }

    if (group >= 0x20 && group <= 0x80 || group === 0xe0) {
      const slot = SLOT_OF[register & 0x1f];
      if (slot === undefined || slot < 0) return;
      const op = this.operators[slot];
      switch (group) {
        case 0x20:
          op.am = (value & 0x80) !== 0;
          op.vib = (value & 0x40) !== 0;
          op.egt = (value & 0x20) !== 0;
          op.ksr = (value & 0x10) !== 0;
          op.mult = value & 0x0f;
          break;
        case 0x40:
          op.ksl = value >> 6;
          op.tl = value & 0x3f;
          break;
        case 0x60:
          op.ar = value >> 4;
          op.dr = value & 0x0f;
          break;
        case 0x80:
          op.sl = value >> 4;
          op.rr = value & 0x0f;
          break;
        default:
          op.wave = value & 3;
      }
      this.updateChannel(op.channel);
      return;
    }

    const c = register & 0x0f;
    if (c > 8) return;
    const channel = this.channels[c];
    if (group === 0xa0 && register < 0xb0) {
      channel.fnum = (channel.fnum & 0x300) | value;
      this.updateChannel(channel);
    } else if (register >= 0xb0 && register <= 0xb8) {
      channel.fnum = (channel.fnum & 0xff) | ((value & 3) << 8);
      channel.block = (value >> 2) & 7;
      channel.on = (value & 0x20) !== 0;
      this.updateChannel(channel);
      this.operators[FIRST_SLOT[c]].setKey(KEY_CHANNEL, channel.on);
      this.operators[FIRST_SLOT[c] + 3].setKey(KEY_CHANNEL, channel.on);
    } else if (register >= 0xc0 && register <= 0xc8) {
      channel.fb = (value >> 1) & 7;
      channel.additive = (value & 1) !== 0;
    }
  }

  /** Quello che dipende dalla nota: quanto accorciare gli inviluppi e quanto abbassare il volume. */
  updateChannel(channel) {
    const keyCode = (channel.block << 1) | ((channel.fnum >> (this.nts ? 8 : 9)) & 1);
    let ksl = (KSL_ROM[channel.fnum >> 6] << 2) - ((8 - channel.block) << 5);
    if (ksl < 0) ksl = 0;
    const first = FIRST_SLOT[channel.index];
    for (const op of [this.operators[first], this.operators[first + 3]]) {
      op.rateOffset = op.ksr ? keyCode : keyCode >> 2;
      op.kslAttenuation = ksl >> KSL_SHIFT[op.ksl];
    }
  }

  // ------------------------------------------------------------ il tempo

  /** I due contatori: uno scatta ogni 80 microsecondi, l'altro ogni 320. */
  clockTimers() {
    for (const timer of this.timers) {
      timer.time += SAMPLE_US;
      while (timer.time >= timer.period) {
        timer.time -= timer.period;
        if (!timer.running) continue;
        timer.counter = (timer.counter + 1) & 0xff;
        if (timer.counter === 0) {
          timer.counter = timer.reload;
          if (!timer.masked) timer.flag = true;
        }
      }
    }
  }

  /** Se tutte le voci tacciono: allora non c'è niente da calcolare, solo il tempo che passa. */
  get idle() {
    for (const op of this.operators) {
      if (op.key || op.env < SILENT) return false;
    }
    return true;
  }

  /**
   * Un campione, cioè un quarantanovemillesimo di secondo.
   * @returns {number} la somma delle nove voci, fra -32768 e 32767 come la manda il chip
   */
  sample() {
    this.clockTimers();
    this.samples++;
    // Il tremolo e il vibrato, due oscillatori lenti che il chip ha una volta
    // sola e che gli operatori usano o no: 3,7 e 6,1 volte al secondo.
    if ((this.samples & 63) === 0) this.tremoloPos = (this.tremoloPos + 1) % 210;
    const tremoloShift = this.deepTremolo ? 2 : 4;
    this.tremolo = (this.tremoloPos < 105 ? this.tremoloPos : 210 - this.tremoloPos) >> tremoloShift;
    if ((this.samples & 1023) === 0) this.vibratoPos = (this.vibratoPos + 1) & 7;
    // Il rumore della batteria: un registro a scorrimento di ventitré bit.
    const bit = ((this.noise >> 14) ^ this.noise) & 1;
    this.noise = (this.noise >> 1) | (bit << 22);

    if (this.idle) return 0;

    const ops = this.operators;
    for (const op of ops) {
      op.envelope();
      let attenuation = op.env + (op.tl << 2) + op.kslAttenuation + (op.am ? this.tremolo : 0);
      if (attenuation > SILENT) attenuation = SILENT;
      op.attenuation = attenuation;
      // La fase, con il vibrato che sposta la frequenza di qualche centesimo.
      const channel = op.channel;
      let fnum = channel.fnum;
      if (op.vib) {
        let range = (fnum >> 7) & 7;
        const pos = this.vibratoPos;
        if (!(pos & 3)) range = 0;
        else if (pos & 1) range >>= 1;
        if (!this.deepVibrato) range >>= 1;
        fnum += pos & 4 ? -range : range;
      }
      op.phaseOut = op.phase >> 9;
      op.phase = (op.phase + ((((fnum << channel.block) >> 1) * MULT[op.mult]) >> 1)) & 0x7ffff;
    }

    if (this.rhythm) {
      // La batteria non ha note: il charleston, il rullante e il piatto
      // prendono la fase da un miscuglio di bit di due oscillatori e del rumore,
      // che è il modo in cui un chip senza campioni fa qualcosa che assomiglia
      // a un colpo di spazzola.
      const hh = ops[HIHAT].phaseOut;
      const tc = ops[CYMBAL].phaseOut;
      const hh2 = (hh >> 2) & 1;
      const hh3 = (hh >> 3) & 1;
      const hh7 = (hh >> 7) & 1;
      const hh8 = (hh >> 8) & 1;
      const tc3 = (tc >> 3) & 1;
      const tc5 = (tc >> 5) & 1;
      const noise = this.noise & 1;
      const mix = (hh2 ^ hh7) | (hh3 ^ tc5) | (tc3 ^ tc5);
      ops[HIHAT].phaseOut = (mix << 9) | ((mix ^ noise) ? 0xd0 : 0x34);
      ops[SNARE].phaseOut = (hh8 << 9) | ((hh8 ^ noise) << 8);
      ops[CYMBAL].phaseOut = (mix << 9) | 0x80;
    }

    let sum = 0;
    const last = this.rhythm ? 6 : 9;
    for (let c = 0; c < last; c++) {
      const channel = this.channels[c];
      const first = ops[FIRST_SLOT[c]];
      const second = ops[FIRST_SLOT[c] + 3];
      const a = this.operate(first, channel.fb ? (first.out + first.prev) >> (9 - channel.fb) : 0, true);
      const b = this.operate(second, channel.additive ? 0 : a, false);
      sum += channel.additive ? a + b : b;
    }
    if (this.rhythm) {
      // La cassa è una voce normale che si sente due volte più forte; gli
      // altri quattro strumenti sono operatori soli, senza modulazione.
      const bass = this.channels[6];
      const first = ops[12];
      const a = this.operate(first, bass.fb ? (first.out + first.prev) >> (9 - bass.fb) : 0, true);
      const b = this.operate(ops[15], bass.additive ? 0 : a, false);
      sum += 2 * b;
      sum += 2 * (this.operate(ops[HIHAT], 0, false) + this.operate(ops[SNARE], 0, false));
      sum += 2 * (this.operate(ops[TOM], 0, false) + this.operate(ops[CYMBAL], 0, false));
    }
    return sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
  }

  /** Un operatore: la sua forma d'onda alla sua fase, spostata dalla modulazione. */
  operate(op, modulation, modulator) {
    if (modulator) op.prev = op.out;
    const wave = this.waveSelect ? op.wave : 0;
    op.out = op.attenuation >= SILENT ? 0 : waveform(wave, (op.phaseOut + modulation) & 0x3ff, op.attenuation);
    return op.out;
  }
}
