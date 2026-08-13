// Commodore BASIC V2 tokeniser and detokeniser.
//
// A .bas file is plain text ("10 PRINT "HI" : GOTO 10"). BASIC does not store
// text: it stores a linked list of lines whose keywords are single bytes. This
// turns one into the other, so a .bas file can be dropped straight into memory
// at $0801 and RUN, exactly as if it had been typed in.

/** Token 0x80 upwards, in ROM order. */
export const TOKENS = [
  'END', 'FOR', 'NEXT', 'DATA', 'INPUT#', 'INPUT', 'DIM', 'READ',
  'LET', 'GOTO', 'RUN', 'IF', 'RESTORE', 'GOSUB', 'RETURN', 'REM',
  'STOP', 'ON', 'WAIT', 'LOAD', 'SAVE', 'VERIFY', 'DEF', 'POKE',
  'PRINT#', 'PRINT', 'CONT', 'LIST', 'CLR', 'CMD', 'SYS', 'OPEN',
  'CLOSE', 'GET', 'NEW', 'TAB(', 'TO', 'FN', 'SPC(', 'THEN',
  'NOT', 'STEP', '+', '-', '*', '/', '^', 'AND',
  'OR', '>', '=', '<', 'SGN', 'INT', 'ABS', 'USR',
  'FRE', 'POS', 'SQR', 'RND', 'LOG', 'EXP', 'COS', 'SIN',
  'TAN', 'ATN', 'PEEK', 'LEN', 'STR$', 'VAL', 'ASC', 'CHR$',
  'LEFT$', 'RIGHT$', 'MID$', 'GO',
];

const REM_TOKEN = 0x8f;
const DATA_TOKEN = 0x83;

/**
 * Keywords sorted longest first, so that INPUT# wins over INPUT and RIGHT$ is
 * never mistaken for a variable called R. Operators are keywords too: the ROM
 * stores '+' as $aa, not as PETSCII.
 */
const KEYWORDS = TOKENS
  .map((text, index) => ({ text, token: 0x80 + index }))
  .sort((a, b) => b.text.length - a.text.length);

/**
 * petcat-style escapes for control characters, so listings can carry cursor
 * moves and colours without resorting to CHR$.
 */
export const CONTROL_ESCAPES = new Map(Object.entries({
  clr: 147, home: 19, down: 17, up: 145, right: 29, left: 157,
  'rvs on': 18, 'rvs off': 146, del: 20, inst: 148, return: 13, space: 32,
  black: 144, white: 5, red: 28, cyan: 159, purple: 156, green: 30,
  blue: 31, yellow: 158, orange: 129, brown: 149, 'light red': 150,
  'grey 1': 151, 'grey 2': 152, 'light green': 153, 'light blue': 154, 'grey 3': 155,
}));

/**
 * Converts one source character to PETSCII. Both cases map to the $41-$5a
 * range, which is what the C64 shows as capitals in its power-on character
 * set — the same convention petcat uses.
 */
export function petsciiFromAscii(char) {
  const code = char.codePointAt(0);
  if (code >= 0x61 && code <= 0x7a) return code - 0x20; // a-z -> A-Z
  if (code === 0xa3) return 0x5c; // £
  if (code === 0x03c0) return 0xff; // π
  if (code > 0xff) return 0x20;
  return code;
}

/** The reverse mapping, for turning a listing back into readable text. */
export function asciiFromPetscii(code) {
  if (code >= 0x41 && code <= 0x5a) return String.fromCharCode(code);
  if (code >= 0xc1 && code <= 0xda) return String.fromCharCode(code - 0x80);
  if (code === 0x5c) return '£';
  if (code === 0xff) return 'π';
  if (code >= 0x20 && code < 0x7f) return String.fromCharCode(code);
  const escape = [...CONTROL_ESCAPES].find(([, value]) => value === code);
  return escape ? `{${escape[0]}}` : '';
}

export class BasicSyntaxError extends Error {
  constructor(message, line) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = 'BasicSyntaxError';
    this.basicLine = line;
  }
}

/**
 * Tokenises BASIC source text into a .prg image.
 * @param {string} source
 * @param {number} [startAddress] where the program will live, normally $0801
 * @returns {Uint8Array} load address (little endian) followed by the program
 */
export function tokenize(source, startAddress = 0x0801) {
  const lines = [];

  for (const rawLine of source.split(/\r\n|\r|\n/)) {
    const text = rawLine.trimEnd();
    if (text.trim() === '') continue;

    const match = /^\s*(\d+)\s?(.*)$/.exec(text);
    if (!match) {
      throw new BasicSyntaxError(`missing line number: "${text.trim().slice(0, 32)}"`);
    }

    const number = Number(match[1]);
    if (number > 63999) throw new BasicSyntaxError('line number above 63999', number);
    if (lines.length && number <= lines[lines.length - 1].number) {
      throw new BasicSyntaxError('line numbers must increase', number);
    }

    lines.push({ number, bytes: tokenizeLine(match[2], number) });
  }

  if (lines.length === 0) throw new BasicSyntaxError('the file contains no BASIC lines');

  // Lay the lines out as a linked list and resolve the forward pointers.
  const out = [];
  let address = startAddress;
  for (const line of lines) {
    const next = address + 4 + line.bytes.length + 1;
    out.push(next & 0xff, (next >> 8) & 0xff);
    out.push(line.number & 0xff, (line.number >> 8) & 0xff);
    out.push(...line.bytes, 0x00);
    address = next;
  }
  out.push(0x00, 0x00); // end of program

  return Uint8Array.from([startAddress & 0xff, (startAddress >> 8) & 0xff, ...out]);
}

function tokenizeLine(text, lineNumber) {
  const bytes = [];
  const upper = text.toUpperCase();
  let i = 0;
  let inQuotes = false;
  let literalUntilColon = false; // everything after DATA is stored verbatim

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') inQuotes = false;
      if (char === '{') {
        const consumed = readEscape(text, i, bytes, lineNumber);
        if (consumed) {
          i += consumed;
          continue;
        }
      }
      bytes.push(petsciiFromAscii(char));
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      bytes.push(0x22);
      i++;
      continue;
    }

    if (literalUntilColon) {
      if (char === ':') literalUntilColon = false;
      else {
        bytes.push(petsciiFromAscii(char));
        i++;
        continue;
      }
    }

    if (char === '?') {
      bytes.push(0x99); // the classic PRINT abbreviation
      i++;
      continue;
    }

    if (char === '{') {
      const consumed = readEscape(text, i, bytes, lineNumber);
      if (consumed) {
        i += consumed;
        continue;
      }
    }

    const keyword = matchKeyword(upper, i);
    if (keyword) {
      bytes.push(keyword.token);
      i += keyword.text.length;

      if (keyword.token === REM_TOKEN) {
        // REM swallows the rest of the line, control escapes included.
        while (i < text.length) {
          if (text[i] === '{') {
            const consumed = readEscape(text, i, bytes, lineNumber);
            if (consumed) {
              i += consumed;
              continue;
            }
          }
          bytes.push(petsciiFromAscii(text[i]));
          i++;
        }
        break;
      }
      if (keyword.token === DATA_TOKEN) literalUntilColon = true;
      continue;
    }

    bytes.push(petsciiFromAscii(char));
    i++;
  }

  if (bytes.length > 250) {
    throw new BasicSyntaxError(`line too long (${bytes.length} bytes, max 250)`, lineNumber);
  }
  return bytes;
}

/**
 * Matches a keyword at `index` in the already-uppercased line.
 * @returns {?{text:string, token:number}}
 */
function matchKeyword(upper, index) {
  for (const entry of KEYWORDS) {
    if (upper.startsWith(entry.text, index)) return entry;
  }
  return null;
}

/**
 * Reads a `{name}` or `{n name}` escape and appends its PETSCII bytes.
 * @returns {number} characters consumed, or 0 when this is not an escape
 */
function readEscape(text, index, bytes, lineNumber) {
  const close = text.indexOf('}', index);
  if (close === -1) return 0;

  const body = text.slice(index + 1, close).toLowerCase().trim();
  const repeated = /^(\d+)\s+(.*)$/.exec(body);
  const name = repeated ? repeated[2] : body;
  const count = repeated ? Number(repeated[1]) : 1;

  let code = CONTROL_ESCAPES.get(name);
  if (code === undefined) {
    // {$1f} and {31} both name a raw PETSCII byte.
    if (/^\$[0-9a-f]{1,2}$/.test(name)) code = parseInt(name.slice(1), 16);
    else if (/^\d{1,3}$/.test(name)) code = Number(name);
    else return 0; // not an escape after all, treat '{' literally

    if (code > 255) throw new BasicSyntaxError(`escape {${body}} is not a byte`, lineNumber);
  }

  for (let n = 0; n < count; n++) bytes.push(code);
  return close - index + 1;
}

/**
 * Turns a tokenised program back into source text.
 * @param {Uint8Array} prg a .prg image, load address first
 */
export function detokenize(prg) {
  let i = 2; // skip the load address
  const out = [];

  while (i + 1 < prg.length) {
    const next = prg[i] | (prg[i + 1] << 8);
    if (next === 0) break;
    const number = prg[i + 2] | (prg[i + 3] << 8);
    i += 4;

    let line = `${number} `;
    let inQuotes = false;
    while (i < prg.length && prg[i] !== 0) {
      const byte = prg[i++];
      if (byte === 0x22) inQuotes = !inQuotes;
      if (byte >= 0x80 && byte <= 0xcb && !inQuotes) line += TOKENS[byte - 0x80];
      else line += asciiFromPetscii(byte);
    }
    i++; // skip the line terminator
    out.push(line);
  }

  return out.join('\n') + '\n';
}
