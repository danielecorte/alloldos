// La tastiera dell'XT, che è un tastierino con dentro un microprocessore.
//
// Sulla tastiera del PC non ci sono i caratteri: ci sono i tasti, numerati
// nell'ordine in cui il progettista li ha cablati sulla matrice, e il codice
// che arriva alla macchina dice "il tasto numero 30 è stato premuto" e più
// tardi "il tasto numero 30 è stato lasciato". Che il tasto numero 30 sia una
// A lo decide il BIOS, guardando se in quel momento c'è uno shift premuto e
// come è messa la lettera maiuscola — ed è per questo che una tastiera
// italiana e una americana sono lo stesso pezzo di ferro con dei disegni
// diversi sopra, e che il DOS parla americano comunque.
//
// Qui la traduzione va nell'altro verso, dai tasti del browser a quei numeri.
// Il browser dà due cose per ogni tasto: `code`, che è la posizione fisica —
// esattamente il concetto che vuole l'XT — e `key`, che è il carattere che ne
// esce secondo la disposizione di chi scrive. Si usa `code`, perché è
// l'unico dei due che parla la stessa lingua della macchina.

/** Da posizione del tasto (KeyboardEvent.code) a codice di scansione XT. */
export const SCANCODES = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d, ControlRight: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31,
  KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  ShiftRight: 0x36, NumpadMultiply: 0x37,
  AltLeft: 0x38, AltRight: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f,
  F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52,
  NumpadDecimal: 0x53,
  // Una tastiera XT non ha le frecce: ha il tastierino, e le frecce ci sono
  // disegnate sopra. Chi preme una freccia preme quei tasti lì.
  ArrowUp: 0x48, ArrowLeft: 0x4b, ArrowRight: 0x4d, ArrowDown: 0x50,
  Home: 0x47, End: 0x4f, PageUp: 0x49, PageDown: 0x51,
  Insert: 0x52, Delete: 0x53,
  NumpadEnter: 0x1c,
};

/** I due shift, che il BIOS guarda per sapere che lettera è. */
export const SHIFT = 0x2a;

/**
 * Da carattere a tasto (e se ci vuole lo shift). Serve a chi deve *scrivere*
 * sulla macchina invece che ascoltarla: le prove, e lo script che installa il
 * DOS sul disco battendo i comandi come li batterebbe una persona.
 *
 * La disposizione è quella americana, che è l'unica che il DOS conosca finché
 * non gli si carica un KEYB.
 */
const UNSHIFTED = {
  '\n': 0x1c, '\r': 0x1c, '\b': 0x0e, '\t': 0x0f, '\x1b': 0x01, ' ': 0x39,
  '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
  '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b,
  '-': 0x0c, '=': 0x0d, '[': 0x1a, ']': 0x1b, ';': 0x27, "'": 0x28,
  '`': 0x29, '\\': 0x2b, ',': 0x33, '.': 0x34, '/': 0x35,
};

const SHIFTED = {
  '!': 0x02, '@': 0x03, '#': 0x04, $: 0x05, '%': 0x06,
  '^': 0x07, '&': 0x08, '*': 0x09, '(': 0x0a, ')': 0x0b,
  _: 0x0c, '+': 0x0d, '{': 0x1a, '}': 0x1b, ':': 0x27, '"': 0x28,
  '~': 0x29, '|': 0x2b, '<': 0x33, '>': 0x34, '?': 0x35,
};

const LETTERS = 'qwertyuiop'.split('').map((letter, i) => [letter, 0x10 + i])
  .concat('asdfghjkl'.split('').map((letter, i) => [letter, 0x1e + i]))
  .concat('zxcvbnm'.split('').map((letter, i) => [letter, 0x2c + i]));

/**
 * @param {string} char
 * @returns {{code:number, shift:boolean}|null}
 */
export function keyFor(char) {
  const lower = char.toLowerCase();
  const letter = LETTERS.find(([name]) => name === lower);
  if (letter) return { code: letter[1], shift: char !== lower };
  if (UNSHIFTED[char] !== undefined) return { code: UNSHIFTED[char], shift: false };
  if (SHIFTED[char] !== undefined) return { code: SHIFTED[char], shift: true };
  return null;
}
