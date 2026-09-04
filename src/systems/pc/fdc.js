// Il NEC 765, che è il pezzo che trasforma una scheda madre in un computer.
//
// Fino a qui la macchina sa contare la memoria e stampare a schermo, ma non ha
// nessun posto da cui prendere qualcosa da fare: il POST arriva in fondo e si
// ferma su "Disk Boot Fail". Il controllore del disco è la porta da cui entra
// il sistema operativo, e il modo in cui entra è sempre lo stesso da
// quarant'anni: il BIOS legge un solo settore — cilindro 0, testina 0, settore
// 1 — lo mette a 0000:7C00 e ci salta dentro. Tutto quello che il DOS è, entra
// da quei 512 byte.
//
// Il 765 si programma a pacchetti: si scrivono uno dopo l'altro i byte del
// comando sulla porta dei dati, guardando ogni volta il registro di stato per
// sapere se il chip è pronto e da che parte sta guardando; poi il chip esegue,
// e quando ha finito alza la IRQ 6; poi si rileggono dalla stessa porta i byte
// del risultato, sempre uno alla volta, finché il chip non dice che ha finito
// di parlare. È un protocollo lento e pieno di attese, ed è per questo che il
// BIOS dorme con HLT mentre aspetta.
//
// I dati però non passano di qui. Il 765 non ha nessun buffer da leggere: i
// byte del settore li mette in memoria il DMA, un byte per volta, mentre il
// processore è fermo. È per questo che ogni operazione ha due metà — la
// programmazione del canale 2, che fa il BIOS, e i byte, che scorrono da soli —
// e che qui il trasferimento vero è una riga sola in mezzo al comando.

/** Le porte del controllore, come le ha lasciate IBM sul bus dell'XT. */
export const FDC_BASE = 0x3f0;
export const FDC_DOR = 0x3f2; // Digital Output: motori, selezione, reset
export const FDC_MSR = 0x3f4; // Main Status: chi può parlare, e in che verso
export const FDC_DATA = 0x3f5; // comandi, parametri e risultati, tutti da qui

/** I bit del registro di stato principale. */
const MSR_RQM = 0x80; // il chip è pronto a un byte
const MSR_DIO = 0x40; // 1 = ha qualcosa da dire, 0 = sta ascoltando
const MSR_NDMA = 0x20; // trasferimento senza DMA, che qui non si usa mai
const MSR_BUSY = 0x10; // un comando è in corso: è così che si sa se il
//                        risultato è finito, perché non se ne dice la lunghezza

/** I bit del Digital Output Register. */
const DOR_RESET = 0x04; // a zero il chip è tenuto in reset
const DOR_DMA = 0x08; // collega DMA e interruzioni al bus
const DOR_MOTOR = 0xf0;

/** I formati che un lettore da 5¼ o 3½ può avere sotto la testina. */
export const FORMATS = [
  { size: 163840, cylinders: 40, heads: 1, sectors: 8, label: '160 KB' },
  { size: 184320, cylinders: 40, heads: 1, sectors: 9, label: '180 KB' },
  { size: 327680, cylinders: 40, heads: 2, sectors: 8, label: '320 KB' },
  { size: 368640, cylinders: 40, heads: 2, sectors: 9, label: '360 KB' },
  { size: 737280, cylinders: 80, heads: 2, sectors: 9, label: '720 KB' },
  { size: 1228800, cylinders: 80, heads: 2, sectors: 15, label: '1,2 MB' },
  { size: 1474560, cylinders: 80, heads: 2, sectors: 18, label: '1,44 MB' },
];

/** Riconosce un'immagine dalla sua lunghezza, che è l'unica cosa che ha. */
export function formatOf(bytes) {
  return FORMATS.find((format) => format.size === bytes.length) ?? null;
}

/**
 * Un lettore, con dentro o senza niente.
 *
 * Il disco è un array di byte e basta: un'immagine `.img` è la copia dei
 * settori uno dietro l'altro, nell'ordine in cui li leggerebbe il controllore.
 * Non c'è nessuna codifica MFM da simulare — il 765 la fa e la disfa da sé, e
 * quello che passa sul bus sono già byte.
 */
export class FloppyDrive {
  constructor() {
    this.medium = null;
    this.format = null;
    this.writeProtected = false;
    /** Dove sta la testina: il chip se lo ricorda per ogni lettore. */
    this.cylinder = 0;
    this.motor = false;
    /** Quante volte il disco è stato scritto, per chi vuole riaverselo. */
    this.writes = 0;
  }

  insert(bytes, { writeProtected = false } = {}) {
    const format = formatOf(bytes);
    if (!format) return false;
    this.medium = bytes;
    this.format = format;
    this.writeProtected = writeProtected;
    this.writes = 0;
    return true;
  }

  eject() {
    this.medium = null;
    this.format = null;
  }

  get ready() {
    return this.medium !== null;
  }

  /**
   * Dove comincia un settore dentro l'immagine, o -1 se quel settore non
   * esiste. La formula è l'ordine in cui i settori stanno su un disco vero:
   * tutta la traccia di sopra, poi tutta quella di sotto, poi il cilindro dopo.
   */
  offset(cylinder, head, sector) {
    const f = this.format;
    if (!f) return -1;
    if (cylinder < 0 || cylinder >= f.cylinders) return -1;
    if (head < 0 || head >= f.heads) return -1;
    if (sector < 1 || sector > f.sectors) return -1;
    return ((cylinder * f.heads + head) * f.sectors + (sector - 1)) * 512;
  }
}

/** Quanti byte ha un settore, dal codice N che sta nel comando. */
const sectorSize = (n) => 128 << Math.min(n & 7, 6);

export class FDC765 {
  /**
   * @param {object} hooks
   * @param {object} hooks.dma il controllore di DMA, di cui si usa il canale 2
   * @param {(irq:number)=>void} hooks.onInterrupt il filo della IRQ 6
   */
  constructor(hooks = {}) {
    this.dma = hooks.dma ?? null;
    this.onInterrupt = hooks.onInterrupt ?? (() => {});
    this.drives = [new FloppyDrive(), new FloppyDrive()];
    this.reset();
  }

  reset() {
    this.dor = 0;
    this.phase = 'command';
    this.command = [];
    this.expected = 1;
    this.result = [];
    this.resultIndex = 0;
    /**
     * Quante volte ancora la "sense interrupt status" deve rispondere che c'è
     * stato un reset. Il chip vero, appena riacceso, interroga tutti e quattro
     * i lettori e tiene in coda quattro risposte: chi resetta il controllore
     * legge la prima e va avanti.
     */
    this.resetSense = 0;
    /** L'ultimo stato di fine comando, che la sense interrupt tira fuori. */
    this.st0 = 0;
    this.seekEnd = false;
    this.drive = 0;
    this.head = 0;
    for (const drive of this.drives) {
      drive.cylinder = 0;
      drive.motor = false;
    }
  }

  /** Il lettore selezionato adesso dal Digital Output Register. */
  get selected() {
    return this.drives[this.dor & 3] ?? this.drives[0];
  }

  /** Se qualche motore gira: serve solo alla spia sul davanti. */
  get motorOn() {
    return (this.dor & DOR_MOTOR) !== 0;
  }

  // ---------------------------------------------------------------- le porte

  read(port) {
    switch (port & 7) {
      case 4:
        return this.status();
      case 5:
        return this.readData();
      default:
        // Sulle schede XT il resto della finestra non risponde: le porte di
        // stato A e B e il registro della velocità sono roba da AT.
        return 0xff;
    }
  }

  write(port, value) {
    value &= 0xff;
    switch (port & 7) {
      case 2:
        return this.writeDOR(value);
      case 5:
        return this.writeData(value);
      default:
    }
    return undefined;
  }

  status() {
    if (!(this.dor & DOR_RESET)) return 0; // tenuto in reset: non risponde
    let msr = MSR_RQM;
    if (this.phase === 'result') msr |= MSR_DIO | MSR_BUSY;
    else if (this.phase === 'execute') msr |= MSR_BUSY;
    else if (this.command.length > 0) msr |= MSR_BUSY;
    return msr;
  }

  /**
   * Il Digital Output Register. Il bit 2 è il filo di reset del chip, e il
   * modo in cui ogni BIOS al mondo azzera il controllore è tenerlo basso per
   * un attimo e rialzarlo: sul fronte di salita il 765 riparte e alza subito
   * la sua interruzione, con quattro risposte di reset in canna.
   */
  writeDOR(value) {
    const was = this.dor;
    this.dor = value;
    for (let i = 0; i < this.drives.length; i++) {
      this.drives[i].motor = (value & (0x10 << i)) !== 0;
    }
    if (!(was & DOR_RESET) && value & DOR_RESET) {
      this.phase = 'command';
      this.command = [];
      this.result = [];
      this.resetSense = 4;
      this.st0 = 0xc0;
      this.seekEnd = true;
      if (value & DOR_DMA) this.onInterrupt();
    }
  }

  readData() {
    if (this.phase !== 'result') return 0xff;
    const byte = this.result[this.resultIndex++] ?? 0xff;
    if (this.resultIndex >= this.result.length) {
      this.phase = 'command';
      this.result = [];
      this.resultIndex = 0;
    }
    return byte;
  }

  writeData(value) {
    if (this.phase !== 'command') return;
    if (this.command.length === 0) {
      this.expected = COMMAND_LENGTH[value & 0x1f] ?? 1;
    }
    this.command.push(value);
    if (this.command.length >= this.expected) this.execute();
  }

  // ------------------------------------------------------------- i comandi

  finish(result, interrupt = true) {
    this.command = [];
    if (result.length === 0) {
      this.phase = 'command';
    } else {
      this.phase = 'result';
      this.result = result;
      this.resultIndex = 0;
    }
    if (interrupt && this.dor & DOR_DMA) this.onInterrupt();
  }

  execute() {
    const cmd = this.command[0] & 0x1f;
    switch (cmd) {
      case 0x03: // specify: tempi di passo e di carico della testina
        return this.finish([], false);
      case 0x04:
        return this.senseDrive();
      case 0x07:
        return this.recalibrate();
      case 0x08:
        return this.senseInterrupt();
      case 0x0f:
        return this.seek();
      case 0x02: // read track
      case 0x05: // write
      case 0x06: // read
      case 0x09: // write deleted
      case 0x0c: // read deleted
        return this.transfer(cmd);
      case 0x0a:
        return this.readID();
      case 0x0d:
        return this.formatTrack();
      default:
        // Comando che non esiste: un solo byte di risposta, con il codice che
        // vuol dire "e questo cosa sarebbe".
        return this.finish([0x80]);
    }
  }

  /** Il byte che sta in cima a quasi tutte le risposte: com'è finita. */
  makeST0(code = 0, extra = 0) {
    return (code << 6) | (this.head ? 4 : 0) | (this.drive & 3) | extra;
  }

  senseDrive() {
    this.drive = this.command[1] & 3;
    this.head = (this.command[1] >> 2) & 1;
    const drive = this.drives[this.drive];
    let st3 = 0x20 | (this.head << 2) | this.drive; // pronto
    if (drive.cylinder === 0) st3 |= 0x10; // sulla traccia zero
    if (drive.format && drive.format.heads > 1) st3 |= 0x08; // due facce
    if (drive.writeProtected) st3 |= 0x40;
    this.finish([st3], false);
  }

  /**
   * La sense interrupt status: l'unico modo che il processore ha di sapere
   * perché il chip ha alzato la IRQ. Chiamarla quando non c'è niente da
   * raccontare è un errore, e il chip risponde con il codice del comando
   * sbagliato — il BIOS ci conta per capire se un'interruzione era sua.
   */
  senseInterrupt() {
    if (this.resetSense > 0) {
      const drive = 4 - this.resetSense;
      this.resetSense--;
      this.finish([0xc0 | drive, this.drives[drive & 1]?.cylinder ?? 0], false);
      return;
    }
    if (!this.seekEnd) {
      this.finish([0x80], false);
      return;
    }
    this.seekEnd = false;
    this.finish([this.st0, this.drives[this.drive].cylinder], false);
  }

  recalibrate() {
    this.drive = this.command[1] & 3;
    this.head = 0;
    const drive = this.drives[this.drive];
    drive.cylinder = 0;
    // Una ricalibrazione finita conta più di quello che il chip aveva da dire
    // sull'accensione: ora la posizione della testina la sa per averla vista.
    this.resetSense = 0;
    this.seekEnd = true;
    // Senza disco la testina non trova mai la traccia zero: il chip ci prova
    // per settantasette passi e poi si arrende con l'errore di ricerca.
    this.st0 = drive.ready ? this.makeST0(0, 0x20) : this.makeST0(1, 0x30);
    this.finish([]);
  }

  seek() {
    this.drive = this.command[1] & 3;
    this.head = (this.command[1] >> 2) & 1;
    const drive = this.drives[this.drive];
    drive.cylinder = this.command[2] & 0xff;
    this.resetSense = 0;
    this.seekEnd = true;
    this.st0 = drive.ready ? this.makeST0(0, 0x20) : this.makeST0(1, 0x30);
    this.finish([]);
  }

  readID() {
    this.drive = this.command[1] & 3;
    this.head = (this.command[1] >> 2) & 1;
    const drive = this.drives[this.drive];
    if (!drive.ready) return this.abort(0x01, 0x00);
    this.st0 = this.makeST0(0);
    this.finish([this.st0, 0, 0, drive.cylinder, this.head, 1, 2]);
  }

  /** Una fine storta: i tre byte di stato più la posizione dove si è fermato. */
  abort(st1, st2, cylinder = 0, head = 0, sector = 0, n = 2) {
    const drive = this.drives[this.drive];
    this.st0 = this.makeST0(1, drive.ready ? 0 : 0x08);
    this.finish([this.st0, st1, st2, cylinder, head, sector, n]);
  }

  /**
   * Lettura e scrittura, che sul 765 sono lo stesso comando in due versi.
   *
   * Il chip parte dal settore che gli si dice e va avanti da solo fino alla
   * fine della traccia (il parametro EOT); se il comando ha il bit multi-track
   * arrivato in fondo passa all'altra faccia. Ma non è lui a decidere quando
   * smettere: smette quando il DMA gli dice che il blocco è finito, e a quel
   * punto racconta dov'era arrivato. Il BIOS ricava da quella posizione quanti
   * settori sono passati, ed è per questo che deve essere quella giusta:
   * la posizione *dopo* l'ultimo settore trasferito.
   */
  transfer(cmd) {
    const multitrack = (this.command[0] & 0x80) !== 0;
    this.drive = this.command[1] & 3;
    this.head = (this.command[1] >> 2) & 1;
    const drive = this.drives[this.drive];
    let cylinder = this.command[2] & 0xff;
    let head = this.command[3] & 1;
    let sector = this.command[4] & 0xff;
    const n = this.command[5] & 0xff;
    const eot = this.command[6] & 0xff;
    const size = n === 0 ? Math.min(this.command[8] & 0xff, 128) : sectorSize(n);
    const writing = cmd === 0x05 || cmd === 0x09;

    if (!drive.ready) return this.abort(0x00, 0x00, cylinder, head, sector, n);
    if (writing && drive.writeProtected) return this.abort(0x02, 0x00, cylinder, head, sector, n);
    if (cylinder !== drive.cylinder) {
      // La testina è su un'altra traccia: il chip legge gli indirizzi che
      // trova scritti sul disco, non li trova, e dice che il settore non c'è.
      return this.abort(0x04, 0x00, cylinder, head, sector, n);
    }

    for (;;) {
      const offset = drive.offset(cylinder, head, sector);
      if (offset < 0) return this.abort(0x04, 0x00, cylinder, head, sector, n);
      if (writing) drive.writes++;

      let ended = false;
      for (let i = 0; i < size; i++) {
        if (writing) {
          const byte = this.dma.transfer(2, null);
          if (byte < 0) {
            ended = true;
            break;
          }
          drive.medium[offset + i] = byte;
        } else {
          if (this.dma.transfer(2, drive.medium[offset + i]) < 0) {
            ended = true;
            break;
          }
        }
        if (this.dma.terminal(2)) {
          // Fine conteggio: il DMA ha finito il suo blocco e alza il filo TC,
          // che per il 765 vuol dire "questo settore era l'ultimo".
          ended = true;
          break;
        }
      }

      // Avanti di un settore, come farebbe la testina: fine traccia, poi
      // eventualmente l'altra faccia, poi il cilindro dopo.
      if (sector >= eot) {
        sector = 1;
        if (multitrack && head === 0 && drive.format.heads > 1) head = 1;
        else {
          head = multitrack ? 0 : head;
          cylinder++;
        }
      } else {
        sector++;
      }

      if (ended) break;
    }

    this.st0 = this.makeST0(0);
    this.finish([this.st0, 0, 0, cylinder, head, sector, n]);
  }

  /**
   * La formattazione di una traccia. Il DOS manda quattro byte per settore —
   * cilindro, testina, numero, dimensione — e il controllore scrive gli
   * indirizzi e riempie i dati con il byte di riempimento. Qui non ci sono
   * indirizzi da scrivere: un'immagine è già tutta traccia, e formattare vuol
   * dire soltanto cancellare.
   */
  formatTrack() {
    this.drive = this.command[1] & 3;
    this.head = (this.command[1] >> 2) & 1;
    const drive = this.drives[this.drive];
    const n = this.command[2] & 0xff;
    const count = this.command[3] & 0xff;
    const filler = this.command[5] & 0xff;
    const size = sectorSize(n);
    if (!drive.ready) return this.abort(0x00, 0x00);
    if (drive.writeProtected) return this.abort(0x02, 0x00);

    let cylinder = drive.cylinder;
    let head = this.head;
    for (let i = 0; i < count; i++) {
      const c = this.dma.transfer(2, null);
      const h = this.dma.transfer(2, null);
      const r = this.dma.transfer(2, null);
      this.dma.transfer(2, null);
      if (c < 0 || h < 0 || r < 0) break;
      cylinder = c;
      head = h;
      const offset = drive.offset(c, h, r);
      if (offset >= 0) {
        drive.medium.fill(filler, offset, offset + size);
        drive.writes++;
      }
    }
    this.st0 = this.makeST0(0);
    this.finish([this.st0, 0, 0, cylinder, head, count + 1, n]);
  }
}

/**
 * Quanti byte è lungo ogni comando, compreso il byte del comando stesso. È la
 * sola cosa che il chip deve sapere in anticipo: legge quel numero di byte e
 * poi esegue, e se ne arrivano di più sono di un altro comando.
 */
const COMMAND_LENGTH = {
  0x02: 9, // read track
  0x03: 3, // specify
  0x04: 2, // sense drive status
  0x05: 9, // write data
  0x06: 9, // read data
  0x07: 2, // recalibrate
  0x08: 1, // sense interrupt status
  0x09: 9, // write deleted data
  0x0a: 2, // read id
  0x0c: 9, // read deleted data
  0x0d: 6, // format track
  0x0f: 3, // seek
};
