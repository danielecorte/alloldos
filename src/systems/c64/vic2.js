// MOS 6569 (VIC-II, PAL).
//
// Rendered one raster line at a time: the machine runs the CPU for a line's
// worth of cycles, then asks the VIC to draw it. That is not sub-cycle exact,
// but badlines, the video/row counters, raster IRQs and $d011/$d016/$d018
// changes are all handled per line, which is what raster splits and scrolling
// actually need.

export const CYCLES_PER_LINE = 63; // PAL 6569
export const LINES_PER_FRAME = 312;

export const SCREEN_WIDTH = 384;
export const SCREEN_HEIGHT = 272;

const FIRST_VISIBLE_LINE = 16; // raster line drawn at framebuffer row 0
const BORDER_LEFT = 32; // framebuffer column of the 40-column display window

/**
 * The 16 C64 colours (Pepto's PAL measurements), pre-packed as little-endian
 * 0xAABBGGRR words so the framebuffer can be a Uint32Array.
 */
export const PALETTE = [
  0xff000000, // 0  black    #000000
  0xffffffff, // 1  white    #ffffff
  0xff2b3768, // 2  red      #68372b
  0xffb2a470, // 3  cyan     #70a4b2
  0xff863d6f, // 4  purple   #6f3d86
  0xff438d58, // 5  green    #588d43
  0xff792835, // 6  blue     #352879
  0xff6fc7b8, // 7  yellow   #b8c76f
  0xff254f6f, // 8  orange   #6f4f25
  0xff003943, // 9  brown    #433900
  0xff59679a, // 10 lt red   #9a6759
  0xff444444, // 11 dk grey  #444444
  0xff6c6c6c, // 12 md grey  #6c6c6c
  0xff84d29a, // 13 lt green #9ad284
  0xffb55e6c, // 14 lt blue  #6c5eb5
  0xff959595, // 15 lt grey  #959595
];

export class VICII {
  /**
   * @param {object} hooks
   * @param {(addr:number)=>number} hooks.read VIC-side memory read (bank + char ROM aware)
   * @param {(index:number)=>number} hooks.readColor colour RAM nibble
   * @param {(active:boolean)=>void} hooks.onInterrupt
   * @param {(stolen:number)=>void} [hooks.onBadline] cycles stolen from the CPU
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.registers = new Uint8Array(0x30);
    this.spriteX = new Uint16Array(8);
    this.spriteY = new Uint8Array(8);

    // Video matrix line buffer, refilled on every badline.
    this.matrixChars = new Uint8Array(40);
    this.matrixColors = new Uint8Array(40);
    // Per-pixel "is foreground" mask for the current line, for sprite priority.
    this.foreground = new Uint8Array(SCREEN_WIDTH);

    this.reset();
  }

  reset() {
    this.registers.fill(0);
    this.spriteX.fill(0);
    this.spriteY.fill(0);
    this.matrixChars.fill(0);
    this.matrixColors.fill(0);

    this.raster = 0;
    this.rasterCompare = 0;
    this.control1 = 0x1b;
    this.control2 = 0x08;
    this.memoryPointers = 0x14;
    this.irqFlags = 0;
    this.irqMask = 0;
    this.borderColor = 14;
    this.background = [6, 0, 0, 0];
    this.spriteMulticolor = [0, 0];
    this.spriteColor = new Uint8Array(8);
    this.spriteEnable = 0;
    this.spriteExpandX = 0;
    this.spriteExpandY = 0;
    this.spriteMulticolorFlags = 0;
    this.spritePriority = 0;
    this.spriteSpriteCollision = 0;
    this.spriteDataCollision = 0;

    this.bankBase = 0;
    this.vcbase = 0;
    this.vc = 0;
    this.rc = 0;
    this.displayState = false;
    this.denLatched = true;
    this.irqActive = false;

    // Vertical border flip-flop, so opening the border works.
    this.verticalBorder = true;
    this.framebuffer.fill(PALETTE[14]);
  }

  get yScroll() {
    return this.control1 & 0x07;
  }

  get xScroll() {
    return this.control2 & 0x07;
  }

  get videoMatrixBase() {
    return this.bankBase + ((this.memoryPointers & 0xf0) << 6);
  }

  get charBase() {
    return this.bankBase + ((this.memoryPointers & 0x0e) << 10);
  }

  get bitmapBase() {
    return this.bankBase + ((this.memoryPointers & 0x08) << 10);
  }

  /** Graphics mode as the 3-bit ECM/BMM/MCM selector. */
  get mode() {
    return ((this.control1 & 0x60) >> 4) | ((this.control2 & 0x10) >> 4);
  }

  setBank(bank) {
    this.bankBase = (bank & 0x03) * 0x4000;
  }

  updateInterrupt() {
    const active = (this.irqFlags & this.irqMask & 0x0f) !== 0;
    if (active) this.irqFlags |= 0x80;
    else this.irqFlags &= 0x7f;
    if (active !== this.irqActive) {
      this.irqActive = active;
      this.hooks.onInterrupt(active);
    }
  }

  raiseInterrupt(flag) {
    this.irqFlags |= flag;
    this.updateInterrupt();
  }

  // ------------------------------------------------------------- line timing

  /**
   * Called at the start of every raster line, before the CPU runs.
   * @returns {number} cycles stolen from the CPU by a badline
   */
  beginLine(line) {
    this.raster = line;

    if (line === 0) this.vcbase = 0;
    if (line === 0x30) this.denLatched = (this.control1 & 0x10) !== 0;

    if (line === this.rasterCompare) this.raiseInterrupt(0x01);

    const badline =
      this.denLatched && line >= 0x30 && line <= 0xf7 && (line & 0x07) === this.yScroll;
    if (badline) {
      this.displayState = true;
      this.rc = 0;
      this.fetchMatrix();
    }
    this.badline = badline;
    return badline ? 40 : 0;
  }

  fetchMatrix() {
    const base = this.videoMatrixBase;
    for (let i = 0; i < 40; i++) {
      const index = (this.vcbase + i) & 0x3ff;
      this.matrixChars[i] = this.hooks.read(base + index);
      this.matrixColors[i] = this.hooks.readColor(index);
    }
  }

  /** Called after the CPU has run the line; advances the video counters. */
  endLine() {
    if (!this.displayState) return;
    if (this.rc === 7) {
      this.vcbase = (this.vcbase + 40) & 0x3ff;
      this.displayState = false; // idle until the next badline
    } else {
      this.rc++;
    }
  }

  // ---------------------------------------------------------------- drawing

  renderLine(line) {
    const y = line - FIRST_VISIBLE_LINE;
    if (y < 0 || y >= SCREEN_HEIGHT) return;

    const fb = this.framebuffer;
    const rowStart = y * SCREEN_WIDTH;
    const border = PALETTE[this.borderColor & 0x0f];

    // Display window geometry (RSEL / CSEL).
    const rsel = (this.control1 & 0x08) !== 0;
    const csel = (this.control2 & 0x08) !== 0;
    const firstLine = rsel ? 51 : 55;
    const lastLine = rsel ? 250 : 246;
    const leftEdge = BORDER_LEFT + (csel ? 0 : 7);
    const rightEdge = BORDER_LEFT + 320 - (csel ? 0 : 9);

    const inWindow = line >= firstLine && line <= lastLine && (this.control1 & 0x10) !== 0;

    if (!inWindow) {
      fb.fill(border, rowStart, rowStart + SCREEN_WIDTH);
      this.foreground.fill(0);
      // Sprites still show in the border area only when the border is open,
      // which this renderer does not model; nothing else to draw.
      return;
    }

    this.foreground.fill(0);
    this.drawGraphics(rowStart, line);
    this.drawSprites(rowStart, line);

    // The border is painted over everything else.
    fb.fill(border, rowStart, rowStart + leftEdge);
    fb.fill(border, rowStart + rightEdge, rowStart + SCREEN_WIDTH);
  }

  drawGraphics(rowStart, line) {
    const fb = this.framebuffer;
    const fg = this.foreground;
    const mode = this.mode;
    const scroll = this.xScroll;
    const rc = this.rc;

    // Idle state: the VIC keeps fetching from $3fff and shows background.
    if (!this.displayState) {
      const idle = PALETTE[this.background[0] & 0x0f];
      fb.fill(idle, rowStart + BORDER_LEFT, rowStart + BORDER_LEFT + 320);
      return;
    }

    const charBase = this.charBase;
    const bitmapBase = this.bitmapBase;
    const bg0 = PALETTE[this.background[0] & 0x0f];

    for (let col = 0; col < 40; col++) {
      const ch = this.matrixChars[col];
      const color = this.matrixColors[col];
      const x0 = BORDER_LEFT + col * 8 + scroll;

      let bits;
      switch (mode) {
        case 0: // standard text
        case 1: // multicolor text
          bits = this.hooks.read(charBase + ch * 8 + rc);
          break;
        case 2: // standard bitmap
        case 3: // multicolor bitmap
          bits = this.hooks.read(bitmapBase + ((this.vcbase + col) & 0x3ff) * 8 + rc);
          break;
        case 4: // extended background colour text
          bits = this.hooks.read(charBase + (ch & 0x3f) * 8 + rc);
          break;
        default:
          bits = 0; // invalid modes display black
          break;
      }

      const multicolor = mode === 1 ? (color & 0x08) !== 0 : mode === 3;

      if (mode >= 5) {
        for (let i = 0; i < 8; i++) this.plot(fb, fg, rowStart, x0 + i, PALETTE[0], false);
        continue;
      }

      if (multicolor) {
        let colors;
        if (mode === 1) {
          colors = [
            bg0,
            PALETTE[this.background[1] & 0x0f],
            PALETTE[this.background[2] & 0x0f],
            PALETTE[color & 0x07],
          ];
        } else {
          colors = [
            bg0,
            PALETTE[(ch >> 4) & 0x0f],
            PALETTE[ch & 0x0f],
            PALETTE[color & 0x0f],
          ];
        }
        for (let i = 0; i < 4; i++) {
          const pair = (bits >> (6 - i * 2)) & 0x03;
          const isForeground = pair >= 2;
          this.plot(fb, fg, rowStart, x0 + i * 2, colors[pair], isForeground);
          this.plot(fb, fg, rowStart, x0 + i * 2 + 1, colors[pair], isForeground);
        }
        continue;
      }

      let onColor;
      let offColor;
      if (mode === 2) {
        onColor = PALETTE[(ch >> 4) & 0x0f];
        offColor = PALETTE[ch & 0x0f];
      } else if (mode === 4) {
        onColor = PALETTE[color & 0x0f];
        offColor = PALETTE[this.background[(ch >> 6) & 0x03] & 0x0f];
      } else {
        onColor = PALETTE[color & 0x0f];
        offColor = bg0;
      }

      for (let i = 0; i < 8; i++) {
        const on = (bits & (0x80 >> i)) !== 0;
        this.plot(fb, fg, rowStart, x0 + i, on ? onColor : offColor, on);
      }
    }
  }

  plot(fb, fg, rowStart, x, color, isForeground) {
    if (x < BORDER_LEFT || x >= BORDER_LEFT + 320) return;
    fb[rowStart + x] = color;
    fg[x] = isForeground ? 1 : 0;
  }

  drawSprites(rowStart, line) {
    const fb = this.framebuffer;
    const fg = this.foreground;
    // Sprite 0 has the highest priority, so draw from 7 down to 0.
    const drawn = new Uint8Array(SCREEN_WIDTH);

    for (let n = 7; n >= 0; n--) {
      const bit = 1 << n;
      if (!(this.spriteEnable & bit)) continue;

      const expandY = (this.spriteExpandY & bit) !== 0;
      const height = expandY ? 42 : 21;
      const top = this.spriteY[n];
      if (line < top || line >= top + height) continue;

      const row = expandY ? (line - top) >> 1 : line - top;
      const pointer = this.hooks.read(this.videoMatrixBase + 0x3f8 + n);
      const dataAddr = this.bankBase + pointer * 64 + row * 3;
      const b0 = this.hooks.read(dataAddr);
      const b1 = this.hooks.read(dataAddr + 1);
      const b2 = this.hooks.read(dataAddr + 2);
      const bits = (b0 << 16) | (b1 << 8) | b2;

      const expandX = (this.spriteExpandX & bit) !== 0;
      const multicolor = (this.spriteMulticolorFlags & bit) !== 0;
      const behind = (this.spritePriority & bit) !== 0;
      const scale = expandX ? 2 : 1;
      // Sprite X 24 is the first column of the display window.
      const x0 = this.spriteX[n] - 24 + BORDER_LEFT;

      const colors = multicolor
        ? [
            0,
            PALETTE[this.spriteMulticolor[0] & 0x0f],
            PALETTE[this.spriteColor[n] & 0x0f],
            PALETTE[this.spriteMulticolor[1] & 0x0f],
          ]
        : [0, PALETTE[this.spriteColor[n] & 0x0f]];

      const step = multicolor ? 2 : 1;
      for (let i = 0; i < 24; i += step) {
        const value = multicolor
          ? (bits >> (22 - i)) & 0x03
          : (bits >> (23 - i)) & 0x01;
        if (value === 0) continue;

        const color = colors[value];
        const width = step * scale;
        const px = x0 + i * scale;
        for (let d = 0; d < width; d++) {
          const x = px + d;
          if (x < 0 || x >= SCREEN_WIDTH) continue;

          if (drawn[x]) this.spriteSpriteCollision |= bit | drawn[x];
          else drawn[x] = bit;

          if (fg[x]) this.spriteDataCollision |= bit;
          if (!behind || !fg[x]) fb[rowStart + x] = color;
        }
      }
    }

    if (this.spriteSpriteCollision && !(this.irqFlags & 0x04)) this.raiseInterrupt(0x04);
    if (this.spriteDataCollision && !(this.irqFlags & 0x02)) this.raiseInterrupt(0x02);
  }

  // --------------------------------------------------------------- registers

  read(reg) {
    reg &= 0x3f;
    if (reg >= 0x2f) return 0xff; // unconnected

    switch (reg) {
      case 0x11:
        return (this.control1 & 0x7f) | ((this.raster & 0x100) >> 1);
      case 0x12:
        return this.raster & 0xff;
      case 0x13:
      case 0x14:
        return this.registers[reg]; // light pen latch
      case 0x15:
        return this.spriteEnable;
      case 0x16:
        return this.control2 | 0xc0;
      case 0x17:
        return this.spriteExpandY;
      case 0x18:
        return this.memoryPointers | 0x01;
      case 0x19:
        return this.irqFlags | 0x70;
      case 0x1a:
        return this.irqMask | 0xf0;
      case 0x1b:
        return this.spritePriority;
      case 0x1c:
        return this.spriteMulticolorFlags;
      case 0x1d:
        return this.spriteExpandX;
      case 0x1e: {
        const value = this.spriteSpriteCollision;
        this.spriteSpriteCollision = 0; // cleared on read
        return value;
      }
      case 0x1f: {
        const value = this.spriteDataCollision;
        this.spriteDataCollision = 0;
        return value;
      }
      case 0x20:
        return this.borderColor | 0xf0;
      case 0x10: {
        let msb = 0;
        for (let n = 0; n < 8; n++) if (this.spriteX[n] & 0x100) msb |= 1 << n;
        return msb;
      }
      default:
        if (reg < 0x10) {
          return reg & 1 ? this.spriteY[reg >> 1] : this.spriteX[reg >> 1] & 0xff;
        }
        if (reg >= 0x21 && reg <= 0x24) return this.background[reg - 0x21] | 0xf0;
        if (reg >= 0x25 && reg <= 0x26) return this.spriteMulticolor[reg - 0x25] | 0xf0;
        if (reg >= 0x27 && reg <= 0x2e) return this.spriteColor[reg - 0x27] | 0xf0;
        return 0xff;
    }
  }

  write(reg, value) {
    reg &= 0x3f;
    value &= 0xff;
    this.registers[reg] = value;

    if (reg < 0x10) {
      const n = reg >> 1;
      if (reg & 1) this.spriteY[n] = value;
      else this.spriteX[n] = (this.spriteX[n] & 0x100) | value;
      return;
    }
    if (reg >= 0x21 && reg <= 0x24) {
      this.background[reg - 0x21] = value & 0x0f;
      return;
    }
    if (reg >= 0x25 && reg <= 0x26) {
      this.spriteMulticolor[reg - 0x25] = value & 0x0f;
      return;
    }
    if (reg >= 0x27 && reg <= 0x2e) {
      this.spriteColor[reg - 0x27] = value & 0x0f;
      return;
    }

    switch (reg) {
      case 0x10:
        for (let n = 0; n < 8; n++) {
          this.spriteX[n] = (this.spriteX[n] & 0xff) | (value & (1 << n) ? 0x100 : 0);
        }
        break;
      case 0x11:
        this.control1 = value;
        this.rasterCompare = (this.rasterCompare & 0xff) | ((value & 0x80) << 1);
        break;
      case 0x12:
        this.rasterCompare = (this.rasterCompare & 0x100) | value;
        break;
      case 0x15:
        this.spriteEnable = value;
        break;
      case 0x16:
        this.control2 = value;
        break;
      case 0x17:
        this.spriteExpandY = value;
        break;
      case 0x18:
        this.memoryPointers = value;
        break;
      case 0x19:
        this.irqFlags &= ~(value & 0x0f); // write 1 to acknowledge
        this.updateInterrupt();
        break;
      case 0x1a:
        this.irqMask = value & 0x0f;
        this.updateInterrupt();
        break;
      case 0x1b:
        this.spritePriority = value;
        break;
      case 0x1c:
        this.spriteMulticolorFlags = value;
        break;
      case 0x1d:
        this.spriteExpandX = value;
        break;
      case 0x1e:
        this.spriteSpriteCollision = 0;
        break;
      case 0x1f:
        this.spriteDataCollision = 0;
        break;
      case 0x20:
        this.borderColor = value & 0x0f;
        break;
      default:
        break;
    }
  }
}
