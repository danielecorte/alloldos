// Passare un file alla macchina.
//
// Fra il computer di oggi e quello del 1988 non c'è nessun cavo: la macchina
// emulata sa leggere settori da un disco, e basta. Quindi un file che arriva
// dal browser lo si mette dove il DOS lo troverà da sé — in una cartella sul
// disco fisso, `C:\SCARICATI`, che è il posto che si sarebbe fatto chiunque
// avesse avuto un modem.
//
// Se è uno zip, si svuota: nel 1988 era il modo in cui il software viaggiava,
// e trovarsi l'archivio sul disco senza niente con cui aprirlo sarebbe una
// beffa. Finisce in una cartella che si chiama come lui — `giochi.zip` diventa
// `C:\SCARICATI\GIOCHI\` — con dentro le sue cartelle, tutte con i nomi
// accorciati a come li vuole il DOS.

import { FAT16, FullDiskError, FullDirectoryError, shortName } from './fat.js';
import { isZip, readZip, UnreadableZipError } from './zip.js';

const SECTOR = 512;

/** La cartella dove finisce tutto quello che arriva da fuori. */
export const DOWNLOADS = 'SCARICATI';

export class NoFilesystemError extends Error {
  constructor() {
    super('su C: non c\'è nessun filesystem');
    this.name = 'NoFilesystemError';
  }
}

export { FullDiskError, FullDirectoryError, UnreadableZipError };

/** Il nome senza l'estensione, che è quello che diventa la cartella. */
function folderName(name) {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const { base } = shortName(stem);
  return base;
}

/**
 * Scrive un file — o tutto uno zip — sul disco fisso della macchina.
 *
 * Il disco è quello vero, quello che la scheda legge: dopo, perché il DOS se
 * ne accorga, la macchina va riaccesa. Non è una scortesia dell'emulatore, è
 * come funziona: il DOS si tiene in memoria pezzi di FAT e di cartella, e uno
 * che gli cambia il disco sotto mentre gira è esattamente quello che i
 * manuali dell'epoca dicevano di non fare mai.
 *
 * @param {{data: Uint8Array, writes: number}} disk il disco fisso della macchina
 * @param {string} name il nome del file come arriva dal browser
 * @param {Uint8Array} bytes
 * @returns {Promise<{folder:string, names:string[], bytes:number, zip:boolean}>}
 */
export async function loadIntoDisk(disk, name, bytes) {
  const volume = FAT16.of(disk.data);
  if (!volume) throw new NoFilesystemError();

  const written = [];
  let total = 0;

  if (isZip(bytes)) {
    const entries = await readZip(bytes);
    const root = folderName(name);

    // Il conto prima di cominciare, perché un disco che si riempie a metà
    // strada lascia dentro mezzo archivio e nessun modo di sapere quale metà.
    // Nel conto ci vanno anche le cartelle: una cartella su un disco DOS è un
    // file come gli altri, e si prende il suo cluster.
    const folders = new Set([DOWNLOADS, `${DOWNLOADS}/${root}`]);
    for (const entry of entries) {
      const parts = entry.path.split('/').filter(Boolean);
      parts.pop();
      for (let i = 0; i < parts.length; i++) {
        folders.add(`${DOWNLOADS}/${root}/${parts.slice(0, i + 1).join('/')}`);
      }
    }
    const room =
      entries.reduce((sum, entry) => sum + roundUp(entry.bytes.length, volume.clusterSize), 0) +
      folders.size * volume.clusterSize;
    if (room > volume.freeBytes) throw new FullDiskError(room, volume.freeBytes);

    for (const entry of entries) {
      const parts = entry.path.split('/').filter(Boolean);
      const file = parts.pop();
      const dir = volume.mkdirp([DOWNLOADS, root, ...parts]);
      written.push(volume.writeFile(dir, file, entry.bytes, { unique: true }));
      total += entry.bytes.length;
    }
    disk.writes += sectorsFor(total, entries.length);
    return { folder: `C:\\${DOWNLOADS}\\${root}`, names: written, bytes: total, zip: true };
  }

  if (roundUp(bytes.length, volume.clusterSize) > volume.freeBytes) {
    throw new FullDiskError(bytes.length, volume.freeBytes);
  }
  const dir = volume.mkdirp([DOWNLOADS]);
  written.push(volume.writeFile(dir, name, bytes));
  disk.writes += sectorsFor(bytes.length, 1);
  return { folder: `C:\\${DOWNLOADS}`, names: written, bytes: bytes.length, zip: false };
}

const roundUp = (size, unit) => Math.ceil(size / unit) * unit || unit;

/** Quanti settori sono cambiati: i byte, più la FAT e le cartelle attorno. */
const sectorsFor = (bytes, count) => Math.ceil(bytes / SECTOR) + count + 2;
