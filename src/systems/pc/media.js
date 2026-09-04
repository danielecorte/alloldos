// I dischi: quello che si infila nel lettore e quello che sta dentro.
//
// Un'immagine di disco per PC non ha niente dentro: è la fila dei settori
// così come stanno sul disco, 512 byte per volta, senza intestazioni e senza
// nomi. Tutto quello che serve per capirla è la sua lunghezza — 737.280 byte
// vuol dire "un dischetto da 720 KB", e i primi 512 sono per definizione il
// settore di avvio. È la ragione per cui un `.img` di quarant'anni fa si apre
// ancora oggi: non c'è nessun formato da riconoscere.
//
// Il sistema operativo di questa macchina è FreeDOS, che sta a DOS come AROS
// sta al Kickstart: scritto da zero, libero, e capace di far girare le stesse
// cose. Non è nel repository — nessun software di sistema lo è — ma a
// differenza del Kickstart si scarica in un colpo solo dal sito del progetto,
// ed è quello che fa `npm run fetch-roms`.

import { formatOf } from './fdc.js';
import { DISK_SIZE, HardDisk } from './ata.js';

/** Il progetto, per i crediti e per chi lo vuole andare a prendere. */
export const FREEDOS_URL = 'https://www.freedos.org/';

/**
 * Il dischetto di avvio dell'edizione a dischetti di FreeDOS 1.3, nella
 * versione da 720 KB: l'unica misura che un lettore da tre pollici e mezzo
 * attaccato a un controllore XT sa leggere, perché le altre due — 1,2 MB e
 * 1,44 MB — vogliono una velocità di trasferimento che quella scheda non sa
 * fare. Sta dentro un archivio con tutti gli altri dischetti, e da lì si tira
 * fuori.
 */
export const FREEDOS_SPEC = {
  file: 'fdboot.img',
  size: 737280,
  label: 'FreeDOS 1.3',
  member: '720k/x86BOOT.img',
  source:
    'https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/distributions/1.3/official/FD13-FloppyEdition.zip',
};

/** L'immagine del disco fisso, che si costruisce in casa con `npm run make-hdd`. */
export const HDD_SPEC = { file: 'hdd.img', size: DISK_SIZE, label: 'disco fisso' };

const FLOPPY_KEY = 'alloldos.pc.floppy';

function mediaURL(file) {
  return new URL(`../../../roms/pc/${file}`, import.meta.url);
}

async function fetchImage(file, expected) {
  try {
    const response = await fetch(mediaURL(file), { cache: 'force-cache' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return expected && bytes.length !== expected ? null : bytes;
  } catch {
    return null;
  }
}

/**
 * Il dischetto da mettere in A: all'accensione. Prima si guarda se c'è quello
 * scaricato accanto alle ROM; poi quello che l'utente ha lasciato cadere
 * sulla finestra l'ultima volta, che sta nel deposito del browser.
 *
 * @returns {Promise<?Uint8Array>}
 */
export async function loadFloppy() {
  const fetched = await fetchImage(FREEDOS_SPEC.file, FREEDOS_SPEC.size);
  if (fetched) return fetched;
  return readStoredFloppy();
}

/**
 * Il disco fisso. Se ce n'è uno già installato lo si monta, altrimenti se ne
 * monta uno vuoto: venti mega di zeri, che è esattamente quello che si
 * comprava — un disco nuovo non ha niente sopra, nemmeno una partizione, e
 * toccava a te partizionarlo e formattarlo.
 *
 * @returns {Promise<HardDisk>}
 */
export async function loadHardDisk() {
  const image = await fetchImage(HDD_SPEC.file);
  if (image && image.length >= DISK_SIZE) return new HardDisk(image.slice(0, DISK_SIZE));
  const blank = new Uint8Array(DISK_SIZE);
  if (image) blank.set(image);
  return new HardDisk(blank);
}

/** Un dischetto sta nel deposito del browser; un disco fisso da venti mega no. */
function readStoredFloppy() {
  try {
    const encoded = localStorage.getItem(FLOPPY_KEY);
    if (!encoded) return null;
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return formatOf(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

export function storeFloppy(bytes) {
  try {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    localStorage.setItem(FLOPPY_KEY, btoa(binary));
    return true;
  } catch {
    // Un dischetto da 1,44 MB non ci sta nel deposito, e non è un guaio: resta
    // dentro la macchina finché la finestra è aperta.
    return false;
  }
}

/**
 * Cosa è il file che qualcuno ha appena lasciato cadere sulla finestra.
 * @param {Uint8Array} bytes
 * @returns {?{kind:'floppy'|'hdd', label:string}}
 */
export function classifyImage(bytes) {
  const format = formatOf(bytes);
  if (format) return { kind: 'floppy', label: format.label };
  if (bytes.length >= 1024 * 1024 && bytes.length % 512 === 0) {
    return { kind: 'hdd', label: `${Math.round(bytes.length / 1024 / 1024)} MB` };
  }
  return null;
}
