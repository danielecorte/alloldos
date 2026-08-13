// C64 keyboard matrix, plus a symbolic PC -> C64 key map.
//
// Symbolic means: the character you type is the character the C64 receives.
// Pressing Shift+2 on a US layout gives '@', which on the C64 is an unshifted
// key, so the emulated Shift is derived from the character, not from the host
// modifier. Letters keep the authentic behaviour (Shift+A is a graphics glyph
// in the default upper-case/graphics mode).

/**
 * MATRIX[pa][pb]: the CPU drives one port A line low and reads the eight port B
 * lines, so each row below is one port A line and the position within it is the
 * port B bit. Read it against the KERNAL's decode table at $eb81, where key
 * number pa * 8 + pb selects the character: index 0 is INST/DEL and index 40
 * is '+', which is what pins the orientation down.
 */
const MATRIX = [
  /* PA0 */ ['DEL', 'RETURN', 'RIGHT', 'F7', 'F1', 'F3', 'F5', 'DOWN'],
  /* PA1 */ ['3', 'W', 'A', '4', 'Z', 'S', 'E', 'LSHIFT'],
  /* PA2 */ ['5', 'R', 'D', '6', 'C', 'F', 'T', 'X'],
  /* PA3 */ ['7', 'Y', 'G', '8', 'B', 'H', 'U', 'V'],
  /* PA4 */ ['9', 'I', 'J', '0', 'M', 'K', 'O', 'N'],
  /* PA5 */ ['PLUS', 'P', 'L', 'MINUS', 'PERIOD', 'COLON', 'AT', 'COMMA'],
  /* PA6 */ ['POUND', 'ASTERISK', 'SEMICOLON', 'HOME', 'RSHIFT', 'EQUALS', 'UPARROW', 'SLASH'],
  /* PA7 */ ['1', 'LEFTARROW', 'CTRL', '2', 'SPACE', 'COMMODORE', 'Q', 'RUNSTOP'],
];

/** name -> [port A line, port B bit] */
const KEY_POSITIONS = new Map();
/** The same positions the other way round, for the on-screen diagnostic. */
const POSITION_NAMES = new Map();
MATRIX.forEach((bits, pa) => {
  bits.forEach((name, pb) => {
    const position = [pa, pb];
    KEY_POSITIONS.set(name, position);
    POSITION_NAMES.set(position, name);
  });
});

/** Printable character -> [C64 key name, needs shift]. */
const CHAR_MAP = new Map(Object.entries({
  ' ': ['SPACE', false],
  '+': ['PLUS', false],
  '-': ['MINUS', false],
  '*': ['ASTERISK', false],
  '/': ['SLASH', false],
  '=': ['EQUALS', false],
  '@': ['AT', false],
  ':': ['COLON', false],
  ';': ['SEMICOLON', false],
  ',': ['COMMA', false],
  '.': ['PERIOD', false],
  '£': ['POUND', false],
  '^': ['UPARROW', false],
  '_': ['LEFTARROW', false],
  '!': ['1', true],
  '"': ['2', true],
  '#': ['3', true],
  $: ['4', true],
  '%': ['5', true],
  '&': ['6', true],
  "'": ['7', true],
  '(': ['8', true],
  ')': ['9', true],
  '<': ['COMMA', true],
  '>': ['PERIOD', true],
  '?': ['SLASH', true],
  '[': ['COLON', true],
  ']': ['SEMICOLON', true],
}));

/** event.code -> [C64 key name, forced shift or null to follow the host Shift]. */
const CODE_MAP = new Map(Object.entries({
  Enter: ['RETURN', null],
  NumpadEnter: ['RETURN', null],
  Backspace: ['DEL', false],
  Delete: ['DEL', true], // Shift+DEL is INST on the C64
  Space: ['SPACE', null],
  Escape: ['RUNSTOP', null],
  Tab: ['CTRL', false],
  Home: ['HOME', false],
  End: ['HOME', true], // Shift+HOME is CLR
  ArrowRight: ['RIGHT', false],
  ArrowLeft: ['RIGHT', true],
  ArrowDown: ['DOWN', false],
  ArrowUp: ['DOWN', true],
  F1: ['F1', false],
  F2: ['F1', true],
  F3: ['F3', false],
  F4: ['F3', true],
  F5: ['F5', false],
  F6: ['F5', true],
  F7: ['F7', false],
  F8: ['F7', true],
}));

/**
 * Host modifiers. They assert no key of their own: the matrix reads them from
 * the flags on every event instead, so a lost keyup cannot leave one stuck.
 * Commodore is on Alt rather than Ctrl, because Ctrl+letter is a browser
 * shortcut and the window is gone before the keyup arrives.
 */
const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);

/** Joystick bits, the same on both ports: they pull the port lines low. */
const JOY_UP = 0x01;
const JOY_DOWN = 0x02;
const JOY_LEFT = 0x04;
const JOY_RIGHT = 0x08;
const JOY_FIRE = 0x10;

/** The numeric keypad is always a joystick, which leaves the cursor keys alone. */
const JOYSTICK_CODES = new Map(Object.entries({
  Numpad8: JOY_UP,
  Numpad2: JOY_DOWN,
  Numpad4: JOY_LEFT,
  Numpad6: JOY_RIGHT,
  Numpad0: JOY_FIRE,
  Numpad5: JOY_FIRE,
  NumpadDecimal: JOY_FIRE,
}));

/**
 * The cursor keys can be a joystick too, but only on request: BASIC needs them
 * to be cursor keys, and a laptop has no numeric keypad to fall back on.
 */
const ARROW_JOYSTICK_CODES = new Map(Object.entries({
  ArrowUp: JOY_UP,
  ArrowDown: JOY_DOWN,
  ArrowLeft: JOY_LEFT,
  ArrowRight: JOY_RIGHT,
  Space: JOY_FIRE,
}));

export class Keyboard {
  constructor() {
    /** One byte per port A line, holding the mask of port B bits pressed on it. */
    this.columns = new Uint8Array(8);
    /** Bits set = direction/fire active; they pull the port lines low. */
    this.joystick2 = 0x00;
    this.joystick1 = 0x00;
    /**
     * Which port the emulated stick is plugged into, 1 or 2. Games are split
     * roughly evenly between the two and nothing on the tape says which.
     */
    this.joystickPort = 2;
    /** Whether the cursor keys drive that stick instead of the C64's own keys. */
    this.arrowsAreJoystick = false;
    /** event.code -> {keys, shift} for every non-modifier key currently down. */
    this.held = new Map();
    /**
     * Shift and Commodore are not tracked as held keys: they are read from the
     * modifier flags every event carries. Those flags are the truth about the
     * host keyboard even when a keyup goes missing — stolen by a browser
     * shortcut, by switching window mid-chord, or by AltGr.
     */
    this.hostShift = false;
    this.hostCommodore = false;
    this.onRestore = null;
  }

  reset() {
    this.columns.fill(0);
    this.joystick1 = this.joystick2 = 0;
    this.held.clear();
    this.hostShift = this.hostCommodore = false;
  }

  pressPosition(pa, pb) {
    this.columns[pa] |= 1 << pb;
  }

  /**
   * Rebuilds the whole matrix from what is held plus the host modifiers, which
   * is why a lost modifier keyup cannot poison later keystrokes: nothing is
   * remembered that the next event does not confirm.
   */
  recompute() {
    this.columns.fill(0);

    // A key mapped from the character it produced decides Shift for itself:
    // on an Italian layout ';' is Shift+',' on the host but unshifted on the
    // C64, so the host's Shift must not reach the matrix. The most recently
    // pressed such key wins; otherwise Shift follows the host.
    let shift = this.hostShift;
    for (const entry of this.held.values()) {
      for (const position of entry.keys) this.pressPosition(position[0], position[1]);
      if (entry.shift !== null) shift = entry.shift;
    }

    if (shift) {
      const position = KEY_POSITIONS.get('LSHIFT');
      this.pressPosition(position[0], position[1]);
    }
    if (this.hostCommodore) {
      const position = KEY_POSITIONS.get('COMMODORE');
      this.pressPosition(position[0], position[1]);
    }
  }

  /** The joystick direction a key stands for, or 0 if it is an ordinary key. */
  joystickBit(code) {
    if (this.arrowsAreJoystick && ARROW_JOYSTICK_CODES.has(code)) {
      return ARROW_JOYSTICK_CODES.get(code);
    }
    return JOYSTICK_CODES.get(code) ?? 0;
  }

  pushJoystick(bit, pressed) {
    const port = this.joystickPort === 1 ? 'joystick1' : 'joystick2';
    if (pressed) this[port] |= bit;
    else this[port] &= ~bit;
  }

  /**
   * Moves the stick to the other port, letting go of everything first so
   * nothing is left held down on the port being abandoned.
   */
  setJoystickPort(port) {
    this.joystick1 = 0;
    this.joystick2 = 0;
    this.joystickPort = port === 1 ? 1 : 2;
  }

  /** Re-reads the host modifier state carried by any keyboard event. */
  syncModifiers(event) {
    this.hostShift = event.shiftKey === true;
    this.hostCommodore = event.altKey === true;
  }

  /**
   * Works out which C64 keys a keydown stands for.
   * @returns {?{keys:Array<number[]>, shift:(boolean|null)}} shift true forces
   *   Shift down, false forces it up, null lets the host's Shift through
   */
  resolve(event) {
    if (CODE_MAP.has(event.code)) {
      const [name, forcedShift] = CODE_MAP.get(event.code);
      return { keys: [KEY_POSITIONS.get(name)], shift: forcedShift };
    }

    // Letters keep Shift's C64 meaning: Shift+A is a graphics glyph in the
    // power-on character set, exactly as on the real machine.
    if (/^Key[A-Z]$/.test(event.code)) {
      return { keys: [KEY_POSITIONS.get(event.code.slice(3))], shift: null };
    }
    if (/^Digit[0-9]$/.test(event.code) && !event.shiftKey) {
      return { keys: [KEY_POSITIONS.get(event.code.slice(5))], shift: false };
    }

    // Everything else is mapped by the character the host layout produced.
    if (event.key.length === 1) {
      const entry = CHAR_MAP.get(event.key);
      if (entry) return { keys: [KEY_POSITIONS.get(entry[0])], shift: entry[1] };

      const upper = event.key.toUpperCase();
      if (KEY_POSITIONS.has(upper)) return { keys: [KEY_POSITIONS.get(upper)], shift: false };
    }

    return null;
  }

  /**
   * Explains what a keydown was turned into, for the on-screen diagnostic.
   * @returns {{host:string, c64:string}}
   */
  describe(event) {
    const host = `${event.code} key="${event.key}"${event.shiftKey ? ' +shift' : ''}${
      event.altKey ? ' +alt' : ''
    }${event.ctrlKey ? ' +ctrl' : ''}`;

    if (event.code === 'PageUp') return { host, c64: 'RESTORE (NMI)' };
    if (JOYSTICK_CODES.has(event.code)) return { host, c64: 'joystick porta 2' };

    const resolved = this.resolve(event);
    if (!resolved) return { host, c64: '— nessun tasto C64 —' };

    const names = resolved.keys.map((position) => {
      const name = POSITION_NAMES.get(position) ?? '?';
      return `${name} (PA${position[0]},PB${position[1]})`;
    });
    const shift =
      resolved.shift === true ? ' + SHIFT'
      : resolved.shift === false ? ' (senza shift)'
      : this.hostShift ? ' + SHIFT (dall host)'
      : '';
    return { host, c64: names.join(' + ') + shift };
  }

  /** Names of every key the emulated machine currently sees as held down. */
  heldKeyNames() {
    const names = [];
    for (const [name, position] of KEY_POSITIONS) {
      if (this.columns[position[0]] & (1 << position[1])) names.push(name);
    }
    return names;
  }

  /** @returns {boolean} true when the event was consumed by the emulated machine */
  handleKeyDown(event) {
    this.syncModifiers(event);

    if (event.code === 'PageUp') {
      this.onRestore?.(); // RESTORE is wired straight to /NMI
      return true;
    }
    const direction = this.joystickBit(event.code);
    if (direction) {
      this.pushJoystick(direction, true);
      return true;
    }
    // The modifiers themselves carry no key of their own; syncModifiers has
    // already recorded them.
    if (MODIFIER_CODES.has(event.code)) {
      this.recompute();
      return true;
    }
    if (this.held.has(event.code)) return true; // ignore auto-repeat

    const resolved = this.resolve(event);
    if (!resolved) {
      this.recompute();
      return false;
    }

    this.held.set(event.code, resolved);
    this.recompute();
    return true;
  }

  handleKeyUp(event) {
    this.syncModifiers(event);

    const direction = this.joystickBit(event.code);
    if (direction) {
      this.pushJoystick(direction, false);
      return true;
    }

    const known = this.held.delete(event.code);
    this.recompute();
    return known || MODIFIER_CODES.has(event.code);
  }

  // ------------------------------------------------------------- CIA 1 ports

  /**
   * The normal scan: every key on a port A line the CPU is driving low pulls
   * its own port B bit low. Joystick 1 sits on the same port B lines.
   */
  readPortB(portAOutput) {
    let result = 0xff;
    for (let pa = 0; pa < 8; pa++) {
      if (!(portAOutput & (1 << pa))) result &= ~this.columns[pa];
    }
    return result & ~this.joystick1 & 0xff;
  }

  /** The mirror image, used by software that scans the other way round. */
  readPortA(portBOutput) {
    let result = 0xff;
    for (let pa = 0; pa < 8; pa++) {
      if (this.columns[pa] & ~portBOutput & 0xff) result &= ~(1 << pa);
    }
    return result & ~this.joystick2 & 0xff;
  }
}
