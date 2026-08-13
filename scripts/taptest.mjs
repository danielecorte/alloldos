#!/usr/bin/env node
// Records a BASIC program onto a tape image, then makes the emulated C64 load
// it back with its own ROM routines: LOAD, PRESS PLAY ON TAPE, SEARCHING,
// FOUND, LOADING, READY. If the KERNAL is happy with the pulses, they are right.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C64 } from '../src/systems/c64/machine.js';
import { tokenize } from '../src/systems/c64/basic.js';
import { parseTAP, encodeTAP } from '../src/systems/c64/tap.js';
import { BUTTON_PLAY, BUTTON_RECORD } from '../src/systems/c64/datasette.js';
import { readScreenText, isAtReadyPrompt } from '../src/systems/c64/screen.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const rom = (name) => new Uint8Array(readFileSync(join(ROOT, 'roms', 'c64', name)));

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

function runUntil(c64, predicate, maxFrames, what) {
  for (let frame = 0; frame < maxFrames; frame++) {
    c64.runFrame();
    if (predicate(c64)) return frame;
  }
  throw new Error(`gave up waiting for ${what}\n\n${readScreenText(c64)}`);
}

// ------------------------------------------------------- record a tape

const source = '10 print "caricato dal nastro"\n20 a=6*7:print "a=";a\n';
const prg = tokenize(source);
const tapBytes = encodeTAP(prg, { name: 'NASTRO' });

check('the image is a .tap', String.fromCharCode(...tapBytes.subarray(0, 12)) === 'C64-TAPE-RAW');

const tape = parseTAP(tapBytes);
check('it parses back', tape.pulses.length > 0, `${tape.pulses.length} pulses`);
check(
  'it is a plausible length',
  tape.cycles > 985248 && tape.cycles < 985248 * 60,
  `${(tape.cycles / 985248).toFixed(1)}s of tape`,
);

// -------------------------------------------------------- play it back

const c64 = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });
runUntil(c64, isAtReadyPrompt, 400, 'the READY prompt');

c64.datasette.insert(tape, 'NASTRO');
c64.typeIntoBuffer([0x4c, 0x4f, 0x41, 0x44, 0x0d]); // LOAD + Return

runUntil(
  c64,
  (machine) => readScreenText(machine).includes('PRESS PLAY ON TAPE'),
  200,
  'the PRESS PLAY prompt',
);
check('the KERNAL asks for PLAY', true);

// Press PLAY, exactly as a person would once the machine asked.
c64.datasette.press(BUTTON_PLAY);

runUntil(c64, (machine) => readScreenText(machine).includes('SEARCHING'), 200, 'SEARCHING');
check('the motor starts and it searches', c64.datasette.motorOn);

const foundFrames = runUntil(
  c64,
  (machine) => readScreenText(machine).includes('FOUND'),
  4000,
  'the header to be found',
);
const found = readScreenText(c64).split('\n').find((line) => line.includes('FOUND'));
check('it reads the header block', found?.includes('NASTRO'), found?.trim());

runUntil(c64, (machine) => readScreenText(machine).includes('LOADING'), 2000, 'LOADING');

// The READY. left over from the boot message is still on screen, so wait for
// one that comes after LOADING rather than for any READY. at all.
const loadFinished = (machine) => {
  const text = readScreenText(machine);
  const loading = text.indexOf('LOADING');
  return loading >= 0 && text.indexOf('READY.', loading) > loading;
};
const loadFrames = runUntil(c64, loadFinished, 8000, 'the load to finish');

console.log(
  `\nTape read in ${((foundFrames + loadFrames) / 50.125).toFixed(1)}s of C64 time, ` +
    `${(c64.datasette.progress * 100).toFixed(0)}% of the tape used\n`,
);
console.log(readScreenText(c64).split('\n').filter((line) => line).join('\n'));
console.log();

// ------------------------------------------------- did it arrive intact?

const start = c64.peekWord(0x2b);
const end = c64.peekWord(0x2d);
const loaded = Array.from({ length: end - start }, (_, i) => c64.peek(start + i));
const expected = Array.from(prg.subarray(2));

check('the program landed at $0801', start === 0x0801, `$${start.toString(16)}`);
check(
  'every byte matches what was recorded',
  loaded.length === expected.length && loaded.every((byte, i) => byte === expected[i]),
  `${loaded.length} bytes vs ${expected.length}`,
);

// And it still runs.
c64.typeIntoBuffer([0x52, 0x55, 0x4e, 0x0d]);
runUntil(c64, (machine) => readScreenText(machine).includes('A= 42'), 400, 'the program to run');
check('and it runs', readScreenText(c64).includes('CARICATO DAL NASTRO'));

// ------------------------------------------- the machine records its own

// The strongest check there is: let the KERNAL write a tape with its own SAVE
// routine, then hand the waveform straight back to it.
const scribe = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });
runUntil(scribe, isAtReadyPrompt, 400, 'the READY prompt');
scribe.loadPRG(prg);
scribe.datasette.press(BUTTON_RECORD);
scribe.typeIntoBuffer([0x53, 0x41, 0x56, 0x45, 0x22, 0x41, 0x0d]); // SAVE"A
// The motor also pauses between blocks, so wait for BASIC's prompt rather than
// for the tape to stop, or the recording comes out truncated.
const saveFinished = (machine) => {
  const text = readScreenText(machine);
  const saving = text.indexOf('SAVING');
  return saving >= 0 && text.indexOf('READY.', saving) > saving;
};
runUntil(scribe, saveFinished, 6000, 'the save to finish');

const recorded = scribe.datasette.recordedPulses();
check('the machine recorded a tape', recorded.length > 1000, `${recorded.length} pulses`);

const player = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });
runUntil(player, isAtReadyPrompt, 400, 'the READY prompt');
player.datasette.insert(
  { version: 1, pulses: recorded, cycles: recorded.reduce((total, pulse) => total + pulse, 0) },
  'A',
);
player.typeIntoBuffer([0x4c, 0x4f, 0x41, 0x44, 0x0d]);
runUntil(player, (machine) => readScreenText(machine).includes('PRESS PLAY'), 300, 'PRESS PLAY');
player.datasette.press(BUTTON_PLAY);
runUntil(player, (machine) => readScreenText(machine).includes('FOUND'), 4000, 'FOUND');
runUntil(player, (machine) => readScreenText(machine).includes('LOADING'), 2000, 'LOADING');
runUntil(player, loadFinished, 8000, 'the round trip to finish');

const back = Array.from({ length: player.peekWord(0x2d) - 0x0801 }, (_, i) => player.peek(0x0801 + i));
check(
  'save to tape and load back is lossless',
  back.length === expected.length && back.every((byte, i) => byte === expected[i]),
  `${back.length} bytes back`,
);

console.log(failures === 0 ? '\nTape OK.' : `\n${failures} tape problem(s).`);
process.exit(failures === 0 ? 0 : 1);
