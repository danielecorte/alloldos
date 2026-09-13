// L'MC146818: l'orologio che non si spegne, e i cento byte che si ricordano.
//
// È il chip più domestico di tutto il PC. Dentro ci sono due cose senza niente in
// comune, messe insieme solo perché condividevano la batteria: un **orologio** che
// conta secondi, minuti, ore e giorni anche a macchina spenta, e **centoventotto
// byte di memoria** che sopravvivono allo spegnimento. In quei byte c'è la
// configurazione della macchina — quanti dischi, quanta memoria, da dove partire —
// e per chiunque abbia avuto un PC negli anni Novanta questa è "il setup del
// BIOS", e la batteria che si scarica è l'orologio che torna al 1980.
//
// Il modo di parlargli è di due porte: nella 70h si scrive *quale* byte si vuole,
// nella 71h si legge o si scrive quel byte. Il bit alto della 70h, per un incidente
// storico che è rimasto, è anche l'interruttore delle interruzioni non mascherabili.
//
// Qui l'orologio dice l'ora vera del computer che sta eseguendo l'emulatore: è la
// stessa cosa che faceva la batteria, e chi accende la macchina si aspetta che il
// DOS sappia che giorno è.

/** Le due porte, e i registri che contano. */
export const CMOS_INDEX = 0x70;
export const CMOS_DATA = 0x71;

export const REG_SECONDS = 0x00;
export const REG_MINUTES = 0x02;
export const REG_HOURS = 0x04;
export const REG_WEEKDAY = 0x06;
export const REG_DAY = 0x07;
export const REG_MONTH = 0x08;
export const REG_YEAR = 0x09;
export const REG_STATUS_A = 0x0a;
export const REG_STATUS_B = 0x0b;
export const REG_STATUS_C = 0x0c;
export const REG_STATUS_D = 0x0d;
export const REG_CENTURY = 0x32;

export class CMOS {
  /**
   * @param {object} [options]
   * @param {number} [options.ram] quanti byte di memoria ha la macchina
   * @param {()=>Date} [options.now] che ora è
   */
  constructor({ ram = 32 * 1024 * 1024, now = () => new Date() } = {}) {
    this.now = now;
    this.bytes = new Uint8Array(128);
    this.index = 0;
    /** Il bit alto della porta dell'indice, che è l'interruttore delle NMI. */
    this.nmiDisabled = true;
    this.describe(ram);
  }

  /**
   * Quello che il firmware si aspetta di trovare scritto qui dentro, e che su una
   * macchina vera ci aveva scritto il setup del BIOS.
   *
   * La misura della memoria è la voce che conta più di tutte, ed è raccontata in
   * tre pezzi per una ragione archeologica: i primi 640 KB in un posto, i mega
   * dal primo al sedicesimo in un altro, e tutto quello che sta sopra i sedici
   * mega in un terzo, contato in blocchi da 64 KB. Ogni volta che la memoria dei
   * PC ha sfondato un limite, hanno aggiunto due byte da un'altra parte invece di
   * cambiare quelli di prima — che è la storia di questa architettura in un byte.
   */
  describe(ram) {
    const base = Math.min(ram, 640 * 1024) / 1024;
    this.bytes[0x15] = base & 0xff;
    this.bytes[0x16] = (base >> 8) & 0xff;

    const extended = Math.min(Math.max(ram - 1024 * 1024, 0), 15 * 1024 * 1024) / 1024;
    this.bytes[0x17] = extended & 0xff;
    this.bytes[0x18] = (extended >> 8) & 0xff;
    this.bytes[0x30] = extended & 0xff;
    this.bytes[0x31] = (extended >> 8) & 0xff;

    const above16 = Math.max(ram - 16 * 1024 * 1024, 0) / (64 * 1024);
    this.bytes[0x34] = above16 & 0xff;
    this.bytes[0x35] = (above16 >> 8) & 0xff;

    // Lo stato dell'orologio: la base dei tempi a 32 kHz e il divisore giusto,
    // l'ora in binario e in formato ventiquattro ore, la batteria buona.
    this.bytes[REG_STATUS_A] = 0x26;
    this.bytes[REG_STATUS_B] = 0x02 | 0x04;
    this.bytes[REG_STATUS_D] = 0x80;

    // Che macchina è: un lettore di dischetti da 1,44, un disco fisso da
    // dichiarare nel modo nuovo (tipo 47, "come dice il disco"), e lo schermo.
    this.bytes[0x10] = 0x40;
    this.bytes[0x12] = 0xf0;
    this.bytes[0x19] = 47;
    this.bytes[0x14] = 0x05; // lettore presente, schermo VGA
    // Da dove provare a partire, in ordine: dischetto, disco fisso, CD.
    this.bytes[0x38] = 0x00;
    this.bytes[0x3d] = 0x12;
    this.bytes[0x5f] = 0x00; // un processore solo
  }

  /** Il byte dell'ora che il chip mostrerebbe adesso. */
  clock(register) {
    const date = this.now();
    const binary = (this.bytes[REG_STATUS_B] & 0x04) !== 0;
    const value = {
      [REG_SECONDS]: date.getSeconds(),
      [REG_MINUTES]: date.getMinutes(),
      [REG_HOURS]: date.getHours(),
      [REG_WEEKDAY]: date.getDay() + 1,
      [REG_DAY]: date.getDate(),
      [REG_MONTH]: date.getMonth() + 1,
      [REG_YEAR]: date.getFullYear() % 100,
      [REG_CENTURY]: Math.floor(date.getFullYear() / 100),
    }[register];
    // In decimale codificato in binario, che è come nascono gli orologi: ogni
    // cifra in mezzo byte, perché così si mandavano direttamente a un display.
    return binary ? value : ((value / 10) << 4) | value % 10;
  }

  read(port) {
    if ((port & 1) === 0) return 0xff; // la porta dell'indice non si rilegge
    const at = this.index & 0x7f;
    if ([REG_SECONDS, REG_MINUTES, REG_HOURS, REG_WEEKDAY, REG_DAY, REG_MONTH, REG_YEAR, REG_CENTURY].includes(at)) {
      return this.clock(at);
    }
    if (at === REG_STATUS_A) {
      // Il bit 7 dice "sto aggiornando l'ora, non leggere adesso". Qui l'ora non
      // si aggiorna mai a metà — la si calcola al momento — e quindi il bit resta
      // spento: chi aspetta che passi non aspetta.
      return this.bytes[REG_STATUS_A] & 0x7f;
    }
    if (at === REG_STATUS_C) {
      const value = this.bytes[REG_STATUS_C];
      this.bytes[REG_STATUS_C] = 0; // leggendolo si azzera, ed è così che si ringrazia
      return value;
    }
    return this.bytes[at];
  }

  write(port, value) {
    if ((port & 1) === 0) {
      this.index = value & 0x7f;
      this.nmiDisabled = (value & 0x80) !== 0;
      return;
    }
    const at = this.index & 0x7f;
    if (at === REG_STATUS_C || at === REG_STATUS_D) return; // di sola lettura
    this.bytes[at] = value & 0xff;
  }
}
