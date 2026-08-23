// The keyboard and the mouse.
//
// An Amiga keyboard is a computer in its own right: it scans its own matrix and
// sends the machine a byte down a serial line whenever a key goes down or comes
// back up. The byte is the key's code shifted up one, with the bottom bit
// saying which of the two just happened — and then the whole thing inverted,
// because the line idles high.
//
// The mouse is simpler and stranger: two pairs of counters in JOY0DAT that the
// hardware bumps as the ball turns. Nothing reports a position; the software
// works out how far the mouse went by watching the counters drift.

/** Browser key codes to Amiga raw key codes, by position on the keyboard. */
const KEY_MAP = {
  Backquote: 0x00,
  Digit1: 0x01,
  Digit2: 0x02,
  Digit3: 0x03,
  Digit4: 0x04,
  Digit5: 0x05,
  Digit6: 0x06,
  Digit7: 0x07,
  Digit8: 0x08,
  Digit9: 0x09,
  Digit0: 0x0a,
  Minus: 0x0b,
  Equal: 0x0c,
  Backslash: 0x0d,
  Numpad0: 0x0f,

  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Numpad1: 0x1d,
  Numpad2: 0x1e,
  Numpad3: 0x1f,

  KeyA: 0x20,
  KeyS: 0x21,
  KeyD: 0x22,
  KeyF: 0x23,
  KeyG: 0x24,
  KeyH: 0x25,
  KeyJ: 0x26,
  KeyK: 0x27,
  KeyL: 0x28,
  Semicolon: 0x29,
  Quote: 0x2a,
  Numpad4: 0x2d,
  Numpad5: 0x2e,
  Numpad6: 0x2f,

  IntlBackslash: 0x30,
  KeyZ: 0x31,
  KeyX: 0x32,
  KeyC: 0x33,
  KeyV: 0x34,
  KeyB: 0x35,
  KeyN: 0x36,
  KeyM: 0x37,
  Comma: 0x38,
  Period: 0x39,
  Slash: 0x3a,
  NumpadDecimal: 0x3c,
  Numpad7: 0x3d,
  Numpad8: 0x3e,
  Numpad9: 0x3f,

  Space: 0x40,
  Backspace: 0x41,
  Tab: 0x42,
  NumpadEnter: 0x43,
  Enter: 0x44,
  Escape: 0x45,
  Delete: 0x46,
  NumpadSubtract: 0x4a,
  ArrowUp: 0x4c,
  ArrowDown: 0x4d,
  ArrowRight: 0x4e,
  ArrowLeft: 0x4f,

  F1: 0x50,
  F2: 0x51,
  F3: 0x52,
  F4: 0x53,
  F5: 0x54,
  F6: 0x55,
  F7: 0x56,
  F8: 0x57,
  F9: 0x58,
  F10: 0x59,
  NumpadDivide: 0x5c,
  NumpadMultiply: 0x5d,
  NumpadAdd: 0x5e,
  Insert: 0x5f, // Help, which is where an Amiga keyboard puts it

  ShiftLeft: 0x60,
  ShiftRight: 0x61,
  CapsLock: 0x62,
  ControlLeft: 0x63,
  ControlRight: 0x63,
  AltLeft: 0x64,
  AltRight: 0x65,
  MetaLeft: 0x66, // left Amiga
  MetaRight: 0x67,
  ContextMenu: 0x67,
};

/** The keyboard's own announcements, sent before and after the key codes. */
const KEY_INITIATE_POWER_UP = 0xfd;
const KEY_TERMINATE_POWER_UP = 0xfe;

/** Roughly the time a real keyboard takes over one byte and its handshake. */
const SEND_INTERVAL_CYCLES = 3000;

const JOY_UP = 0x01;
const JOY_DOWN = 0x02;
const JOY_LEFT = 0x04;
const JOY_RIGHT = 0x08;
const JOY_FIRE = 0x10;

/**
 * The stick, when there is one, is the cursor keys and the space bar.
 *
 * The C64 in the next room can leave its joystick on the numeric keypad all the
 * time, because a real C64 has no keypad for the keys to clash with. An Amiga
 * does, and games use it, so here the stick has to be asked for: until it is,
 * every one of these keys is its own key and reaches the machine as itself.
 */
const JOYSTICK_CODES = new Map(Object.entries({
  ArrowUp: JOY_UP,
  ArrowDown: JOY_DOWN,
  ArrowLeft: JOY_LEFT,
  ArrowRight: JOY_RIGHT,
  Space: JOY_FIRE,
}));

export class AmigaKeyboard {
  constructor() {
    this.queue = [];
    this.held = new Set();
    this.sinceLastByte = 0;
    /** Mouse counters, exactly as JOY0DAT reports them. */
    this.mouseX = 0;
    this.mouseY = 0;
    this.buttons = [false, false, false]; // left, right, middle
    /** Which way the stick in the game port is pushed, and whether it is fired. */
    this.joystick = 0;
    /** Whether the cursor keys are that stick rather than the Amiga's own keys. */
    this.arrowsAreJoystick = false;
    this.announce();
  }

  reset() {
    this.queue.length = 0;
    this.held.clear();
    this.buttons = [false, false, false];
    this.joystick = 0;
    this.announce();
  }

  /** A real keyboard says hello at power-on, and the ROM waits to hear it. */
  announce() {
    this.queue.push(KEY_INITIATE_POWER_UP, KEY_TERMINATE_POWER_UP);
  }

  /**
   * @param {KeyboardEvent} event
   * @returns {boolean} true if the key belongs to the Amiga and not the browser
   */
  handleKeyDown(event) {
    const direction = this.joystickBit(event.code);
    if (direction) {
      this.joystick |= direction;
      return true;
    }
    const code = KEY_MAP[event.code];
    if (code === undefined) return false;
    // A held key repeats in the browser; the Amiga repeats keys itself.
    if (this.held.has(code)) return true;
    this.held.add(code);
    this.send(code, false);
    return true;
  }

  handleKeyUp(event) {
    const direction = this.joystickBit(event.code);
    if (direction) {
      this.joystick &= ~direction;
      return true;
    }
    const code = KEY_MAP[event.code];
    if (code === undefined) return false;
    if (!this.held.delete(code)) return true;
    this.send(code, true);
    return true;
  }

  /** The direction a key stands for while the stick is plugged in, or 0. */
  joystickBit(code) {
    if (!this.arrowsAreJoystick) return 0;
    return JOYSTICK_CODES.get(code) ?? 0;
  }

  /**
   * Unplugs the stick, letting go of it first: a direction left held on a port
   * nobody is reading any more is a direction held forever.
   */
  setJoystick(plugged) {
    this.joystick = 0;
    this.arrowsAreJoystick = plugged === true;
  }

  /** Everything goes up when the window loses focus, or keys stick down. */
  releaseAll() {
    for (const code of this.held) this.send(code, true);
    this.held.clear();
    this.joystick = 0;
  }

  send(code, up) {
    this.queue.push((~((code << 1) | (up ? 1 : 0)) & 0xff) >>> 0);
  }

  /**
   * Hands the next byte to CIA-A, no faster than a keyboard could send one.
   * @param {number} cycles CPU cycles since the last call
   * @returns {number} the byte, or -1 when there is nothing to say
   */
  tick(cycles) {
    this.sinceLastByte += cycles;
    if (this.queue.length === 0 || this.sinceLastByte < SEND_INTERVAL_CYCLES) return -1;
    this.sinceLastByte = 0;
    return this.queue.shift();
  }

  // -------------------------------------------------------------- the mouse

  /** @param {number} dx @param {number} dy in host pixels */
  moveMouse(dx, dy) {
    this.mouseX = (this.mouseX + dx) & 0xff;
    this.mouseY = (this.mouseY + dy) & 0xff;
  }

  setButton(index, down) {
    if (index >= 0 && index < 3) this.buttons[index] = down;
  }

  /** JOY0DAT: the vertical counter above the horizontal one. */
  get joy0dat() {
    return ((this.mouseY & 0xff) << 8) | (this.mouseX & 0xff);
  }

  /**
   * JOY1DAT: the game port, where a joystick goes.
   *
   * The port is wired for a mouse, so what it reports is a pair of quadrature
   * counters, and a joystick has to be read out of them sideways. Left and
   * right are plain bits, 9 and 1. Up and down are not: they come out of the
   * bit below each of those, exclusive-ored with it, which is what the two
   * lines of shifting and xoring at the top of every game's control routine is
   * for. So the value has to be built to survive that arithmetic.
   */
  get joy1dat() {
    const right = (this.joystick & JOY_RIGHT) !== 0;
    const left = (this.joystick & JOY_LEFT) !== 0;
    const up = (this.joystick & JOY_UP) !== 0;
    const down = (this.joystick & JOY_DOWN) !== 0;
    let value = 0;
    if (right) value |= 0x0002;
    if (left) value |= 0x0200;
    if (up !== right) value |= 0x0001; // bit 0, so that bit 0 xor bit 1 is up
    if (down !== left) value |= 0x0100; // bit 8, likewise against bit 9
    return value;
  }

  /** The left button is a CIA pin; it reads low while it is down. */
  get fireBit() {
    return this.buttons[0] ? 0 : 0x40;
  }

  /** The game port's fire button is the pin next door, and just as active low. */
  get joystickFireBit() {
    return this.joystick & JOY_FIRE ? 0 : 0x80;
  }

  /** POTGOR carries the other two buttons, and they are active low as well. */
  get potgor() {
    let value = 0xff00;
    if (!this.buttons[1]) value |= 0x0400; // right
    if (!this.buttons[2]) value |= 0x0100; // middle
    return value;
  }
}
