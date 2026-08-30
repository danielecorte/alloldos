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

export class MissingBIOSError extends Error {
  constructor() {
    super('missing PC BIOS ROM');
    this.name = 'MissingBIOSError';
  }
}

/**
 * Dove starebbe la ROM se qualcuno ce l'avesse messa. Calcolato da questo
 * modulo e non dalla radice del sito, perché GitHub Pages serve alloldos da una
 * sottocartella e l'unica fetch che conta deve ritrovare la strada di casa.
 */
function romURL() {
  return new URL(`../../../roms/pc/${BIOS_SPEC.file}`, import.meta.url);
}

async function fetchROM() {
  try {
    const response = await fetch(romURL(), { cache: 'force-cache' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === BIOS_SPEC.size ? bytes : null;
  } catch {
    return null;
  }
}

function readStoredROM() {
  const encoded = localStorage.getItem(STORAGE_KEY);
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    if (binary.length !== BIOS_SPEC.size) return null;
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
  if (bytes.length !== BIOS_SPEC.size) return false;
  if (bytes[bytes.length - 16] !== 0xea) return false;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  localStorage.setItem(STORAGE_KEY, btoa(binary));
  return true;
}

/**
 * @returns {Promise<Uint8Array>}
 * @throws {MissingBIOSError}
 */
export async function loadBIOS() {
  const bytes = (await fetchROM()) ?? readStoredROM();
  if (!bytes) throw new MissingBIOSError();
  return bytes;
}
