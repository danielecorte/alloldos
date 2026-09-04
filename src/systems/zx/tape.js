// Il registratore, che sullo Spectrum non è un accessorio: è l'unità a dischi.
//
// Nel cavo dell'EAR arriva un suono, e il suono è tutto. Non c'è nessun
// formato di file, nessun settore, nessun indice: c'è un'onda quadra, e il
// programma di caricamento che sta nella ROM misura quanto dura ogni mezza
// onda contando i cicli del processore. Se la mezza onda è lunga è un uno, se
// è corta è uno zero, e otto di quelli fanno un byte. Tutto qui.
//
// Il tono di guida — quel fischio continuo di cinque secondi prima di ogni
// blocco — serve a due cose: dare tempo al motore del registratore di
// arrivare a velocità, e far capire alla ROM che quello che sta arrivando è
// un segnale e non rumore. Poi due impulsi più corti dicono "adesso comincia",
// e da lì in poi sono bit.
//
// Un file `.tap` non contiene quel suono: contiene i byte, e le durate sono
// quelle standard della ROM. Quindi qui il suono non viene interpretato,
// viene **rifatto**: si generano gli impulsi con i tempi esatti che avrebbe
// avuto la cassetta, e la ROM li misura come misurava quelli veri. È il
// motivo per cui non c'è niente da capire di sbagliato — nessuno qui legge i
// byte del nastro, li legge lo Spectrum.

/** Le durate standard, in T-state, come le fa la routine SA-BYTES della ROM. */
export const PILOT_PULSE = 2168;
export const PILOT_HEADER = 8063; // impulsi di guida prima di un'intestazione
export const PILOT_DATA = 3223; //   e prima di un blocco di dati
export const SYNC_FIRST = 667;
export const SYNC_SECOND = 735;
export const BIT_ZERO = 855;
export const BIT_ONE = 1710;
/** La pausa fra un blocco e il successivo: un secondo, come sulla cassetta. */
export const BLOCK_PAUSE = 3500000;

export class TAPFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TAPFormatError';
  }
}

/**
 * I blocchi dentro un `.tap`: due byte di lunghezza e poi quei byte.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array[]}
 */
export function parseTAP(bytes) {
  const blocks = [];
  let at = 0;
  while (at + 2 <= bytes.length) {
    const length = bytes[at] | (bytes[at + 1] << 8);
    at += 2;
    if (length === 0) continue;
    if (at + length > bytes.length) throw new TAPFormatError('un blocco finisce fuori dal file');
    blocks.push(bytes.subarray(at, at + length));
    at += length;
  }
  if (blocks.length === 0) throw new TAPFormatError('non c\'è nessun blocco qui dentro');
  return blocks;
}

/**
 * Il nome che sta scritto nell'intestazione di un blocco, se è
 * un'intestazione: byte di tipo 0, poi il genere, poi dieci caratteri.
 * @param {Uint8Array[]} blocks
 */
export function tapeName(blocks) {
  for (const block of blocks) {
    if (block.length === 19 && block[0] === 0x00) {
      let name = '';
      for (let i = 2; i < 12; i++) name += String.fromCharCode(block[i]);
      return name.trim();
    }
  }
  return '';
}

export class Tape {
  /**
   * @param {Uint8Array[]} blocks
   * @param {string} [label]
   */
  constructor(blocks, label = '') {
    this.blocks = blocks;
    this.label = label;
    this.reset();
  }

  reset() {
    this.playing = false;
    /** Il livello sul filo dell'EAR adesso. */
    this.level = 0;
    this.block = 0;
    /** A che punto siamo dentro il blocco: guida, sincronismo, byte, pausa. */
    this.phase = 'pilot';
    this.pulses = 0;
    this.byte = 0;
    this.bit = 0;
    this.half = 0;
    /** Quando cade il prossimo fronte, in T-state assoluti della macchina. */
    this.nextEdge = 0;
    this.startedAt = 0;
  }

  play(now) {
    if (this.finished) this.rewind();
    this.playing = true;
    this.startedAt = now;
    this.nextEdge = now;
    this.phase = 'pilot';
    this.pulses = 0;
    this.level = 0;
  }

  stop() {
    this.playing = false;
  }

  rewind() {
    const playing = this.playing;
    this.reset();
    this.playing = playing;
  }

  get finished() {
    return this.block >= this.blocks.length;
  }

  /** Quanti blocchi sono già passati, per dire a che punto è. */
  get progress() {
    return this.blocks.length ? Math.min(1, this.block / this.blocks.length) : 1;
  }

  /**
   * Il livello sul filo dell'EAR all'istante `t`, in T-state assoluti.
   *
   * Gli impulsi non si generano tutti in anticipo — un gioco da 48 KB sono
   * ottocentomila fronti — ma uno alla volta, avanzando fin dove serve. Chi
   * chiede il livello lo chiede sempre in avanti nel tempo, ed è l'unica cosa
   * che serve perché il conto stia in piedi.
   *
   * @param {number} t
   * @returns {number} 0 o 1
   */
  levelAt(t) {
    if (!this.playing) return 0;
    let guard = 0;
    while (t >= this.nextEdge && !this.finished && guard++ < 100000) {
      this.advance();
    }
    return this.level;
  }

  /** Il fronte successivo: quanto dura, e cosa viene dopo. */
  advance() {
    const block = this.blocks[this.block];
    if (!block) return;

    switch (this.phase) {
      case 'pilot': {
        const total = block[0] < 128 ? PILOT_HEADER : PILOT_DATA;
        this.level ^= 1;
        this.nextEdge += PILOT_PULSE;
        this.pulses++;
        if (this.pulses >= total) {
          this.phase = 'sync1';
        }
        return;
      }
      case 'sync1':
        this.level ^= 1;
        this.nextEdge += SYNC_FIRST;
        this.phase = 'sync2';
        return;
      case 'sync2':
        this.level ^= 1;
        this.nextEdge += SYNC_SECOND;
        this.phase = 'data';
        this.byte = 0;
        this.bit = 0;
        this.half = 0;
        return;
      case 'data': {
        // Ogni bit sono due mezze onde della stessa lunghezza: lunga per uno,
        // corta per zero. È l'unica differenza fra i due, e il caricamento
        // non fa altro che misurarla.
        const value = block[this.byte];
        const one = (value >> (7 - this.bit)) & 1;
        this.level ^= 1;
        this.nextEdge += one ? BIT_ONE : BIT_ZERO;
        this.half++;
        if (this.half === 2) {
          this.half = 0;
          this.bit++;
          if (this.bit === 8) {
            this.bit = 0;
            this.byte++;
            if (this.byte >= block.length) this.phase = 'pause';
          }
        }
        return;
      }
      default: // pausa fra un blocco e l'altro: filo fermo
        this.level = 0;
        this.nextEdge += BLOCK_PAUSE;
        this.block++;
        this.phase = 'pilot';
        this.pulses = 0;
    }
  }
}

/**
 * Rimette insieme un `.tap` dai blocchi, per chi vuole riportarsi via quello
 * che ha registrato.
 * @param {Uint8Array[]} blocks
 */
export function encodeTAP(blocks) {
  let length = 0;
  for (const block of blocks) length += block.length + 2;
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const block of blocks) {
    bytes[at++] = block.length & 0xff;
    bytes[at++] = (block.length >> 8) & 0xff;
    bytes.set(block, at);
    at += block.length;
  }
  return bytes;
}
