// La scheda madre: un mega di indirizzi, sei chip e nessun mistero.
//
// Quello che rende un PC un PC non è il processore — l'8088 era montato anche
// altrove — ma questa mappa, che è rimasta identica per quarant'anni:
//
//   00000-9FFFF  i 640 KB, "abbastanza per chiunque"
//   A0000-BFFFF  la memoria delle schede video
//   C0000-EFFFF  le ROM delle schede, che il BIOS va a cercare all'accensione
//   F0000-FFFFF  il BIOS
//
// Il confine a 640 KB non è una decisione sulla memoria: è dove IBM ha deciso
// di far cominciare le schede, e da lì in poi tutto il DOS ci ha sbattuto
// contro. Sopra ci sono 384 KB di indirizzi che quasi nessuna scheda usava, e
// mezza industria degli anni Ottanta è consistita nel provare a starci dentro.
//
// I chip intorno sono sei: il controllore delle interruzioni, i tre contatori,
// le tre porte parallele con gli interruttori, il controllore di DMA, la
// tastiera e la scheda video. Nessuno di loro sa dell'esistenza degli altri —
// si parlano solo attraverso questo bus e attraverso i fili di interrupt — ed è
// per questo che sono file separati.
//
// Il tempo qui si conta in cicli del processore, e da quelli si ricava tutto il
// resto: i colpi del quarzo dei contatori e i punti del pennello video. I chip
// non vengono aggiornati a ogni istruzione — sarebbe lentissimo — ma ogni volta
// che qualcuno tocca una porta, e comunque ogni tanto: quello che conta è che
// chi legge un registro lo trovi al valore che avrebbe adesso.

import { CPU286, CS } from './cpu286.js';
import { PIC8259 } from './pic.js';
import { PIT8253, PIT_CLOCK } from './pit.js';
import { PPI8255, VIDEO_CGA_80 } from './ppi.js';
import { DMA8237 } from './dma.js';
import { CGA, DOT_CLOCK, CGA_BASE, CGA_SIZE } from './cga.js';
import { XTKeyboard } from './keyboard.js';
import { BIOS_BASE } from './roms.js';

/** Il processore, in Hz. Un 286 da otto: veloce per il 1988, non assurdo. */
export const CPU_CLOCK = 8000000;

/** La memoria convenzionale: 640 KB, e non uno di più. */
export const RAM_SIZE = 0xa0000;

/** Quanti cicli passano al massimo fra due allineamenti dei chip. */
const SYNC_INTERVAL = 64;

export const FPS = 60;
export const FRAME_CYCLES = Math.round(CPU_CLOCK / FPS);

export class PC {
  /**
   * @param {Uint8Array} bios gli otto KB del BIOS, mappati in cima
   * @param {object} [options]
   * @param {number} [options.video] il tipo di scheda video negli interruttori
   */
  constructor(bios, options = {}) {
    this.bios = bios;
    this.ram = new Uint8Array(RAM_SIZE);
    this.cga = new CGA();

    this.pic = new PIC8259();
    this.dma = new DMA8237({
      read8: (addr) => this.read8(addr),
      write8: (addr, value) => this.write8(addr, value),
    });
    this.pit = new PIT8253({
      onChannel0: () => this.pic.pulse(0),
      onChannel1: (pulses) => this.dma.refresh(pulses),
    });
    this.keyboard = new XTKeyboard({
      onInterrupt: (active) => this.pic.setLine(1, active),
    });
    this.ppi = new PPI8255(
      {
        readKeyboard: () => this.keyboard.read(),
        setKeyboardLines: (held, cleared) => this.keyboard.setLines(held, cleared),
        timer2Output: () => this.pit.speakerOutput,
        setSpeaker: (gate, data) => this.setSpeaker(gate, data),
      },
      { floppies: 1, video: options.video ?? VIDEO_CGA_80 },
    );

    this.cpu = new CPU286(this);
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.cga.reset();
    this.pic.reset();
    this.pit.reset();
    this.ppi.reset();
    this.dma.reset();
    this.keyboard.reset();
    this.cpu.reset();

    /** Il tempo, in cicli del processore da quando è stata accesa. */
    this.cycles = 0;
    this.synced = 0;
    this.nextSync = SYNC_INTERVAL;
    this.pitRemainder = 0;
    this.videoRemainder = 0;
    /** Se le interruzioni non mascherabili passano: il BIOS le apre a metà POST. */
    this.nmiEnabled = false;
    /** L'altoparlante: il cancello del contatore 2 e il filo dei dati. */
    this.speaker = { gate: false, data: false, changes: 0 };
  }

  // ------------------------------------------------------------- la memoria

  read8(addr) {
    addr &= 0xfffff;
    if (addr < RAM_SIZE) return this.ram[addr];
    if (addr >= CGA_BASE && addr < CGA_BASE + 2 * CGA_SIZE) {
      // Sedici KB di scheda video, ripetuti due volte: la CGA decodifica solo
      // quattordici bit di indirizzo, e quello che c'è sotto B8000 riappare
      // identico sotto BC000.
      return this.cga.readMemory(addr - CGA_BASE);
    }
    if (addr >= BIOS_BASE) return this.bios[addr - BIOS_BASE];
    // Sopra i 640 KB e sotto il BIOS non c'è niente, e un bus senza nessuno
    // sopra legge tutti uno: è così che il BIOS scopre dove finisce la memoria.
    return 0xff;
  }

  write8(addr, value) {
    addr &= 0xfffff;
    if (addr < RAM_SIZE) {
      this.ram[addr] = value & 0xff;
      return;
    }
    if (addr >= CGA_BASE && addr < CGA_BASE + 2 * CGA_SIZE) {
      this.cga.writeMemory(addr - CGA_BASE, value);
    }
    // Tutto il resto è ROM o vuoto: scriverci non fa niente, e non è un errore.
  }

  // --------------------------------------------------------------- le porte

  inb(port) {
    port &= 0xffff;
    this.catchUp();
    if (port < 0x10) return this.dma.read(port);
    if (port >= 0x20 && port < 0x30) return this.pic.read(port);
    if (port >= 0x40 && port < 0x50) return this.pit.read(port);
    if (port >= 0x60 && port < 0x70) return this.ppi.read(port);
    if (port >= 0x80 && port < 0x90) return this.dma.readPage(port);
    if (port >= 0x3d0 && port < 0x3e0) return this.cga.read(port);
    // Nessuno risponde: il bus resta alto, e chi cercava una scheda capisce
    // che non c'è. È così che il BIOS conta le porte seriali che non hai.
    return 0xff;
  }

  outb(port, value) {
    port &= 0xffff;
    value &= 0xff;
    this.catchUp();
    if (port < 0x10) return this.dma.write(port, value);
    if (port >= 0x20 && port < 0x30) return this.pic.write(port, value);
    if (port >= 0x40 && port < 0x50) return this.pit.write(port, value);
    if (port >= 0x60 && port < 0x70) return this.ppi.write(port, value);
    if (port >= 0x80 && port < 0x90) return this.dma.writePage(port, value);
    if (port === 0xa0) {
      // Il bistabile delle NMI: un solo bit, e nemmeno un registro da rileggere.
      this.nmiEnabled = (value & 0x80) !== 0;
      return;
    }
    if (port >= 0x3d0 && port < 0x3e0) return this.cga.write(port, value);
    return undefined;
  }

  /**
   * L'altoparlante. Il suono esce dall'AND fra due bit: il contatore 2 dà
   * l'onda, il bit 1 della porta 61h dice se collegarla al cono. Chi voleva più
   * dell'onda quadra pilotava quel bit a mano, e il timer diventava soltanto un
   * modo per sapere quando muoverlo.
   */
  setSpeaker(gate, data) {
    this.pit.setGate2(gate);
    if (this.speaker.gate !== gate || this.speaker.data !== data) this.speaker.changes++;
    this.speaker.gate = gate;
    this.speaker.data = data;
  }

  // ----------------------------------------------------------- il tempo che passa

  /** Porta i chip al momento in cui è arrivato il processore. */
  catchUp() {
    const delta = this.cycles - this.synced;
    if (delta <= 0) return;
    this.synced = this.cycles;

    this.pitRemainder += delta * PIT_CLOCK;
    const ticks = Math.floor(this.pitRemainder / CPU_CLOCK);
    this.pitRemainder -= ticks * CPU_CLOCK;
    this.pit.advance(ticks);

    this.videoRemainder += delta * DOT_CLOCK;
    const dots = Math.floor(this.videoRemainder / CPU_CLOCK);
    this.videoRemainder -= dots * CPU_CLOCK;
    this.cga.advance(dots);
  }

  /**
   * Se c'è una richiesta che il PIC lascia passare e il processore la accetta,
   * gliela si dà. Si guarda solo fra un'istruzione e l'altra: un interrupt in
   * mezzo a una lascerebbe la macchina in uno stato che non esiste.
   */
  serviceInterrupts() {
    const irq = this.pic.request();
    if (irq < 0) return;
    if (!this.cpu.if_) return;
    // Dopo una STI passa ancora un'istruzione prima che le interruzioni
    // entrino: è il rinvio che fa funzionare `sti` seguito da `hlt`.
    if (this.cpu.stiDelay && !this.cpu.halted) return;
    this.cpu.interrupt(this.pic.acknowledge(irq));
  }

  /**
   * Manda avanti la macchina di un certo numero di cicli.
   * @returns {number} i cicli davvero consumati, che sono almeno quelli chiesti
   */
  runCycles(cycles) {
    const end = this.cycles + cycles;
    while (this.cycles < end) {
      if (this.cpu.halted) {
        // Ferma in attesa di un interrupt: non c'è niente da eseguire, e si
        // salta direttamente al prossimo momento in cui qualcosa può cambiare.
        this.cycles = Math.min(end, this.nextSync);
      } else {
        this.cycles += this.cpu.step();
      }
      if (this.cycles >= this.nextSync) {
        this.catchUp();
        this.nextSync = this.cycles + SYNC_INTERVAL;
        this.serviceInterrupts();
      }
    }
    this.catchUp();
    return this.cycles - (end - cycles);
  }

  /** Un sessantesimo di secondo, che è quanto dura un quadro sullo schermo. */
  runFrame() {
    this.runCycles(FRAME_CYCLES);
  }

  /** Dove sta esattamente il processore, che serve solo a chi lo sta guardando. */
  get location() {
    return `${this.cpu.s[CS].toString(16).padStart(4, '0')}:${this.cpu.ip.toString(16).padStart(4, '0')}`;
  }
}
