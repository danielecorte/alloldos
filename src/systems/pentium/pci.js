// Il bus PCI, cioè il momento in cui le schede smettono di essere ponticelli.
//
// Su un PC del 1988 una scheda stava a un indirizzo perché qualcuno aveva messo
// un ponticello su quell'indirizzo, e due schede con lo stesso ponticello
// litigavano per sempre. Il PCI rovescia il problema: ogni scheda ha
// **duecentocinquantasei byte di configurazione** in cui dichiara chi è — un
// numero di produttore, un numero di modello, di che classe è — e quali finestre
// di indirizzi vorrebbe. È il firmware che poi le assegna, e da questo viene
// tutto quello che negli anni Novanta si è chiamato "plug and play".
//
// Quei byte non stanno nella memoria: ci si arriva da due porte, che sono
// l'ultima cosa in tutto il PCI a essere ancora fatta come nel 1981. Si scrive
// in CF8h *chi* si vuole interrogare — bus, dispositivo, funzione, e quale dei
// 256 byte — e poi si legge o si scrive da CFCh. Due porte, e sotto ci passa
// tutto: le schede video, i dischi, la rete, per trent'anni.

/** Le due porte: l'indirizzo e i dati. */
export const PCI_ADDRESS = 0xcf8;
export const PCI_DATA = 0xcfc;

/** Dove stanno le cose nei primi sessantaquattro byte, che sono uguali per tutti. */
export const VENDOR_ID = 0x00;
export const DEVICE_ID = 0x02;
export const COMMAND = 0x04;
export const STATUS = 0x06;
export const REVISION = 0x08;
export const PROG_IF = 0x09;
export const SUBCLASS = 0x0a;
export const CLASS = 0x0b;
export const HEADER_TYPE = 0x0e;
export const BAR0 = 0x10;
export const SUBSYSTEM_VENDOR = 0x2c;
export const SUBSYSTEM_ID = 0x2e;
export const INTERRUPT_LINE = 0x3c;
export const INTERRUPT_PIN = 0x3d;

/**
 * Una funzione PCI: i suoi duecentocinquantasei byte, e la maschera di quali si
 * lasciano scrivere.
 *
 * La maschera non è un dettaglio: metà di quei byte sono di sola lettura perché
 * dicono cosa la scheda *è*, e il firmware che provasse a cambiarli scoprirebbe
 * che non cambiano — ed è così che funziona il riconoscimento. L'altra metà si
 * scrive, e le finestre di indirizzi (i BAR) hanno una maschera ancora diversa:
 * i bit bassi sono inchiodati a zero, e da quanti ne sono inchiodati il firmware
 * capisce **quanto è grande** la finestra che la scheda vuole. È il trucco più
 * elegante di tutto il PCI: la scheda dichiara la sua misura lasciandosi
 * scrivere solo i bit che le servono.
 */
export class PCIFunction {
  /**
   * @param {object} spec
   * @param {number} spec.vendor
   * @param {number} spec.device
   * @param {string} spec.name come si chiama, per chi guarda
   */
  constructor(spec) {
    this.name = spec.name ?? 'device';
    this.config = new Uint8Array(256);
    /** Quali byte accettano una scrittura: zero vuol dire "di sola lettura". */
    this.writable = new Uint8Array(256);
    this.write16(VENDOR_ID, spec.vendor);
    this.write16(DEVICE_ID, spec.device);
    if (spec.classCode !== undefined) this.write16(SUBCLASS, spec.classCode);
    if (spec.progIf !== undefined) this.config[PROG_IF] = spec.progIf;
    if (spec.revision !== undefined) this.config[REVISION] = spec.revision;
    if (spec.subsystemVendor !== undefined) this.write16(SUBSYSTEM_VENDOR, spec.subsystemVendor);
    if (spec.subsystemId !== undefined) this.write16(SUBSYSTEM_ID, spec.subsystemId);
    // Il registro di comando si scrive sempre: è quello con cui il firmware
    // accende le finestre di indirizzi e la capacità di fare da padrone del bus.
    this.writable[COMMAND] = 0xff;
    this.writable[COMMAND + 1] = 0x07;
    this.writable[INTERRUPT_LINE] = 0xff;
  }

  write16(at, value) {
    this.config[at] = value & 0xff;
    this.config[at + 1] = (value >> 8) & 0xff;
  }

  read16(at) {
    return this.config[at] | (this.config[at + 1] << 8);
  }

  read32(at) {
    return (this.read16(at) | (this.read16(at + 2) << 16)) >>> 0;
  }

  /**
   * Una finestra di indirizzi. `size` deve essere una potenza di due: i bit che
   * restano sotto non si lasciano scrivere, e il firmware li legge a zero per
   * sapere quanto spazio deve trovare.
   */
  addBAR(index, size, { io = false } = {}) {
    const at = BAR0 + index * 4;
    const mask = ~(size - 1) >>> 0;
    for (let i = 0; i < 4; i++) this.writable[at + i] = (mask >>> (i * 8)) & 0xff;
    // Il bit 0 dice se la finestra è di porte o di memoria, ed è di sola lettura.
    if (io) this.config[at] = 0x01;
    return at;
  }

  /** Dove il firmware ha deciso che sta la finestra. */
  bar(index) {
    const value = this.read32(BAR0 + index * 4);
    return value & 1 ? value & 0xfffffffc : value & 0xfffffff0;
  }

  get ioEnabled() {
    return (this.config[COMMAND] & 1) !== 0;
  }

  get memoryEnabled() {
    return (this.config[COMMAND] & 2) !== 0;
  }

  read(offset) {
    return this.config[offset & 0xff];
  }

  write(offset, value) {
    offset &= 0xff;
    const keep = ~this.writable[offset] & 0xff;
    this.config[offset] = (this.config[offset] & keep) | (value & this.writable[offset]);
    this.onWrite?.(offset, value);
  }
}

/**
 * Il bus: chi c'è sopra, e le due porte da cui lo si interroga.
 *
 * Un posto vuoto non dà errore e non lascia il bus alto come su ISA: risponde
 * FFFF al numero di produttore, che vuol dire "qui non c'è nessuno". È così che
 * il firmware scopre cosa c'è dentro la macchina senza saperlo in anticipo — e
 * per questo un PC del 1995 si accende con una scheda che nel 1994 non esisteva.
 */
export class PCIBus {
  constructor() {
    /** Le funzioni, indicizzate come le indirizza il bus: bus, device, funzione. */
    this.functions = new Map();
    this.address = new Uint8Array(4);
  }

  /**
   * @param {number} device il numero di slot
   * @param {number} fn quale funzione dentro quel dispositivo
   * @param {PCIFunction} implementation
   */
  add(device, fn, implementation) {
    this.functions.set(((device & 0x1f) << 3) | (fn & 7), implementation);
    return implementation;
  }

  at(bus, device, fn) {
    if (bus !== 0) return null;
    return this.functions.get(((device & 0x1f) << 3) | (fn & 7)) ?? null;
  }

  /** L'indirizzo scritto in CF8h, smontato nei suoi pezzi. */
  get selected() {
    const value =
      (this.address[0] |
        (this.address[1] << 8) |
        (this.address[2] << 16) |
        (this.address[3] << 24)) >>>
      0;
    return {
      enabled: (value & 0x80000000) !== 0,
      bus: (value >>> 16) & 0xff,
      device: (value >>> 11) & 0x1f,
      fn: (value >>> 8) & 7,
      register: value & 0xfc,
    };
  }

  read(port) {
    if (port >= PCI_ADDRESS && port < PCI_ADDRESS + 4) return this.address[port - PCI_ADDRESS];
    const { enabled, bus, device, fn, register } = this.selected;
    if (!enabled) return 0xff;
    const target = this.at(bus, device, fn);
    // Niente in quello slot: il ponte risponde per lui, e risponde "nessuno".
    if (!target) return 0xff;
    return target.read(register | (port & 3));
  }

  write(port, value) {
    if (port >= PCI_ADDRESS && port < PCI_ADDRESS + 4) {
      this.address[port - PCI_ADDRESS] = value & 0xff;
      return;
    }
    const { enabled, bus, device, fn, register } = this.selected;
    if (!enabled) return;
    this.at(bus, device, fn)?.write(register | (port & 3), value);
  }
}
