// Trovare il BIOS.
//
// Un PC senza BIOS non fa niente: il 286 si sveglia a F000:FFF0 e legge, e se
// lì non c'è niente ha finito. Ma a differenza del Kickstart dell'Amiga, qui
// una ROM libera c'è davvero: GLaBIOS è un BIOS PC scritto da zero, in GPL, che
// gira sulle macchine vere e passa gli stessi test delle altre. È l'unico BIOS
// PC libero e completo che esista — un BIOS AT libero non c'è, ed è per questo
// che la scheda di questa macchina è una XT con un 286 sopra.
//
// Otto KB, che si mappano in cima al mega: F000:E000, cioè FE000h. La ROM non
// sta nel repository — nessun firmware ci sta — e `npm run fetch-roms` la
// scarica dalla pagina delle versioni del progetto.

const STORAGE_KEY = 'alloldos.rom.pc.bios';
const CARD_STORAGE_KEY = 'alloldos.rom.pc.xtide';

/** Il progetto, per chi arriva sulla pagina senza la ROM. */
export const GLABIOS_URL = 'https://glabios.org/';

/** La versione con cui la macchina è provata, e da dove si prende. */
export const GLABIOS_VERSION = '0.4.2';
export const GLABIOS_SOURCE_URL =
  `https://github.com/640-KB/GLaBIOS/releases/download/v${GLABIOS_VERSION}/GLABIOS_${GLABIOS_VERSION}_8T.ROM`;

/**
 * Fra le dieci varianti pubblicate serve questa: il build 8088 — un 286 esegue
 * tutto quello che esegue un 8088, mentre i build "V20" usano le istruzioni in
 * più del NEC V20, che il 286 non ha — nella versione Turbo, che è quella per i
 * cloni generici, ed è quello che questa macchina è.
 */
export const BIOS_SPEC = { file: 'glabios.rom', size: 8192, label: 'GLaBIOS', source: GLABIOS_SOURCE_URL };

/** Dove finisce mappata: gli ultimi otto KB del mega di memoria reale. */
export const BIOS_BASE = 0xfe000;

// ------------------------------------------------------ la ROM della scheda
//
// Il BIOS di sistema non sa niente di dischi fissi — nessun BIOS XT lo sa, il
// disco fisso è arrivato dopo — e quello che ne sa se lo porta dietro la
// scheda. La XTIDE Universal BIOS è la ROM libera che fanno girare tutte le
// schede IDE per macchine vecchie: dodici KB che si affacciano a C800 e che
// il POST trova da solo mentre passa in rassegna la finestra delle schede.

/** Il progetto, per i crediti e per chi la vuole andare a prendere. */
export const XTIDE_URL = 'https://www.xtideuniversalbios.org/';

/**
 * Il build XT, versione grande: quello con il menu di avvio, che è la parte
 * che serve davvero — il BIOS di sistema sa avviare solo dal floppy, e senza
 * quel menu il disco fisso sarebbe un posto dove tenere le cose ma non da cui
 * partire.
 */
export const XTIDE_REVISION = 'r638';
export const XTIDE_SOURCE_URL =
  `https://www.xtideuniversalbios.org/binaries/${XTIDE_REVISION}/ide_xtl.bin`;

export const CARD_SPEC = {
  file: 'xtide.bin',
  size: 10244,
  label: 'XTIDE Universal BIOS',
  source: XTIDE_SOURCE_URL,
};

/** Dove la scheda si affaccia: la prima finestra libera dopo le schede video. */
export const CARD_ROM_BASE = 0xc8000;

export class MissingBIOSError extends Error {
  constructor() {
    super('missing PC BIOS ROM');
    this.name = 'MissingBIOSError';
  }
}

/**
 * Una ROM di scheda come la scriverebbe il programmatore di EEPROM.
 *
 * L'immagine pubblicata è solo il codice: dice nel terzo byte quanto è grande
 * la memoria su cui va scritta, ma non ci arriva, e non ha la somma di
 * controllo in fondo. Chi la scrive davvero su una scheda la allunga fino a
 * quella misura e chiude i conti — il BIOS di sistema somma tutti i byte e
 * salta dentro solo se il totale fa zero. Questo fa la stessa cosa: nessun
 * byte del codice viene toccato, si riempie il vuoto e si firma la fine.
 *
 * @param {Uint8Array} raw
 * @returns {Uint8Array}
 */
export function padOptionROM(raw) {
  const size = (raw[2] ?? 0) * 512;
  if (size < raw.length) return raw;
  const rom = new Uint8Array(size);
  rom.set(raw);
  let sum = 0;
  for (let i = 0; i < size - 1; i++) sum = (sum + rom[i]) & 0xff;
  rom[size - 1] = (256 - sum) & 0xff;
  return rom;
}

/** Una ROM di scheda si riconosce dai due byte con cui si presenta. */
export function isOptionROM(bytes) {
  return bytes.length > 3 && bytes[0] === 0x55 && bytes[1] === 0xaa && bytes[2] > 0;
}

/**
 * Dove starebbe la ROM se qualcuno ce l'avesse messa. Calcolato da questo
 * modulo e non dalla radice del sito, perché GitHub Pages serve alloldos da una
 * sottocartella e l'unica fetch che conta deve ritrovare la strada di casa.
 */
function romURL(file = BIOS_SPEC.file) {
  return new URL(`../../../roms/pc/${file}`, import.meta.url);
}

async function fetchROM(file = BIOS_SPEC.file) {
  try {
    const response = await fetch(romURL(file), { cache: 'force-cache' });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function readStoredROM(key = STORAGE_KEY) {
  const encoded = localStorage.getItem(key);
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Riconosce un file lasciato cadere sulla finestra. Una ROM di BIOS si
 * riconosce da dove salta all'accensione: gli ultimi sedici byte sono il primo
 * codice che il processore esegue, e cominciano sempre con un salto lontano.
 */
export function acceptROMFile(bytes) {
  const card = isOptionROM(bytes);
  if (!card) {
    if (bytes.length !== BIOS_SPEC.size) return false;
    if (bytes[bytes.length - 16] !== 0xea) return false;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  localStorage.setItem(card ? CARD_STORAGE_KEY : STORAGE_KEY, btoa(binary));
  return card ? 'card' : 'bios';
}

/**
 * @returns {Promise<Uint8Array>}
 * @throws {MissingBIOSError}
 */
export async function loadBIOS() {
  const fetched = await fetchROM();
  const bytes = (fetched?.length === BIOS_SPEC.size ? fetched : null) ?? readStoredROM();
  if (!bytes || bytes.length !== BIOS_SPEC.size) throw new MissingBIOSError();
  return bytes;
}

/**
 * La ROM della scheda del disco, se c'è. Senza, la macchina si accende lo
 * stesso e ha soltanto il floppy: è esattamente quello che succedeva a chi
 * comprava il computer senza il disco fisso.
 *
 * @returns {Promise<?Uint8Array>} la ROM già pronta da mappare
 */
export async function loadCardROM() {
  const fetched = await fetchROM(CARD_SPEC.file);
  const bytes = (fetched && isOptionROM(fetched) ? fetched : null) ?? readStoredROM(CARD_STORAGE_KEY);
  if (!bytes || !isOptionROM(bytes)) return null;
  return padOptionROM(bytes);
}
