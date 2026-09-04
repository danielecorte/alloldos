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
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      toggle: (name, on) => {
        if (on ?? !this.classes.has(name)) this.classes.add(name);
        else this.classes.delete(name);
      },
      contains: (name) => this.classes.has(name),
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

  requestPointerLock() {
    document.pointerLockElement = this;
    document.dispatch('pointerlockchange');
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
  innerHeight: 800,
  innerWidth: 1200,
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
    return {
      gain: { value: 0, setValueAtTime() {}, setTargetAtTime() {} },
      connect: (node) => node,
      disconnect() {},
    };
  }
  createOscillator() {
    return {
      type: 'square',
      frequency: { value: 0, setValueAtTime() {} },
      connect: (node) => node,
      start() {},
      stop() {},
    };
  }
  get currentTime() {
    return 0;
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
  pointerLockElement: null,
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
  exitPointerLock() {
    document.pointerLockElement = null;
    document.dispatch('pointerlockchange');
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

// A double click on the picture is the other way in. The C64 has no mouse of
// its own, so the gesture is free; on the Amiga it is not, and it is gone there.
session.canvas.dispatch('dblclick');
check('a double click on the picture does it too', document.fullscreenElement === session.root);

// The bar hides itself in fullscreen and comes back at the bottom edge.
check('entering fullscreen shows the bar, to say where it went', session.root.classes.has('c64--controls-shown'));
session.hideControls();
session.root.dispatch('mousemove', { clientY: 400 });
check('the bar stays away while the pointer is on the picture', !session.root.classes.has('c64--controls-shown'));
session.root.dispatch('mousemove', { clientY: 780 });
check('and comes back when it goes down to the edge', session.root.classes.has('c64--controls-shown'));
session.root.dispatch('mousemove', { clientY: 100 });
check('then goes away again on its own', !session.root.classes.has('c64--controls-shown'));
check('and the bar itself is where it always was', session.controls.children.includes(session.bar));
document.exitFullscreen();
check('out of fullscreen nothing is hidden any more', !session.root.classes.has('c64--controls-shown'));

// The panel someone without the ROMs lands on. No local run ever shows it —
// the ROMs are right there in roms/ — but on a public page it is the first
// thing every visitor sees, so it gets checked like anything else.
let filePickerOpened = false;
session.pickFile = () => { filePickerOpened = true; };
session.showROMPrompt(['KERNAL']);
const panel = session.overlay.children[0];
const panelText = [panel.innerHTML, ...panel.children.map((node) => node.innerHTML || node.textContent)].join(' ');
check('the ROM prompt asks for the ROMs before explaining itself', panelText.includes('Trascina qui'));
check('it says what is missing', panelText.includes('KERNAL'));
check(
  'and offers a download for it, rather than leaving the visitor to guess',
  panelText.includes('kernal-901227-03.bin') && panelText.includes('VICE-Team'),
);
check('but only for the ROM that is actually missing', !panelText.includes('chargen-901225-01.bin'));
panel.children.find((node) => node.tagName === 'BUTTON').dispatch('click');
check('and its button opens the file picker', filePickerOpened);

session.dispose();
check('it shuts down cleanly', session.running === false);

// ------------------------------------------------------------- the Amiga

// The same browser layer, for the other machine. It starts with no Kickstart,
// which is what every visitor to the public page gets, and then is handed one.
const amigaEntry = (await import('../src/boot/systems.js')).SYSTEMS.find((s) => s.id === 'amiga');
check('the boot menu offers the Amiga', amigaEntry?.available === true);

const amigaModule = await amigaEntry.load();
const amiga = await amigaModule.boot(new StubElement('main'), { onExit: () => {} });

/** A file the way the browser hands one over. */
const asFile = (name, bytes) => ({ name, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });

// A Kickstart-shaped ROM with a program in it rather than an operating system:
// enough to prove that a dropped ROM is recognised, stored and booted. It is
// only needed when there is no real one in roms/amiga to boot from.
const fakeROM = new Uint8Array(262144);
const romView = new DataView(fakeROM.buffer);
romView.setUint16(0, 0x1114, false); // the size marker a 256 KB Kickstart starts with
romView.setUint16(2, 0x4ef9, false); // and its jump
romView.setUint32(4, 0x00fc0008, false);
[0x33fc, 0x0f00, 0x00df, 0xf180, 0x60fe].forEach((word, i) => romView.setUint16(8 + i * 2, word, false));

if (amiga.machine === null) {
  check('with no Kickstart it does not pretend to have booted', true);
  await amiga.acceptFile(asFile('kick13.rom', fakeROM));
  check('and a dropped one starts the machine', amiga.machine !== null);
  check('and is kept for next time', localStorage.getItem('alloldos.rom.amiga.kickstart') !== null);
} else {
  check('a Kickstart in roms/amiga boots on its own', amiga.machine !== null);
  check('and the session says which one', amiga.status.textContent.includes('Kickstart'), amiga.status.textContent);
}

// The panel a visitor without a ROM lands on. No local run reaches it when
// there is a ROM in roms/amiga, so it is asked for by name, the same way the
// C64's is.
amiga.showROMPrompt();
const romPanel = amiga.overlay.children[0];
const romText = [romPanel.innerHTML, ...romPanel.children.map((n) => n.innerHTML || n.textContent)].join(' ');
check('it asks for the ROM before explaining itself', romText.includes('Trascina qui la ROM Kickstart'));
check('it says how big one is', romText.includes('256 KB') && romText.includes('512 KB'));
check('it points at the licence you can buy', romText.includes('amigaforever.com'));
check('and at the free replacement that works', romText.includes('aros'));
amiga.overlay.replaceChildren();

pump(10);
check('the emulated 68000 is running the ROM', amiga.machine.cpu.instructions > 1000, `${amiga.machine.cpu.instructions} istruzioni`);
check('and the picture is being drawn', amiga.machine.frameCount > 0, `${amiga.machine.frameCount} quadri`);

// A disk, through the same path the file picker uses.
const adf = new Uint8Array(901120);
adf.set([0x44, 0x4f, 0x53, 0x00]); // "DOS"
const root = 880 * 512;
const label = 'Workbench';
adf[root + 432] = label.length;
for (let i = 0; i < label.length; i++) adf[root + 433 + i] = label.charCodeAt(i);

await amiga.acceptFile(asFile('workbench.adf', adf));
check('a dropped .adf goes in the drive', amiga.machine.drives[0].inserted);
check('and the drive row says what is in it', amiga.driveRows[0].label.textContent.includes('Workbench'));
check('and that it can be booted from', amiga.status.textContent.includes('Reset'));
check('while the second drive says it is empty', amiga.driveRows[1].label.textContent.includes('vuoto'));

// The second disk of a game goes in the second drive, without being asked.
const other = adf.slice();
const otherLabel = 'Disco2';
other[root + 432] = otherLabel.length;
for (let i = 0; i < otherLabel.length; i++) other[root + 433 + i] = otherLabel.charCodeAt(i);
await amiga.acceptFile(asFile('disco2.adf', other));
check('a second .adf goes into DF1:', amiga.machine.drives[1].inserted);
check('and DF0: keeps the one it had', amiga.machine.drives[0].label === 'Workbench');
check('and the row says which drive it went into', amiga.driveRows[1].label.textContent.includes('DF1:'));
check('and the bar says it too', amiga.status.textContent.includes('DF1:'), amiga.status.textContent);

// What happens when the machine writes to it. There is nowhere in a browser to
// put a disk down, so the .adf comes straight back out as a file.
const downloads = [];
const realCreateObjectURL = URL.createObjectURL;
const realCreateElement = document.createElement;
let lastAnchor = null;
globalThis.URL.createObjectURL = (blob) => {
  downloads.push(blob);
  return 'blob:stub';
};
document.createElement = (tag) => {
  const node = realCreateElement(tag);
  if (tag === 'a') lastAnchor = node;
  return node;
};

const drive = amiga.machine.drives[0];
drive.image[123] = 0x77; // where a write would have left its mark
drive.modified = true;
drive.writeCount++;

amiga.offerModifiedDisk(0);
check('a disk being written to is not handed back mid-write', downloads.length === 0);
amiga.quietAt[0] = performance.now() - 1; // the drive has gone quiet
amiga.offerModifiedDisk(0);
check('and comes back as a file once the drive stops', downloads.length === 1);
check('a whole .adf of it', downloads[0]?.size === 901120, `${downloads[0]?.size} byte`);
check('named after the disk', /^workbench .*\.adf$/.test(lastAnchor?.download ?? ''), lastAnchor?.download);
check('and the bar says which drive wrote it', amiga.status.textContent.includes('DF0:'), amiga.status.textContent);
amiga.offerModifiedDisk(0);
check('the same write is not downloaded twice', downloads.length === 1);
amiga.updateDrives(); // the drive lights are redrawn every frame
check('the drive light shows the disk has been written to', amiga.driveRows[0].label.textContent.includes('scritto'));

// The other drive has its own everything: its own tab, its own count.
amiga.toggleWriteProtect(1);
check('the write-protect tab can be pushed across', amiga.machine.drives[1].writeProtected === true);
check('on that drive and not the other', drive.writeProtected === false);
check('and its button says which way it is', amiga.driveRows[1].protect.textContent.includes('sì'));
amiga.toggleWriteProtect(1);
check('and back', amiga.machine.drives[1].writeProtected === false);

drive.writeCount++; // one more write, still in the machine
amiga.ejectDisk(0);
check('ejecting a written disk hands it back first', downloads.length === 2);
check('and it comes back out again', amiga.machine.drives[0].inserted === false);
check('while DF1: still has its disk', amiga.machine.drives[1].inserted);

// With DF0: empty again, the next disk dropped goes back into it.
await amiga.acceptFile(asFile('workbench.adf', adf));
check('a disk dropped now fills the empty drive', amiga.machine.drives[0].inserted);
amiga.ejectDisk(0);
amiga.ejectDisk(1);
check('and both come out', !amiga.machine.drives[0].inserted && !amiga.machine.drives[1].inserted);

globalThis.URL.createObjectURL = realCreateObjectURL;
document.createElement = realCreateElement;

// A file that is neither a ROM nor a disk says so instead of throwing.
await amiga.acceptFiles([asFile('nonsense.txt', new Uint8Array(64))]);
check('anything else is refused politely', amiga.status.textContent.includes('.adf'), amiga.status.textContent);

// The mouse: the Amiga only ever knows how far the ball turned.
amiga.captureMouse();
check('the picture can capture the pointer', document.pointerLockElement === amiga.canvas);
const beforeMouse = amiga.machine.keyboard.joy0dat;
amiga.canvas.dispatch('mousemove', { movementX: 8, movementY: 4 });
check('and moving it moves the counters', amiga.machine.keyboard.joy0dat !== beforeMouse);
amiga.canvas.dispatch('mousedown', { button: 0 });
check('the left button is a CIA pin, and it goes low', amiga.machine.keyboard.fireBit === 0);
amiga.canvas.dispatch('mouseup', { button: 0 });
check('and back up', amiga.machine.keyboard.fireBit === 0x40);

// The joystick has to be asked for, because it takes keys the Amiga wants.
check('there is no stick in the port to begin with', amiga.machine.keyboard.arrowsAreJoystick === false);
sendKey('keydown', 'ArrowLeft', 'ArrowLeft');
check('so a cursor key is a cursor key', amiga.machine.keyboard.joy1dat === 0);
sendKey('keyup', 'ArrowLeft', 'ArrowLeft');

amiga.toggleJoystick();
check('the button plugs one in', amiga.machine.keyboard.arrowsAreJoystick === true);
check('and says which port it went into', amiga.joystickButton.textContent.includes('porta 2'));
sendKey('keydown', 'ArrowLeft', 'ArrowLeft');
check('now the same key pushes the stick', (amiga.machine.keyboard.joy1dat & 0x0200) !== 0);
sendKey('keyup', 'ArrowLeft', 'ArrowLeft');

amiga.toggleJoystick();
check('and the button takes it out again', amiga.joystickButton.textContent === 'Joystick: no');

// Typing: a key becomes a byte on the keyboard's serial line, inverted.
sendKey('keydown', 'KeyA', 'a');
const queued = amiga.machine.keyboard.queue;
check('a key press is queued as an Amiga key code', queued[queued.length - 1] === (~(0x20 << 1) & 0xff), String(queued[queued.length - 1]));

// The double click belongs to the Amiga: it opens drawers, picks up icons and
// starts games, and it must not throw the screen back into a window.
document.exitPointerLock();
amiga.toggleFullscreen();
amiga.canvas.dispatch('dblclick');
check('a double click no longer drops out of fullscreen', document.fullscreenElement === amiga.root);

amiga.hideControls();
amiga.root.dispatch('mousemove', { clientY: 780 });
check('the bar comes back at the bottom edge', amiga.root.classes.has('amiga--controls-shown'));

// With the mouse captured the pointer is the Amiga's, and the edge means
// nothing: the way back to the bar is Escape, which lets the pointer go.
amiga.captureMouse();
check('capturing the mouse takes the bar away', !amiga.root.classes.has('amiga--controls-shown'));
amiga.root.dispatch('mousemove', { clientY: 799 });
check('and the edge does not bring it back while the Amiga has the pointer', !amiga.root.classes.has('amiga--controls-shown'));
document.exitPointerLock();
check('letting the pointer go brings the bar back', amiga.root.classes.has('amiga--controls-shown'));
document.exitFullscreen();

amiga.dispose();
check('the Amiga shuts down cleanly', amiga.running === false);


// ------------------------------------------------------------------ il PC

// La terza macchina. A differenza delle altre due il suo firmware è libero e
// sta in roms/pc, quindi qui si accende davvero e si arriva al DOS — che è
// l'unico modo di sapere che ci si arriva anche aprendo la pagina.
const pcEntry = (await import('../src/boot/systems.js')).SYSTEMS.find((s) => s.id === 'pc');
check('the boot menu offers the PC', pcEntry?.available === true);

const pcModule = await pcEntry.load();
const pc = await pcModule.boot(new StubElement('main'), { onExit: () => {} });

if (pc.machine === null) {
  check('the PC asks for its BIOS when there is none', pc.overlay.children.length > 0);
  const romPanel = pc.overlay.children[0];
  const romText = [romPanel.innerHTML, ...romPanel.children.map((n) => n.innerHTML || n.textContent)].join(' ');
  check('and says where to get it, because this one is free', romText.includes('glabios'));
} else {
  check('the PC booted', pc.machine !== null);
  check('the canvas is 640 by 200, which is what a CGA draws', pc.canvas.width === 640 && pc.canvas.height === 200);

  // Il POST, e poi il sistema operativo. Ci vogliono un po' di quadri: la
  // macchina conta 640 KB e prova il lettore prima di guardare il disco.
  const pcScreen = () => pc.machine.cga.text().join('\n');
  // Il POST scorre via da solo appena il sistema operativo parte, quindi si
  // tiene l'ultima schermata in cui il BIOS stava ancora parlando.
  let post = '';
  let reached = '';
  for (let i = 0; i < 900 && !reached; i++) {
    pump(4);
    const text = pcScreen();
    if (text.includes('GLaBIOS')) post = text;
    if (/C:\\>/.test(text)) reached = 'C:';
    else if (/A:\\>/.test(text) || /proceed \[Y,N\]/.test(text)) reached = 'A:';
  }
  check('it gets through the POST', post.includes('GLaBIOS'), post.split('\n')[1]);
  check('with all 640 KB counted', /RAM\s+\[ 640 KB OK \]/.test(post));
  check('and finds the hard disk card', post.includes('C800') && post.includes('XTIDE'));
  check('and boots an operating system', reached !== '', reached || 'nessun prompt');

  // La spia del lettore e quella del disco escono dallo stato vero dei chip.
  pc.updateDrives();
  check('the drive rows say what is in the machine', pc.diskRow.text.textContent.includes('20 MB'));

  // Un tasto passa dalla finestra alla matrice della tastiera XT.
  sendKey('keydown', 'KeyA', 'a');
  const queued = pc.machine.keyboard.queue.concat(pc.machine.keyboard.latch);
  check('a key press becomes an XT scan code', queued.includes(0x1e), queued.join(' '));
  sendKey('keyup', 'KeyA', 'a');

  // Lo schermo intero e la barra che si nasconde, come sulle altre due.
  pc.toggleFullscreen();
  check('fullscreen hands the screen to the machine', document.fullscreenElement === pc.root);
  pc.hideControls();
  pc.root.dispatch('mousemove', { clientY: 780 });
  check('the bar comes back at the bottom edge', pc.root.classes.has('pc--controls-shown'));
  document.exitFullscreen();

  // Un dischetto trascinato sulla finestra entra in A:.
  const floppyPath = join(ROOT, 'roms', 'pc', 'fdboot.img');
  if (existsSync(floppyPath)) {
    const bytes = new Uint8Array(readFileSync(floppyPath));
    await pc.acceptFiles([asFile('prova.img', bytes)]);
    check('a dropped .img goes into the drive', pc.machine.fdc.drives[0].medium !== null);
    check('and the machine says which one and how big', pc.status.textContent.includes('720 KB'), pc.status.textContent);
  }
}

pc.dispose();
check('the PC shuts down cleanly', pc.running === false);

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
check(
  'and it is laid out as credits and then one machine at a time',
  ['Crediti', 'Commodore 64', 'Amiga 500', 'PC 286'].every((title) =>
    aboutText.includes(`about__section">${title}`),
  ),
);
check('the C64 section links its own ROMs', aboutText.includes('kernal-901227-03.bin'));
check('and the Amiga section says where its Kickstart comes from', aboutText.includes('amigaforever.com'));
check('and the PC section links the free firmware it runs on', aboutText.includes('glabios') && aboutText.includes('freedos.org'));

sendKey('keydown', 'Escape', 'Escape');
check('Escape goes back to the boot menu', leftAbout);
about.dispose();
sendKey('keydown', 'Escape', 'Escape'); // nothing left listening, nothing should happen

console.log(failures === 0 ? '\nUI OK.' : `\n${failures} UI problem(s).`);
process.exit(failures === 0 ? 0 : 1);
