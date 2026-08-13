#!/usr/bin/env node
// Presses keys through the same Keyboard class the browser uses and reads back
// what the emulated C64 actually received. Diagnostic tool, not part of `npm test`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { C64 } from '../src/systems/c64/machine.js';
import { readScreenLine, isAtReadyPrompt } from '../src/systems/c64/screen.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const rom = (name) => new Uint8Array(readFileSync(join(ROOT, 'roms', 'c64', name)));

const c64 = new C64({ kernal: rom('kernal.bin'), basic: rom('basic.bin'), chargen: rom('chargen.bin') });
while (!isAtReadyPrompt(c64)) c64.runFrame();

/** A DOM KeyboardEvent as far as Keyboard cares. */
const event = (code, key, shiftKey = false, altKey = false) => ({
  code, key, shiftKey, altKey, ctrlKey: false, metaKey: false,
});

function press(descriptor) {
  const down = c64.keyboard.handleKeyDown(descriptor);
  for (let i = 0; i < 8; i++) c64.runFrame();
  c64.keyboard.handleKeyUp(descriptor);
  for (let i = 0; i < 4; i++) c64.runFrame();
  return down;
}

/** Where the cursor is, so we can read the line being typed. */
const cursorRow = () => c64.peek(0xd6);

function type(descriptors) {
  const row = cursorRow();
  for (const descriptor of descriptors) press(descriptor);
  return readScreenLine(c64, row);
}

let failures = 0;
function expect(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label.padEnd(28)} got "${got}"${ok ? '' : `  want "${want}"`}`);
}

// A plain word: physical keys, no modifiers.
expect(
  'letters',
  type([...'HELLO'].map((c) => event(`Key${c}`, c.toLowerCase()))),
  'HELLO',
);
press(event('Enter', 'Enter'));

// Digits.
expect('digits', type([...'1234567890'].map((c) => event(`Digit${c}`, c))), '1234567890');
press(event('Enter', 'Enter'));

// Symbols, which are mapped by the character the host layout produced.
const symbols = [
  ['"', 'Digit2', true],
  ['(', 'Digit8', true],
  [')', 'Digit9', true],
  [';', 'Semicolon', false],
  [':', 'Period', true],
  [',', 'Comma', false],
  ['.', 'Period', false],
  ['+', 'Equal', false],
  ['-', 'Minus', false],
  ['*', 'Digit8', true],
  ['/', 'Slash', false],
  ['=', 'Equal', false],
  ['?', 'Slash', true],
  ['<', 'Comma', true],
  ['>', 'Period', true],
  ['$', 'Digit4', true],
];
expect(
  'symbols',
  type(symbols.map(([char, code, shift]) => event(code, char, shift))),
  symbols.map(([char]) => char).join(''),
);
press(event('Enter', 'Enter'));

// A real command, typed the way a user would.
const row = cursorRow();
for (const descriptor of [
  event('KeyP', 'p'), event('KeyR', 'r'), event('KeyI', 'i'), event('KeyN', 'n'), event('KeyT', 't'),
  event('Space', ' '),
  event('Digit2', '"', true),
  event('KeyO', 'o'), event('KeyK', 'k'),
  event('Digit2', '"', true),
]) press(descriptor);
expect('a typed command', readScreenLine(c64, row), 'PRINT "OK"');
press(event('Enter', 'Enter'));
for (let i = 0; i < 20; i++) c64.runFrame();

const screen = Array.from({ length: 25 }, (_, r) => readScreenLine(c64, r));
expect('and BASIC ran it', screen.includes('OK') ? 'OK' : screen.join('|'), 'OK');

// Editing keys: INST/DEL, and CLR/HOME plus the cursor.
let editRow = cursorRow();
for (const descriptor of [
  event('KeyA', 'a'), event('KeyB', 'b'), event('KeyC', 'c'), event('KeyD', 'd'),
  event('Backspace', 'Backspace'),
]) press(descriptor);
expect('backspace deletes', readScreenLine(c64, editRow), 'ABC');

// Shift+HOME is CLR, which wipes the screen and parks the cursor at the top.
press(event('End', 'End'));
editRow = cursorRow();
for (const descriptor of [event('KeyH', 'h'), event('KeyI', 'i')]) press(descriptor);
expect('shift+home clears', `${editRow}:${readScreenLine(c64, editRow)}`, '0:HI');

// The cursor keys walk back over what was typed.
for (let i = 0; i < 2; i++) press(event('ArrowLeft', 'ArrowLeft'));
press(event('KeyO', 'o'));
expect('cursor left moves back', readScreenLine(c64, 0), 'OI');

// The Italian layout, where a lot of punctuation is shifted that is not shifted
// on the C64: ';' is Shift+',' on the host but an unshifted key on the machine,
// so the host's Shift must not reach the matrix or you get ']' instead.
press(event('End', 'End'));
// '_' is deliberately absent from the expected text: the C64 has no underscore,
// so it maps to the left-arrow key and that is what the screen shows.
const italian = [
  [';', 'Comma', true, ';'], [':', 'Period', true, ':'], ['_', 'Minus', true, '←'],
  ['!', 'Digit1', true, '!'], ['£', 'Digit3', true, '£'],
  ['/', 'Digit7', true, '/'], ['(', 'Digit8', true, '('], [')', 'Digit9', true, ')'],
  ['=', 'Digit0', true, '='], ['?', 'Minus', true, '?'], ["'", 'Minus', false, "'"],
  ['+', 'BracketRight', false, '+'], ['*', 'BracketRight', true, '*'],
  ['<', 'IntlBackslash', false, '<'], ['>', 'IntlBackslash', true, '>'],
];
c64.keyboard.handleKeyDown(event('ShiftLeft', 'Shift', true));
const italianRow = cursorRow();
for (const [char, code, shift] of italian) press(event(code, char, shift));
c64.keyboard.handleKeyUp(event('ShiftLeft', 'Shift', false));
const italianGot = readScreenLine(c64, italianRow);
press(event('Enter', 'Enter')); // BASIC will complain, but the line is done with
expect('italian layout punctuation', italianGot, italian.map(([, , , shown]) => shown).join(''));

// A '"' typed on its own puts the C64 into quote mode, where control codes are
// printed instead of obeyed. That is faithful, so it is tested separately.
press(event('Digit2', '"', true));
press(event('End', 'End')); // CLR, which quote mode must swallow
press(event('Digit2', '"', true)); // closing quote leaves quote mode
press(event('Enter', 'Enter'));
expect('quote mode swallows CLR', readScreenLine(c64, 0) === '' ? 'cleared' : 'kept', 'kept');

// A modifier whose keyup never arrives — a browser shortcut stole it, or the
// window lost focus mid-chord — must not poison every later keystroke.
press(event('End', 'End')); // CLR, so we get a clean screen
c64.keyboard.handleKeyDown(event('ShiftLeft', 'Shift', true));
for (let i = 0; i < 4; i++) c64.runFrame();
// ...and now the keyup goes missing. The next event reports shiftKey: false.
let stuckRow = cursorRow();
for (const c of 'NEW') press(event(`Key${c}`, c.toLowerCase()));
expect('a lost shift keyup heals', readScreenLine(c64, stuckRow), 'NEW');

// Same for the Commodore key, which lives on Alt.
c64.keyboard.handleKeyDown(event('AltLeft', 'Alt', false, true));
for (let i = 0; i < 4; i++) c64.runFrame();
press(event('Enter', 'Enter'));
stuckRow = cursorRow();
for (const c of 'LIST') press(event(`Key${c}`, c.toLowerCase()));
expect('a lost commodore keyup heals', readScreenLine(c64, stuckRow), 'LIST');
expect('nothing is left held down', c64.keyboard.heldKeyNames().join(',') || '(none)', '(none)');

// ----------------------------------------------------------- the joystick

// Games are split between the two ports and nothing says which one they want,
// so both have to work. Read them the way a game does: port A all outputs held
// high, port B all inputs.
c64.write(0xdc02, 0xff);
c64.write(0xdc00, 0xff);
c64.write(0xdc03, 0x00);
const port1 = () => c64.read(0xdc01);
const port2 = () => c64.read(0xdc00);

const stick = c64.keyboard;
stick.arrowsAreJoystick = true;
stick.setJoystickPort(1);

const push = (code) => {
  const descriptor = event(code, code);
  stick.handleKeyDown(descriptor);
  return () => stick.handleKeyUp(descriptor);
};

let release = push('ArrowRight');
expect('port 1: right pulls PB3 low', (port1() & 0x08) === 0 ? 'low' : 'high', 'low');
expect('port 1: nothing else moves', (port1() & 0x17) === 0x17 ? 'clean' : 'dirty', 'clean');
release();
expect('port 1: released', (port1() & 0x1f) === 0x1f ? 'idle' : 'stuck', 'idle');

release = push('Space');
expect('port 1: space is fire', (port1() & 0x10) === 0 ? 'low' : 'high', 'low');
release();

// The same stick, moved to the other port.
stick.setJoystickPort(2);
release = push('ArrowLeft');
expect('port 2: left pulls PA2 low', (port2() & 0x04) === 0 ? 'low' : 'high', 'low');
expect('port 2: port 1 stays idle', (port1() & 0x1f) === 0x1f ? 'idle' : 'disturbed', 'idle');
release();

// Switching ports must not leave a direction held down on the old one.
release = push('ArrowUp');
stick.setJoystickPort(1);
expect('changing port lets go', (port2() & 0x1f) === 0x1f ? 'idle' : 'stuck', 'idle');
release();

// The keypad is a joystick whatever the cursor keys are doing.
stick.arrowsAreJoystick = false;
stick.setJoystickPort(2);
release = push('Numpad6');
expect('keypad still works', (port2() & 0x08) === 0 ? 'low' : 'high', 'low');
release();
release = push('ArrowRight');
expect('and the arrows are cursor keys again', (port2() & 0x08) === 0x08 ? 'idle' : 'moved', 'idle');
release();

console.log(failures === 0 ? '\nKeyboard OK.' : `\n${failures} keyboard problem(s).`);
process.exit(failures === 0 ? 0 : 1);
