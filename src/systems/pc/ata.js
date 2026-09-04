// L'hard disk, che su una macchina come questa è una scheda in più.
//
// Nel 1988 il disco fisso non era parte del computer: era un pezzo che si
// comprava dopo, si infilava in una fessura e si portava dietro il proprio
// BIOS. È per quello che la mappa di memoria del PC ha quel buco fra C000 e
// F000: il BIOS di sistema, appena finito il POST, ci passa sopra a passi di
// due KB, e ogni volta che trova 55 AA seguiti da una lunghezza e da una
// somma di controllo giusta salta dentro. La scheda si presenta, aggancia
// l'INT 13h, e da quel momento il DOS ha una lettera in più.
//
// Qui la scheda è una XT-CF: un adattatore fra il bus a otto bit e una scheda
// CompactFlash, che elettricamente è un disco IDE. È l'unica famiglia di
// schede per cui esista un BIOS libero — la XTIDE Universal BIOS, GPL — e
// quindi l'unico modo di dare un disco a questa macchina senza che sia
// l'emulatore a fingere le chiamate.
//
// Il protocollo è quello di tutti i dischi ATA, e non è cambiato più: si
// scrivono in cinque registri il numero di settori e l'indirizzo, si scrive
// il comando nel sesto, e poi si legge (o si scrive) il settore dalla porta
// dei dati mentre il bit DRQ è alto. La differenza della XT-CF è solo il
// cablaggio: i registri stanno a passi di due porte invece che una, perché il
// filo A0 del bus non arriva alla scheda, e i dati passano un byte per volta
// invece che due — è per questo che il BIOS della scheda, appena trova il
// disco, gli manda un "set features" per dirgli di parlare a otto bit.

/** Dove risponde la scheda: 300h è il ponticello di fabbrica di ogni XT-CF. */
export const XTCF_BASE = 0x300;
/** Trentadue porte: sedici per i registri, sedici per il blocco di controllo. */
export const XTCF_SIZE = 0x20;
/** Il blocco di controllo comincia dove si accende il filo A4. */
const CONTROL_BLOCK = 0x10;

/** Dove si affaccia la ROM della scheda: la finestra dei dischi. */
export const OPTION_ROM_BASE = 0xc8000;

/** I registri, come li chiama il manuale ATA. */
const REG_DATA = 0;
const REG_ERROR = 1; // in lettura l'errore, in scrittura le "features"
const REG_COUNT = 2;
const REG_SECTOR = 3;
const REG_CYL_LOW = 4;
const REG_CYL_HIGH = 5;
const REG_DRIVE_HEAD = 6;
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
 * La geometria del disco. Venti mega con 615 cilindri, 4 testine e 17 settori
 * è esattamente uno Seagate ST-225, il disco che c'era dentro mezzo mondo nel
 * 1988: un disco più grande sarebbe stato un lusso da workstation, e uno più
 * piccolo non ci avrebbe fatto stare il DOS e qualcosa da farci girare.
 */
export const GEOMETRY = { cylinders: 615, heads: 4, sectors: 17 };
export const DISK_SIZE = GEOMETRY.cylinders * GEOMETRY.heads * GEOMETRY.sectors * 512;

const SECTOR = 512;

/**
 * Il disco vero e proprio: un blocco di byte e la sua geometria.
 *
 * Un disco ATA si può indirizzare in due modi — per cilindro/testina/settore,
 * che è come sono fatti i dischi veri, o per numero progressivo (LBA), che è
 * come sono fatte le schede CF. I due conti portano allo stesso byte, e il
 * disco accetta tutti e due perché il DOS usa il primo e il BIOS della scheda
 * preferisce il secondo.
 */
export class HardDisk {
  constructor(image = null, geometry = GEOMETRY) {
    this.geometry = geometry;
    this.data = image ?? new Uint8Array(DISK_SIZE);
    /** Quante volte è stato scritto: serve a chi vuole riportarsi via l'immagine. */
    this.writes = 0;
  }

  get sectorCount() {
    return Math.floor(this.data.length / SECTOR);
  }

  read(lba) {
    const offset = lba * SECTOR;
    if (offset < 0 || offset + SECTOR > this.data.length) return null;
    return this.data.subarray(offset, offset + SECTOR);
  }

  write(lba, bytes) {
    const offset = lba * SECTOR;
    if (offset < 0 || offset + SECTOR > this.data.length) return false;
    this.data.set(bytes, offset);
    this.writes++;
    return true;
  }
}

export class XTCF {
  /**
   * @param {HardDisk|null} disk il disco montato sulla scheda, o niente
   */
  constructor(disk = null) {
    this.disk = disk;
    /**
     * La geometria che il disco *dice* di avere, che dopo un "initialize
     * device parameters" può non essere quella fisica: è così che i dischi
     * grandi entravano nei BIOS piccoli.
     */
    this.logical = { ...(disk?.geometry ?? GEOMETRY) };
    this.reset();
  }

  reset() {
    this.registers = new Uint8Array(8);
    this.registers[REG_COUNT] = 1;
    this.registers[REG_SECTOR] = 1;
    this.status = ST_READY | ST_SEEK_DONE;
    this.error = 0;
    this.features = 0;
    this.control = 0;
    /** Il settore in transito, e a che punto siamo dentro. */
    this.buffer = new Uint8Array(SECTOR);
    this.index = 0;
    this.remaining = 0;
    this.lba = 0;
    this.writing = false;
    this.eightBit = false;
    this.multiple = 1;
  }

  /** Se il disco selezionato adesso è quello che c'è davvero (il master). */
  get present() {
    return this.disk !== null && (this.registers[REG_DRIVE_HEAD] & 0x10) === 0;
  }

  // ---------------------------------------------------------------- il bus

  /** Da porta a registro: la scheda non riceve A0, quindi conta di due in due. */
  decode(port) {
    const offset = (port - XTCF_BASE) & (XTCF_SIZE - 1);
    return { register: (offset >> 1) & 7, control: (offset & CONTROL_BLOCK) !== 0 };
  }

  read(port) {
    const { register, control } = this.decode(port);
    // Un posto vuoto sul bus legge tutti uno; una scheda senza disco risponde
    // invece con uno stato a zero, ed è così che il BIOS distingue "non c'è
    // nessuna scheda" da "c'è la scheda ma il disco no".
    if (control) return register === 6 ? this.readStatus() : 0xff;
    if (!this.present) return register === REG_STATUS ? 0 : 0xff;
    switch (register) {
      case REG_DATA:
        return this.readData();
      case REG_ERROR:
        return this.error;
      case REG_STATUS:
        return this.readStatus();
      default:
        return this.registers[register];
    }
  }

  write(port, value) {
    value &= 0xff;
    const { register, control } = this.decode(port);
    if (control) {
      // Il registro di controllo: un bit per le interruzioni, uno per il
      // reset. La scheda XT-CF non ha nemmeno il filo dell'interruzione
      // collegato, e il BIOS della scheda infatti gira a domanda e risposta.
      if (register === 6) {
        if (value & 0x04) this.reset();
        this.control = value;
      }
      return;
    }
    switch (register) {
      case REG_DATA:
        return this.writeData(value);
      case REG_ERROR:
        this.features = value;
        return;
      case REG_STATUS:
        return this.execute(value);
      default:
        this.registers[register] = value;
    }
    return undefined;
  }

  readStatus() {
    return this.present ? this.status : 0;
  }

  // ------------------------------------------------------------- i settori

  readData() {
    if (!(this.status & ST_DRQ)) return 0xff;
    const byte = this.buffer[this.index++];
    if (this.index >= SECTOR) this.nextSector();
    return byte;
  }

  writeData(value) {
    if (!(this.status & ST_DRQ)) return;
    this.buffer[this.index++] = value;
    if (this.index >= SECTOR) {
      this.disk.write(this.lba, this.buffer);
      this.lba++;
      this.nextSector();
    }
  }

  /** Finito un settore: o ce n'è un altro, o il comando è finito. */
  nextSector() {
    this.index = 0;
    this.remaining--;
    if (this.remaining <= 0) {
      this.status = ST_READY | ST_SEEK_DONE;
      this.writing = false;
      return;
    }
    if (this.writing) {
      this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
      return;
    }
    this.lba++;
    const sector = this.disk.read(this.lba);
    if (!sector) return this.fail(ERR_NOT_FOUND);
    this.buffer.set(sector);
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
  }

  fail(code) {
    this.error = code;
    this.status = ST_READY | ST_SEEK_DONE | ST_ERROR;
    this.remaining = 0;
    this.index = 0;
  }

  /**
   * L'indirizzo che sta adesso nei registri, contato in settori dall'inizio.
   * Il bit 6 del registro testina dice in quale delle due lingue è scritto.
   */
  address() {
    const head = this.registers[REG_DRIVE_HEAD];
    if (head & 0x40) {
      return (
        ((head & 0x0f) << 24) |
        (this.registers[REG_CYL_HIGH] << 16) |
        (this.registers[REG_CYL_LOW] << 8) |
        this.registers[REG_SECTOR]
      );
    }
    const cylinder = (this.registers[REG_CYL_HIGH] << 8) | this.registers[REG_CYL_LOW];
    const sector = this.registers[REG_SECTOR];
    if (sector < 1) return -1;
    return (
      (cylinder * this.logical.heads + (head & 0x0f)) * this.logical.sectors + (sector - 1)
    );
  }

  // ------------------------------------------------------------- i comandi

  execute(command) {
    if (!this.present) return;
    this.error = 0;
    const count = this.registers[REG_COUNT] === 0 ? 256 : this.registers[REG_COUNT];

    switch (command) {
      case 0x20: // read sectors, con e senza rilettura in caso di errore
      case 0x21:
      case 0xc4: // read multiple: i byte escono comunque dalla stessa porta
        return this.startRead(count);
      case 0x30:
      case 0x31:
      case 0xc5:
        return this.startWrite(count);
      case 0x40:
      case 0x41: {
        // Verifica: legge e non consegna niente, serve solo a sapere se c'è.
        const lba = this.address();
        if (lba < 0 || lba + count > this.disk.sectorCount) return this.fail(ERR_NOT_FOUND);
        this.status = ST_READY | ST_SEEK_DONE;
        return undefined;
      }
      case 0x70: // seek
      case 0x90: // diagnostica: la scheda risponde "tutto bene" (codice 1)
      case 0xe0:
      case 0xe1:
      case 0xe2:
      case 0xe3:
      case 0xe5:
      case 0xe7: // flush: qui la scrittura è già arrivata a destinazione
        this.status = ST_READY | ST_SEEK_DONE;
        if (command === 0x90) this.error = 1;
        return undefined;
      case 0x91: {
        // Initialize device parameters: il disco accetta di raccontarsi con
        // un'altra geometria, purché ci stia dentro.
        this.logical.heads = (this.registers[REG_DRIVE_HEAD] & 0x0f) + 1;
        this.logical.sectors = this.registers[REG_COUNT];
        this.logical.cylinders = Math.floor(
          this.disk.sectorCount / Math.max(1, this.logical.heads * this.logical.sectors),
        );
        this.status = ST_READY | ST_SEEK_DONE;
        return undefined;
      }
      case 0xc6:
        this.multiple = this.registers[REG_COUNT] || 1;
        this.status = ST_READY | ST_SEEK_DONE;
        return undefined;
      case 0xec:
        return this.identify();
      case 0xef:
        // Set features: quella che conta è 01h, "parlami a otto bit", che è
        // la prima cosa che il BIOS della scheda chiede al disco.
        if (this.features === 0x01) this.eightBit = true;
        else if (this.features === 0x81) this.eightBit = false;
        this.status = ST_READY | ST_SEEK_DONE;
        return undefined;
      default:
        if (command >= 0x10 && command <= 0x1f) {
          // Recalibrate: sulle schede CF non c'è niente da riportare a casa.
          this.status = ST_READY | ST_SEEK_DONE;
          return undefined;
        }
        return this.fail(ERR_ABORT);
    }
  }

  startRead(count) {
    const lba = this.address();
    if (lba < 0 || lba >= this.disk.sectorCount) return this.fail(ERR_NOT_FOUND);
    this.lba = lba;
    this.remaining = count;
    this.writing = false;
    const sector = this.disk.read(lba);
    if (!sector) return this.fail(ERR_NOT_FOUND);
    this.buffer.set(sector);
    this.index = 0;
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
    return undefined;
  }

  startWrite(count) {
    const lba = this.address();
    if (lba < 0 || lba >= this.disk.sectorCount) return this.fail(ERR_NOT_FOUND);
    this.lba = lba;
    this.remaining = count;
    this.writing = true;
    this.index = 0;
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
    return undefined;
  }

  /**
   * I 512 byte con cui un disco ATA si presenta: la geometria, il nome, e
   * cosa sa fare. È la ragione per cui dagli anni Novanta in poi nessuno ha
   * più dovuto scrivere il numero di cilindri negli interruttori del BIOS.
   */
  identify() {
    const words = new Uint16Array(256);
    const put = (index, text, length) => {
      // Le stringhe ATA sono a coppie scambiate, perché il bus è a sedici bit
      // e i byte escono nell'ordine in cui stanno nella parola.
      const padded = text.padEnd(length, ' ').slice(0, length);
      for (let i = 0; i < length; i += 2) {
        words[index + i / 2] = (padded.charCodeAt(i) << 8) | padded.charCodeAt(i + 1);
      }
    };
    const g = this.disk.geometry;
    words[0] = 0x045a; // disco fisso, non rimovibile
    words[1] = g.cylinders;
    words[3] = g.heads;
    words[6] = g.sectors;
    put(10, 'ALLOLDOS-CF-1', 20); // numero di serie
    put(23, '1.0', 8); // versione del firmware
    put(27, 'alloldos XT-CF 20 MB', 40);
    words[47] = 0x8001; // un settore per volta nei trasferimenti a blocchi
    words[49] = 0x0200; // sa parlare in LBA
    words[51] = 0x0200;
    words[53] = 0x0001; // le parole 54-58 sono valide
    words[54] = this.logical.cylinders;
    words[55] = this.logical.heads;
    words[56] = this.logical.sectors;
    const capacity = this.logical.cylinders * this.logical.heads * this.logical.sectors;
    words[57] = capacity & 0xffff;
    words[58] = (capacity >> 16) & 0xffff;
    words[60] = this.disk.sectorCount & 0xffff;
    words[61] = (this.disk.sectorCount >> 16) & 0xffff;
    this.buffer.set(new Uint8Array(words.buffer));
    this.index = 0;
    this.remaining = 1;
    this.writing = false;
    this.status = ST_READY | ST_SEEK_DONE | ST_DRQ;
  }
}
