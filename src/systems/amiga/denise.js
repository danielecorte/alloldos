// Denise: the chip that turns bitplanes into a picture.
//
// Agnus hands over one line's worth of bitplane words; Denise puts them
// together bit by bit into colour numbers, looks those up in the 32 colour
// registers, lays the eight sprites over the top and writes pixels. The line is
// drawn in pieces rather than in one go, so a copper that changes a colour
// half way across the screen changes it half way across the screen.
//
// Everything inside is measured in hires pixels — four to a colour clock — so
// that a 640-wide Workbench and a 320-wide game share one framebuffer.

/** Hires pixels across the visible window, and lines down it. */
export const SCREEN_WIDTH = 688;
/** Raster lines we show, and the framebuffer rows they get: two each, because
 *  an interlaced screen puts a different picture on every other one. */
export const VISIBLE_LINES = 284;
export const SCREEN_HEIGHT = VISIBLE_LINES * 2;

/** The first line and the first hires pixel of the raster we actually show. */
export const FIRST_VISIBLE_LINE = 26;
export const FIRST_VISIBLE_X = 216; // hires pixels — 108 lores, just after blanking

/** A colour clock is two lores pixels, or four hires ones. */
export const COLOR_CLOCKS_PER_LINE = 227;

const PLANES = 6;

export class Denise {
  constructor() {
    this.framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.colors = new Uint16Array(32); // as written: 4 bits each of R, G and B
    this.palette = new Uint32Array(64); // resolved to pixels, EHB included

    // One line's worth of decoded playfield, one entry per hires pixel.
    this.playfield = new Uint8Array(SCREEN_WIDTH);
    this.playfieldKind = new Uint8Array(SCREEN_WIDTH); // 0 background, 1 PF1, 2 PF2
    this.hamPixels = new Uint32Array(SCREEN_WIDTH);
    this.spritePixel = new Uint8Array(SCREEN_WIDTH); // colour register, 0 = none
    this.spritePair = new Uint8Array(SCREEN_WIDTH);

    // Sprite registers, and where the fetched data for this line came from.
    this.sprPos = new Uint16Array(8);
    this.sprCtl = new Uint16Array(8);
    this.sprDataA = new Uint16Array(8);
    this.sprDataB = new Uint16Array(8);
    this.sprArmed = new Uint8Array(8);

    this.reset();
  }

  reset() {
    this.bplcon0 = 0;
    this.bplcon1 = 0;
    this.bplcon2 = 0;
    this.colors.fill(0);
    this.sprPos.fill(0);
    this.sprCtl.fill(0);
    this.sprDataA.fill(0);
    this.sprDataB.fill(0);
    this.sprArmed.fill(0);
    this.updatePalette();

    this.line = -1;
    this.renderedX = 0;
    this.rowBase = -1;
    this.rowSpan = 2;
    this.framebuffer.fill(this.palette[0]);
  }

  // ------------------------------------------------------------------ colour

  /** Rebuilds the resolved palette, including the extra-half-brite entries. */
  updatePalette() {
    for (let i = 0; i < 32; i++) {
      const value = this.colors[i];
      const r = ((value >> 8) & 0x0f) * 17;
      const g = ((value >> 4) & 0x0f) * 17;
      const b = (value & 0x0f) * 17;
      this.palette[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      // Six planes without HAM means the top half of the range is the bottom
      // half at half brightness — the Amiga's 64 colours for the price of 32.
      this.palette[i + 32] =
        (0xff000000 | ((b >> 1) << 16) | ((g >> 1) << 8) | (r >> 1)) >>> 0;
    }
  }

  setColor(index, value) {
    this.colors[index & 0x1f] = value & 0x0fff;
    const i = index & 0x1f;
    const r = ((value >> 8) & 0x0f) * 17;
    const g = ((value >> 4) & 0x0f) * 17;
    const b = (value & 0x0f) * 17;
    this.palette[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    this.palette[i + 32] = (0xff000000 | ((b >> 1) << 16) | ((g >> 1) << 8) | (r >> 1)) >>> 0;
  }

  get planeCount() {
    return (this.bplcon0 >> 12) & 7;
  }

  get hires() {
    return (this.bplcon0 & 0x8000) !== 0;
  }

  get ham() {
    return (this.bplcon0 & 0x0800) !== 0;
  }

  get dualPlayfield() {
    return (this.bplcon0 & 0x0400) !== 0;
  }

  get interlaced() {
    return (this.bplcon0 & 0x0004) !== 0;
  }

  // -------------------------------------------------------------- the line

  /**
   * Starts a new line: works out where every pixel of it comes from, but does
   * not put any colour on it yet.
   *
   * @param {number} vpos
   * @param {Uint16Array[]} planes one buffer of fetched words per bitplane
   * @param {number} words how many of those words are this line's
   * @param {number} ddfstrt first fetch, in colour clocks
   * @param {{hstart:number, hstop:number}} window the display window, in lores
   * @param {number} field 0 or 1: which half of an interlaced picture this is
   */
  startLine(vpos, planes, words, ddfstrt, window, field = 0) {
    this.endLine(); // whatever the last line still owed
    this.line = vpos;
    this.renderedX = 0;

    // A line of a non-interlaced screen fills both of its rows; a line of an
    // interlaced one fills the row belonging to the field being drawn, and the
    // other field fills the gaps on the next pass.
    const row = vpos - FIRST_VISIBLE_LINE;
    const lace = this.interlaced;
    this.rowSpan = lace ? 1 : 2;
    this.rowBase =
      row >= 0 && row < VISIBLE_LINES ? (row * 2 + (lace ? field : 0)) * SCREEN_WIDTH : -1;

    this.playfield.fill(0);
    this.playfieldKind.fill(0);
    this.spritePixel.fill(0);
    if (words > 0) this.decodePlayfield(planes, words, ddfstrt, window);
    this.decodeSprites();
  }

  /**
   * Unpacks the bitplanes into one colour number per pixel.
   *
   * The picture does not start where the fetch does: the data goes through
   * Agnus and Denise before it reaches the screen, which is why a standard
   * screen fetched from colour clock $38 first appears at lores pixel $81.
   */
  decodePlayfield(planes, words, ddfstrt, window) {
    const hires = this.hires;
    const count = Math.min(this.planeCount, PLANES);
    if (count === 0) return;

    const pixelsPerWord = 16;
    const step = hires ? 1 : 2; // hires pixels covered by one playfield pixel
    const delay = hires ? 18 : 34; // the pipeline, in hires pixels
    // The scroll registers count lores pixels, which are two of ours.
    const scrollOdd = (this.bplcon1 & 0x0f) * 2;
    const scrollEven = ((this.bplcon1 >> 4) & 0x0f) * 2;

    const start = ddfstrt * 4 + delay - FIRST_VISIBLE_X;
    const clipLeft = window.hstart * 2 - FIRST_VISIBLE_X;
    const clipRight = window.hstop * 2 - FIRST_VISIBLE_X;
    const dual = this.dualPlayfield;

    for (let word = 0; word < words; word++) {
      const base = start + word * pixelsPerWord * step;
      if (base + pixelsPerWord * step <= 0 || base >= SCREEN_WIDTH) continue;

      for (let bit = 0; bit < pixelsPerWord; bit++) {
        const shift = 15 - bit;
        let odd = 0;
        let even = 0;
        let index = 0;
        for (let plane = 0; plane < count; plane++) {
          const value = (planes[plane][word] >> shift) & 1;
          index |= value << plane;
          // Odd-numbered planes are playfield one, even-numbered playfield two.
          if (plane & 1) even |= value << (plane >> 1);
          else odd |= value << (plane >> 1);
        }

        for (let sub = 0; sub < step; sub++) {
          const at = base + bit * step + sub;
          const x = at + (dual ? 0 : scrollOdd);
          if (x < clipLeft || x >= clipRight || x < 0 || x >= SCREEN_WIDTH) continue;

          if (dual) {
            const x1 = at + scrollOdd;
            const x2 = at + scrollEven;
            if (odd && x1 >= 0 && x1 < SCREEN_WIDTH && x1 >= clipLeft && x1 < clipRight) {
              this.playfield[x1] = odd;
              this.playfieldKind[x1] = 1;
            }
            if (even && x2 >= 0 && x2 < SCREEN_WIDTH && x2 >= clipLeft && x2 < clipRight) {
              // Playfield two draws from colours 8 to 15.
              if (this.playfieldKind[x2] === 0 || !this.playfieldOneInFront()) {
                this.playfield[x2] = even + 8;
                this.playfieldKind[x2] = 2;
              }
            }
          } else {
            this.playfield[x] = index;
            this.playfieldKind[x] = index === 0 ? 0 : 2;
          }
        }
      }
    }

    if (this.ham) this.decodeHAM(clipLeft, clipRight);
  }

  playfieldOneInFront() {
    return (this.bplcon2 & 0x0040) === 0;
  }

  /**
   * Hold-and-modify: four of the six planes carry a value and the other two say
   * what to do with it — pick a colour register, or change one component of the
   * colour already on screen. 4096 colours out of a 32-entry palette.
   */
  decodeHAM(clipLeft, clipRight) {
    let current = this.palette[0];
    const from = Math.max(0, clipLeft);
    const to = Math.min(SCREEN_WIDTH, clipRight);
    for (let x = from; x < to; x++) {
      const value = this.playfield[x];
      const control = (value >> 4) & 3;
      const level = (value & 0x0f) * 17;
      if (control === 0) current = this.palette[value & 0x0f];
      else if (control === 1) current = (current & 0xff00ffff) | (level << 16); // blue
      else if (control === 2) current = (current & 0xffffff00) | level; // red
      else current = (current & 0xffff00ff) | (level << 8); // green
      this.hamPixels[x] = current >>> 0;
      this.playfieldKind[x] = 2;
    }
  }

  /** Lays this line's sprites into their own buffer, nearest sprite winning. */
  decodeSprites() {
    for (let index = 7; index >= 0; index--) {
      if (!this.sprArmed[index]) continue;
      const attached = index & 1 ? (this.sprCtl[index] & 0x80) !== 0 : false;
      if (index & 1 && attached) continue; // drawn together with its partner

      const hstart = ((this.sprPos[index] & 0xff) << 1) | (this.sprCtl[index] & 1);
      const pair = index >> 1;
      const partnerAttached = (this.sprCtl[index | 1] & 0x80) !== 0 && !(index & 1);

      const dataA = this.sprDataA[index];
      const dataB = this.sprDataB[index];
      const dataC = partnerAttached ? this.sprDataA[index | 1] : 0;
      const dataD = partnerAttached ? this.sprDataB[index | 1] : 0;

      for (let bit = 0; bit < 16; bit++) {
        const shift = 15 - bit;
        let color =
          (((dataA >> shift) & 1) << 0) |
          (((dataB >> shift) & 1) << 1);
        if (partnerAttached) {
          color |= (((dataC >> shift) & 1) << 2) | (((dataD >> shift) & 1) << 3);
        }
        if (color === 0) continue;

        const register = partnerAttached ? 16 + color : 16 + pair * 4 + color;
        // A sprite pixel is one lores pixel: two of ours.
        const left = (hstart + bit) * 2 - FIRST_VISIBLE_X;
        for (let sub = 0; sub < 2; sub++) {
          const x = left + sub;
          if (x < 0 || x >= SCREEN_WIDTH) continue;
          this.spritePixel[x] = register;
          this.spritePair[x] = pair;
        }
      }
    }
  }

  // ------------------------------------------------------------- the pixels

  /**
   * Puts colour on the line as far as the given beam position, and no further:
   * anything written to a colour register after this point belongs to the
   * pixels that come after it.
   * @param {number} hpos colour clock the beam has reached
   */
  renderUpTo(hpos) {
    const target = Math.min(SCREEN_WIDTH, hpos * 4 - FIRST_VISIBLE_X);
    if (target <= this.renderedX) return;
    const from = Math.max(0, this.renderedX);
    this.renderedX = target;
    if (this.rowBase < 0) return;

    const background = this.palette[0];
    const ham = this.ham;
    for (let x = from; x < target; x++) {
      const sprite = this.spritePixel[x];
      const kind = this.playfieldKind[x];
      let color;

      if (sprite && this.spriteWins(this.spritePair[x], kind)) {
        color = this.palette[sprite];
      } else if (kind === 0) {
        color = background;
      } else if (ham) {
        color = this.hamPixels[x];
      } else {
        color = this.palette[this.playfield[x] & 0x3f];
      }
      this.framebuffer[this.rowBase + x] = color;
      if (this.rowSpan === 2) this.framebuffer[this.rowBase + SCREEN_WIDTH + x] = color;
    }
  }

  /**
   * BPLCON2 says which sprite pairs a playfield hides: a playfield priority of
   * two covers sprite pairs 0 and 1 and stays behind the rest. Zero, which is
   * what everything comes up as, leaves the playfield behind every sprite —
   * which is why a mouse pointer works before anyone sets this register.
   */
  spriteWins(pair, playfieldKind) {
    if (playfieldKind === 0) return true;
    const priority = playfieldKind === 1 ? this.bplcon2 & 7 : (this.bplcon2 >> 3) & 7;
    return pair >= priority;
  }

  /** Finishes the line, whatever the beam was doing when it was interrupted. */
  endLine() {
    if (this.line < 0) return;
    this.renderUpTo(COLOR_CLOCKS_PER_LINE);
  }

  // ---------------------------------------------------------------- registers

  writeRegister(offset, value) {
    if (offset >= 0x180 && offset < 0x1c0) {
      this.setColor((offset - 0x180) >> 1, value);
      return;
    }
    if (offset >= 0x140 && offset < 0x180) {
      const sprite = (offset - 0x140) >> 3;
      switch (offset & 6) {
        case 0: // SPRxPOS
          this.sprPos[sprite] = value;
          break;
        case 2: // SPRxCTL disarms the sprite
          this.sprCtl[sprite] = value;
          this.sprArmed[sprite] = 0;
          break;
        case 4: // SPRxDATA arms it
          this.sprDataA[sprite] = value;
          this.sprArmed[sprite] = 1;
          break;
        default:
          this.sprDataB[sprite] = value;
          break;
      }
      return;
    }
    switch (offset) {
      case 0x100:
        this.bplcon0 = value;
        break;
      case 0x102:
        this.bplcon1 = value;
        break;
      case 0x104:
        this.bplcon2 = value;
        break;
      default:
        break;
    }
  }
}
