// Il filesystem dell'Amiga, quel tanto che basta per farci stare un programma.
//
// Un .adf è fatto di blocchi da 512 byte, e AmigaDOS li usa così: il blocco 880
// è la radice del disco, con una tabella hash di 72 caselle che porta ai file;
// ogni file ha un blocco di intestazione e poi una catena di blocchi di dati.
// Nell'OFS — il filesystem del 1985, quello che la Kickstart 1.3 monta da sola —
// ogni blocco di dati si porta dietro ventiquattro byte di suo: che file è, che
// pezzo è, quanto è lungo e dov'è il pezzo dopo. Restano 488 byte per il file.
//
// Serve a due cose: fabbricare un disco da dare all'emulatore, e rileggere dal
// disco che ne esce quello che la macchina ci ha scritto sopra. Il secondo è il
// motivo per cui questo file esiste: senza, "il salvataggio ha funzionato" resta
// un'opinione sui settori invece di essere un fatto sul file.

export const BLOCK_SIZE = 512;
export const BLOCKS = 1760;
export const ROOT_BLOCK = 880;
export const DATA_PER_BLOCK = BLOCK_SIZE - 24;

const T_HEADER = 2;
const T_DATA = 8;
const ST_ROOT = 1;
const ST_FILE = -3;
const HASH_SIZE = 72;

const view = (image) => new DataView(image.buffer, image.byteOffset, image.byteLength);
const at = (block, offset) => block * BLOCK_SIZE + offset;

/**
 * Dove finisce un nome nella tabella hash della radice. Tredici è il numero che
 * ha scelto Metacomco nel 1985 e da allora non si tocca: cambiarlo vorrebbe dire
 * che un disco scritto qui non si legge più di là.
 */
export function hashName(name) {
  let hash = name.length;
  for (const character of name.toUpperCase()) {
    hash = (hash * 13 + character.charCodeAt(0)) & 0x7ff;
  }
  return hash % HASH_SIZE;
}

/**
 * La somma di controllo di un blocco: tutti i 128 long sommati fanno zero.
 * Il campo della somma viene azzerato prima di calcolarla, e poi ci si mette il
 * complemento — che è esattamente il modo di dire "adesso la somma fa zero".
 */
function blockChecksum(image, block, field) {
  const data = view(image);
  data.setUint32(at(block, field), 0, false);
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE / 4; i++) sum = (sum + data.getUint32(at(block, i * 4), false)) >>> 0;
  data.setUint32(at(block, field), (-sum) >>> 0, false);
}

/** Il blocco di boot ha una somma tutta sua: si somma col riporto e si nega. */
function bootChecksum(image) {
  const data = view(image);
  data.setUint32(4, 0, false);
  let sum = 0;
  for (let i = 0; i < (BLOCK_SIZE * 2) / 4; i++) {
    const before = sum;
    sum = (sum + data.getUint32(i * 4, false)) >>> 0;
    if (sum < before) sum = (sum + 1) >>> 0; // il riporto rientra dalla coda
  }
  data.setUint32(4, ~sum >>> 0, false);
}

/** I giorni dal 1° gennaio 1978, che per AmigaDOS è quando comincia il tempo. */
function amigaDate(when = new Date()) {
  const epoch = Date.UTC(1978, 0, 1);
  const elapsed = when.getTime() - epoch;
  const days = Math.floor(elapsed / 86400000);
  const rest = elapsed - days * 86400000;
  return { days, mins: Math.floor(rest / 60000), ticks: Math.floor((rest % 60000) / 20) };
}

function putName(image, block, offset, name) {
  image[at(block, offset)] = name.length;
  for (let i = 0; i < name.length; i++) image[at(block, offset + 1 + i)] = name.charCodeAt(i);
}

function getName(image, block, offset) {
  const length = image[at(block, offset)];
  let name = '';
  for (let i = 0; i < length; i++) name += String.fromCharCode(image[at(block, offset + 1 + i)]);
  return name;
}

/**
 * Un disco formattato OFS con dentro i file che gli si danno.
 *
 * Nessun blocco di boot vero: il codice che avvia AmigaOS da un floppy è di
 * Commodore e non sta qui. Il disco si monta e si legge, non si avvia.
 *
 * @param {{name:string, files:{name:string, data:Uint8Array|string}[]}} spec
 * @returns {Uint8Array} 880 KB
 */
export function makeDisk({ name = 'Vuoto', files = [] } = {}) {
  const image = new Uint8Array(BLOCKS * BLOCK_SIZE);
  const data = view(image);
  const now = amigaDate();

  // Il blocco di boot: "DOS" e basta, più il puntatore alla radice.
  image[0] = 0x44;
  image[1] = 0x4f;
  image[2] = 0x53;
  image[3] = 0; // OFS
  data.setUint32(8, ROOT_BLOCK, false);

  // La radice.
  data.setUint32(at(ROOT_BLOCK, 0), T_HEADER, false);
  data.setUint32(at(ROOT_BLOCK, 12), HASH_SIZE, false);
  data.setInt32(at(ROOT_BLOCK, 312), -1, false); // bm_flag: la mappa è valida
  data.setUint32(at(ROOT_BLOCK, 316), ROOT_BLOCK + 1, false); // dov'è la mappa
  for (const [i, offset] of [420, 472, 484].entries()) {
    void i;
    data.setUint32(at(ROOT_BLOCK, offset), now.days, false);
    data.setUint32(at(ROOT_BLOCK, offset + 4), now.mins, false);
    data.setUint32(at(ROOT_BLOCK, offset + 8), now.ticks, false);
  }
  putName(image, ROOT_BLOCK, 432, name);
  data.setInt32(at(ROOT_BLOCK, 508), ST_ROOT, false);

  // I blocchi occupati, che poi finiscono nella mappa: radice e mappa stessa.
  const used = new Set([ROOT_BLOCK, ROOT_BLOCK + 1]);
  let next = 882; // il primo libero dopo la mappa

  for (const file of files) {
    const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data;
    const header = next++;
    const blocks = Math.max(1, Math.ceil(bytes.length / DATA_PER_BLOCK));
    const dataBlocks = [];
    for (let i = 0; i < blocks; i++) dataBlocks.push(next++);
    for (const block of [header, ...dataBlocks]) used.add(block);

    data.setUint32(at(header, 0), T_HEADER, false);
    data.setUint32(at(header, 4), header, false);
    data.setUint32(at(header, 8), dataBlocks.length, false);
    data.setUint32(at(header, 16), dataBlocks[0], false);
    // I puntatori ai dati stanno nella stessa tabella della radice, ma riempita
    // al contrario: il primo pezzo del file è l'ultima casella.
    dataBlocks.forEach((block, i) => data.setUint32(at(header, 24 + (71 - i) * 4), block, false));
    data.setUint32(at(header, 324), bytes.length, false);
    data.setUint32(at(header, 420), now.days, false);
    data.setUint32(at(header, 424), now.mins, false);
    data.setUint32(at(header, 428), now.ticks, false);
    putName(image, header, 432, file.name);
    data.setUint32(at(header, 500), ROOT_BLOCK, false);
    data.setInt32(at(header, 508), ST_FILE, false);

    dataBlocks.forEach((block, i) => {
      const from = i * DATA_PER_BLOCK;
      const slice = bytes.subarray(from, from + DATA_PER_BLOCK);
      data.setUint32(at(block, 0), T_DATA, false);
      data.setUint32(at(block, 4), header, false);
      data.setUint32(at(block, 8), i + 1, false);
      data.setUint32(at(block, 12), slice.length, false);
      data.setUint32(at(block, 16), dataBlocks[i + 1] ?? 0, false);
      image.set(slice, at(block, 24));
      blockChecksum(image, block, 20);
    });

    // Il nome entra nella tabella hash della radice, in coda a chi c'era già.
    const slot = at(ROOT_BLOCK, 24 + hashName(file.name) * 4);
    let chain = data.getUint32(slot, false);
    if (chain === 0) data.setUint32(slot, header, false);
    else {
      while (data.getUint32(at(chain, 496), false) !== 0) chain = data.getUint32(at(chain, 496), false);
      data.setUint32(at(chain, 496), header, false);
      blockChecksum(image, chain, 20);
    }
    blockChecksum(image, header, 20);
  }

  // La mappa dei blocchi liberi: un bit per blocco, e il bit acceso vuol dire
  // libero. Comincia dal blocco 2, perché i due di boot non si contano.
  const bitmap = ROOT_BLOCK + 1;
  for (let block = 2; block < BLOCKS; block++) {
    if (used.has(block)) continue;
    const bit = block - 2;
    const offset = at(bitmap, 4 + (bit >> 5) * 4);
    data.setUint32(offset, (data.getUint32(offset, false) | (1 << (bit & 31))) >>> 0, false);
  }
  blockChecksum(image, bitmap, 0);
  blockChecksum(image, ROOT_BLOCK, 20);
  bootChecksum(image);
  return image;
}

/** Quello che c'è nella radice, nome per nome. */
export function listFiles(image) {
  const data = view(image);
  const names = [];
  for (let slot = 0; slot < HASH_SIZE; slot++) {
    let block = data.getUint32(at(ROOT_BLOCK, 24 + slot * 4), false);
    while (block !== 0 && block < BLOCKS) {
      names.push(getName(image, block, 432));
      block = data.getUint32(at(block, 496), false);
    }
  }
  return names;
}

/**
 * Un file, seguito come lo seguirebbe AmigaDOS: dalla tabella hash al blocco di
 * intestazione, e da lì di blocco in blocco fino a finire i byte.
 * @returns {?Uint8Array}
 */
export function readFile(image, name) {
  const data = view(image);
  let block = data.getUint32(at(ROOT_BLOCK, 24 + hashName(name) * 4), false);
  while (block !== 0 && block < BLOCKS && getName(image, block, 432).toUpperCase() !== name.toUpperCase()) {
    block = data.getUint32(at(block, 496), false);
  }
  if (block === 0 || block >= BLOCKS) return null;

  const size = data.getUint32(at(block, 324), false);
  const out = new Uint8Array(size);
  let written = 0;
  let piece = data.getUint32(at(block, 16), false);
  while (piece !== 0 && piece < BLOCKS && written < size) {
    const length = Math.min(data.getUint32(at(piece, 12), false), size - written);
    out.set(image.subarray(at(piece, 24), at(piece, 24 + length)), written);
    written += length;
    piece = data.getUint32(at(piece, 16), false);
  }
  return written === size ? out : out.subarray(0, written);
}

/** Vero se ogni blocco in uso torna con la sua somma di controllo. */
export function checkDisk(image) {
  const data = view(image);
  const bad = [];
  for (let block = 2; block < BLOCKS; block++) {
    const type = data.getUint32(at(block, 0), false);
    if (type !== T_HEADER && type !== T_DATA) continue;
    let sum = 0;
    for (let i = 0; i < BLOCK_SIZE / 4; i++) sum = (sum + data.getUint32(at(block, i * 4), false)) >>> 0;
    if (sum !== 0) bad.push(block);
  }
  return bad;
}
