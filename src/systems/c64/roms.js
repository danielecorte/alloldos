// Locating the three C64 firmware images.
//
// They are looked for in /roms/c64 first (put there by `npm run fetch-roms`),
// and otherwise in the browser's local storage, where the drag-and-drop
// fallback keeps whatever the user supplied.

const STORAGE_PREFIX = 'alloldos.rom.c64.';

/**
 * Where someone without the firmware can get it: VICE has shipped it for
 * decades, and this is its source tree — the same place `npm run fetch-roms`
 * looks, so the page and the script can never point at two different files.
 */
export const ROM_SOURCE_URL =
  'https://raw.githubusercontent.com/VICE-Team/svn-mirror/main/vice/data/C64';

export const ROM_SPECS = [
  { name: 'kernal', file: 'kernal.bin', size: 8192, label: 'KERNAL', source: 'kernal-901227-03.bin' },
  { name: 'basic', file: 'basic.bin', size: 8192, label: 'BASIC', source: 'basic-901226-01.bin' },
  { name: 'chargen', file: 'chargen.bin', size: 4096, label: 'Character generator', source: 'chargen-901225-01.bin' },
];

/** `<a>` markup for downloading one ROM from VICE, sized in whole kilobytes. */
export function romDownloadLink(spec) {
  return (
    `<a href="${ROM_SOURCE_URL}/${spec.source}" target="_blank" rel="noopener noreferrer">` +
    `${spec.source}</a> — ${spec.size / 1024} KB`
  );
}

export class MissingROMsError extends Error {
  /** @param {string[]} missing names of the ROMs that could not be found */
  constructor(missing) {
    super(`missing C64 ROMs: ${missing.join(', ')}`);
    this.name = 'MissingROMsError';
    this.missing = missing;
  }
}

/**
 * Where the firmware lives, worked out from this module rather than from the
 * root of the site: hosting alloldos in a subdirectory — which is what GitHub
 * Pages does — must not break the one fetch that has to find its way home.
 */
function romURL(file) {
  return new URL(`../../../roms/c64/${file}`, import.meta.url);
}

async function fetchROM(spec) {
  try {
    const response = await fetch(romURL(spec.file), { cache: 'force-cache' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length === spec.size ? bytes : null;
  } catch {
    return null;
  }
}

function readStoredROM(spec) {
  const encoded = localStorage.getItem(STORAGE_PREFIX + spec.name);
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    if (binary.length !== spec.size) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function storeROM(name, bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  localStorage.setItem(STORAGE_PREFIX + name, btoa(binary));
}

/**
 * Identifies a dropped ROM file and stores it. BASIC and KERNAL are both 8K, so
 * the file name is trusted first and the contents are used to break the tie:
 * BASIC opens with its cold-start vector, KERNAL ends with the reset vector.
 * @returns {?string} the ROM name it was recognised as
 */
export function acceptROMFile(bytes, filename = '') {
  const hint = filename.toLowerCase();
  const named = ROM_SPECS.find((spec) => hint.includes(spec.name) && bytes.length === spec.size);
  const spec = named ?? identifyROM(bytes);
  if (!spec) return null;
  storeROM(spec.name, bytes);
  return spec.name;
}

function identifyROM(bytes) {
  if (bytes.length === 4096) return ROM_SPECS.find((spec) => spec.name === 'chargen');
  if (bytes.length !== 8192) return null;
  if (bytes[0] === 0x94 && bytes[1] === 0xe3) return ROM_SPECS.find((spec) => spec.name === 'basic');
  if (bytes[0x1ffc] === 0xe2 && bytes[0x1ffd] === 0xfc) {
    return ROM_SPECS.find((spec) => spec.name === 'kernal');
  }
  return null;
}

/**
 * @returns {Promise<{kernal:Uint8Array, basic:Uint8Array, chargen:Uint8Array}>}
 * @throws {MissingROMsError}
 */
export async function loadROMs() {
  const found = {};
  const missing = [];

  for (const spec of ROM_SPECS) {
    const bytes = (await fetchROM(spec)) ?? readStoredROM(spec);
    if (bytes) found[spec.name] = bytes;
    else missing.push(spec.label);
  }

  if (missing.length) throw new MissingROMsError(missing);
  return found;
}
