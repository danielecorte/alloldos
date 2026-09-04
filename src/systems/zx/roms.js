// Trovare la ROM dello Spectrum.
//
// Sedici KB, e dentro ci sta tutto: l'interprete BASIC, l'aritmetica in
// virgola mobile a cinque byte, il disegno dei caratteri, il caricamento da
// nastro, il gestore degli interrupt. È il programma più denso di quella
// generazione di macchine — 16 KB per una cosa che sul C64 ne prende 20 e
// sull'Amiga 512 — ed è scritto in gran parte da Steve Vickers, con
// l'aritmetica di Jim Westwood.
//
// È di Amstrad, che comprò tutto il baraccone Sinclair nel 1986, e che da
// allora ne ha permesso la ridistribuzione insieme agli emulatori. È per
// questo che qui, a differenza della Kickstart dell'Amiga, la ROM si scarica
// davvero: sta dentro il sorgente di **Fuse**, l'emulatore libero che gira su
// Unix da vent'anni, ed è da lì che `npm run fetch-roms` la prende.
//
// Chi non ne vuole sapere di una ROM proprietaria ha un'alternativa vera:
// **OpenSE BASIC** è un rimpiazzo libero, compatibile e più veloce, e si mette
// al suo posto trascinandolo sulla finestra.

const STORAGE_KEY = 'alloldos.rom.zx.48';

/** Quanto è grande, e come si riconosce: i primi byte sono sempre quelli. */
export const ROM_SIZE = 0x4000;

/** Dove sta la ROM che si può scaricare, e chi la distribuisce. */
export const FUSE_URL = 'https://fuse-emulator.sourceforge.net/';
export const FUSE_VERSION = '1.6.0';
export const FUSE_SOURCE_URL =
  `https://downloads.sourceforge.net/project/fuse-emulator/fuse/${FUSE_VERSION}/fuse-${FUSE_VERSION}.tar.gz`;

/** Il rimpiazzo libero, per chi lo preferisce. */
export const OPENSE_URL = 'https://spectrumcomputing.co.uk/entry/27510/ZX-Spectrum/OpenSE_BASIC';

export const ROM_SPEC = {
  file: '48.rom',
  size: ROM_SIZE,
  label: 'ZX Spectrum 48K',
  member: `fuse-${FUSE_VERSION}/roms/48.rom`,
  source: FUSE_SOURCE_URL,
};

export class MissingROMError extends Error {
  constructor() {
    super('missing ZX Spectrum ROM');
    this.name = 'MissingROMError';
  }
}

/**
 * Se questi sedici KB sono una ROM da Spectrum. La prima istruzione di ogni
 * ROM Sinclair — e di ogni rimpiazzo che voglia funzionare — è la stessa:
 * chiudere le interruzioni e azzerare A, perché il chip si sveglia con i
 * registri a caso e la prima cosa da fare è non farsi interrompere.
 */
export function isSpectrumROM(bytes) {
  return bytes.length === ROM_SIZE && bytes[0] === 0xf3 && bytes[1] === 0xaf;
}

function romURL() {
  return new URL(`../../../roms/zx/${ROM_SPEC.file}`, import.meta.url);
}

async function fetchROM() {
  try {
    const response = await fetch(romURL(), { cache: 'force-cache' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return isSpectrumROM(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

function readStoredROM() {
  try {
    const encoded = localStorage.getItem(STORAGE_KEY);
    if (!encoded) return null;
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return isSpectrumROM(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** Riconosce un file lasciato cadere sulla finestra. */
export function acceptROMFile(bytes) {
  if (!isSpectrumROM(bytes)) return false;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  localStorage.setItem(STORAGE_KEY, btoa(binary));
  return true;
}

/**
 * @returns {Promise<Uint8Array>}
 * @throws {MissingROMError}
 */
export async function loadROM() {
  const bytes = (await fetchROM()) ?? readStoredROM();
  if (!bytes) throw new MissingROMError();
  return bytes;
}
