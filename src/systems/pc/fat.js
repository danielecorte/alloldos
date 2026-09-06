// Mettere un file sul disco fisso senza chiederlo al DOS.
//
// Fin qui la regola di questa macchina è stata di non scrivere un byte di
// filesystem: la tabella delle partizioni e la FAT le hanno scritte FDISK e
// FORMAT veri, girando sul 286, perché era l'unico modo di essere sicuri che
// fossero giuste. Qui quella regola si rompe, e vale la pena dire perché.
//
// Un file che arriva dal browser deve entrare nel disco, e nel disco non c'è
// nessuna porta: la macchina emulata legge settori, e i settori li dispone il
// filesystem. Fare fare il lavoro al DOS vorrebbe dire battergli il file sulla
// tastiera un byte per volta con DEBUG, che per un dischetto di roba vuol dire
// una giornata. Quindi la FAT la scriviamo noi — ma il giudice resta FreeDOS:
// la prova, in `pctest.mjs`, scrive di qua a macchina spenta, poi l'accende e
// non tocca più niente. È il DOS a fare `DIR`, a fare `TYPE`, a caricare e far
// girare un programma uscito da uno zip, a scriverci accanto un file suo, e
// alla fine a cancellare tutto quanto: se il disco torna libero degli stessi
// byte che aveva prima, ogni catena e ogni voce di cartella era al suo posto,
// e a dirlo è lui e non noi.
//
// Che cosa è una FAT16, in tre righe. Il disco è diviso in cluster — qui due
// KB, quattro settori — e la FAT è una fila di numeri, uno per cluster, che
// dice qual è il pezzo dopo: un file è una catena, il suo primo anello sta
// nella voce di cartella insieme al nome, e l'ultimo ha per numero FFFF. Le
// cartelle sono file anche loro, con dentro le voci da trentadue byte; quella
// principale però sta in un posto fisso e ha un numero massimo di voci, che è
// il motivo per cui su un disco DOS la radice si riempie e le sottocartelle no.

const SECTOR = 512;
const ENTRY = 32;

/** Gli attributi di una voce di cartella, quelli che ci servono. */
const ATTR_DIRECTORY = 0x10;
const ATTR_ARCHIVE = 0x20;
const ATTR_LABEL = 0x08;

/** I due modi in cui una voce può essere libera: mai usata, oppure cancellata. */
const NEVER_USED = 0x00;
const DELETED = 0xe5;

/** L'ultimo anello di una catena. */
const END_OF_CHAIN = 0xffff;

/** I tipi di partizione che sanno essere una FAT16. */
const FAT16_TYPES = [0x04, 0x06, 0x0e];

const readU16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const readU32 = (bytes, at) => (readU16(bytes, at) | (readU16(bytes, at + 2) << 16)) >>> 0;

function writeU16(bytes, at, value) {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
}

function writeU32(bytes, at, value) {
  writeU16(bytes, at, value & 0xffff);
  writeU16(bytes, at + 2, (value >>> 16) & 0xffff);
}

/** Quello che il DOS non accetta in un nome, e che quindi diventa un underscore. */
const FORBIDDEN = new Set('"*+,/:;<=>?[\\]|. '.split(''));

/**
 * Un nome come lo vuole il DOS: otto caratteri, un punto, altri tre, e tutto
 * maiuscolo. I nomi lunghi non esistono ancora — arriveranno con Windows 95,
 * sette anni dopo questa macchina — quindi `relazione finale.txt` diventa
 * `RELAZION.TXT`, esattamente come sarebbe successo allora copiandolo da un
 * dischetto formattato altrove.
 *
 * @param {string} name
 * @returns {{base:string, ext:string}}
 */
export function shortName(name) {
  // Gli spazi spariscono e basta — è quello che fa il DOS, e `appunti di
  // ieri.txt` diventa `APPUNTID.TXT` — mentre quello che non è un carattere
  // buono diventa un underscore, che almeno si vede che c'era qualcosa.
  const clean = (text) =>
    [...text]
      .map((char) => {
        const upper = char.toUpperCase();
        if (upper === ' ') return '';
        if (upper.charCodeAt(0) > 126 || FORBIDDEN.has(upper)) return '_';
        return upper;
      })
      .join('');

  const dot = name.lastIndexOf('.');
  const rawBase = dot > 0 ? name.slice(0, dot) : name;
  const rawExt = dot > 0 ? name.slice(dot + 1) : '';
  const base = clean(rawBase).slice(0, 8).replace(/_+$/, '') || 'FILE';
  return { base, ext: clean(rawExt).slice(0, 3) };
}

/** Gli undici byte come stanno scritti nella voce: nome e tipo, senza il punto. */
function packName({ base, ext }) {
  return base.padEnd(8, ' ') + ext.padEnd(3, ' ');
}

/** E come si legge, per farlo vedere a chi ha trascinato il file. */
export function displayName(packed) {
  const base = packed.slice(0, 8).trimEnd();
  const ext = packed.slice(8, 11).trimEnd();
  return ext ? `${base}.${ext}` : base;
}

/**
 * L'ora come la scrive il DOS: due parole da sedici bit, con i secondi divisi
 * per due e gli anni contati dal 1980 — che è quanto bastava a chi progettava
 * un formato pensando che sarebbe durato qualche anno.
 */
function dosStamp(when = new Date()) {
  const year = Math.min(Math.max(when.getFullYear(), 1980), 2107) - 1980;
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: (year << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

export class FullDiskError extends Error {
  constructor(needed, free) {
    super(`servono ${needed} byte e sul disco ce ne sono ${free}`);
    this.name = 'FullDiskError';
    this.needed = needed;
    this.free = free;
  }
}

export class FullDirectoryError extends Error {
  constructor() {
    super('la cartella principale è piena');
    this.name = 'FullDirectoryError';
  }
}

/**
 * Il filesystem di una partizione, aperto sopra l'immagine del disco. Non
 * copia niente: lavora sui byte dell'immagine che ha in mano, che sono gli
 * stessi che la macchina legge attraverso la scheda.
 */
export class FAT16 {
  /**
   * Trova la partizione e ci si apre sopra, o restituisce null se lì dentro
   * non c'è niente da leggere — un disco appena comprato, per esempio.
   *
   * @param {Uint8Array} image
   * @returns {?FAT16}
   */
  static of(image) {
    if (image.length < 2 * SECTOR) return null;
    if (image[510] !== 0x55 || image[511] !== 0xaa) return null;
    for (let i = 0; i < 4; i++) {
      const at = 446 + i * 16;
      const sectors = readU32(image, at + 12);
      if (!sectors || !FAT16_TYPES.includes(image[at + 4])) continue;
      const volume = new FAT16(image, readU32(image, at + 8));
      if (volume.valid) return volume;
    }
    return null;
  }

  /**
   * @param {Uint8Array} image l'immagine di tutto il disco
   * @param {number} start il settore in cui comincia la partizione
   */
  constructor(image, start) {
    this.image = image;
    this.start = start;

    const boot = start * SECTOR;
    this.bytesPerSector = readU16(image, boot + 11);
    this.sectorsPerCluster = image[boot + 13];
    this.reserved = readU16(image, boot + 14);
    this.fatCopies = image[boot + 16];
    this.rootEntries = readU16(image, boot + 17);
    this.fatSectors = readU16(image, boot + 22);
    const small = readU16(image, boot + 19);
    this.totalSectors = small || readU32(image, boot + 32);

    this.fatStart = start + this.reserved;
    this.rootStart = this.fatStart + this.fatCopies * this.fatSectors;
    this.rootSectors = Math.ceil((this.rootEntries * ENTRY) / SECTOR);
    this.dataStart = this.rootStart + this.rootSectors;
    this.clusterSize = this.sectorsPerCluster * SECTOR;
    this.clusters = Math.floor((this.totalSectors - (this.dataStart - start)) / this.sectorsPerCluster);

    this.valid =
      this.bytesPerSector === SECTOR &&
      this.sectorsPerCluster > 0 &&
      this.fatCopies > 0 &&
      this.rootEntries > 0 &&
      this.fatSectors > 0 &&
      this.clusters > 4084 && // sotto questa soglia sarebbe una FAT12
      (this.dataStart + this.clusters * this.sectorsPerCluster) * SECTOR <= image.length;
  }

  /** L'etichetta scritta da FORMAT, che sta in una voce della radice. */
  get label() {
    for (const at of this.slots(null)) {
      if (this.image[at] === NEVER_USED) break;
      if (this.image[at] === DELETED) continue;
      if ((this.image[at + 11] & ATTR_LABEL) === 0) continue;
      return displayName(this.text(at, 11)).replace('.', '');
    }
    return '';
  }

  /** Quanto ci sta ancora: i cluster liberi, in byte. */
  get freeBytes() {
    let free = 0;
    for (let cluster = 2; cluster < this.clusters + 2; cluster++) {
      if (this.getFAT(cluster) === 0) free += this.clusterSize;
    }
    return free;
  }

  // ------------------------------------------------------------------ la FAT

  getFAT(cluster) {
    return readU16(this.image, this.fatStart * SECTOR + cluster * 2);
  }

  /** Un numero si scrive in tutte le copie della FAT: è per questo che ce ne sono due. */
  setFAT(cluster, value) {
    for (let copy = 0; copy < this.fatCopies; copy++) {
      const base = (this.fatStart + copy * this.fatSectors) * SECTOR;
      writeU16(this.image, base + cluster * 2, value);
    }
  }

  /**
   * Prende dei cluster liberi e li lega in catena. Non ne prende nessuno se
   * non ce ne sono abbastanza: meglio dire di no che lasciare un file a metà.
   *
   * @param {number} count
   * @returns {number[]}
   */
  allocate(count) {
    const found = [];
    for (let cluster = 2; cluster < this.clusters + 2 && found.length < count; cluster++) {
      if (this.getFAT(cluster) === 0) found.push(cluster);
    }
    if (found.length < count) {
      throw new FullDiskError(count * this.clusterSize, found.length * this.clusterSize);
    }
    found.forEach((cluster, i) => {
      this.setFAT(cluster, i + 1 < found.length ? found[i + 1] : END_OF_CHAIN);
    });
    return found;
  }

  /** Gli anelli di una catena, dal primo all'ultimo. */
  chain(first) {
    const clusters = [];
    let cluster = first;
    while (cluster >= 2 && cluster < 0xfff8 && !clusters.includes(cluster)) {
      clusters.push(cluster);
      cluster = this.getFAT(cluster);
    }
    return clusters;
  }

  /** Libera una catena: i cluster tornano a zero, e i byte restano dove sono. */
  release(first) {
    for (const cluster of this.chain(first)) this.setFAT(cluster, 0);
  }

  /** Dove comincia un cluster dentro l'immagine. */
  offsetOf(cluster) {
    return (this.dataStart + (cluster - 2) * this.sectorsPerCluster) * SECTOR;
  }

  // ------------------------------------------------------------- le cartelle

  /**
   * Le posizioni delle voci di una cartella, una per una. La radice è un
   * pezzo di disco con un numero fisso di posti; una sottocartella è un file
   * come gli altri, e quindi cresce.
   *
   * @param {?number} cluster il primo cluster, o null per la radice
   */
  *slots(cluster) {
    if (cluster === null || cluster === 0) {
      const base = this.rootStart * SECTOR;
      for (let i = 0; i < this.rootEntries; i++) yield base + i * ENTRY;
      return;
    }
    for (const link of this.chain(cluster)) {
      const base = this.offsetOf(link);
      for (let i = 0; i < this.clusterSize / ENTRY; i++) yield base + i * ENTRY;
    }
  }

  text(at, length) {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.image[at + i]);
    return out;
  }

  /** La voce con quel nome, se in quella cartella c'è. */
  find(dir, packed) {
    for (const at of this.slots(dir)) {
      if (this.image[at] === NEVER_USED) return -1;
      if (this.image[at] === DELETED) continue;
      if (this.text(at, 11) === packed) return at;
    }
    return -1;
  }

  /**
   * Un posto libero dove scrivere una voce nuova. Se una sottocartella è
   * piena le si attacca un cluster in più; se è piena la radice non si può
   * fare niente, ed è una cosa che sui dischi DOS capitava davvero.
   */
  freeSlot(dir) {
    for (const at of this.slots(dir)) {
      if (this.image[at] === NEVER_USED || this.image[at] === DELETED) return at;
    }
    if (dir === null || dir === 0) throw new FullDirectoryError();

    const [grown] = this.allocate(1);
    this.image.fill(0, this.offsetOf(grown), this.offsetOf(grown) + this.clusterSize);
    const last = this.chain(dir).pop();
    this.setFAT(last, grown);
    this.setFAT(grown, END_OF_CHAIN);
    return this.offsetOf(grown);
  }

  /** Scrive una voce: il nome, il tipo, l'ora, il primo anello e la lunghezza. */
  writeEntry(at, packed, attributes, cluster, size) {
    const { time, date } = dosStamp();
    this.image.fill(0, at, at + ENTRY);
    for (let i = 0; i < 11; i++) this.image[at + i] = packed.charCodeAt(i);
    this.image[at + 11] = attributes;
    writeU16(this.image, at + 14, time);
    writeU16(this.image, at + 16, date);
    writeU16(this.image, at + 18, date);
    writeU16(this.image, at + 22, time);
    writeU16(this.image, at + 24, date);
    writeU16(this.image, at + 26, cluster);
    writeU32(this.image, at + 28, size);
  }

  /**
   * Un nome che in quella cartella non c'è ancora. Se c'è, si accorcia e si
   * numera — `RELAZION.TXT`, `RELAZI~1.TXT` — che è quello che farà Windows
   * dieci anni dopo per la stessa ragione.
   */
  uniqueName(dir, name) {
    const wanted = shortName(name);
    if (this.find(dir, packName(wanted)) < 0) return wanted;
    for (let n = 1; n < 1000; n++) {
      const suffix = `~${n}`;
      const base = wanted.base.slice(0, Math.max(1, 8 - suffix.length)) + suffix;
      const candidate = { base, ext: wanted.ext };
      if (this.find(dir, packName(candidate)) < 0) return candidate;
    }
    throw new Error(`troppi file che si chiamano come ${name}`);
  }

  /**
   * Crea una cartella dentro un'altra e restituisce il suo primo cluster. Le
   * due voci `.` e `..` che ci finiscono dentro non sono un vezzo: sono il
   * solo modo che il DOS ha di risalire da una cartella a quella di sopra.
   *
   * @param {?number} dir
   * @param {string} name
   * @returns {number}
   */
  mkdir(dir, name) {
    const packed = packName(shortName(name));
    const existing = this.find(dir, packed);
    if (existing >= 0 && this.image[existing + 11] & ATTR_DIRECTORY) {
      return readU16(this.image, existing + 26);
    }
    if (existing >= 0) throw new Error(`${name} c'è già, e non è una cartella`);

    const [cluster] = this.allocate(1);
    const at = this.offsetOf(cluster);
    this.image.fill(0, at, at + this.clusterSize);
    this.writeEntry(at, '.          ', ATTR_DIRECTORY, cluster, 0);
    this.writeEntry(at + ENTRY, '..         ', ATTR_DIRECTORY, dir ?? 0, 0);
    this.writeEntry(this.freeSlot(dir), packed, ATTR_DIRECTORY, cluster, 0);
    return cluster;
  }

  /**
   * Le cartelle di un percorso, creando quelle che mancano — `MD` per ogni
   * pezzo, che è quello che si faceva a mano.
   *
   * @param {string|string[]} path
   * @returns {?number} il cluster dell'ultima, null se è la radice
   */
  mkdirp(path) {
    const parts = (Array.isArray(path) ? path : path.split(/[\\/]+/)).filter(Boolean);
    let dir = null;
    for (const part of parts) dir = this.mkdir(dir, part);
    return dir;
  }

  // ---------------------------------------------------------------- i file

  /**
   * La voce di un percorso — `SCARICATI\GIOCHI\LEGGIMI.TXT` — o -1 se
   * lungo la strada manca qualcosa.
   */
  locate(path) {
    const parts = path.split(/[\\/]+/).filter(Boolean);
    let dir = null;
    for (let i = 0; i < parts.length; i++) {
      const at = this.find(dir, packName(shortName(parts[i])));
      if (at < 0) return -1;
      if (i === parts.length - 1) return at;
      if (!(this.image[at + 11] & ATTR_DIRECTORY)) return -1;
      dir = readU16(this.image, at + 26);
    }
    return -1;
  }

  /**
   * Rilegge un file seguendo la sua catena. Serve soprattutto alle prove: un
   * file copiato dal DOS e riletto di qua dice se le due idee di dove stiano
   * i byte — la nostra e la sua — sono la stessa idea.
   *
   * @param {string} path
   * @returns {?Uint8Array}
   */
  read(path) {
    const at = this.locate(path);
    if (at < 0) return null;
    const size = readU32(this.image, at + 28);
    const out = new Uint8Array(size);
    let done = 0;
    for (const cluster of this.chain(readU16(this.image, at + 26))) {
      if (done >= size) break;
      const from = this.offsetOf(cluster);
      const take = Math.min(this.clusterSize, size - done);
      out.set(this.image.subarray(from, from + take), done);
      done += take;
    }
    return out;
  }

  /**
   * Scrive un file in una cartella. Se ce n'era già uno con lo stesso nome,
   * quello vecchio se ne va — è quello che fa `COPY` quando si risponde di sì.
   *
   * @param {?number} dir la cartella, null per la radice
   * @param {string} name il nome come arriva dal browser, anche lungo
   * @param {Uint8Array} bytes
   * @param {object} [options]
   * @param {boolean} [options.unique] numerare invece di sovrascrivere, che è
   *   quello che serve svuotando uno zip: due nomi lunghi diversi possono
   *   diventare lo stesso nome corto, e nessuno dei due va perso
   * @returns {string} il nome con cui è finito sul disco
   */
  writeFile(dir, name, bytes, { unique = false } = {}) {
    const wanted = unique ? this.uniqueName(dir, name) : shortName(name);
    const packed = packName(wanted);
    const previous = this.find(dir, packed);
    if (previous >= 0) {
      if (this.image[previous + 11] & ATTR_DIRECTORY) throw new Error(`${name} è una cartella`);
      this.release(readU16(this.image, previous + 26));
    }

    const count = Math.ceil(bytes.length / this.clusterSize);
    const clusters = count ? this.allocate(count) : [];
    clusters.forEach((cluster, i) => {
      const from = i * this.clusterSize;
      const chunk = bytes.subarray(from, from + this.clusterSize);
      const at = this.offsetOf(cluster);
      this.image.fill(0, at, at + this.clusterSize);
      this.image.set(chunk, at);
    });

    const at = previous >= 0 ? previous : this.freeSlot(dir);
    this.writeEntry(at, packed, ATTR_ARCHIVE, clusters[0] ?? 0, bytes.length);
    return displayName(packed);
  }
}
