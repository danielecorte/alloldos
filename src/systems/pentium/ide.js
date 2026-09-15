// L'IDE, cioè il disco che si è portato dietro il proprio controllore.
//
// Il nome lo dice: *Integrated Drive Electronics*. Prima, su un PC, il
// controllore era una scheda e il disco era un motore con dei piatti: la scheda
// sapeva come erano fatti i piatti, e cambiare disco voleva dire cambiare
// scheda. Nel 1986 a qualcuno viene in mente di prendere la scheda e avvitarla
// *sopra* il disco, e di lasciare sul bus solo i registri. Da quel momento il
// disco è una scatola nera che parla un protocollo, e la "scheda" sulla scheda
// madre non deve sapere niente di niente — è per questo che nel 1995 non è più
// una scheda ma mezzo chip del ponte sud.
//
// Il protocollo è lo stesso dell'XT-CF del 286 di qui accanto, perché è lo stesso
// protocollo: cinque registri per dire quanti settori e dove, uno per il comando,
// e poi i byte che passano dalla porta dei dati mentre il bit DRQ è alto. Le
// differenze sono due, e sono quelle che fanno di questa la macchina di dieci anni
// dopo:
//
//  - **i dati passano a sedici bit**. Sul bus a otto bit dell'XT il disco doveva
//    parlare un byte per volta; qui la porta dei dati è larga una parola, e un
//    settore sono 256 letture invece di 512.
//  - **c'è l'indirizzamento lineare**. Cilindro/testina/settore è un'astrazione
//    che nel 1986 corrispondeva ancora a come erano fatti i piatti e nel 1995 non
//    più: i dischi hanno tracce con un numero variabile di settori, e la geometria
//    che raccontano è una bugia gentile. L'LBA — il settore contato dall'inizio —
//    è la verità, e da qui in poi è l'unica cosa che conta.
//
// Il resto è il pezzo di architettura più longevo che il PC abbia: le porte 1F0h
// e 170h, i due canali con due dischi ognuno, il "master" e lo "slave" scelti da
// un bit. Trent'anni e tre generazioni di cavi dopo, un disco SATA si presenta
// ancora con IDENTIFY DEVICE.

import { HardDisk, GEOMETRY } from '../pc/ata.js';

/** Le porte dei due canali: il blocco dei comandi e quello di controllo. */
export const PRIMARY = { command: 0x1f0, control: 0x3f6, irq: 14 };
export const SECONDARY = { command: 0x170, control: 0x376, irq: 15 };

const SECTOR = 512;

/** I registri, come li chiama il manuale ATA. */
const REG_DATA = 0;
const REG_ERROR = 1; // in lettura l'errore, in scrittura le "features"
const REG_COUNT = 2;
const REG_LBA_LOW = 3;
const REG_LBA_MID = 4;
const REG_LBA_HIGH = 5;
const REG_DRIVE = 6;
const REG_STATUS = 7; // in lettura lo stato, in scrittura il comando

/** I bit dello stato, che sono gli stessi da quarant'anni. */
const ST_BUSY = 0x80;
const ST_READY = 0x40;
const ST_SEEK_DONE = 0x10;
const ST_DRQ = 0x08;
const ST_ERROR = 0x01;

/** I bit dell'errore. */
const ERR_ABORT = 0x04;
const ERR_NOT_FOUND = 0x10;

/**
 * Un disco attaccato a un canale: i byte, la geometria che racconta, e il pezzo
 * di settore in transito.
 */
class Drive {
  /**
   * @param {HardDisk} disk
   * @param {object} [options]
   * @param {boolean} [options.removable]
   */
  constructor(disk, { removable = false } = {}) {
    this.disk = disk;
    this.removable = removable;
    /**
     * La geometria che il disco *dice* di avere. Un "initialize device
     * parameters" può cambiarla: è così che i dischi grandi entravano nei BIOS
     * piccoli, e il conto torna comunque perché a tradurre è il disco.
     */
    this.logical = { ...(disk.geometry ?? GEOMETRY) };
    this.multiple = 16;
    this.reset();
  }

  reset() {
    this.buffer = new Uint8Array(SECTOR);
    this.index = 0;
    this.remaining = 0;
    this.writing = false;
    this.lba = 0;
  }

  get sectorCount() {
    return this.disk.sectorCount;
  }
}

/**
 * Un canale: due porte di registri, due dischi, e un filo di interruzione.
 *
 * I due dischi non sono simmetrici solo per modo di dire: condividono i registri,
 * e quello che risponde è quello selezionato dal bit 4 del registro delle
 * testine. È per questo che su un cavo IDE il disco lento rallentava anche quello
 * veloce — non sono due dispositivi su un bus, sono due metà di uno.
 */
export class IDEChannel {
  /**
   * @param {object} ports
   * @param {(active:boolean)=>void} [onInterrupt]
   */
  constructor(ports, onInterrupt) {
    this.ports = ports;
    this.onInterrupt = onInterrupt;
    this.drives = [null, null];
    this.reset();
  }

  reset() {
    this.registers = new Uint8Array(8);
    this.registers[REG_COUNT] = 1;
    this.registers[REG_LBA_LOW] = 1;
    this.status = ST_READY | ST_SEEK_DONE;
    this.error = 0;
    this.features = 0;
    /** Il registro di controllo: il bit 1 spegne le interruzioni. */
    this.control = 0;
    this.irq = false;
    for (const drive of this.drives) drive?.reset();
  }

  /**
   * @param {number} index 0 = master, 1 = slave
   * @param {HardDisk} disk
   */
  attach(index, disk) {
    this.drives[index] = disk ? new Drive(disk) : null;
    return this.drives[index];
  }

  /** Il disco selezionato adesso, o niente se in quel posto non c'è nulla. */
  get selected() {
    return this.drives[(this.registers[REG_DRIVE] >> 4) & 1];
  }

  get present() {
    return this.selected !== null && this.selected !== undefined;
  }

  setInterrupt(active) {
    const wanted = active && (this.control & 0x02) === 0;
    if (this.irq === wanted) return;
    this.irq = wanted;
    this.onInterrupt?.(wanted);
  }

  // ----------------------------------------------------------------- il bus

  read(port) {
    if (port === this.ports.control || port === this.ports.control + 1) {
      // Lo stato "alternativo": lo stesso byte, ma leggerlo non chiude
      // l'interruzione. Serve a chi vuole guardare come va senza dire di aver
      // visto — per esempio a chi aspetta che il disco si liberi.
      return this.present ? this.status : 0;
    }
    const register = port - this.ports.command;
    if (!this.present) return register === REG_STATUS ? 0 : 0xff;
    switch (register) {
      case REG_DATA:
        return this.readData(1);
      case REG_ERROR:
        return this.error;
      case REG_STATUS:
        // Leggere lo stato è anche il modo di dire "ho visto": l'interruzione si
        // chiude qui, e ogni driver del mondo lo dà per scontato.
        this.setInterrupt(false);
        return this.status;
      default:
        return this.registers[register];
    }
  }

  write(port, value) {
    value &= 0xff;
    if (port === this.ports.control || port === this.ports.control + 1) {
      // Il bit 2 è il reset di tutto il canale, e lo si tira su e giù a mano.
      // Finché il bit resta su i dischi sono in reset, e lo dicono con BSY: un
      // driver che segue la norma tira su il bit, aspetta di vedere BSY, e solo
      // allora lo rimette giù. E il registro va ricordato col bit acceso, o il
      // fronte di discesa — che è quando i dischi si ripresentano — non si vede.
      const wasReset = (this.control & 0x04) !== 0;
      if (!wasReset && value & 0x04) {
        this.reset();
        this.status = ST_BUSY;
      }
      this.control = value;
      if (wasReset && !(value & 0x04)) this.signature();
      return;
    }
    const register = port - this.ports.command;
    switch (register) {
      case REG_DATA:
        return this.writeData(value, 1);
      case REG_ERROR:
        this.features = value;
        return undefined;
      case REG_STATUS:
        return this.execute(value);
      default:
        this.registers[register] = value;
        return undefined;
    }
  }

  /**
   * Dopo un reset il disco si presenta scrivendo un numero nei registri di
   * indirizzo: 0000 vuol dire "sono un disco", 14EB vuol dire "sono un lettore
   * di CD e mi si parla a pacchetti". È l'unico modo che c'è di distinguerli, e
   * ancora oggi è quello che si usa.
   */
  signature() {
    this.registers[REG_COUNT] = 1;
    this.registers[REG_LBA_LOW] = 1;
    this.registers[REG_LBA_MID] = 0;
    this.registers[REG_LBA_HIGH] = 0;
    this.status = ST_READY | ST_SEEK_DONE;
    this.error = 1;
  }

  // ------------------------------------------------------------- i settori

  /**
   * I byte del settore in transito. A sedici bit ne escono due per volta, che è
   * la differenza fra questo disco e quello del 286: lo stesso protocollo su un
   * bus due volte più largo.
   */
  readData(width) {
    const drive = this.selected;
    if (!drive || !(this.status & ST_DRQ)) return width === 1 ? 0xff : 0xffff;
    let value = 0;
    for (let i = 0; i < width; i++) value |= drive.buffer[drive.index++] << (i * 8);
    if (drive.index >= SECTOR) this.nextSector(drive);
    return value;
  }

  writeData(value, width) {
    const drive = this.selected;
    if (!drive || !(this.status & ST_DRQ)) return;
    for (let i = 0; i < width; i++) drive.buffer[drive.index++] = (value >>> (i * 8)) & 0xff;
    if (drive.index >= SECTOR) {
      drive.disk.write(drive.lba, drive.buffer);
      drive.lba++;
      this.nextSector(drive);
    }
  }

  /** Finito un settore: o ce n'è un altro, o il comando è finito. */
  nextSector(drive) {
    drive.index = 0;
    drive.remaining--;
    this.registers[REG_COUNT] = drive.remaining & 0xff;
    if (drive.remaining <= 0) {
      this.status = ST_READY | ST_SEEK_DONE;
      drive.writing = false;
      this.setInterrupt(true);
      return;
    }
    if (drive.writing) {
      this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
      this.setInterrupt(true);
      return;
    }
    drive.lba++;
    const sector = drive.disk.read(drive.lba);
    if (!sector) return this.fail(ERR_NOT_FOUND);
    drive.buffer.set(sector);
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
    this.setInterrupt(true);
    return undefined;
  }

  fail(code) {
    this.error = code;
    this.status = ST_READY | ST_SEEK_DONE | ST_ERROR;
    const drive = this.selected;
    if (drive) {
      drive.remaining = 0;
      drive.index = 0;
      drive.writing = false;
    }
    this.setInterrupt(true);
  }

  /**
   * L'indirizzo che sta adesso nei registri, contato in settori dall'inizio. Il
   * bit 6 del registro delle testine dice in quale delle due lingue è scritto: la
   * geometria, o il numero progressivo. Le due strade portano allo stesso byte, e
   * a tradurre è il disco — che è tutto il punto dell'IDE.
   */
  address() {
    const drive = this.selected;
    const head = this.registers[REG_DRIVE];
    if (head & 0x40) {
      return (
        ((head & 0x0f) * 0x1000000 +
          this.registers[REG_LBA_HIGH] * 0x10000 +
          this.registers[REG_LBA_MID] * 0x100 +
          this.registers[REG_LBA_LOW]) >>>
        0
      );
    }
    const cylinder = (this.registers[REG_LBA_HIGH] << 8) | this.registers[REG_LBA_MID];
    const sector = this.registers[REG_LBA_LOW];
    if (sector < 1) return -1;
    const { heads, sectors } = drive.logical;
    return (cylinder * heads + (head & 0x0f)) * sectors + (sector - 1);
  }

  // ------------------------------------------------------------- i comandi

  execute(command) {
    const drive = this.selected;
    if (!drive) return;
    this.error = 0;
    const count = this.registers[REG_COUNT] === 0 ? 256 : this.registers[REG_COUNT];

    switch (command) {
      case 0x20:
      case 0x21:
      case 0xc4:
        return this.startRead(drive, count);
      case 0x30:
      case 0x31:
      case 0xc5:
        return this.startWrite(drive, count);
      case 0x40:
      case 0x41: {
        const lba = this.address();
        if (lba < 0 || lba + count > drive.sectorCount) return this.fail(ERR_NOT_FOUND);
        this.status = ST_READY | ST_SEEK_DONE;
        this.setInterrupt(true);
        return undefined;
      }
      case 0x08: // device reset: quello dei lettori di CD, che un disco ignora
      case 0x70: // seek
      case 0x90: // diagnostica: tutto bene, codice 1
      case 0xe0: // standby, idle, sleep: qui non c'è nessun motore da fermare
      case 0xe1:
      case 0xe2:
      case 0xe3:
      case 0xe5:
      case 0xe6:
      case 0xe7: // flush: la scrittura è già arrivata ai piatti
      case 0xea:
        this.status = ST_READY | ST_SEEK_DONE;
        if (command === 0x90) this.error = 1;
        this.setInterrupt(true);
        return undefined;
      case 0x91:
        drive.logical.heads = (this.registers[REG_DRIVE] & 0x0f) + 1;
        drive.logical.sectors = this.registers[REG_COUNT];
        drive.logical.cylinders = Math.floor(
          drive.sectorCount / Math.max(1, drive.logical.heads * drive.logical.sectors),
        );
        this.status = ST_READY | ST_SEEK_DONE;
        this.setInterrupt(true);
        return undefined;
      case 0xc6:
        drive.multiple = this.registers[REG_COUNT] || 16;
        this.status = ST_READY | ST_SEEK_DONE;
        this.setInterrupt(true);
        return undefined;
      case 0xec:
        return this.identify(drive);
      case 0xef:
        this.status = ST_READY | ST_SEEK_DONE;
        this.setInterrupt(true);
        return undefined;
      case 0xa1:
        // IDENTIFY PACKET DEVICE: è la domanda «sei un lettore di CD?», e un
        // disco risponde di no rifiutando il comando. Il firmware la fa a tutti.
        return this.fail(ERR_ABORT);
      default:
        if (command >= 0x10 && command <= 0x1f) {
          this.status = ST_READY | ST_SEEK_DONE;
          this.setInterrupt(true);
          return undefined;
        }
        return this.fail(ERR_ABORT);
    }
  }

  startRead(drive, count) {
    const lba = this.address();
    if (lba < 0 || lba >= drive.sectorCount) return this.fail(ERR_NOT_FOUND);
    const sector = drive.disk.read(lba);
    if (!sector) return this.fail(ERR_NOT_FOUND);
    drive.lba = lba;
    drive.remaining = count;
    drive.writing = false;
    drive.buffer.set(sector);
    drive.index = 0;
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
    this.setInterrupt(true);
    return undefined;
  }

  startWrite(drive, count) {
    const lba = this.address();
    if (lba < 0 || lba >= drive.sectorCount) return this.fail(ERR_NOT_FOUND);
    drive.lba = lba;
    drive.remaining = count;
    drive.writing = true;
    drive.index = 0;
    // In scrittura il disco non alza l'interruzione adesso: la alza quando ha
    // preso il settore. Il primo DRQ è un invito, non una risposta.
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
    return undefined;
  }

  /**
   * I 512 byte con cui un disco ATA si presenta: il nome, la geometria, quanti
   * settori ha davvero, e cosa sa fare. È la ragione per cui dal 1994 in poi
   * nessuno ha più dovuto scrivere il numero di cilindri negli interruttori del
   * BIOS — e il motivo per cui un disco comprato oggi si accende in una macchina
   * di trent'anni fa.
   */
  identify(drive) {
    const words = new Uint16Array(256);
    const put = (index, text, length) => {
      const padded = text.padEnd(length, ' ').slice(0, length);
      for (let i = 0; i < length; i += 2) {
        words[index + i / 2] = (padded.charCodeAt(i) << 8) | padded.charCodeAt(i + 1);
      }
    };
    const g = drive.disk.geometry ?? GEOMETRY;
    const megabytes = Math.round((drive.sectorCount * SECTOR) / 1024 / 1024);
    words[0] = 0x0040; // disco fisso, non rimovibile
    // Le due parole che la norma ha poi dichiarato superate e che i dischi
    // dell'epoca riempivano comunque: i byte di una traccia e quelli di un
    // settore, prima della formattazione. Il BIOS di Bochs ci prende la misura
    // del blocco da leggere, e con uno zero lì legge zero parole.
    words[4] = (SECTOR * (g.sectors ?? 17)) & 0xffff;
    words[5] = SECTOR;
    words[1] = Math.min(g.cylinders, 16383);
    words[3] = g.heads;
    words[6] = g.sectors;
    put(10, 'ALLOLDOS-IDE-1', 20); // numero di serie
    put(23, '1.0', 8); // versione del firmware
    put(27, `alloldos IDE ${megabytes} MB`, 40);
    words[47] = 0x8010; // sedici settori per volta nei trasferimenti a blocchi
    words[49] = 0x0300; // sa fare LBA e DMA
    words[51] = 0x0200; // tempi PIO
    words[53] = 0x0003; // le parole 54-58 e 64-70 sono valide
    words[54] = drive.logical.cylinders;
    words[55] = drive.logical.heads;
    words[56] = drive.logical.sectors;
    const capacity = drive.logical.cylinders * drive.logical.heads * drive.logical.sectors;
    words[57] = capacity & 0xffff;
    words[58] = (capacity >>> 16) & 0xffff;
    words[59] = 0x0100 | drive.multiple;
    // I settori contati dall'inizio: è questo il numero vero, e l'unico che non
    // sia una bugia gentile sulla forma dei piatti.
    words[60] = drive.sectorCount & 0xffff;
    words[61] = (drive.sectorCount >>> 16) & 0xffff;
    words[64] = 0x0003; // modi PIO avanzati
    words[80] = 0x0010; // ATA/ATAPI-4
    drive.buffer.set(new Uint8Array(words.buffer));
    drive.index = 0;
    drive.remaining = 1;
    drive.writing = false;
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
    this.setInterrupt(true);
  }
}

/**
 * I due canali insieme, che è come stanno dentro il ponte sud: quattro dischi in
 * tutto, e le porte di sempre.
 */
export class IDE {
  /**
   * @param {(irq:number, active:boolean)=>void} [onInterrupt]
   */
  constructor(onInterrupt) {
    this.channels = [
      new IDEChannel(PRIMARY, (active) => onInterrupt?.(PRIMARY.irq, active)),
      new IDEChannel(SECONDARY, (active) => onInterrupt?.(SECONDARY.irq, active)),
    ];
  }

  reset() {
    for (const channel of this.channels) channel.reset();
  }

  /** Il canale che risponde a una porta, o niente. */
  channelFor(port) {
    if (port >= PRIMARY.command && port < PRIMARY.command + 8) return this.channels[0];
    if (port === PRIMARY.control || port === PRIMARY.control + 1) return this.channels[0];
    if (port >= SECONDARY.command && port < SECONDARY.command + 8) return this.channels[1];
    if (port === SECONDARY.control || port === SECONDARY.control + 1) return this.channels[1];
    return null;
  }

  read(port) {
    return this.channelFor(port)?.read(port) ?? 0xff;
  }

  write(port, value) {
    this.channelFor(port)?.write(port, value);
  }

  /** Se una porta è quella dei dati, che è l'unica larga più di un byte. */
  isData(port) {
    return port === PRIMARY.command || port === SECONDARY.command;
  }

  readData(port, width) {
    return this.channelFor(port)?.readData(width) ?? 0xffff;
  }

  writeData(port, value, width) {
    this.channelFor(port)?.writeData(value, width);
  }

  /** Il disco montato sul primo posto del primo canale, che è C: per il DOS. */
  get master() {
    return this.channels[0].drives[0]?.disk ?? null;
  }
}
