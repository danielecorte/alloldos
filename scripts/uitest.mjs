#!/usr/bin/env node
// Runs the browser layer — the session in src/systems/c64/index.js — against a
// stub DOM, so the code that only ever ran in a browser gets exercised too.
// Anything it throws lands here instead of in someone's console.
//
//   node scripts/uitest.mjs [tape.tap]

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// ------------------------------------------------------------ the stub DOM

class StubElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.innerHTML = '';
    this.hidden = false;
    this.files = [];
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    };
  }

  append(...nodes) {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes) {
    this.children = nodes;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ preventDefault() {}, ...event });
  }

  setAttribute() {}
  focus() {}
  click() {}
  remove() {}
  blur() {}

  requestFullscreen() {
    document.fullscreenElement = this;
    document.dispatch('fullscreenchange');
    return Promise.resolve();
  }

  getContext() {
    return {
      createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: () => {},
    };
  }
}

const listeners = new Map();
const windowStub = {
  addEventListener(type, handler) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const list = listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  },
  setInterval: () => 0,
  clearInterval: () => {},
  // AudioContext is attached below, once the class exists.
};

/** Sends a keyboard event the way the browser would, to the window listeners. */
function sendKey(type, code, key, extra = {}) {
  for (const handler of listeners.get(type) ?? []) {
    handler({ code, key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, ...extra });
  }
}

class StubAudioContext {
  constructor() {
    this.state = 'suspended';
    this.sampleRate = 44100;
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  createGain() {
    return { gain: { value: 0 }, connect: (node) => node, disconnect() {} };
  }
  close() {
    return Promise.resolve();
  }
}

class StubAudioWorkletNode {
  constructor() {
    this.port = { postMessage: () => {}, onmessage: null };
  }
  connect(node) {
    return node;
  }
  disconnect() {}
}

// The animation-frame queue, driven by hand below.
let pendingFrames = [];
globalThis.requestAnimationFrame = (callback) => pendingFrames.push(callback);
globalThis.cancelAnimationFrame = () => {};
globalThis.window = windowStub;
windowStub.AudioContext = StubAudioContext;
globalThis.AudioContext = StubAudioContext;
globalThis.AudioWorkletNode = StubAudioWorkletNode;
const documentListeners = new Map();
globalThis.document = {
  createElement: (tag) => new StubElement(tag),
  body: new StubElement('body'),
  fullscreenElement: null,
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, []);
    documentListeners.get(type).push(handler);
  },
  removeEventListener(type, handler) {
    const list = documentListeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  },
  dispatch(type) {
    for (const handler of documentListeners.get(type) ?? []) handler({});
  },
  exitFullscreen() {
    document.fullscreenElement = null;
    document.dispatch('fullscreenchange');
    return Promise.resolve();
  },
};
globalThis.localStorage = {
  store: new Map(),
  getItem(key) {
    return this.store.get(key) ?? null;
  },
  setItem(key, value) {
    this.store.set(key, value);
  },
  removeItem(key) {
    this.store.delete(key);
  },
};
globalThis.fetch = async (url) => {
  // A browser resolves every URL against the page; here the module-relative
  // ones arrive already absolute, as file: URLs.
  const text = String(url);
  const path = text.startsWith('file:') ? fileURLToPath(text) : join(ROOT, text.replace(/^\//, ''));
  if (!existsSync(path)) return { ok: false, status: 404 };
  const bytes = readFileSync(path);
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};

// ---------------------------------------------------------------- the run

const { boot } = await import('../src/systems/c64/index.js');
const { readScreenText } = await import('../src/systems/c64/screen.js');

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

const container = new StubElement('main');
const session = await boot(container, { onExit: () => {} });
check('the session booted', session.machine !== null);
check('the canvas is the size of the picture', session.canvas.width === 384);

let now = 0;
/** Runs the animation-frame loop, surfacing anything it throws. */
function pump(ticks, milliseconds = 16) {
  for (let i = 0; i < ticks; i++) {
    const due = pendingFrames;
    pendingFrames = [];
    now += milliseconds;
    for (const callback of due) callback(now);
  }
}

pump(200);
check('it reaches the READY prompt', readScreenText(session.machine).includes('READY.'));

// Typing goes through the real window listeners.
for (const [code, key] of [['KeyP', 'p'], ['KeyR', 'r'], ['KeyI', 'i'], ['KeyN', 'n'], ['KeyT', 't']]) {
  sendKey('keydown', code, key);
  pump(6);
  sendKey('keyup', code, key);
  pump(3);
}
sendKey('keydown', 'Enter', 'Enter');
pump(4);
sendKey('keyup', 'Enter', 'Enter');
pump(40);
// PRINT on its own is valid BASIC and just prints a blank line, so look for the
// echoed command rather than for an error.
check('a typed command reaches BASIC', readScreenText(session.machine).includes('PRINT'));

// Loading a .bas through the same path the file picker uses.
session.runProgram(
  (await import('../src/systems/c64/basic.js')).tokenize('10 print "ui test"\n'),
  'test.bas',
);
pump(400);
check('a .bas loads and runs', readScreenText(session.machine).includes('UI TEST'));

// And a tape, if one is lying around.
const tapeFile = process.argv[2] ?? '1994.tap';
if (existsSync(join(ROOT, tapeFile))) {
  session.insertTape(new Uint8Array(readFileSync(join(ROOT, tapeFile))), tapeFile.replace(/\.tap$/i, ''));
  check('the tape went in', session.machine.datasette.tape !== null);

  // Warp makes each tick worth 24 frames, so this is the whole tape.
  for (let i = 0; i < 4000 && session.tapeStage; i++) pump(1);
  check('the tape finished loading', session.tapeStage === null, `stage ${session.tapeStage}`);
  pump(300);

  const screen = readScreenText(session.machine);
  check('the game started', screen.includes('PRESS'), screen.split('\n').find((line) => line.includes('PRESS')));

  // C, then S, then P — the keys that stopped it in the browser.
  for (const [code, key] of [['KeyC', 'c'], ['KeyS', 's'], ['KeyP', 'p']]) {
    sendKey('keydown', code, key);
    pump(20);
    sendKey('keyup', code, key);
    pump(120);
    console.log(`      after ${key.toUpperCase()}: pc $${session.machine.cpu.pc.toString(16)}`);
  }
  check('the machine is still running', !session.machine.cpu.jammed);
  check('the animation loop is still alive', pendingFrames.length > 0);

  // Alive is not the same as doing something: watch the picture and the spread
  // of the program counter to tell a running game from a wedged one.
  // The whole picture, not the first rows: those are all top border and never
  // change, which makes a perfectly healthy game look frozen.
  const snapshot = () => {
    let hash = 0;
    const pixels = session.machine.vic.framebuffer;
    for (let i = 0; i < pixels.length; i += 7) hash = (hash * 31 + pixels[i]) | 0;
    return hash;
  };
  const pcSeen = new Set();
  const originalStep = session.machine.cpu.step.bind(session.machine.cpu);
  session.machine.cpu.step = () => {
    pcSeen.add(session.machine.cpu.pc & 0xff00);
    return originalStep();
  };

  const before = snapshot();
  pump(120);
  const after = snapshot();
  check('the picture is still changing', before !== after);
  check('the game is running real code', pcSeen.size > 3, `${pcSeen.size} pages touched`);

  // Running is still not the same as playable, so play it. 1994 steers with up
  // and down — up walks right, down walks left — and the man is sprite 0, so
  // his X coordinate is the whole chain end to end: a keydown on the window,
  // the matrix, joystick port 1, the game's own read of $dc01, the picture.
  check(
    'the emulator spotted which port the game wants',
    session.machine.joystickPolls[1] > session.machine.joystickPolls[2],
    `port 1: ${session.machine.joystickPolls[1]} reads, port 2: ${session.machine.joystickPolls[2]}`,
  );

  check(
    'and said so in the status bar, while there was still time to be useful',
    session.status.textContent.includes('porta 1'),
    session.status.textContent,
  );

  session.cycleJoystick(); // arrows and space become the stick in port 1
  check('the arrows are a joystick in port 1', session.machine.keyboard.joystickPort === 1);

  /** Holds a key down and reports where the man ended up, sampled as he walks. */
  const walk = (code) => {
    const positions = [];
    sendKey('keydown', code, code);
    for (let i = 0; i < 10; i++) {
      pump(12);
      positions.push(session.machine.vic.spriteX[0]);
    }
    sendKey('keyup', code, code);
    pump(6);
    return positions;
  };

  // Left first: he starts near the right-hand edge, where there is no room to
  // walk right and a working control would look like a broken one.
  const left = walk('ArrowDown');
  const right = walk('ArrowUp');
  const still = walk('KeyZ'); // a key the game does not use: he should stay put

  check('down walks the man left', left[left.length - 1] < left[0], left.join(' '));
  check('up walks him back to the right', right[right.length - 1] > right[0], right.join(' '));
  check('and he stands still when nothing is pressed', still.every((x) => x === still[0]), still.join(' '));
}

// Fullscreen, through the same button the bar shows.
session.toggleFullscreen();
check('fullscreen hands the screen to the whole machine', document.fullscreenElement === session.root);
check('and the button offers the way back', session.fullscreenButton.textContent === 'Finestra');

// Leaving it the browser's way — Escape, or its own control — not ours.
document.exitFullscreen();
check('leaving fullscreen is noticed even when the browser does it', document.fullscreenElement === null);
check('and the button says so again', session.fullscreenButton.textContent === 'Schermo intero');

// A double click on the picture is the other way in.
session.canvas.dispatch('dblclick');
check('a double click on the picture does it too', document.fullscreenElement === session.root);
document.exitFullscreen();

// The panel someone without the ROMs lands on. No local run ever shows it —
// the ROMs are right there in roms/ — but on a public page it is the first
// thing every visitor sees, so it gets checked like anything else.
let filePickerOpened = false;
session.pickFile = () => { filePickerOpened = true; };
session.showROMPrompt(['KERNAL']);
const panel = session.overlay.children[0];
const panelText = [panel.innerHTML, ...panel.children.map((node) => node.innerHTML || node.textContent)].join(' ');
check('the ROM prompt asks for the ROMs before explaining itself', panelText.includes('Trascina qui'));
check('it says what is missing, and under what name', panelText.includes('KERNAL') && panelText.includes('kernal.bin'));
panel.children.find((node) => node.tagName === 'BUTTON').dispatch('click');
check('and its button opens the file picker', filePickerOpened);

session.dispose();
check('it shuts down cleanly', session.running === false);

// The about page boots through the same contract as a machine, so it can be
// run here the same way — and what it claims about itself has to be true.
const aboutEntry = (await import('../src/boot/systems.js')).SYSTEMS.find((system) => system.id === 'about');
check('the boot menu lists an about entry', aboutEntry?.available === true && typeof aboutEntry.load === 'function');

let leftAbout = false;
const about = await (await aboutEntry.load()).boot(new StubElement('main'), { onExit: () => { leftAbout = true; } });
const aboutText = about.root.children.map((node) => node.innerHTML || node.textContent).join(' ');
check('it says who wrote it', aboutText.includes('Daniele Corte') && aboutText.includes('Claude Code'));
check('it says which licence it is under', aboutText.includes('GNU General Public License'));
check('it points at the public repository', aboutText.includes('github.com/danielecorte/alloldos'));

sendKey('keydown', 'Escape', 'Escape');
check('Escape goes back to the boot menu', leftAbout);
about.dispose();
sendKey('keydown', 'Escape', 'Escape'); // nothing left listening, nothing should happen

console.log(failures === 0 ? '\nUI OK.' : `\n${failures} UI problem(s).`);
process.exit(failures === 0 ? 0 : 1);
