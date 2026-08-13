// Reading the 40x25 text screen back as text.
//
// Used to tell when the KERNAL has finished booting (the READY prompt appears)
// and by the self test to check what a program printed.

/** Screen codes $00-$3f; $40-$7f are the graphics set, which has no text form. */
const SCREEN_CODES = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[£]↑← !"#$%&\'()*+,-./0123456789:;<=>?';

export const SCREEN_BASE = 0x0400;
export const SCREEN_COLUMNS = 40;
export const SCREEN_ROWS = 25;

/** @param {import('./machine.js').C64} machine */
export function readScreenLine(machine, row) {
  let text = '';
  for (let col = 0; col < SCREEN_COLUMNS; col++) {
    const code = machine.peek(SCREEN_BASE + row * SCREEN_COLUMNS + col) & 0x7f;
    text += code < SCREEN_CODES.length ? SCREEN_CODES[code] : ' ';
  }
  return text.trimEnd();
}

export function readScreenText(machine) {
  const rows = [];
  for (let row = 0; row < SCREEN_ROWS; row++) rows.push(readScreenLine(machine, row));
  return rows.join('\n');
}

/** True once BASIC is sitting at its prompt with an empty keyboard buffer. */
export function isAtReadyPrompt(machine) {
  return machine.peek(0xc6) === 0 && readScreenText(machine).includes('READY.');
}
