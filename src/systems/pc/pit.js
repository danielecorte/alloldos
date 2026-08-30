// L'8253, tre contatori che contano all'indietro.
//
// Un solo quarzo da 1,193 MHz — un dodicesimo dei 14,318 MHz che sull'XT
// facevano anche il colore e il processore — entra in tre contatori a sedici
// bit, e ognuno dei tre ha avuto un mestiere fisso per vent'anni:
//
//   - il canale 0 batte il tempo. Caricato con 65536, esce a 18,2 Hz: è la IRQ
//     0, il tic del BIOS, il motivo per cui l'orologio del DOS avanza a scatti
//     di cinquantacinque millesimi e per cui il tempo di gioco di mezza
//     generazione di giochi è multiplo di quel numero.
//   - il canale 1 chiede il rinfresco della memoria dinamica ogni quindici
//     microsecondi. Non lo si tocca: chi lo fermava vedeva la macchina
//     dimenticarsi di sé stessa in pochi millisecondi.
//   - il canale 2 va all'altoparlante. È l'unico suono che questa macchina ha
//     di suo, ed è un'onda quadra: la nota è il divisore, il volume non esiste.
//
// Il modo si sceglie scrivendo una parola di comando sulla porta 43h, e i modi
// che contano sono due: il 2, che manda un impulso ogni N colpi, e il 3, che
// divide a metà e restituisce un'onda quadra. Gli altri esistono, quasi nessuno
// li ha mai usati.

/** Le porte: i tre contatori e la parola di comando. */
export const PIT_CH0 = 0x40;
export const PIT_CTRL = 0x43;

/** Il quarzo, in Hz: 14318180 / 12, e da lì tutto il resto. */
export const PIT_CLOCK = 1193182;

class Counter {
  constructor() {
    this.reset();
  }

  reset() {
    this.mode = 0;
    /** Come si leggono e scrivono i sedici bit: 1 = basso, 2 = alto, 3 = tutti e due. */
    this.access = 3;
    this.reload = 0;
    this.count = 0;
    this.output = 0;
    this.gate = true;
    this.running = false;

    this.writeHigh = false;
    this.readHigh = false;
    this.latched = -1;
  }

  /** Il conteggio pieno: zero vuol dire 65536, che è il giro più lungo. */
  get period() {
    return this.reload === 0 ? 0x10000 : this.reload;
  }

  /**
   * Fa passare `ticks` colpi di quarzo e torna quante volte l'uscita è salita:
   * un impulso nel modo 2, mezza onda nel modo 3, una volta sola nel modo 0.
   */
  advance(ticks) {
    if (!this.running || !this.gate) return 0;
    const period = this.period;
    let edges = 0;

    if (this.mode === 3) {
      // Onda quadra: il contatore scende di due per colpo e a fine corsa
      // ribalta l'uscita. Il fronte che serve al mondo è uno ogni due.
      let count = this.count - ticks * 2;
      while (count <= 0) {
        count += period;
        this.output ^= 1;
        if (this.output) edges++;
      }
      this.count = count;
      return edges;
    }

    if (this.mode === 2 || this.mode === 6) {
      let count = this.count - ticks;
      while (count <= 0) {
        count += period;
        edges++;
      }
      this.count = count;
      this.output = 1;
      return edges;
    }

    // Modi 0, 1, 4, 5: si arriva a zero una volta e l'uscita ci resta.
    let count = this.count - ticks;
    if (count <= 0) {
      if (!this.output) {
        this.output = 1;
        edges = 1;
      }
      count = ((count % 0x10000) + 0x10000) % 0x10000;
    }
    this.count = count;
    return edges;
  }

  /** Il valore che il chip mostrerebbe adesso, latch permettendo. */
  read() {
    const value = this.latched >= 0 ? this.latched : this.count & 0xffff;
    let byte;
    if (this.access === 1) byte = value & 0xff;
    else if (this.access === 2) byte = (value >> 8) & 0xff;
    else {
      byte = this.readHigh ? (value >> 8) & 0xff : value & 0xff;
      this.readHigh = !this.readHigh;
      if (!this.readHigh && this.latched >= 0) this.latched = -1;
      return byte;
    }
    if (this.latched >= 0) this.latched = -1;
    return byte;
  }

  write(value) {
    // Nei modi a un byte solo l'altra metà del contatore è zero, non quella di
    // prima: il BIOS ci conta quando riprogramma il rinfresco con un divisore
    // piccolo dopo averne provato uno grande.
    if (this.access === 1) this.load(value);
    else if (this.access === 2) this.load((value << 8) & 0xffff);
    else if (!this.writeHigh) {
      this.reload = (this.reload & 0xff00) | value;
      this.writeHigh = true;
      // Nel modo 0 la scrittura del byte basso ferma già il conteggio: è così
      // che si evita di far scattare l'uscita con mezzo valore dentro.
      if (this.mode === 0) this.running = false;
    } else {
      this.writeHigh = false;
      this.load(((value << 8) | (this.reload & 0xff)) & 0xffff);
    }
  }

  load(value) {
    this.reload = value & 0xffff;
    this.count = this.period;
    this.running = true;
    this.output = this.mode === 2 || this.mode === 3 ? 1 : 0;
  }

  /** Il comando di latch: la lettura successiva vede il valore di adesso. */
  latch() {
    this.latched = this.count & 0xffff;
    this.readHigh = false;
  }

  configure(access, mode) {
    this.access = access;
    this.mode = mode;
    this.writeHigh = false;
    this.readHigh = false;
    this.latched = -1;
    this.running = false;
    this.output = mode === 2 || mode === 3 ? 1 : 0;
  }
}

export class PIT8253 {
  /**
   * @param {object} hooks
   * @param {(edges:number)=>void} [hooks.onChannel0] il tic di sistema, IRQ 0
   * @param {(edges:number)=>void} [hooks.onChannel1] la richiesta di rinfresco
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.channels = [new Counter(), new Counter(), new Counter()];
    this.reset();
  }

  reset() {
    for (const channel of this.channels) channel.reset();
    // Il canale 2 conta solo se il programma apre il suo cancello, scrivendo
    // sul bit 0 della porta 61h: è quello l'interruttore dell'altoparlante.
    this.channels[2].gate = false;
  }

  /** L'uscita del canale 2, che la PPI mostra e l'altoparlante segue. */
  get speakerOutput() {
    return this.channels[2].output;
  }

  setGate2(open) {
    const channel = this.channels[2];
    if (channel.gate === open) return;
    channel.gate = open;
    if (open) channel.count = channel.period;
  }

  advance(ticks) {
    if (ticks <= 0) return;
    const timer = this.channels[0].advance(ticks);
    if (timer && this.hooks.onChannel0) this.hooks.onChannel0(timer);
    const refresh = this.channels[1].advance(ticks);
    if (refresh && this.hooks.onChannel1) this.hooks.onChannel1(refresh);
    this.channels[2].advance(ticks);
  }

  read(port) {
    const index = port & 3;
    if (index === 3) return 0xff; // la parola di comando non si rilegge
    return this.channels[index].read();
  }

  write(port, value) {
    value &= 0xff;
    const index = port & 3;
    if (index !== 3) {
      this.channels[index].write(value);
      return;
    }

    const select = (value >> 6) & 3;
    if (select === 3) return; // il comando di lettura all'indietro è dell'8254
    const access = (value >> 4) & 3;
    if (access === 0) {
      this.channels[select].latch();
      return;
    }
    this.channels[select].configure(access, (value >> 1) & 7);
  }
}
