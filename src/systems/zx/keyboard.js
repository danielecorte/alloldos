// Dai tasti del browser a quaranta tasti di gomma.
//
// La tastiera dello Spectrum ha quaranta tasti e basta: niente virgola, niente
// punto, niente parentesi, nessun tasto per cancellare. Tutto quello che manca
// si ottiene con due tasti insieme — il *symbol shift*, che è il tasto rosso
// in basso a destra, dà i simboli scritti in rosso sotto ogni tasto; il *caps
// shift*, in basso a sinistra, dà le maiuscole, le frecce e il DELETE.
//
// Ed è per questo che ogni tasto ha cinque parole scritte sopra. Non era
// barocco: era il modo di far entrare un intero linguaggio di programmazione
// in una tastiera da quaranta tasti, dove ogni comando del BASIC si batte con
// una pressione sola — PRINT è la P, LOAD è la J — e il computer sa quale dei
// cinque significati intendi guardando a che punto della riga sei. Chi ci ha
// imparato a programmare non ha mai scritto per esteso la parola PRINT.
//
// Qui la mappatura è quella che una persona si aspetta oggi: le lettere e i
// numeri dove sono, e per tutto il resto la combinazione giusta di shift,
// generata da qui. Chi vuole i due tasti veri li ha comunque: Maiusc è caps
// shift e Ctrl è symbol shift.

import { KEY_ROWS } from './ula.js';

/** name -> [riga, bit], dalla matrice della ULA. */
const POSITIONS = new Map();
KEY_ROWS.forEach((row, index) => {
  row.forEach((name, bit) => POSITIONS.set(name, [index, bit]));
});

export const CAPS_SHIFT = 'Shift';
export const SYMBOL_SHIFT = 'SymbolShift';

/**
 * I tasti del browser che sono un tasto dello Spectrum e basta.
 * @type {Record<string, string>}
 */
const DIRECT = {
  Enter: 'Enter',
  Space: 'Space',
  ShiftLeft: CAPS_SHIFT,
  ShiftRight: CAPS_SHIFT,
  ControlLeft: SYMBOL_SHIFT,
  ControlRight: SYMBOL_SHIFT,
  AltLeft: SYMBOL_SHIFT,
  AltRight: SYMBOL_SHIFT,
};
for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') DIRECT[`Key${letter}`] = letter;
for (let digit = 0; digit <= 9; digit++) DIRECT[`Digit${digit}`] = String(digit);

/**
 * I tasti che sullo Spectrum sono due tasti insieme. Le frecce e il DELETE
 * stanno sui numeri con il caps shift — ed è per questo che sulla tastiera
 * dello Spectrum le frecce sono disegnate sui tasti 5, 6, 7 e 8.
 * @type {Record<string, [string, string]>}
 */
const COMBINATIONS = {
  Backspace: [CAPS_SHIFT, '0'],
  ArrowLeft: [CAPS_SHIFT, '5'],
  ArrowDown: [CAPS_SHIFT, '6'],
  ArrowUp: [CAPS_SHIFT, '7'],
  ArrowRight: [CAPS_SHIFT, '8'],
  Escape: [CAPS_SHIFT, '1'], // EDIT
  CapsLock: [CAPS_SHIFT, '2'],
  Tab: [CAPS_SHIFT, 'Space'], // BREAK
  Comma: [SYMBOL_SHIFT, 'N'],
  Period: [SYMBOL_SHIFT, 'M'],
  Semicolon: [SYMBOL_SHIFT, 'O'],
  Quote: [SYMBOL_SHIFT, 'P'],
  Slash: [SYMBOL_SHIFT, 'V'],
  Minus: [SYMBOL_SHIFT, 'J'],
  Equal: [SYMBOL_SHIFT, 'L'],
  BracketLeft: [SYMBOL_SHIFT, '8'],
  BracketRight: [SYMBOL_SHIFT, '9'],
  Backslash: [SYMBOL_SHIFT, 'D'],
  Backquote: [SYMBOL_SHIFT, 'X'],
};

/**
 * Che tasti dello Spectrum sono un tasto del browser.
 * @param {string} code il `code` dell'evento, cioè la posizione fisica
 * @returns {string[]} i nomi dei tasti da tenere premuti insieme
 */
export function keysFor(code) {
  if (DIRECT[code]) return [DIRECT[code]];
  if (COMBINATIONS[code]) return [...COMBINATIONS[code]];
  return [];
}

/** Dove sta un tasto nella matrice. */
export function positionOf(name) {
  return POSITIONS.get(name) ?? null;
}

/**
 * I tasti da premere per battere un carattere, per chi deve *scrivere* sulla
 * macchina invece che ascoltarla: le prove, e il caricamento automatico.
 *
 * @param {string} char
 * @returns {string[][]} una pressione per elemento
 */
export function keysForCharacter(char) {
  if (char === '\n' || char === '\r') return [['Enter']];
  if (char === ' ') return [['Space']];
  const upper = char.toUpperCase();
  if (POSITIONS.has(upper)) return [[upper]];
  const symbol = {
    '"': ['P'], '£': ['4'], $: ['4'], '!': ['1'], '@': ['2'], '#': ['3'],
    '%': ['5'], '&': ['6'], "'": ['7'], '(': ['8'], ')': ['9'], _: ['0'],
    '<': ['R'], '>': ['T'], '=': ['L'], '+': ['K'], '-': ['J'], '*': ['B'],
    '/': ['V'], ':': ['Z'], ';': ['O'], ',': ['N'], '.': ['M'], '?': ['C'],
  }[char];
  if (symbol) return [[SYMBOL_SHIFT, ...symbol]];
  return [];
}

/**
 * Il joystick Kempston, che non è nella macchina: è una scheda che si
 * infilava dietro, e che ha vinto perché è arrivata prima. Cinque bit a uno
 * quando si spinge, su una porta che risponde a qualunque indirizzo con il
 * bit 5 basso.
 */
export const KEMPSTON = { right: 0x01, left: 0x02, down: 0x04, up: 0x08, fire: 0x10 };

export const JOYSTICK_KEYS = {
  ArrowRight: KEMPSTON.right,
  ArrowLeft: KEMPSTON.left,
  ArrowDown: KEMPSTON.down,
  ArrowUp: KEMPSTON.up,
  Space: KEMPSTON.fire,
  ControlLeft: KEMPSTON.fire,
};
