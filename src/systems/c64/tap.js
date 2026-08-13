// The .tap tape image format.
//
// A .tap does not contain files: it contains the raw train of pulses that came
// off the tape head, measured in processor cycles between one falling edge and
// the next. Nothing here understands what the pulses mean — the emulated C64
// decodes them with its own ROM routines, which is why turbo loaders work too.

const SIGNATURE = 'C64-TAPE-RAW';
const HEADER_SIZE = 20;

/** A zero byte in a v0 file means "longer than a byte could say". */
const V0_OVERFLOW_CYCLES = 256 * 8;

export class TAPFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TAPFormatError';
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{version:number, pulses:Int32Array, cycles:number}} pulse lengths in phi2 cycles
 */
export function parseTAP(bytes) {
  if (bytes.length < HEADER_SIZE) throw new TAPFormatError('file too short to be a tape image');

  const signature = String.fromCharCode(...bytes.subarray(0, 12));
  if (signature !== SIGNATURE) {
    throw new TAPFormatError(`not a tape image (expected "${SIGNATURE}", found "${signature}")`);
  }

  const version = bytes[12];
  if (version > 2) throw new TAPFormatError(`unsupported .tap version ${version}`);

  const declared = bytes[16] | (bytes[17] << 8) | (bytes[18] << 16) | (bytes[19] << 24);
  const data = bytes.subarray(HEADER_SIZE, HEADER_SIZE + (declared || bytes.length - HEADER_SIZE));

  const pulses = [];
  let cycles = 0;
  let i = 0;
  while (i < data.length) {
    const byte = data[i++];
    let length;
    if (byte !== 0) {
      length = byte * 8;
    } else if (version === 0) {
      length = V0_OVERFLOW_CYCLES;
    } else {
      // Version 1 and 2 spell long pulses out in three extra bytes.
      length = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
      i += 3;
    }
    pulses.push(length);
    cycles += length;
  }

  return { version, pulses: Int32Array.from(pulses), cycles };
}

// --------------------------------------------------------------- writing

/**
 * The layout below was not taken from documentation: the emulated C64 was made
 * to SAVE a program with its own ROM routines and the resulting waveform was
 * measured. Every pulse is two equal half waves of 184, 256 or 344 cycles, so
 * falling edge to falling edge comes to 368, 512 and 688 — the numbers here.
 */
const SHORT = 0x2e;
const MEDIUM = 0x40;
const LONG = 0x56;

/** Leader lengths the ROM writes, and the gap it leaves between two copies. */
const HEADER_LEADER = 0x6a00; // 27136 pulses, about ten seconds of tape
const DATA_LEADER = 0x1500; // 5376
const COPY_GAP = 80;

/** A 0 bit is short-then-medium, a 1 bit is medium-then-short. */
function writeBit(out, bit) {
  if (bit) out.push(MEDIUM, SHORT);
  else out.push(SHORT, MEDIUM);
}

/** Each byte is announced by a long-medium marker and ends with an odd parity bit. */
function writeByte(out, value) {
  out.push(LONG, MEDIUM);
  let ones = 0;
  for (let i = 0; i < 8; i++) {
    const bit = (value >> i) & 1;
    ones += bit;
    writeBit(out, bit);
  }
  writeBit(out, ones & 1 ? 0 : 1);
}

/**
 * One recording of a block. Everything is stored twice: the countdown bytes
 * tell the loader which copy it is looking at, so a dropout in the first can be
 * repaired from the second.
 */
function writeCopy(out, payload, countdownStart) {
  for (let i = 0; i < 9; i++) writeByte(out, countdownStart - i);

  let checksum = 0;
  for (const byte of payload) {
    writeByte(out, byte);
    checksum ^= byte;
  }
  writeByte(out, checksum);
  out.push(LONG, SHORT); // end of data
}

function writeBlock(out, payload, leaderPulses) {
  for (let i = 0; i < leaderPulses; i++) out.push(SHORT);
  writeCopy(out, payload, 0x89);
  // The two copies are separated by a short run of leader, not butted together:
  // without this gap the ROM reads the first copy and then loses its place.
  for (let i = 0; i < COPY_GAP; i++) out.push(SHORT);
  writeCopy(out, payload, 0x09);
  for (let i = 0; i < COPY_GAP; i++) out.push(SHORT);
}

/** 16 bytes of PETSCII, space padded, the way the header block wants it. */
function tapeName(name) {
  const bytes = new Uint8Array(16).fill(0x20);
  const upper = name.toUpperCase().replace(/[^ -~]/g, '');
  for (let i = 0; i < Math.min(16, upper.length); i++) bytes[i] = upper.charCodeAt(i);
  return bytes;
}

/**
 * Records a program onto a tape image in the standard ROM format.
 * @param {Uint8Array} prg a .prg image, load address first
 * @param {{name?:string, leader?:number}} [options] a shorter leader than the
 *   ROM's own still loads, and makes for a much shorter tape
 * @returns {Uint8Array} a complete .tap file
 */
export function encodeTAP(prg, options = {}) {
  const { name = 'PROGRAM', leader = HEADER_LEADER } = options;

  const start = prg[0] | (prg[1] << 8);
  const data = prg.subarray(2);
  const end = start + data.length;

  // The header block tells the KERNAL what the following data block is.
  const header = new Uint8Array(192).fill(0x20);
  header[0] = 0x01; // relocatable program
  header[1] = start & 0xff;
  header[2] = (start >> 8) & 0xff;
  header[3] = end & 0xff;
  header[4] = (end >> 8) & 0xff;
  header.set(tapeName(name), 5);

  const pulses = [];
  writeBlock(pulses, header, leader);
  writeBlock(pulses, data, Math.min(leader, DATA_LEADER));

  const file = new Uint8Array(HEADER_SIZE + pulses.length);
  for (let i = 0; i < SIGNATURE.length; i++) file[i] = SIGNATURE.charCodeAt(i);
  file[12] = 0; // version 0: every pulse fits in one byte
  file[16] = pulses.length & 0xff;
  file[17] = (pulses.length >> 8) & 0xff;
  file[18] = (pulses.length >> 16) & 0xff;
  file[19] = (pulses.length >> 24) & 0xff;
  file.set(pulses, HEADER_SIZE);

  return file;
}
