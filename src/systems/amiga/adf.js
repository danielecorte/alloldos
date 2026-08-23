// ADF images, and the MFM they have to become.
//
// An .adf file is the bytes of a disk with everything that made it a disk taken
// out: 80 cylinders, two sides, eleven 512-byte sectors, in order, and nothing
// else. What the Amiga's disk hardware actually reads is a bit stream — sector
// headers, checksums, gaps and all — which trackdisk.device decodes in
// software. So the emulator has to put back what the image left out: this is
// the encoder that turns a track of an image into the flux the machine expects.

export const SECTORS_PER_TRACK = 11;
export const BYTES_PER_SECTOR = 512;
export const TRACKS = 160; // 80 cylinders, two heads
export const ADF_SIZE = TRACKS * SECTORS_PER_TRACK * BYTES_PER_SECTOR;

/** The sync word every sector announces itself with. */
export const SYNC = 0x4489;

/** MFM bytes in one physical track — eleven sectors plus the gap. */
export const MFM_TRACK_LENGTH = 12500;

const SECTOR_MFM_LENGTH = 1088;

export class ADFFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ADFFormatError';
  }
}

/**
 * Splits a long into its odd and even bits, each spread out into the data
 * positions of an MFM long. This is the whole trick of Amiga MFM: a value is
 * stored in two passes, so that the clock bit between any two data bits never
 * depends on data the drive has not read yet.
 */
function oddEven(value) {
  return [(value >>> 1) & 0x55555555, value & 0x55555555];
}

function writeLong(out, at, value) {
  out[at] = (value >>> 24) & 0xff;
  out[at + 1] = (value >>> 16) & 0xff;
  out[at + 2] = (value >>> 8) & 0xff;
  out[at + 3] = value & 0xff;
}

/**
 * Encodes one whole track of an image, ready for the disk DMA to stream.
 * @param {Uint8Array} image the .adf
 * @param {number} track cylinder * 2 + head
 * @returns {Uint8Array} MFM_TRACK_LENGTH bytes
 */
export function encodeTrack(image, track) {
  const out = new Uint8Array(MFM_TRACK_LENGTH);
  out.fill(0xaa); // the gap: zero bytes, which in MFM are all clock and no data

  for (let sector = 0; sector < SECTORS_PER_TRACK; sector++) {
    const at = sector * SECTOR_MFM_LENGTH;
    const source = (track * SECTORS_PER_TRACK + sector) * BYTES_PER_SECTOR;

    // Two bytes of nothing, then the sync pattern twice.
    writeLong(out, at, 0xaaaaaaaa);
    out[at + 4] = SYNC >> 8;
    out[at + 5] = SYNC & 0xff;
    out[at + 6] = SYNC >> 8;
    out[at + 7] = SYNC & 0xff;

    // $ff, the track, the sector, and how many sectors are left before the gap.
    const info =
      ((0xff << 24) | (track << 16) | (sector << 8) | (SECTORS_PER_TRACK - sector)) >>> 0;
    const [infoOdd, infoEven] = oddEven(info);
    writeLong(out, at + 8, infoOdd);
    writeLong(out, at + 12, infoEven);

    // The sector label: sixteen bytes AmigaDOS leaves empty.
    for (let i = 0; i < 8; i++) writeLong(out, at + 16 + i * 4, 0);

    // The data, all the odd halves first and then all the even ones.
    let dataChecksum = 0;
    for (let i = 0; i < 128; i++) {
      const long =
        ((image[source + i * 4] << 24) |
          (image[source + i * 4 + 1] << 16) |
          (image[source + i * 4 + 2] << 8) |
          image[source + i * 4 + 3]) >>>
        0;
      const [odd, even] = oddEven(long);
      dataChecksum ^= odd ^ even;
      writeLong(out, at + 64 + i * 4, odd);
      writeLong(out, at + 64 + 512 + i * 4, even);
    }

    // Both checksums are over the MFM data bits, not the bytes they came from.
    const [headerOdd, headerEven] = oddEven((infoOdd ^ infoEven) >>> 0);
    writeLong(out, at + 48, headerOdd);
    writeLong(out, at + 52, headerEven);
    const [dataOdd, dataEven] = oddEven(dataChecksum >>> 0);
    writeLong(out, at + 56, dataOdd);
    writeLong(out, at + 60, dataEven);
  }

  fillClockBits(out);
  return out;
}

/**
 * Puts the clock bits in, in one sweep over the finished track: one between
 * every pair of data bits, set only when both of its neighbours are zero. That
 * rule is what stops the flux transitions from ever drifting too far apart to
 * read back — and the sync word is the one pattern that breaks it, which is
 * precisely what makes it findable in a stream where nothing else can.
 */
function fillClockBits(out) {
  let previous = 0;
  for (let i = 0; i < out.length; i += 2) {
    const word = (out[i] << 8) | out[i + 1];
    if (word === SYNC) {
      previous = word & 1;
      continue;
    }
    let fixed = word & 0x5555;
    for (let bit = 15; bit >= 1; bit -= 2) {
      const data = (fixed >> (bit - 1)) & 1;
      const before = bit === 15 ? previous : (fixed >> (bit + 1)) & 1;
      if (!data && !before) fixed |= 1 << bit;
    }
    out[i] = (fixed >> 8) & 0xff;
    out[i + 1] = fixed & 0xff;
    previous = fixed & 1;
  }
}

/**
 * @param {Uint8Array} bytes
 * @throws {ADFFormatError} if it is not the size a floppy is
 */
export function checkADF(bytes) {
  if (bytes.length !== ADF_SIZE) {
    throw new ADFFormatError(
      `un .adf è di ${ADF_SIZE} byte (880 KB), questo ne ha ${bytes.length}`,
    );
  }
}

/**
 * The name AmigaDOS gave the disk, out of the root block — block 880, where the
 * volume name sits as a length byte followed by up to thirty more.
 * @returns {string} empty if the disk has no readable name
 */
export function volumeName(bytes) {
  const root = 880 * BYTES_PER_SECTOR;
  const length = bytes[root + 432];
  if (!length || length > 30) return '';
  let name = '';
  for (let i = 0; i < length; i++) name += String.fromCharCode(bytes[root + 433 + i]);
  return /^[\x20-\x7e]+$/.test(name) ? name : '';
}

/** True if the disk starts with "DOS", which is what the ROM will boot from. */
export function isBootable(bytes) {
  return bytes[0] === 0x44 && bytes[1] === 0x4f && bytes[2] === 0x53;
}
