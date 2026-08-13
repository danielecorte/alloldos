#!/usr/bin/env node
// Headless smoke test: boots the emulated C64, checks it reaches the READY
// prompt, then tokenises a small BASIC program, runs it and reads the result
// back off the screen. Run with `node scripts/selftest.mjs`.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C64 } from '../src/systems/c64/machine.js';
import { tokenize, detokenize } from '../src/systems/c64/basic.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const rom = (name) => new Uint8Array(readFileSync(join(ROOT, 'roms', 'c64', name)));

const SCREEN_CODES =
  '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[£]↑← !"#$%&\'()*+,-./0123456789:;<=>?';

/** Reads one line of the 40x25 text screen back as a string. */
function screenLine(c64, row) {
  let text = '';
  for (let col = 0; col < 40; col++) {
    const code = c64.peek(0x0400 + row * 40 + col) & 0x7f;
    text += code < SCREEN_CODES.length ? SCREEN_CODES[code] : '?';
  }
  return text.trimEnd();
}

function screenText(c64) {
  return Array.from({ length: 25 }, (_, row) => screenLine(c64, row)).join('\n');
}

function runUntil(c64, predicate, maxFrames, what) {
  for (let frame = 0; frame < maxFrames; frame++) {
    c64.runFrame();
    if (predicate(c64)) return frame;
  }
  throw new Error(`timed out after ${maxFrames} frames waiting for ${what}\n\n${screenText(c64)}`);
}

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

// ---------------------------------------------------------------- boot test

const c64 = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });

const bootFrames = runUntil(
  c64,
  (machine) => screenText(machine).includes('READY.'),
  400,
  'the READY prompt',
);
console.log(`\nBooted in ${bootFrames} frames (${(bootFrames / 50.125).toFixed(2)}s of C64 time)\n`);
console.log(screenText(c64).split('\n').slice(0, 6).join('\n'));
console.log();

check('sign-on message', screenText(c64).includes('COMMODORE 64 BASIC V2'));
check('free memory', screenText(c64).includes('38911 BASIC BYTES FREE'));
check('READY prompt', screenText(c64).includes('READY.'));
check('border colour is light blue', c64.vic.borderColor === 14, `got ${c64.vic.borderColor}`);

// Colour RAM is four bits wide, and software reads these cells as plain colour
// numbers: anything in the top nibble turns comparisons against a colour table
// into permanent mismatches, which wedges games solid.
c64.write(0xd800, 0x07);
check('colour RAM reads back as a nibble', c64.read(0xd800) === 0x07, `got $${c64.read(0xd800).toString(16)}`);
c64.write(0xd9ff, 0xff);
check('and never has bits above 15', c64.read(0xd9ff) === 0x0f, `got $${c64.read(0xd9ff).toString(16)}`);
check('screen memory at $0400', c64.vic.videoMatrixBase === 0x0400);

// ------------------------------------------------------------ tokeniser test

const source = `10 rem alloldos self test
20 for i=1 to 3
30 print "line";i
40 next i
50 a$="ok":print a$
`;

const prg = tokenize(source);
check('tokenised load address is $0801', (prg[0] | (prg[1] << 8)) === 0x0801);
check(
  'round trip through the detokeniser',
  detokenize(prg).includes('20 FOR I=1 TO 3'),
  detokenize(prg).split('\n')[1],
);

// The first line must be: link, line number 10, REM token, then the text.
check('REM is stored as token $8f', prg[6] === 0x8f, `got $${prg[6].toString(16)}`);
check('FOR is stored as token $81', prg.includes(0x81));
check("'+'-style operators are tokenised", tokenize('10 a=1+2\n').includes(0xaa));

// ---------------------------------------------------------------- load + run

c64.loadPRG(prg);
check('program links to $0801', c64.peekWord(0x2b) === 0x0801);

// Type RUN and Return into the KERNAL keyboard buffer, exactly like a user would.
c64.typeIntoBuffer([0x52, 0x55, 0x4e, 0x0d]);

runUntil(c64, (machine) => screenText(machine).includes('LINE 3'), 300, 'the program to run');
runUntil(
  c64,
  (machine) => machine.peek(0xc6) === 0 && screenText(machine).lastIndexOf('READY.') > 0,
  300,
  'the program to finish',
);

const output = screenText(c64);
console.log(output.split('\n').filter((line) => line).slice(-8).join('\n'));
console.log();

check('printed LINE 1', output.includes('LINE 1'));
check('printed LINE 2', output.includes('LINE 2'));
check('printed LINE 3', output.includes('LINE 3'));
check('string assignment worked', output.includes('OK'));

// ----------------------------------------------------- the bundled programs

for (const name of readdirSync(join(ROOT, 'programs')).filter((file) => file.endsWith('.bas'))) {
  const text = readFileSync(join(ROOT, 'programs', name), 'utf8');
  let error = null;
  try {
    tokenize(text);
  } catch (cause) {
    error = cause.message;
  }
  check(`programs/${name} tokenises`, error === null, error ?? '');
}

// ciao.bas exercises the control-code escapes, TAB( and POKE.
const hello = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });
runUntil(hello, (machine) => screenText(machine).includes('READY.'), 400, 'the READY prompt');
hello.loadPRG(tokenize(readFileSync(join(ROOT, 'programs', 'ciao.bas'), 'utf8')));
hello.typeIntoBuffer([0x52, 0x55, 0x4e, 0x0d]);
runUntil(hello, (machine) => screenText(machine).includes('BASIC V2.'), 500, 'ciao.bas to finish');

const hi = screenText(hello);
check('{clr} cleared the RUN command away', !hi.includes('RUN\n'), hi.split('\n')[0]);
check('TAB( indented the twelfth line', hi.includes('\n            ALLOLDOS'));
// {cyan} colours the banner, and POKE 646 gives each ALLOLDOS its own colour.
check('{cyan} reached colour RAM', hello.colorRam[40 * 1] === 3, `colour ${hello.colorRam[40 * 1]}`);
check('POKE 646 coloured line 1 white', hello.colorRam[40 * 3 + 1] === 1);
check('POKE 646 coloured line 2 red', hello.colorRam[40 * 4 + 2] === 2);

// Run one of them for real and check the VIC actually drew something.
const maze = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });
runUntil(maze, (machine) => screenText(machine).includes('READY.'), 400, 'the READY prompt');
maze.loadPRG(tokenize(readFileSync(join(ROOT, 'programs', 'labirinto.bas'), 'utf8')));
maze.typeIntoBuffer([0x52, 0x55, 0x4e, 0x0d]);
for (let frame = 0; frame < 1200; frame++) maze.runFrame(); // ~24s of C64 time

const glyphs = Array.from({ length: 1000 }, (_, i) => maze.peek(0x0400 + i)).filter(
  (code) => code === 77 || code === 78, // the two diagonal graphics characters
).length;
check('labirinto.bas filled the screen', glyphs > 800, `${glyphs} graphics characters`);

const lit = maze.vic.framebuffer.filter((pixel) => pixel !== maze.vic.framebuffer[0]).length;
check('the VIC rendered a picture', lit > 5000, `${lit} non-border pixels`);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
