// Il firmware del 386, che è il terzo firmware libero di questa collezione.
//
// Il 286 accanto gira su GLaBIOS, che è un BIOS XT; il Pentium su SeaBIOS, che
// vuole almeno un 486 — usa BSWAP, un'istruzione del 486, senza chiedere prima
// che processore c'è. Per un 386 il BIOS libero è quello di **Bochs**, scritto
// nel 2002 per l'emulatore omonimo e compilato per il 386: la sua versione
// «legacy» è tutta a sedici bit, sessantaquattro KB senza la parte a trentadue
// bit che fa le domande a CPUID. LGPL. Accanto va il **VGABIOS LGPL**, nato
// insieme a lui: il BIOS della scheda video, che su una macchina vera stava in
// una ROM sulla scheda e che qui si affaccia a C0000, dove il BIOS la cerca.
//
// Nessuno dei due sta nel repository, come nessun firmware. Stanno invece nel
// repository di Bochs, già compilati, e `npm run fetch-roms` li prende da lì —
// dalla versione 2.7, sempre la stessa, così che i byte siano quelli provati.

const BIOS_KEY = 'alloldos.rom.pc386.bios';
const VIDEO_KEY = 'alloldos.rom.pc386.vgabios';

/** I due progetti, per i crediti e per chi li vuole andare a vedere. */
export const BOCHS_URL = 'https://bochs.sourceforge.io/';
export const VGABIOS_URL = 'https://www.nongnu.org/vgabios/';

/** Dove stanno i due binari: il repository di Bochs, alla versione 2.7. */
export const BOCHS_RELEASE_URL = 'https://github.com/bochs-emu/Bochs/tree/REL_2_7_FINAL/bochs/bios';
const RELEASE = 'https://raw.githubusercontent.com/bochs-emu/Bochs/REL_2_7_FINAL/bochs/bios';

/**
 * Il BIOS di sistema: sessantaquattro KB, da F0000 a FFFFF. Gli ultimi sedici
 * byte sono il primo codice che il processore esegue, e cominciano con un salto
 * lontano.
 */
export const BIOS_SPEC = {
  file: 'bochs-legacy.bin',
  size: 65536,
  label: 'BIOS di Bochs',
  source: `${RELEASE}/BIOS-bochs-legacy`,
};

/** Il BIOS della scheda video, che la macchina affaccia a C0000. */
export const VIDEO_SPEC = {
  file: 'vgabios-lgpl.bin',
  label: 'VGABIOS LGPL',
  source: `${RELEASE}/VGABIOS-lgpl-latest`,
};

export const VIDEO_ROM_BASE = 0xc0000;

export class MissingBIOSError extends Error {
  constructor() {
    super('missing Bochs BIOS image');
    this.name = 'MissingBIOSError';
  }
}

/** Un pezzo di testo dentro un'immagine, per riconoscerla da come si firma. */
function contains(bytes, text) {
  const wanted = Array.from(text, (char) => char.charCodeAt(0));
  outer: for (let i = 0; i + wanted.length <= bytes.length; i++) {
    for (let j = 0; j < wanted.length; j++) if (bytes[i + j] !== wanted[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Il BIOS di Bochs si riconosce dalla misura, dal salto in fondo e dalla firma.
 * La firma serve: anche SeaBIOS esiste da sessantaquattro KB, e su un 386 non
 * partirebbe.
 */
export function isSystemBIOS(bytes) {
  return bytes.length === BIOS_SPEC.size && bytes[bytes.length - 16] === 0xea && contains(bytes, 'Bochs');
}

/** E una ROM di scheda dai due byte con cui si presenta, come sempre. */
export function isOptionROM(bytes) {
  return bytes.length > 3 && bytes[0] === 0x55 && bytes[1] === 0xaa && bytes[2] > 0;
}

function romURL(file) {
  return new URL(`../../../roms/pc386/${file}`, import.meta.url);
}

async function fetchROM(file) {
  try {
    const response = await fetch(romURL(file), { cache: 'force-cache' });
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function readStored(key) {
  try {
    const encoded = localStorage.getItem(key);
    if (!encoded) return null;
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function store(key, bytes) {
  try {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    localStorage.setItem(key, btoa(binary));
    return true;
  } catch {
    return false;
  }
}

/**
 * Riconosce un file lasciato cadere sulla finestra e lo mette da parte.
 * @returns {?('bios'|'video')}
 */
export function acceptROMFile(bytes) {
  if (isSystemBIOS(bytes)) {
    store(BIOS_KEY, bytes);
    return 'bios';
  }
  if (isOptionROM(bytes)) {
    store(VIDEO_KEY, bytes);
    return 'video';
  }
  return null;
}

/**
 * @returns {Promise<Uint8Array>}
 * @throws {MissingBIOSError}
 */
export async function loadBIOS() {
  const fetched = await fetchROM(BIOS_SPEC.file);
  const bytes = (fetched && isSystemBIOS(fetched) ? fetched : null) ?? readStored(BIOS_KEY);
  if (!bytes || !isSystemBIOS(bytes)) throw new MissingBIOSError();
  return bytes;
}

/**
 * La ROM della scheda video, se c'è. Senza, la macchina si accende comunque e
 * fa il suo POST — solo che non ha niente su cui scriverlo.
 *
 * @returns {Promise<?Uint8Array>}
 */
export async function loadVideoROM() {
  const fetched = await fetchROM(VIDEO_SPEC.file);
  const bytes = (fetched && isOptionROM(fetched) ? fetched : null) ?? readStored(VIDEO_KEY);
  return bytes && isOptionROM(bytes) ? bytes : null;
}
