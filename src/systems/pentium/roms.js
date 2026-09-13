// Trovare il firmware, che qui per la seconda volta è libero fino in fondo.
//
// Il PC 286 di questa collezione gira su GLaBIOS, che è un BIOS XT: libero, ma
// per una macchina del 1981. Per una macchina del 1995 quel BIOS non basta — ci
// vogliono il PCI, il modo protetto, i dischi grandi — e il firmware libero che
// lo fa esiste, si chiama **SeaBIOS** ed è quello che accende ogni macchina
// virtuale di QEMU da quindici anni. LGPLv3, scritto da zero, e con dentro anche
// la sua **SeaVGABIOS**: il BIOS della scheda video, che è un pezzo a parte
// perché su una macchina vera stava in una ROM sulla scheda.
//
// Sono due file e vanno in `roms/pentium/`. Non stanno nel repository — nessun
// firmware ci sta — ma sono più facili da trovare di tutti gli altri: se sul
// computer c'è QEMU installato, ci sono già, e `npm run fetch-roms` se li prende
// da lì.

const BIOS_KEY = 'alloldos.rom.pentium.bios';
const VIDEO_KEY = 'alloldos.rom.pentium.vgabios';

/** Il progetto, per i crediti e per chi lo vuole andare a prendere. */
export const SEABIOS_URL = 'https://www.seabios.org/';
export const SEABIOS_SOURCE_URL = 'https://www.seabios.org/Download';
/** E il pacchetto Debian, che è il modo più corto di avere i due file. */
export const SEABIOS_PACKAGE_URL = 'https://packages.debian.org/stable/seabios';

/**
 * Il BIOS di sistema. Le misure buone sono tre — 64, 128 e 256 KB — perché
 * SeaBIOS si compila in tutte e tre, e la macchina lo mappa in cima ai quattro
 * giga e in fondo al megabyte: l'ultimo byte dell'immagine sta sempre a FFFFF,
 * e sedici byte prima c'è il salto da cui il processore comincia.
 */
export const BIOS_SPEC = {
  file: 'seabios.bin',
  sizes: [65536, 131072, 262144],
  label: 'SeaBIOS',
  from: '/usr/share/seabios/bios.bin',
};

/**
 * Il BIOS della scheda video. Serve la variante **ISA**: la scheda di questa
 * macchina è una VGA come quelle del 1987, senza le estensioni di Bochs, e
 * quella ROM lo scopre da sé e ripiega sui registri di sempre — lo dice anche,
 * mentre parte. La macchina non la mappa in una finestra: la passa al BIOS
 * attraverso il canale di configurazione, come fa QEMU, e il BIOS la copia dove
 * va e la esegue.
 */
export const VIDEO_SPEC = {
  file: 'vgabios.bin',
  label: 'SeaVGABIOS',
  from: '/usr/share/seabios/vgabios-isavga.bin',
};

export class MissingBIOSError extends Error {
  constructor() {
    super('missing SeaBIOS image');
    this.name = 'MissingBIOSError';
  }
}

/** Un BIOS di sistema si riconosce dalla misura e dal salto in fondo. */
export function isSystemBIOS(bytes) {
  if (!BIOS_SPEC.sizes.includes(bytes.length)) return false;
  // Gli ultimi sedici byte sono il primo codice che il processore esegue, e
  // cominciano con un salto lontano: è così da prima che ci fosse un PC.
  return bytes[bytes.length - 16] === 0xea;
}

/** E una ROM di scheda dai due byte con cui si presenta, come sempre. */
export function isOptionROM(bytes) {
  return bytes.length > 3 && bytes[0] === 0x55 && bytes[1] === 0xaa && bytes[2] > 0;
}

function romURL(file) {
  return new URL(`../../../roms/pentium/${file}`, import.meta.url);
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
 * fa il suo POST — solo che non ha niente su cui scriverlo, come un PC senza
 * monitor attaccato.
 *
 * @returns {Promise<?Uint8Array>}
 */
export async function loadVideoROM() {
  const fetched = await fetchROM(VIDEO_SPEC.file);
  const bytes = (fetched && isOptionROM(fetched) ? fetched : null) ?? readStored(VIDEO_KEY);
  return bytes && isOptionROM(bytes) ? bytes : null;
}
