// La scheda madre del 1995, che è la prima che non si capisce guardandola.
//
// Su quella del 286, qui accanto, ogni chip si vede: il controllore delle
// interruzioni, i contatori, il DMA, la tastiera, e una mappa di memoria che si
// disegna in quattro righe. Qui i chip sono due — un ponte nord e un ponte sud —
// e dentro ci sono tutti quelli di prima, gli stessi, con gli stessi indirizzi:
// l'8259 risponde ancora alla porta 20h e il contatore ancora alla 40h, nel 1995
// come nel 1981. Il PC non ha mai buttato niente.
//
// Quello che cambia sono tre cose, e sono quelle che rendono questa una macchina
// diversa e non un 286 più veloce:
//
//  - **la memoria è tanta**. Trentadue mega invece di uno, e il processore li
//    indirizza tutti senza segmenti. Ma il megabyte in fondo è ancora fatto come
//    nel 1981, buchi compresi, perché lì dentro gira il DOS.
//  - **la mappa non è più fissa**. I PAM del ponte nord decidono, per ogni pezzo
//    da sedici KB della memoria alta, se lì risponde la ROM o la RAM: è così che
//    il BIOS si copia in memoria e continua a girare da lì.
//  - **c'è un bus che si racconta**. Sul PCI il firmware trova le schede
//    chiedendo, non sapendo: e siccome il firmware libero che ci gira sopra —
//    SeaBIOS — è nato per una macchina emulata, questa macchina gli si presenta
//    per quello che è.
//
// Il tempo si conta in cicli del processore, come sull'altra macchina, e da quelli
// si ricava tutto il resto. Il contatore di cicli del Pentium (quello di RDTSC) è
// lo stesso numero: è la prima volta che il software può leggere l'orologio che
// l'emulatore usa per far girare i chip.

import { CPU586, CS, CR0_PE } from './cpu586.js';
import { PCIBus, PCI_ADDRESS } from './pci.js';
import { HostBridge, ISABridge, IDEFunction } from './i440fx.js';
import { CMOS, CMOS_INDEX } from './cmos.js';
import { KBC8042, KBC_DATA } from './kbc.js';
import { VGA } from './vga.js';
import { FirmwareConfig, FWCFG_SELECTOR, FWCFG_DATA } from './fwcfg.js';
import { IDE, PRIMARY, SECONDARY } from './ide.js';
import { PIC8259 } from '../pc/pic.js';
import { FDC765 } from '../pc/fdc.js';
import { PIT8253, PIT_CLOCK } from '../pc/pit.js';
import { DMA8237 } from '../pc/dma.js';

/**
 * Il primo Pentium, sessantasei milioni di cicli al secondo. Non è la velocità a
 * cui questo emulatore gira — gira meno, e per ora non importa — ma quella che la
 * macchina *dichiara*, e da cui il firmware ricava i suoi tempi di attesa. Quel
 * che conta è che sia coerente: il contatore di cicli, i contatori del timer e i
 * ritardi vengono tutti da questo numero.
 */
export const CPU_CLOCK = 66000000;

/** Quanta memoria: trentadue mega, che nel 1995 era una macchina da lavoro. */
export const RAM_SIZE = 32 * 1024 * 1024;

/** I 640 KB, la finestra della scheda video, e la memoria alta. */
export const LOW_RAM = 0xa0000;
export const VIDEO_BASE = 0xa0000;
export const VIDEO_SIZE = 0x20000;
export const UPPER_BASE = 0xc0000;
export const UPPER_END = 0x100000;

/** Dove si affacciano le ROM delle schede: sedici pezzi da sedici KB. */
export const CARD_ROM_BASE = 0xc0000;
export const CARD_ROM_SIZE = 0x20000;

/** Quanti cicli passano al massimo fra due allineamenti dei chip. */
const SYNC_INTERVAL = 128;

export const FPS = 60;
export const FRAME_CYCLES = Math.round(CPU_CLOCK / FPS);

/**
 * Le due catene di interruzioni.
 *
 * L'AT ne ha due perché otto righe non bastavano più, e la seconda non è attaccata
 * al processore: è attaccata alla riga 2 della prima. Quindi una interruzione
 * "alta" — il disco, l'orologio, il mouse — arriva al processore raccontata due
 * volte, e va chiusa due volte: prima al chip che l'ha presa e poi a quello che
 * l'ha passata. Chi si dimentica il secondo EOI pianta la macchina in un modo che
 * sembra magia, ed è uno degli errori classici di chi scrive un driver.
 */
class InterruptChain {
  constructor() {
    this.master = new PIC8259();
    this.slave = new PIC8259();
  }

  reset() {
    this.master.reset();
    this.slave.reset();
  }

  /** Alza una delle sedici righe, e fa risalire la catena se è una alta. */
  setLine(irq, active) {
    if (irq < 8) {
      this.master.setLine(irq, active);
      return;
    }
    this.slave.setLine(irq - 8, active);
    // La riga 2 del primo chip è il filo che arriva dal secondo, e va tenuta
    // alta finché il secondo ha qualcosa da dire.
    this.master.setLine(2, this.slave.request() >= 0);
  }

  pulse(irq) {
    this.setLine(irq, true);
    this.setLine(irq, false);
  }

  /** Il vettore da dare al processore adesso, o -1 se non c'è niente. */
  acknowledge() {
    const irq = this.master.request();
    if (irq < 0) return -1;
    if (irq !== 2) return this.master.acknowledge(irq);
    // Cascata: il primo chip dice "è del secondo", e il vettore lo dà il secondo.
    const second = this.slave.request();
    this.master.acknowledge(2);
    if (second < 0) return this.master.base + 7; // interruzione fantasma
    const vector = this.slave.acknowledge(second);
    this.master.setLine(2, this.slave.request() >= 0);
    return vector;
  }

  get pending() {
    return this.master.request() >= 0;
  }

  /**
   * Se c'è qualcosa che chiede, senza guardare le priorità.
   *
   * Serve a essere chiesto **a ogni istruzione**, e quindi deve costare due
   * letture e un AND. La domanda precisa — chi ha la priorità, e se qualcosa è
   * ancora in servizio — la si fa dopo, solo se questa dice sì.
   */
  get raised() {
    return (this.master.irr & ~this.master.imr) !== 0;
  }

  read(port) {
    return port < 0xa0 ? this.master.read(port) : this.slave.read(port);
  }

  write(port, value) {
    if (port < 0xa0) this.master.write(port, value);
    else this.slave.write(port, value);
  }
}

export class Pentium {
  /**
   * @param {Uint8Array} bios l'immagine del BIOS, 128 o 256 KB
   * @param {object} [options]
   * @param {number} [options.ram]
   * @param {{base:number,bytes:Uint8Array}[]} [options.cards] le ROM delle schede
   * @param {()=>Date} [options.now]
   */
  constructor(bios, options = {}) {
    this.biosImage = bios;
    this.ramSize = options.ram ?? RAM_SIZE;
    this.ram = new Uint8Array(this.ramSize);
    this.cardROM = new Uint8Array(CARD_ROM_SIZE).fill(0xff);
    for (const card of options.cards ?? []) {
      this.cardROM.set(card.bytes, card.base - CARD_ROM_BASE);
    }

    /**
     * Per ognuno dei sedici pezzi da sedici KB fra C0000 e FFFFF: se le letture
     * vengono dalla memoria invece che dalla ROM, e se le scritture arrivano da
     * qualche parte. È la mappa che i PAM del ponte nord governano.
     */
    this.shadow = Array.from({ length: 16 }, () => ({ read: false, write: false }));

    /**
     * Il cancello sul ventunesimo bit. All'accensione è **aperto**, e non chiuso
     * come si potrebbe credere: la prima istruzione che il processore va a leggere
     * sta a FFFFFFF0, e il ventunesimo bit lì è acceso. Una macchina che si
     * svegliasse col cancello chiuso non riuscirebbe a leggere il proprio BIOS.
     * Chi vuole il riavvolgimento dell'8086 — e negli anni Ottanta c'era del
     * software che ci contava — lo chiude a mano dopo.
     */
    this.a20 = true;

    this.pci = new PCIBus();
    this.bridge = this.pci.add(0, 0, new HostBridge((region, read, write) => this.remap(region, read, write)));
    this.isa = this.pci.add(1, 0, new ISABridge());
    this.ide = this.pci.add(1, 1, new IDEFunction());

    this.pics = new InterruptChain();
    this.pit = new PIT8253({
      onChannel0: () => this.pics.pulse(0),
      onChannel1: (pulses) => this.dma.refresh(pulses),
    });
    this.cmos = new CMOS({ ram: this.ramSize, now: options.now });
    this.kbc = new KBC8042({
      onKeyboardInterrupt: (active) => this.pics.setLine(1, active),
      onMouseInterrupt: (active) => this.pics.setLine(12, active),
      onA20: (open) => this.setA20(open),
      onReset: () => this.pendingReset = true,
    });
    const bus = {
      read8: (addr) => this.read8(addr),
      write8: (addr, value) => this.write8(addr, value),
    };
    this.dma = new DMA8237(bus);
    this.dma16 = new DMA8237(bus);

    /** La scheda video, che è l'unica di cui questa macchina non può fare a meno. */
    this.video = new VGA(CPU_CLOCK);

    /**
     * I dischi. Il lettore di dischetti è lo stesso NEC 765 del 286 di qui
     * accanto — è lo stesso chip, e nel 1995 è ancora quello, dentro il ponte sud
     * invece che su una scheda — e i dischi fissi sono IDE sulle porte di sempre.
     */
    this.floppy = new FDC765({ dma: this.dma, onInterrupt: () => this.pics.pulse(6) });
    this.disks = new IDE((irq, active) => this.pics.setLine(irq, active));
    if (options.disk) this.disks.channels[0].attach(0, options.disk);
    if (options.disk2) this.disks.channels[0].attach(1, options.disk2);
    if (options.floppy) this.insertFloppy(options.floppy);
    else this.describeFloppy(null);

    /**
     * Il canale da cui il firmware chiede alla macchina com'è fatta, e da cui
     * riceve la ROM della scheda video: su una macchina come questa quella ROM non
     * sta dentro una scheda, gliela passa la scheda madre come file. È quello che
     * fa QEMU con una VGA ISA, ed è il pezzo che permette a un firmware unico di
     * accendere macchine diverse.
     */
    this.fwcfg = new FirmwareConfig({ ram: this.ramSize });
    for (const rom of options.videoROMs ?? []) {
      this.fwcfg.addFile(`vgaroms/${rom.name}`, rom.bytes);
    }

    /**
     * La porta 402h, da cui il firmware racconta cosa sta facendo. Non è un pezzo
     * di hardware vero: è una porta che gli emulatori mettono a disposizione e che
     * SeaBIOS usa se la trova, un carattere per volta. Su una macchina vera lo
     * stesso racconto usciva dalla porta seriale, e chi scriveva BIOS teneva un
     * terminale attaccato dietro.
     */
    this.log = '';

    this.cpu = new CPU586(this);
    this.reset();
  }

  reset() {
    this.cycles = 0;
    this.synced = 0;
    this.nextSync = SYNC_INTERVAL;
    this.pitRemainder = 0;
    this.pendingReset = false;

    this.ram.fill(0);
    this.pics.reset();
    this.pit.reset();
    this.dma.reset();
    this.dma16.reset();
    this.kbc.reset();
    this.video?.reset();
    this.floppy.reset();
    this.disks.reset();
    this.a20 = true;
    // I PAM tornano come li trova l'accensione: la ROM risponde a tutta la
    // memoria alta, e la RAM che c'è sotto non la vede nessuno.
    for (const page of this.shadow) {
      page.read = false;
      page.write = false;
    }
    this.bridge.config.fill(0, 0x59, 0x60);
    this.bridge.remapAll();
    this.cpu.reset();

    /** L'altoparlante e il bit di rinfresco, che stanno nella porta 61h. */
    this.portB = 0;
    this.nmiEnabled = false;
  }

  /**
   * Un dischetto nel lettore, e la scheda madre che se ne accorge.
   *
   * La seconda metà conta quanto la prima: il firmware non guarda che dischetto
   * c'è, guarda com'è **configurata la macchina** — un byte nella memoria
   * dell'orologio, scritto dal setup del BIOS, che dice che lettore è montato. Un
   * lettore da 1,44 MB e un dischetto da 720 KB hanno geometrie diverse, e se il
   * byte dice la prima mentre dentro c'è la seconda il settore di avvio si legge
   * e il resto no.
   *
   * Quindi la macchina dichiara il lettore che serve al dischetto che c'è. È una
   * finzione onesta: quel byte è il setup, e il setup descrive la macchina che hai
   * — e una macchina senza dischetti, nel 1995 come adesso, è una macchina in cui
   * il lettore non c'è. Dichiararlo comunque costa al firmware cinque secondi
   * passati a interrogare un lettore vuoto.
   *
   * @param {Uint8Array} bytes
   */
  insertFloppy(bytes) {
    if (!this.floppy.drives[0].insert(bytes)) return false;
    this.describeFloppy(this.floppy.drives[0].format);
    return true;
  }

  /** Il byte del setup che dice che lettore c'è, e quello dell'equipaggiamento. */
  describeFloppy(format) {
    const type = { 368640: 1, 1228800: 2, 737280: 3, 1474560: 4 }[format?.size] ?? 0;
    this.cmos.bytes[0x10] = type << 4;
    // Il byte dell'equipaggiamento: il bit 0 dice se c'è un lettore, i bit 6-7
    // quanti. E lo schermo, che è sempre una VGA.
    this.cmos.bytes[0x14] = (type ? 0x01 : 0x00) | 0x04;
  }

  // ------------------------------------------------------------- la mappa

  /** Un pezzo della memoria alta cambia padrone, perché i PAM sono cambiati. */
  remap(region, read, write) {
    const first = (region.base - UPPER_BASE) >> 14;
    for (let i = 0; i < region.size >> 14; i++) {
      this.shadow[first + i].read = read;
      this.shadow[first + i].write = write;
    }
  }

  setA20(open) {
    this.a20 = open;
    // Il cancello cambia quali byte sono quali: le traduzioni che il processore
    // si è tenuto non valgono più.
    this.cpu.flushTLB();
  }

  /** Il byte della ROM che si affaccia a un indirizzo della memoria alta. */
  romAt(addr) {
    if (addr >= UPPER_BASE && addr < CARD_ROM_BASE + CARD_ROM_SIZE) {
      return this.cardROM[addr - CARD_ROM_BASE];
    }
    // Il BIOS si affaccia in fondo al megabyte con la sua coda: un'immagine da
    // 128 KB copre E0000-FFFFF, una da 256 le ultime due finestre da sedici KB in
    // modo diverso, e in tutti i casi l'ultimo byte dell'immagine sta a FFFFF.
    const from = this.biosImage.length - (UPPER_END - addr);
    return from >= 0 ? this.biosImage[from] : 0xff;
  }

  read8(addr) {
    addr >>>= 0;
    // Il cancello A20 chiuso spegne il ventunesimo bit di ogni indirizzo: è il
    // riavvolgimento dell'8086 tenuto in vita con un filo, e ogni sistema
    // operativo protetto comincia aprendolo.
    if (!this.a20) addr &= ~0x100000;
    if (addr < LOW_RAM) return this.ram[addr];
    if (addr < UPPER_BASE) return this.video ? this.video.read(addr - VIDEO_BASE) : 0xff;
    if (addr < UPPER_END) {
      return this.shadow[(addr - UPPER_BASE) >> 14].read ? this.ram[addr] : this.romAt(addr);
    }
    if (addr < this.ramSize) return this.ram[addr];
    // La ROM si affaccia anche in cima ai quattro giga, ed è da lì che il
    // processore legge la sua prima istruzione — e da lì che il BIOS rilegge sé
    // stesso mentre si copia in memoria, perché mentre lo fa la finestra in
    // fondo al megabyte è già diventata RAM vuota.
    if (addr >= 0x100000000 - this.biosImage.length) {
      return this.biosImage[addr - (0x100000000 - this.biosImage.length)];
    }
    if (this.video && addr >= this.video.linearBase && addr < this.video.linearBase + this.video.linearSize) {
      return this.video.readLinear(addr - this.video.linearBase);
    }
    return 0xff;
  }

  write8(addr, value) {
    addr >>>= 0;
    if (!this.a20) addr &= ~0x100000;
    value &= 0xff;
    if (addr < LOW_RAM) {
      this.ram[addr] = value;
      return;
    }
    if (addr < UPPER_BASE) {
      this.video?.write(addr - VIDEO_BASE, value);
      return;
    }
    if (addr < UPPER_END) {
      // Scrivere dove risponde la ROM non fa niente e non è un errore: è quello
      // che succede su una macchina vera, e il firmware ci conta.
      if (this.shadow[(addr - UPPER_BASE) >> 14].write) this.ram[addr] = value;
      return;
    }
    if (addr < this.ramSize) {
      this.ram[addr] = value;
      return;
    }
    if (this.video && addr >= this.video.linearBase && addr < this.video.linearBase + this.video.linearSize) {
      this.video.writeLinear(addr - this.video.linearBase, value);
    }
  }

  // -------------------------------------------------------------- le porte

  inb(port) {
    port &= 0xffff;
    this.catchUp();
    if (port < 0x10) return this.dma.read(port);
    if (port >= 0x20 && port < 0x24) return this.pics.read(0x20 | (port & 1));
    if (port >= 0x40 && port < 0x44) return this.pit.read(port);
    if (port === KBC_DATA || port === 0x64) return this.kbc.read(port);
    if (port === 0x61) return this.portBValue;
    if (port === 0x70 || port === 0x71) return this.cmos.read(port);
    if (port >= 0x80 && port < 0x90) return this.dma.readPage(port);
    // La porta 92h, il modo veloce di fare le due cose che prima si chiedevano
    // al controllore della tastiera: il bit 1 è il cancello A20, il bit 0 è il
    // riavvio. Il bit del riavvio si legge **spento**: scatta sul fronte, e chi
    // rilegge la porta per cambiare solo A20 non deve trovarsi riavviato.
    if (port === 0x92) return this.a20 ? 0x02 : 0x00;
    if (port >= 0xa0 && port < 0xa4) return this.pics.read(0xa0 | (port & 1));
    if (port >= 0xc0 && port < 0xe0) return this.dma16.read((port - 0xc0) >> 1);
    if (port >= PRIMARY.command && port < PRIMARY.command + 8) return this.disks.read(port);
    if (port >= SECONDARY.command && port < SECONDARY.command + 8) return this.disks.read(port);
    if (port === PRIMARY.control || port === SECONDARY.control) return this.disks.read(port);
    if (port >= 0x3f0 && port < 0x3f6) return this.floppy.read(port);
    if (port === 0x3f7) {
      // La porta che i due si dividono: il bit 7 è del lettore di dischetti — dice
      // che il dischetto è stato cambiato — e gli altri sette del disco fisso. Due
      // schede diverse sullo stesso byte, che è il genere di cosa che succede
      // quando gli indirizzi finiscono.
      const inserted = this.floppy.drives[0]?.medium;
      return (inserted ? 0x00 : 0x80) | (this.disks.read(0x3f7) & 0x7f);
    }
    if (port >= 0x3b0 && port < 0x3e0) return this.video?.readPort(port) ?? 0xff;
    if (port >= PCI_ADDRESS && port < PCI_ADDRESS + 8) return this.pci.read(port);
    if (port === FWCFG_SELECTOR || port === FWCFG_DATA) return this.fwcfg.read(port);
    if (port === 0xcf9) return this.resetControl ?? 0;
    if (port === 0x4d0 || port === 0x4d1) return this.elcr?.[port & 1] ?? 0;
    return 0xff;
  }

  outb(port, value) {
    port &= 0xffff;
    value &= 0xff;
    this.catchUp();
    if (port < 0x10) return this.dma.write(port, value);
    if (port >= 0x20 && port < 0x24) return this.pics.write(0x20 | (port & 1), value);
    if (port >= 0x40 && port < 0x44) return this.pit.write(port, value);
    if (port === KBC_DATA || port === 0x64) return this.kbc.write(port, value);
    if (port === 0x61) return this.setPortB(value);
    if (port === CMOS_INDEX || port === 0x71) {
      this.cmos.write(port, value);
      // Il bit alto della porta dell'indice è l'interruttore delle NMI: due cose
      // senza niente in comune sullo stesso byte, e nessuno le ha più separate.
      if (port === CMOS_INDEX) this.nmiEnabled = (value & 0x80) === 0;
      return undefined;
    }
    if (port >= 0x80 && port < 0x90) return this.dma.writePage(port, value);
    if (port === 0x92) {
      this.setA20((value & 0x02) !== 0);
      if ((value & 0x01) && !this.fastReset) this.pendingReset = true;
      this.fastReset = (value & 0x01) !== 0;
      return undefined;
    }
    if (port >= 0xa0 && port < 0xa4) return this.pics.write(0xa0 | (port & 1), value);
    if (port >= 0xc0 && port < 0xe0) return this.dma16.write((port - 0xc0) >> 1, value);
    if (port === 0x402 || port === 0x403) return this.trace(value);
    if (port >= PRIMARY.command && port < PRIMARY.command + 8) return this.disks.write(port, value);
    if (port >= SECONDARY.command && port < SECONDARY.command + 8) return this.disks.write(port, value);
    if (port === PRIMARY.control || port === SECONDARY.control) return this.disks.write(port, value);
    if (port >= 0x3f0 && port < 0x3f6) return this.floppy.write(port, value);
    if (port === 0x3f7) return undefined; // il registro della velocità, che qui non cambia niente
    if (port >= 0x3b0 && port < 0x3e0) return this.video?.writePort(port, value);
    if (port >= PCI_ADDRESS && port < PCI_ADDRESS + 8) return this.pci.write(port, value);
    if (port >= FWCFG_SELECTOR && port <= FWCFG_SELECTOR + 1) return this.fwcfg.write(port, value);
    if (port === 0xcf9) {
      // Il registro di riavvio del ponte sud: il bit 2 tira giù il piedino di
      // reset del processore. Dal 1995 è così che un sistema operativo si
      // riavvia, e SeaBIOS lo prova per primo — se non risponde nessuno passa a
      // un INT 3 senza gestore (che è un triple fault, e anche quello riavvia) e
      // poi al vecchio comando del controllore di tastiera. Tre modi di dare la
      // stessa botta, in ordine di eleganza.
      if (value & 0x04) this.pendingReset = true;
      this.resetControl = value;
      return undefined;
    }
    if (port === 0x4d0 || port === 0x4d1) {
      this.elcr ??= [0, 0];
      this.elcr[port & 1] = value;
      return undefined;
    }
    return undefined;
  }

  /**
   * Le porte larghe più di un byte.
   *
   * Sul bus ISA quasi tutto è a otto bit, e un accesso a sedici si fa in due
   * volte: è quello che succede qui per ogni porta tranne una. La porta dei dati
   * del disco è larga una parola davvero — è la differenza fra questo disco e
   * quello del 286 — e un settore la attraversa 256 volte invece di 512.
   */
  inw(port) {
    port &= 0xffff;
    if (this.disks.isData(port)) {
      this.catchUp();
      return this.disks.readData(port, 2);
    }
    return this.inb(port) | (this.inb(port + 1) << 8);
  }

  outw(port, value) {
    port &= 0xffff;
    if (this.disks.isData(port)) {
      this.catchUp();
      this.disks.writeData(port, value & 0xffff, 2);
      return;
    }
    this.outb(port, value & 0xff);
    this.outb(port + 1, (value >> 8) & 0xff);
  }

  /**
   * A trentadue bit c'è una distinzione che conta. Una porta normale occupa
   * quattro indirizzi consecutivi, e un accesso largo li tocca tutti e quattro:
   * è così che si scrive in un colpo solo l'indirizzo di configurazione del PCI.
   * La porta dei dati di un disco invece è una **finestra su una fila**: quattro
   * byte li si prendono dallo stesso indirizzo, uno dietro l'altro. Confondere le
   * due cose vuol dire scrivere due volte la metà bassa di un indirizzo, e non
   * trovare più il ponte nord.
   */
  ind(port) {
    port &= 0xffff;
    if (this.disks.isData(port)) return (this.inw(port) | (this.inw(port) << 16)) >>> 0;
    return (this.inw(port) | (this.inw(port + 2) << 16)) >>> 0;
  }

  outd(port, value) {
    port &= 0xffff;
    if (this.disks.isData(port)) {
      this.outw(port, value & 0xffff);
      this.outw(port, (value >>> 16) & 0xffff);
      return;
    }
    this.outw(port, value & 0xffff);
    this.outw(port + 2, (value >>> 16) & 0xffff);
  }

  /**
   * Il bit 4 della porta 61h cambia stato a ogni giro del contatore 1, che sulla
   * scheda madre serve a rinfrescare la memoria. Nessun programma se ne
   * interessa, tranne uno: chi vuole misurare un tempo brevissimo senza
   * programmare niente guarda quel bit cambiare, e ci ha fatto tutti i ritardi
   * dei driver del DOS.
   */
  get portBValue() {
    const refresh = Math.floor((this.cycles * PIT_CLOCK) / CPU_CLOCK / 15) & 1;
    return (this.portB & 0x0f) | (refresh << 4) | (this.pit.speakerOutput ? 0x20 : 0);
  }

  setPortB(value) {
    this.portB = value;
    this.pit.setGate2((value & 1) !== 0);
  }

  /** Un carattere del racconto del firmware. */
  trace(value) {
    const char = String.fromCharCode(value);
    if (this.log.length < 1 << 20) this.log += char;
    this.onTrace?.(char);
  }

  // ---------------------------------------------------------- il tempo

  catchUp() {
    const delta = this.cycles - this.synced;
    if (delta <= 0) return;
    this.synced = this.cycles;
    this.pitRemainder += delta * PIT_CLOCK;
    const ticks = Math.floor(this.pitRemainder / CPU_CLOCK);
    this.pitRemainder -= ticks * CPU_CLOCK;
    if (ticks) this.pit.advance(ticks);
    this.video?.advance(delta);
  }

  /**
   * Se la macchina è passata almeno una volta per il modo protetto. Non serve
   * alla macchina: serve a chi la guarda da fuori, perché un firmware che non ci
   * passa non è arrivato in fondo al suo lavoro.
   */
  get everProtected() {
    return this.sawProtected === true;
  }

  serviceInterrupts() {
    if (!this.pics.pending) return;
    if (!this.cpu.if_) return;
    if (this.cpu.stiDelay && !this.cpu.halted) return;
    const vector = this.pics.acknowledge();
    if (vector < 0) return;
    try {
      this.cpu.interrupt(vector);
    } catch (error) {
      // Anche entrare in un gestore può fallire — una porta della IDT che non
      // c'è, uno stack che non c'è più — e allora quello che si alza è
      // un'eccezione, che va raccontata al processore come tutte le altre e non
      // fatta esplodere addosso a chi lo sta emulando.
      this.cpu.serviceFault(error);
    }
  }

  /**
   * Manda avanti la macchina.
   * @returns {number} i cicli davvero consumati
   */
  runCycles(count) {
    const end = this.cycles + count;
    while (this.cycles < end) {
      if (this.cpu.halted) this.cycles = Math.min(end, this.idleUntil());
      else this.cycles += this.cpu.step();
      // Le interruzioni si guardano fra un'istruzione e l'altra, come le guarda
      // il processore, e non ogni tanto. Non è un dettaglio di precisione: il
      // firmware, mentre aspetta un disco, apre le interruzioni per **tre
      // istruzioni** — `sti`, `nop`, `pause`, `cli` — e chi guarda ogni cento
      // cicli quella finestra non la vede mai, e aspetta per sempre una cosa che
      // era già arrivata. Costa due letture per istruzione, e la domanda vera la
      // si fa solo quando quelle due dicono di sì.
      if (this.pics.raised && this.cpu.if_ && !this.cpu.stiDelay) {
        this.catchUp();
        this.serviceInterrupts();
      }
      if (this.cycles >= this.nextSync) {
        if (this.cpu.protectedMode) this.sawProtected = true;
        this.catchUp();
        this.nextSync = this.cycles + SYNC_INTERVAL;
        this.serviceInterrupts();
        // Tre eccezioni una dentro l'altra e la macchina si spegne e riparte. Non
        // è un modo di dire: per anni il modo normale di tornare in real mode da
        // un sistema protetto è stato provocare un triple fault apposta, e il
        // riavvio che se ne otteneva era più veloce di qualunque altro.
        if (this.cpu.tripleFault) {
          this.cpu.tripleFault = false;
          this.pendingReset = true;
        }
        if (this.pendingReset) {
          this.pendingReset = false;
          this.resetMachine();
        }
      }
    }
    this.catchUp();
    return this.cycles - (end - count);
  }

  runFrame() {
    this.runCycles(FRAME_CYCLES);
  }

  /**
   * Fin dove si può saltare mentre il processore è fermo.
   *
   * Un HLT vuol dire «svegliami quando succede qualcosa», e quello che succede
   * lo sappiamo: il prossimo giro del contatore 0. Portare l'orologio
   * direttamente là invece di avanzare a passetti non cambia niente di quello
   * che la macchina vede — nessuno sta guardando, per definizione — e cambia
   * tutto per chi la sta emulando: un'attesa di sessanta secondi del firmware
   * costa mille passi invece di trenta milioni. È la stessa ragione per cui una
   * macchina vera in HLT consuma meno.
   */
  idleUntil() {
    const channel = this.pit.channels[0];
    if (!channel.running || !channel.gate) return this.nextSync;
    // Quanti cicli di processore stanno nei colpi di quarzo che restano.
    const ticks = Math.max(1, channel.count);
    const cycles = Math.ceil((ticks * CPU_CLOCK) / PIT_CLOCK);
    return Math.max(this.nextSync, this.cycles + cycles);
  }

  /**
   * Il riavvio: quello che succede quando qualcuno tira il piedino di reset. La
   * memoria non si azzera — su una macchina vera nessuno la azzera, e il BIOS lo
   * sa: è così che si distingue un riavvio a caldo da un'accensione — ma tutto
   * il resto riparte da zero.
   */
  resetMachine() {
    this.pics.reset();
    this.pit.reset();
    this.dma.reset();
    this.dma16.reset();
    this.kbc.reset();
    this.video.reset();
    this.floppy.reset();
    this.disks.reset();
    this.a20 = true;
    for (const page of this.shadow) {
      page.read = false;
      page.write = false;
    }
    this.bridge.config.fill(0, 0x59, 0x60);
    this.bridge.remapAll();
    this.portB = 0;
    this.fastReset = false;
    this.cpu.reset();
  }

  /** Dove sta il processore, per chi lo sta guardando. */
  get location() {
    if (!this.cpu.protectedMode) {
      return `${this.cpu.s[CS].toString(16).padStart(4, '0')}:${this.cpu.eip.toString(16).padStart(4, '0')}`;
    }
    return `${this.cpu.s[CS].toString(16).padStart(4, '0')}:${(this.cpu.eip >>> 0).toString(16).padStart(8, '0')}`;
  }

  get inProtectedMode() {
    return (this.cpu.cr0 & CR0_PE) !== 0;
  }
}
