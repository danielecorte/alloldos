// La scheda di rete: una NE2000, cioè il chip della National del 1986 con
// attorno la memoria e le porte che ci ha messo Novell.
//
// Il DP8390 non sa niente del processore. Ha un **anello di pagine** da 256 byte
// in una memoria tutta sua, e ci scrive dentro i pacchetti che arrivano dal
// cavo, uno dietro l'altro, ognuno con quattro byte davanti che dicono com'è
// andata e dove comincia il prossimo. Il driver insegue: tiene un confine
// (BNRY) fin dove ha già letto, e il chip non lo scavalca mai — se l'anello è
// pieno il pacchetto si perde, e lo ritrasmetterà chi l'ha mandato.
//
// La memoria non è nello spazio del processore. Ci si arriva da **una porta
// sola**, con il «DMA remoto»: si dice al chip da che indirizzo e quanti byte, e
// poi li si legge dalla porta dei dati uno dietro l'altro, come dal disco. È la
// scelta che ha reso la NE2000 la scheda più economica e più copiata della sua
// epoca, e per questo quella che ogni sistema operativo sa ancora pilotare.
//
// Sul PCI la stessa cosa l'ha rifatta Realtek, e si chiama RTL8029: stesso chip,
// stesse porte, solo che l'indirizzo e l'interruzione li sceglie il BIOS invece
// di un ponticello. Windows 98 e Linux ce l'hanno di serie, e il DOS la pilota col
// packet driver della NE2000 come se fosse una scheda ISA.

import { PCIFunction, INTERRUPT_PIN } from './pci.js';

/** La finestra di porte: sedici registri, poi otto per i dati e otto per il reset. */
export const NE2000_PORTS = 0x20;
export const DATA_PORT = 0x10;

/** L'indirizzo con cui la scheda si presenta: lo stesso che dà QEMU, 52:54:00. */
export const DEFAULT_MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];

/**
 * La memoria della scheda. I primi trentadue byte sono la PROM con l'indirizzo
 * della scheda; il buffer vero comincia a 4000h, alla pagina 40h, ed è lungo
 * trentadue KB — il doppio di una NE2000 d'epoca, come quella di QEMU: i driver
 * usano quello che si aspettano, e chi ne vuole di più lo trova.
 */
const MEM_START = 0x4000;
const MEM_SIZE = 0xc000;

/** Il pacchetto più lungo che un'ethernet porta, senza il CRC. */
const MAX_FRAME = 1514;
/** E il più corto: sotto i sessanta byte il chip lo allunga lui. */
const MIN_FRAME = 60;

// Il registro di comando.
const CR_STOP = 0x01;
const CR_START = 0x02;
const CR_TRANSMIT = 0x04;
const CR_DMA_READ = 0x08;
const CR_DMA_WRITE = 0x10;

// Il registro delle interruzioni: un bit per ogni cosa successa.
export const ISR_RX = 0x01;
export const ISR_TX = 0x02;
const ISR_RDC = 0x40;
const ISR_RESET = 0x80;

const RSR_OK = 0x01;
const RSR_MULTICAST = 0x20;
const TSR_OK = 0x01;

/** Il CRC dell'ethernet, da cui il chip ricava in quale casella del filtro cade un indirizzo di gruppo. */
function crc32(bytes, length) {
  let crc = 0xffffffff;
  for (let i = 0; i < length; i++) {
    let b = bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      const carry = ((crc >>> 31) ^ b) & 1;
      crc = (crc << 1) >>> 0;
      b >>= 1;
      if (carry) crc = (crc ^ 0x04c11db7) >>> 0;
    }
  }
  return crc;
}

export class NE2000 {
  /**
   * @param {object} options
   * @param {(active:boolean)=>void} options.setIRQ il filo dell'interruzione
   * @param {number[]} [options.mac]
   */
  constructor({ setIRQ, mac = DEFAULT_MAC }) {
    this.setIRQ = setIRQ;
    this.mac = Uint8Array.from(mac);
    this.mem = new Uint8Array(MEM_SIZE);
    /** Dove vanno i pacchetti che il driver trasmette. Senza, cadono per terra, come senza cavo. */
    this.onTransmit = null;
    this.line = false;
    /** Quanti pacchetti sono passati, per la lucina. */
    this.packets = 0;
    this.reset();
  }

  reset() {
    this.cr = CR_STOP | 0x20;
    this.isr = ISR_RESET;
    this.imr = 0;
    this.pstart = 0;
    this.pstop = 0;
    this.bnry = 0;
    this.curr = 0;
    this.tpsr = 0;
    this.tbcr = 0;
    this.rsar = 0;
    this.rbcr = 0;
    this.rcr = 0;
    this.tcr = 0;
    this.dcr = 0;
    this.tsr = 0;
    this.rsr = 0;
    this.par = Uint8Array.from(this.mac);
    this.mar = new Uint8Array(8);
    this.resetChip();
  }

  /**
   * Quello che fa la porta del reset: la PROM torna a dire l'indirizzo della
   * scheda, e il chip alza il bit che il driver aspetta per sapere che è pronto.
   * Ogni byte della PROM sta due volte, perché un driver che legge a sedici bit
   * trovi l'indirizzo nelle metà basse; e i due «W» in fondo gli dicono che la
   * scheda sa parlare a sedici bit.
   */
  resetChip() {
    const prom = new Uint8Array(16);
    prom.set(this.mac);
    prom[14] = 0x57;
    prom[15] = 0x57;
    for (let i = 0; i < 16; i++) {
      this.mem[2 * i] = prom[i];
      this.mem[2 * i + 1] = prom[i];
    }
    this.isr |= ISR_RESET;
    this.updateIRQ();
  }

  updateIRQ() {
    // Il bit del reset non è una richiesta: dice solo in che stato è il chip.
    const active = (this.isr & this.imr & 0x7f) !== 0;
    if (active === this.line) return;
    this.line = active;
    this.setIRQ(active);
  }

  get page() {
    return this.cr >> 6;
  }

  // ------------------------------------------------------------- i registri

  read(offset) {
    offset &= NE2000_PORTS - 1;
    if (offset >= DATA_PORT && offset < DATA_PORT + 8) return this.readData(1) & 0xff;
    if (offset >= DATA_PORT + 8) {
      this.resetChip();
      return 0;
    }
    if (offset === 0) return this.cr;
    const page = this.page;
    if (page === 1) {
      if (offset <= 6) return this.par[offset - 1];
      if (offset === 7) return this.curr;
      return this.mar[offset - 8];
    }
    if (page === 2) {
      // La pagina 2 rilegge quello che sulla 0 si può solo scrivere: la usano i
      // programmi di diagnosi, e qualche driver per controllare di aver scritto.
      return [0, this.pstart, this.pstop, 0, this.tpsr, 0, 0, 0, 0, 0, 0, 0, this.rcr, this.tcr, this.dcr, this.imr][offset];
    }
    if (page === 3) {
      // I registri di configurazione della Realtek: 10BASE-T, collegamento su.
      if (offset === 5 || offset === 6) return 0x40;
      return 0;
    }
    switch (offset) {
      case 3:
        return this.bnry;
      case 4:
        return this.tsr;
      case 7:
        return this.isr;
      case 8:
        return this.rsar & 0xff;
      case 9:
        return this.rsar >> 8;
      // Due byte con cui la RTL8029 dice chi è: «P» e «C».
      case 10:
        return 0x50;
      case 11:
        return 0x43;
      case 12:
        return this.rsr;
      default:
        return 0;
    }
  }

  write(offset, value) {
    offset &= NE2000_PORTS - 1;
    value &= 0xff;
    if (offset >= DATA_PORT && offset < DATA_PORT + 8) {
      this.writeData(value, 1);
      return;
    }
    if (offset >= DATA_PORT + 8) return; // scrivere sulla porta del reset non fa niente
    if (offset === 0) {
      this.command(value);
      return;
    }
    const page = this.page;
    if (page === 1) {
      if (offset <= 6) this.par[offset - 1] = value;
      else if (offset === 7) this.curr = value;
      else this.mar[offset - 8] = value;
      return;
    }
    if (page !== 0) return;
    switch (offset) {
      case 1:
        this.pstart = value;
        break;
      case 2:
        this.pstop = value;
        break;
      case 3:
        this.bnry = value;
        break;
      case 4:
        this.tpsr = value;
        break;
      case 5:
        this.tbcr = (this.tbcr & 0xff00) | value;
        break;
      case 6:
        this.tbcr = (this.tbcr & 0xff) | (value << 8);
        break;
      case 7:
        // Si spegne un bit scrivendoci sopra un uno: così il driver chiude quello
        // che ha servito senza cancellare quello che è arrivato nel frattempo.
        this.isr &= ~value;
        this.updateIRQ();
        break;
      case 8:
        this.rsar = (this.rsar & 0xff00) | value;
        break;
      case 9:
        this.rsar = (this.rsar & 0xff) | (value << 8);
        break;
      case 10:
        this.rbcr = (this.rbcr & 0xff00) | value;
        break;
      case 11:
        this.rbcr = (this.rbcr & 0xff) | (value << 8);
        break;
      case 12:
        this.rcr = value;
        break;
      case 13:
        this.tcr = value;
        break;
      case 14:
        this.dcr = value;
        break;
      case 15:
        this.imr = value;
        this.updateIRQ();
        break;
    }
  }

  command(value) {
    this.cr = value;
    if (value & CR_STOP) {
      // Fermo: il chip lo dice alzando il bit del reset, e smette di ricevere.
      this.isr |= ISR_RESET;
      return;
    }
    this.isr &= ~ISR_RESET;
    // Un DMA remoto di zero byte è finito prima di cominciare, e va detto: c'è
    // chi lo usa per sapere se il chip risponde.
    if (value & (CR_DMA_READ | CR_DMA_WRITE) && this.rbcr === 0) {
      this.isr |= ISR_RDC;
    }
    if (value & CR_TRANSMIT) this.transmit();
    this.updateIRQ();
  }

  /**
   * Il pacchetto che il driver ha scritto nella memoria della scheda parte. Qui
   * il cavo è istantaneo: il pacchetto è già dall'altra parte quando il driver
   * guarda se è partito.
   */
  transmit() {
    let from = this.tpsr << 8;
    if (from >= MEM_SIZE) from -= MEM_SIZE - MEM_START;
    const length = Math.min(this.tbcr, MAX_FRAME);
    if (from >= MEM_START && from + length <= MEM_SIZE) {
      // Con il bit di loopback il pacchetto non esce: torna indietro. Lo usano
      // i programmi di diagnosi, e qui basta non mandarlo fuori.
      if ((this.tcr & 0x06) === 0) {
        this.packets++;
        this.onTransmit?.(this.mem.slice(from, from + length));
      }
    }
    this.tsr = TSR_OK;
    this.isr |= ISR_TX;
    this.cr &= ~CR_TRANSMIT;
  }

  // ------------------------------------------------------------ il DMA remoto

  memRead(addr) {
    if (addr < 32 || (addr >= MEM_START && addr < MEM_SIZE)) return this.mem[addr];
    return 0xff;
  }

  memWrite(addr, value) {
    if (addr >= MEM_START && addr < MEM_SIZE) this.mem[addr] = value;
  }

  /** Un passo del DMA remoto: l'indirizzo avanza, gira in fondo all'anello, e il conto scende. */
  advance() {
    this.rsar = (this.rsar + 1) & 0xffff;
    if (this.rsar === this.pstop << 8) this.rsar = this.pstart << 8;
    if (this.rbcr <= 1) {
      this.rbcr = 0;
      this.isr |= ISR_RDC;
      this.updateIRQ();
    } else this.rbcr--;
  }

  /**
   * Quanti byte si porta via un accesso alla porta dei dati. Non lo decide il
   * processore ma il chip: a sedici bit (il bit 0 di DCR) ogni accesso è una
   * parola, anche un `inb` — ed è così che il driver di Linux legge la PROM, un
   * byte buono per ogni parola. Un accesso a trentadue bit sono due parole.
   *
   * @param {1|2|4} width
   */
  span(width) {
    if (!(this.dcr & 1)) return 1;
    return width === 4 ? 4 : 2;
  }

  /** @param {1|2|4} width */
  readData(width) {
    let value = 0;
    const span = this.span(width);
    for (let i = 0; i < span; i++) {
      if (this.rbcr === 0) break;
      value |= this.memRead(this.rsar) << (i * 8);
      this.advance();
    }
    return value >>> 0;
  }

  writeData(value, width) {
    const span = this.span(width);
    for (let i = 0; i < span; i++) {
      if (this.rbcr === 0) break;
      this.memWrite(this.rsar, (value >>> (i * 8)) & 0xff);
      this.advance();
    }
  }

  // --------------------------------------------------------------- il cavo

  /** Le pagine libere dell'anello, cioè quante ne restano prima del confine del driver. */
  get freeBytes() {
    const size = (this.pstop - this.pstart) << 8;
    if (size <= 0) return 0;
    const curr = this.curr << 8;
    const bnry = this.bnry << 8;
    return curr < bnry ? bnry - curr : size - (curr - bnry);
  }

  /** Se il chip è fermo: prima che il driver lo accenda, e dopo che lo spegne. */
  get stopped() {
    return (this.cr & CR_STOP) !== 0;
  }

  /** Se un pacchetto grande quanto si può starebbe dentro adesso. */
  get ready() {
    return !this.stopped && this.freeBytes >= MAX_FRAME + 4 + 256;
  }

  /** Se un pacchetto con questa destinazione è per noi, o per un gruppo a cui il driver si è iscritto. */
  accepts(frame) {
    if (this.rcr & 0x10) return true; // promiscuo
    if (frame[0] & 1) {
      const broadcast = frame[0] === 0xff && frame[1] === 0xff && frame[2] === 0xff && frame[3] === 0xff && frame[4] === 0xff && frame[5] === 0xff;
      if (broadcast) return (this.rcr & 0x04) !== 0;
      if (!(this.rcr & 0x08)) return false;
      const index = crc32(frame, 6) >>> 26;
      return (this.mar[index >> 3] & (1 << (index & 7))) !== 0;
    }
    for (let i = 0; i < 6; i++) if (frame[i] !== this.par[i]) return false;
    return true;
  }

  /**
   * Arriva un pacchetto dal cavo.
   * @param {Uint8Array} frame
   * @returns {boolean} se la scheda lo ha preso o lasciato cadere
   */
  receive(frame) {
    if (!this.ready || frame.length > MAX_FRAME) return false;
    if (!this.accepts(frame)) return true; // non era per noi: preso e buttato, come sul cavo
    let size = frame.length;
    if (size < MIN_FRAME) {
      const padded = new Uint8Array(MIN_FRAME);
      padded.set(frame);
      frame = padded;
      size = MIN_FRAME;
    }
    const start = this.pstart << 8;
    const stop = this.pstop << 8;
    let at = this.curr << 8;
    if (at < start || at >= stop) at = start;
    // Quattro byte d'intestazione, e posto per il CRC che il chip conta e non scrive.
    const total = size + 4;
    let next = at + ((total + 4 + 255) & ~0xff);
    if (next >= stop) next -= stop - start;

    this.rsr = RSR_OK | (frame[0] & 1 ? RSR_MULTICAST : 0);
    this.mem[at] = this.rsr;
    this.mem[at + 1] = next >> 8;
    this.mem[at + 2] = total & 0xff;
    this.mem[at + 3] = total >> 8;
    at += 4;
    let from = 0;
    while (from < size) {
      if (at >= stop) at = start;
      const chunk = Math.min(size - from, stop - at);
      this.mem.set(frame.subarray(from, from + chunk), at);
      from += chunk;
      at += chunk;
    }
    this.curr = next >> 8;
    this.packets++;
    this.isr |= ISR_RX;
    this.updateIRQ();
    return true;
  }
}

/**
 * La stessa scheda sul PCI: una Realtek RTL8029. Chiede trentadue porte, ha il
 * filo A dell'interruzione, e dice di essere un controllore ethernet.
 */
export class RTL8029 extends PCIFunction {
  constructor() {
    super({
      name: 'Realtek RTL8029',
      vendor: 0x10ec,
      device: 0x8029,
      classCode: 0x0200, // rete, ethernet
      revision: 0x00,
      subsystemVendor: 0x10ec,
      subsystemId: 0x8029,
    });
    this.addBAR(0, NE2000_PORTS, { io: true });
    this.config[INTERRUPT_PIN] = 1;
  }

  /** Se una porta sta dentro la finestra che il BIOS le ha dato. */
  claims(port) {
    if (!this.ioEnabled) return false;
    const base = this.bar(0);
    return base !== 0 && port >= base && port < base + NE2000_PORTS;
  }
}
