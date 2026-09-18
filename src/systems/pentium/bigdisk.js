// Il disco grande: lo stesso FreeDOS, trasferito su un disco da un giga.
//
// Il disco che viaggia con alloldos è quello del 286: venti mega, cioè uno
// Seagate ST-225 del 1988. Sul Pentium è un disco assurdo — una macchina del
// 1995 usciva di fabbrica con cinquecento mega o un giga, e Windows 98 da solo
// ne vuole trecento. Ma un'immagine da un giga non può stare nel repository, e
// non serve: quasi tutto quel giga sono zeri, e gli zeri si fanno qui.
//
// Quindi il disco si rifà all'accensione, che è quello che si faceva cambiando
// disco: se ne compra uno più grande, lo si partiziona, lo si formatta, e ci si
// ricopiano sopra i file del vecchio. La FAT non si può allungare sul posto —
// quella nuova è più lunga e sposta tutto quello che le viene dopo — e allora
// si scrive una FAT nuova da capo e i file ci passano uno per uno, con le loro
// cartelle, i loro nomi, le loro date e i loro attributi.
//
// Resta una FAT16, e non una FAT32: il settore di avvio che FreeDOS ha scritto
// sul disco piccolo è una FAT16, e con cluster da sedici KB una FAT16 arriva
// fino a un giga senza far niente di speciale. Il settore di avvio si tiene
// com'è, e gli si cambiano solo i numeri che descrivono il disco: il codice li
// legge da lì, ed è per questo che sta dietro a una tabella di numeri e non ci
// sono scritti dentro.

import { FAT16 } from '../pc/fat.js';
import { HardDisk } from '../pc/ata.js';

const SECTOR = 512;
const ENTRY = 32;
const ATTR_DIRECTORY = 0x10;
const DELETED = 0xe5;

/**
 * La geometria del disco grande, così come la racconta il BIOS: 1024 cilindri,
 * 32 testine, 63 settori per traccia. Il disco dice 2048 cilindri e 16
 * testine, e il BIOS — a cui la CMOS chiede la traduzione LBA, vedi
 * `describeDisks` — dimezza i primi e raddoppia le seconde finché i cilindri
 * non stanno nei dieci bit dell'INT 13h. Fermarsi esattamente a 1024 cilindri
 * vuol dire che tutto il disco è raggiungibile anche da chi conosce solo
 * cilindro, testina e settore.
 */
export const BIG_GEOMETRY = { cylinders: 1024, heads: 32, sectors: 63 };
export const BIG_DISK_SIZE = BIG_GEOMETRY.cylinders * BIG_GEOMETRY.heads * BIG_GEOMETRY.sectors * SECTOR;

/** La partizione comincia sulla seconda traccia, come la metteva FDISK. */
const PARTITION_START = BIG_GEOMETRY.sectors;

/** Sedici KB per cluster: la misura che FORMAT sceglieva per un disco da un giga. */
const SECTORS_PER_CLUSTER = 32;
const ROOT_ENTRIES = 512;

const writeU16 = (bytes, at, value) => {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
};
const writeU32 = (bytes, at, value) => {
  writeU16(bytes, at, value & 0xffff);
  writeU16(bytes, at + 2, value >>> 16);
};
const readU16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const readU32 = (bytes, at) => (readU16(bytes, at) | (readU16(bytes, at + 2) << 16)) >>> 0;

/** Cilindro, testina e settore come stanno in una voce della tabella delle partizioni. */
function chs(lba) {
  const { heads, sectors } = BIG_GEOMETRY;
  const cylinder = Math.min(1023, Math.floor(lba / (heads * sectors)));
  const head = Math.floor(lba / sectors) % heads;
  const sector = (lba % sectors) + 1;
  return [head, sector | ((cylinder >> 8) << 6), cylinder & 0xff];
}

/**
 * Il disco grande, con dentro tutto quello che c'era nel piccolo. Se il disco
 * piccolo non ha una FAT16 che si sappia leggere, non si tocca niente e torna
 * indietro com'era: meglio un disco piccolo che un disco grande e vuoto.
 *
 * @param {HardDisk} small
 * @returns {HardDisk}
 */
export function enlarge(small) {
  const from = FAT16.of(small.data);
  if (!from || small.data.length >= BIG_DISK_SIZE) return small;

  const image = new Uint8Array(BIG_DISK_SIZE);
  // L'ultimo cilindro resta fuori: SeaBIOS lo tiene per sé — i BIOS lo
  // lasciavano libero per le prove del disco — e una partizione che ci
  // arrivasse finirebbe oltre il disco che il BIOS dichiara.
  const { heads, sectors } = BIG_GEOMETRY;
  const total = (BIG_GEOMETRY.cylinders - 1) * heads * sectors - PARTITION_START;

  // Il settore zero: il codice di avvio del vecchio disco, e una partizione sola
  // che prende tutto. Il tipo 06h è «FAT16 più grande di trentadue mega».
  image.set(small.data.subarray(0, 446));
  const entry = 446;
  image[entry] = 0x80;
  image.set(chs(PARTITION_START), entry + 1);
  image[entry + 4] = 0x06;
  image.set(chs(PARTITION_START + total - 1), entry + 5);
  writeU32(image, entry + 8, PARTITION_START);
  writeU32(image, entry + 12, total);
  image[510] = 0x55;
  image[511] = 0xaa;

  // Il settore di avvio della partizione: quello di prima, con i numeri nuovi.
  const boot = PARTITION_START * SECTOR;
  image.set(small.data.subarray(from.start * SECTOR, from.start * SECTOR + SECTOR), boot);
  const fatSectors = fatSectorsFor(total);
  image[boot + 13] = SECTORS_PER_CLUSTER;
  writeU16(image, boot + 14, 1);
  image[boot + 16] = 2;
  writeU16(image, boot + 17, ROOT_ENTRIES);
  writeU16(image, boot + 19, 0); // più di 65535 settori: il numero sta più avanti
  image[boot + 21] = 0xf8;
  writeU16(image, boot + 22, fatSectors);
  writeU16(image, boot + 24, BIG_GEOMETRY.sectors);
  writeU16(image, boot + 26, BIG_GEOMETRY.heads);
  writeU32(image, boot + 28, PARTITION_START);
  writeU32(image, boot + 32, total);
  image[boot + 36] = 0x80;

  const to = new FAT16(image, PARTITION_START);
  if (!to.valid) throw new Error('il disco grande non torna');
  // Le prime due voci della FAT non sono cluster: la prima ripete il tipo di
  // disco, la seconda dice che il disco è stato smontato per bene.
  to.setFAT(0, 0xfff8);
  to.setFAT(1, 0xffff);

  copyDirectory(from, to, null, null, null);
  return new HardDisk(image, { ...BIG_GEOMETRY });
}

/** Quanti settori di FAT servono perché ogni cluster ci abbia il suo numero. */
function fatSectorsFor(total) {
  const rootSectors = (ROOT_ENTRIES * ENTRY) / SECTOR;
  let fat = 1;
  for (;;) {
    const clusters = Math.floor((total - 1 - 2 * fat - rootSectors) / SECTORS_PER_CLUSTER);
    const needed = Math.ceil(((clusters + 2) * 2) / SECTOR);
    if (needed <= fat) return fat;
    fat = needed;
  }
}

/** Le voci vive di una cartella, nell'ordine in cui ci stanno. */
function liveEntries(volume, dir) {
  const out = [];
  for (const at of volume.slots(dir)) {
    if (volume.image[at] === 0) break;
    if (volume.image[at] !== DELETED) out.push(at);
  }
  return out;
}

/**
 * Una cartella, e dentro tutto quello che contiene. Le voci si copiano così
 * come sono — nome, attributi, date — e cambia solo il primo cluster, che sul
 * disco nuovo è un altro.
 */
function copyDirectory(from, to, fromDir, toDir, parent) {
  const entries = liveEntries(from, fromDir);
  const slots = [...to.slots(toDir)];
  if (entries.length > slots.length) throw new Error('una cartella non ci sta nel disco grande');

  entries.forEach((at, i) => {
    const target = slots[i];
    to.image.set(from.image.subarray(at, at + ENTRY), target);
    const name = from.text(at, 11);
    const attributes = from.image[at + 11];
    const size = readU32(from.image, at + 28);
    const first = readU16(from.image, at + 26);

    if (name === '.          ') return writeU16(to.image, target + 26, toDir ?? 0);
    if (name === '..         ') return writeU16(to.image, target + 26, parent ?? 0);
    if (!first) return;

    if (attributes & ATTR_DIRECTORY) {
      const count = liveEntries(from, first).length;
      const clusters = to.allocate(Math.max(1, Math.ceil((count * ENTRY) / to.clusterSize)));
      for (const cluster of clusters) to.image.fill(0, to.offsetOf(cluster), to.offsetOf(cluster) + to.clusterSize);
      writeU16(to.image, target + 26, clusters[0]);
      copyDirectory(from, to, first, clusters[0], toDir);
      return;
    }

    const bytes = readChain(from, first, size);
    const clusters = size ? to.allocate(Math.ceil(size / to.clusterSize)) : [];
    clusters.forEach((cluster, n) => {
      to.image.set(bytes.subarray(n * to.clusterSize, (n + 1) * to.clusterSize), to.offsetOf(cluster));
    });
    writeU16(to.image, target + 26, clusters[0] ?? 0);
  });
}

function readChain(volume, first, size) {
  const out = new Uint8Array(size);
  let done = 0;
  for (const cluster of volume.chain(first)) {
    if (done >= size) break;
    const take = Math.min(volume.clusterSize, size - done);
    const at = volume.offsetOf(cluster);
    out.set(volume.image.subarray(at, at + take), done);
    done += take;
  }
  return out;
}
