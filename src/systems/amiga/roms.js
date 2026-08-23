// Finding the Kickstart.
//
// An Amiga without its Kickstart is a machine with no operating system at all:
// the ROM is not firmware that helps the machine along, it is exec, graphics,
// intuition and dos, all of AmigaOS below the disk. It is looked for in
// /roms/amiga first, and otherwise in the browser's local storage, where
// whatever was dropped on the window last is kept.
//
// Unlike the C64's ROMs there is nowhere honest to download it from: it is
// Cloanto's, sold with Amiga Forever, and no free mirror of it is a legal one.
// So the page says where to buy it, and points at the one free replacement that
// really does boot — the AROS project's m68k Kickstart.

const STORAGE_KEY = 'alloldos.rom.amiga.kickstart';
const EXTENDED_STORAGE_KEY = 'alloldos.rom.amiga.extended';

/** The 256 KB Kickstarts (1.2, 1.3) and the 512 KB ones (2.0 and later). */
export const KICKSTART_SIZES = [262144, 524288];

/**
 * Where an extended ROM is mapped. The A600, the A1200 and the CDTV all have a
 * second ROM socket answering here, and AROS uses it the same way: the
 * Kickstart half holds exec and the kernel, and everything else lives in a
 * second image that the ROM finds by scanning this address for resident tags.
 */
export const EXTENDED_ROM_BASE = 0xe00000;
export const EXTENDED_ROM_SIZE = 0x80000;

export const AMIGA_FOREVER_URL = 'https://www.amigaforever.com/';
export const AROS_URL = 'https://aros.sourceforge.io/';

export class MissingKickstartError extends Error {
  constructor() {
    super('missing Kickstart ROM');
    this.name = 'MissingKickstartError';
  }
}

/**
 * Where the ROM would live if someone put one there. Worked out from this
 * module rather than from the root of the site, because GitHub Pages serves
 * alloldos from a subdirectory and the one fetch that matters has to find its
 * way home.
 */
function romURL() {
  return new URL('../../../roms/amiga/kickstart.rom', import.meta.url);
}

function extendedURL() {
  return new URL('../../../roms/amiga/extended.rom', import.meta.url);
}

/**
 * What a ROM image says it is. Every one of them starts by declaring its own
 * size and then jumping somewhere — $1114 for a 256 KB image, $1111 for a
 * 512 KB one, followed by a JMP.
 *
 * An extended ROM gives itself away by disagreeing with itself: it is half a
 * megabyte of image carrying the marker of a quarter, because it is not the
 * ROM the machine boots from and nothing checks. That mismatch is the only
 * thing in the header that tells the two apart.
 *
 * @returns {?('kickstart'|'extended')}
 */
export function classifyROM(bytes) {
  if (!KICKSTART_SIZES.includes(bytes.length)) return null;
  const magic = (bytes[0] << 8) | bytes[1];
  const jump = (bytes[2] << 8) | bytes[3];
  if (jump !== 0x4ef9) return null;
  if (magic === 0x1111) return bytes.length === 524288 ? 'kickstart' : null;
  if (magic !== 0x1114) return null;
  return bytes.length === 262144 ? 'kickstart' : 'extended';
}

export function looksLikeKickstart(bytes) {
  return classifyROM(bytes) === 'kickstart';
}

/** Cloanto's own copies are encrypted, and need the key file they came with. */
export function isEncryptedROM(bytes) {
  const header = 'AMIROMTYPE1';
  if (bytes.length < header.length) return false;
  for (let i = 0; i < header.length; i++) {
    if (bytes[i] !== header.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The version and revision the ROM reports about itself, which is what tells a
 * 1.3 from a 3.1.
 * @returns {?{version:number, revision:number, name:string}}
 */
export function romVersion(bytes) {
  const version = (bytes[12] << 8) | bytes[13];
  const revision = (bytes[14] << 8) | bytes[15];
  if (version < 30 || version > 47) return null;
  const names = {
    33: '1.2',
    34: '1.3',
    36: '2.0',
    37: '2.04',
    39: '3.0',
    40: '3.1',
    45: '3.1.4',
    46: '3.2',
    47: '3.2',
  };
  return { version, revision, name: names[version] ?? `V${version}` };
}

/**
 * Where a Kickstart of this size belongs in the address space. The 256 KB ROMs
 * of 1.2 and 1.3 sit in the top quarter of the map and are seen twice; the
 * later 512 KB ones fill the whole of it.
 */
export function romBase(size) {
  return size === 262144 ? 0xfc0000 : 0xf80000;
}

function readStored(key = STORAGE_KEY) {
  const encoded = localStorage.getItem(key);
  if (!encoded) return null;
  try {
    const binary = atob(encoded);
    if (!KICKSTART_SIZES.includes(binary.length)) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function store(bytes, key = STORAGE_KEY) {
  let binary = '';
  // In chunks: a 512 KB apply() argument list is more than the stack will take.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  localStorage.setItem(key, btoa(binary));
}

/**
 * Takes a dropped file and keeps it if it is a ROM of either kind.
 * @returns {?{kind:'kickstart'|'extended', size:number, version:?object}}
 */
export function acceptROMFile(bytes) {
  const kind = classifyROM(bytes);
  if (!kind) return null;
  store(bytes, kind === 'extended' ? EXTENDED_STORAGE_KEY : STORAGE_KEY);
  return { kind, size: bytes.length, version: romVersion(bytes) };
}

async function fetchROM(url, kind) {
  try {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return classifyROM(bytes) === kind ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<Uint8Array>} the ROM image, 256 or 512 KB of it
 * @throws {MissingKickstartError}
 */
export async function loadKickstart() {
  const bytes = (await fetchROM(romURL(), 'kickstart')) ?? readStored();
  if (!bytes) throw new MissingKickstartError();
  return bytes;
}

/**
 * The second ROM, if there is one. There usually is not: a real Kickstart is
 * the whole operating system on its own, and only AROS splits itself in two.
 * @returns {Promise<?Uint8Array>}
 */
export async function loadExtendedROM() {
  return (
    (await fetchROM(extendedURL(), 'extended')) ?? readStored(EXTENDED_STORAGE_KEY) ?? null
  );
}
