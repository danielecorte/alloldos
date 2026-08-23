// Agnus: the chip that owns the memory bus.
//
// It counts the beam, decides which of the eight DMA channels gets the next
// slot, fetches the bitplanes and the sprites a line at a time, and runs the
// copper — the little processor that does nothing but wait for the beam and
// poke chip registers, which is how an Amiga changes its display while the
// display is being drawn.

import { COLOR_CLOCKS_PER_LINE } from './denise.js';

export const LINES_PER_FRAME = 312; // PAL
export const CPU_CYCLES_PER_LINE = COLOR_CLOCKS_PER_LINE * 2;

/** DMACON bits, in the order the hardware manual lists them. */
export const DMA_AUD0 = 0x0001;
export const DMA_DISK = 0x0010;
export const DMA_SPRITE = 0x0020;
export const DMA_BLITTER = 0x0040;
export const DMA_COPPER = 0x0080;
export const DMA_BITPLANE = 0x0100;
export const DMA_MASTER = 0x0200;
export const DMA_BLITPRI = 0x0400;

/** Sprite DMA starts once the vertical blank is over. */
const SPRITE_DMA_START_LINE = 25;

export class Agnus {
  /**
   * @param {object} hooks
   * @param {(addr:number)=>number} hooks.read chip RAM, a word at a time
   * @param {(offset:number,value:number)=>void} hooks.writeRegister the
   *   machine's own register decoder, so a copper MOVE goes exactly where a
   *   CPU write would
   * @param {(hpos:number)=>void} hooks.beam tells Denise how far the beam got
   *   before this write, so the pixels before it keep the old colours
   * @param {()=>number} hooks.planeCount how many bitplanes Denise is showing
   * @param {()=>boolean} hooks.hires
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.bplpt = new Uint32Array(6);
    this.sprpt = new Uint32Array(8);
    this.sprVstart = new Uint16Array(8);
    this.sprVstop = new Uint16Array(8);
    this.sprNeedControl = new Uint8Array(8);

    // One line of fetched bitplane data, six planes deep. A line can hold at
    // most 113 words per plane, which is the whole raster line fetched flat out.
    this.planeWords = Array.from({ length: 6 }, () => new Uint16Array(128));
    this.lineWords = 0;

    this.reset();
  }

  reset() {
    this.dmacon = 0;
    this.vpos = 0;
    this.hpos = 0;
    this.longFrame = true;

    this.diwstrt = 0;
    this.diwstop = 0;
    this.ddfstrt = 0;
    this.ddfstop = 0;
    this.bpl1mod = 0;
    this.bpl2mod = 0;
    this.bplpt.fill(0);
    this.sprpt.fill(0);
    this.sprVstart.fill(0);
    this.sprVstop.fill(0);
    this.sprNeedControl.fill(0);

    this.cop1lc = 0;
    this.cop2lc = 0;
    this.copperPC = 0;
    this.copperHpos = 0;
    this.copperWaiting = false;
    this.copperDone = false;
    this.copperWaitV = 0;
    this.copperWaitH = 0;
    this.copperMaskV = 0;
    this.copperMaskH = 0;
    this.copperSkip = false;
    this.copcon = 0;

    this.lineWords = 0;
  }

  /** True when both the master switch and this particular channel are on. */
  dmaOn(channel) {
    return (this.dmacon & DMA_MASTER) !== 0 && (this.dmacon & channel) !== 0;
  }

  writeDMACON(value) {
    if (value & 0x8000) this.dmacon |= value & 0x07ff;
    else this.dmacon &= ~(value & 0x07ff);
  }

  // ------------------------------------------------------- the display window

  /** The display window, in lores pixels and raster lines. */
  get window() {
    const hstart = this.diwstrt & 0xff;
    // The stop position's ninth bit is the inverse of its eighth, which is what
    // lets a 320-pixel window stop at lores 449 with only eight bits to say so.
    const hstop = (this.diwstop & 0xff) | 0x100;
    const vstart = (this.diwstrt >> 8) & 0xff;
    const vstop = ((this.diwstop >> 8) & 0xff) | ((this.diwstop & 0x8000) ? 0 : 0x100);
    return { hstart, hstop, vstart, vstop };
  }

  // -------------------------------------------------------------- the frame

  startFrame() {
    this.vpos = 0;
    // The long-frame flag only alternates when the display is interlaced; on a
    // plain screen every frame is a long one, and software reads VPOSR to find
    // out which field it is about to draw.
    this.longFrame = this.hooks.interlaced() ? !this.longFrame : true;
    this.copperPC = this.cop1lc;
    this.copperWaiting = false;
    this.copperDone = false;
  }

  /**
   * Everything that happens at the left-hand edge of a line: the sprites and
   * the bitplanes for this line are fetched in one go, which is a line's worth
   * of DMA slots collapsed into an instant.
   */
  startLine(vpos) {
    this.vpos = vpos;
    this.hpos = 0;
    this.copperHpos = 0;
    this.fetchSprites(vpos);
    this.fetchBitplanes(vpos);
  }

  fetchBitplanes(vpos) {
    this.lineWords = 0;
    const window = this.window;
    if (!this.dmaOn(DMA_BITPLANE)) return;
    if (vpos < window.vstart || vpos >= window.vstop) return;

    const planes = this.hooks.planeCount();
    if (planes === 0) return;

    // The fetch is organised in blocks of eight colour clocks — one word per
    // plane in lores, two in hires — running from DDFSTRT to DDFSTOP. A block
    // that DDFSTOP lands in the middle of is still fetched whole, which is why
    // this rounds up: a stop four colour clocks early costs nothing at all.
    const blocks = Math.ceil((this.ddfstop - this.ddfstrt) / 8) + 1;
    if (blocks <= 0) return;
    const hires = this.hooks.hires();
    const words = Math.min(hires ? blocks * 2 : blocks, 128);

    for (let plane = 0; plane < planes; plane++) {
      let pointer = this.bplpt[plane];
      const buffer = this.planeWords[plane];
      for (let word = 0; word < words; word++) {
        buffer[word] = this.hooks.read(pointer);
        pointer = (pointer + 2) & 0x1ffffe;
      }
      // The modulo is what turns a bitmap wider than the screen into a window
      // onto it: it is added once per line, after the fetch.
      pointer = (pointer + (plane & 1 ? this.bpl2mod : this.bpl1mod)) & 0x1ffffe;
      this.bplpt[plane] = pointer;
    }
    this.lineWords = words;
  }

  /**
   * The sprite DMA state machine. A sprite is a little program of its own: two
   * control words say where it starts and stops, then one pair of data words
   * per line until it does.
   */
  fetchSprites(vpos) {
    // Every sprite starts each frame by reading its control words again, from
    // wherever its pointer has been left — which is why a copper list rewrites
    // the sprite pointers at the top of every single frame.
    if (vpos === SPRITE_DMA_START_LINE) this.sprNeedControl.fill(1);
    if (!this.dmaOn(DMA_SPRITE)) return;

    for (let index = 0; index < 8; index++) {
      let pointer = this.sprpt[index];

      if (this.sprNeedControl[index] || vpos === this.sprVstop[index]) {
        const pos = this.hooks.read(pointer);
        const ctl = this.hooks.read(pointer + 2);
        pointer = (pointer + 4) & 0x1ffffe;
        this.sprpt[index] = pointer;
        this.hooks.writeRegister(0x140 + index * 8, pos);
        this.hooks.writeRegister(0x142 + index * 8, ctl);
        this.sprVstart[index] = ((pos >> 8) & 0xff) | ((ctl & 0x04) << 6);
        this.sprVstop[index] = ((ctl >> 8) & 0xff) | ((ctl & 0x02) << 7);
        this.sprNeedControl[index] = 0;
        continue;
      }

      if (vpos >= this.sprVstart[index] && vpos < this.sprVstop[index]) {
        const a = this.hooks.read(pointer);
        const b = this.hooks.read(pointer + 2);
        this.sprpt[index] = (pointer + 4) & 0x1ffffe;
        this.hooks.writeRegister(0x144 + index * 8, a);
        this.hooks.writeRegister(0x146 + index * 8, b);
      }
    }
  }

  // ------------------------------------------------------------- the copper

  /**
   * Runs the copper up to a beam position on the current line. It costs four
   * colour clocks an instruction, and it stops dead the moment it asks for a
   * position this line will not reach.
   */
  runCopper(limitHpos) {
    if (!this.dmaOn(DMA_COPPER) || this.copperDone) {
      this.copperHpos = Math.max(this.copperHpos, limitHpos);
      return;
    }

    while (this.copperHpos < limitHpos) {
      if (this.copperWaiting) {
        const position = this.waitPosition();
        if (position < 0) {
          // Not on this line, and possibly never: leave it waiting.
          this.copperHpos = limitHpos;
          return;
        }
        if (position >= limitHpos) {
          this.copperHpos = limitHpos;
          return;
        }
        this.copperHpos = Math.max(this.copperHpos, position);
        this.copperWaiting = false;
      }

      const first = this.hooks.read(this.copperPC);
      const second = this.hooks.read(this.copperPC + 2);
      this.copperPC = (this.copperPC + 4) & 0x1ffffe;
      this.copperHpos += 4;

      // A SKIP that came true swallows whatever instruction follows it, whether
      // that is a MOVE or another WAIT.
      if (this.copperSkip) {
        this.copperSkip = false;
        continue;
      }

      if ((first & 1) === 0) {
        // MOVE. Without CDANG the copper is locked out of the first $40 of
        // registers, which is where the blitter lives.
        const offset = first & 0x1fe;
        const floor = this.copcon & 0x02 ? 0x40 : 0x80;
        if (offset >= floor) {
          this.hooks.beam(this.copperHpos);
          this.hooks.writeRegister(offset, second);
        }
        continue;
      }

      this.copperWaitV = (first >> 8) & 0xff;
      this.copperWaitH = first & 0xfe;
      this.copperMaskV = ((second >> 8) & 0x7f) | 0x80;
      this.copperMaskH = second & 0xfe;

      if ((second & 1) === 0) {
        this.copperWaiting = true;
        // The traditional end of a copper list asks for a line that this frame
        // will never show; treat it as "stop until the next vertical blank".
        if ((this.copperWaitV & this.copperMaskV) === 0xff) {
          this.copperDone = true;
          this.copperHpos = limitHpos;
          return;
        }
      } else {
        // SKIP: the next instruction is thrown away if the beam is already past.
        this.copperSkip = this.beamReached();
      }
    }
  }

  beamReached() {
    const v = this.vpos & this.copperMaskV;
    const target = this.copperWaitV & this.copperMaskV;
    if (v > target) return true;
    if (v < target) return false;
    return (this.copperHpos & this.copperMaskH) >= (this.copperWaitH & this.copperMaskH);
  }

  /**
   * @returns {number} the colour clock this line at which the wait comes true,
   *   or -1 if it does not come true on this line at all
   */
  waitPosition() {
    const v = this.vpos & this.copperMaskV;
    const target = this.copperWaitV & this.copperMaskV;
    if (v > target) return this.copperHpos;
    if (v < target) return -1;
    const wanted = this.copperWaitH & this.copperMaskH;
    if ((this.copperHpos & this.copperMaskH) >= wanted) return this.copperHpos;
    return wanted <= COLOR_CLOCKS_PER_LINE ? wanted : -1;
  }

  strobeCopper(which) {
    this.copperPC = which === 1 ? this.cop1lc : this.cop2lc;
    this.copperWaiting = false;
    this.copperDone = false;
  }

  // ------------------------------------------------------------- registers

  readRegister(offset) {
    switch (offset) {
      case 0x002: // DMACONR
        return this.dmacon & 0x07ff;
      case 0x004: // VPOSR — bit 15 is the long-frame flag, bit 0 the ninth line bit
        return ((this.longFrame ? 0x8000 : 0) | ((this.vpos >> 8) & 1)) & 0xffff;
      case 0x006: // VHPOSR
        return (((this.vpos & 0xff) << 8) | (this.hpos & 0xff)) & 0xffff;
      default:
        return 0xffff;
    }
  }

  writeRegister(offset, value) {
    switch (offset) {
      case 0x02a: // VPOSW
        this.longFrame = (value & 0x8000) !== 0;
        return true;
      case 0x02e:
        this.copcon = value;
        return true;
      case 0x080:
        this.cop1lc = (this.cop1lc & 0x0000ffff) | ((value & 0x1f) << 16);
        return true;
      case 0x082:
        this.cop1lc = (this.cop1lc & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x084:
        this.cop2lc = (this.cop2lc & 0x0000ffff) | ((value & 0x1f) << 16);
        return true;
      case 0x086:
        this.cop2lc = (this.cop2lc & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x088:
        this.strobeCopper(1);
        return true;
      case 0x08a:
        this.strobeCopper(2);
        return true;
      case 0x08e:
        this.diwstrt = value;
        return true;
      case 0x090:
        this.diwstop = value;
        return true;
      case 0x092:
        this.ddfstrt = value & 0xfc;
        return true;
      case 0x094:
        this.ddfstop = value & 0xfc;
        return true;
      case 0x096:
        this.writeDMACON(value);
        return true;
      case 0x108:
        this.bpl1mod = (value << 16) >> 16;
        return true;
      case 0x10a:
        this.bpl2mod = (value << 16) >> 16;
        return true;
      default:
        break;
    }

    if (offset >= 0x0e0 && offset < 0x0fc) {
      const plane = (offset - 0x0e0) >> 2;
      if (offset & 2) this.bplpt[plane] = (this.bplpt[plane] & 0x1f0000) | (value & 0xfffe);
      else this.bplpt[plane] = (this.bplpt[plane] & 0x00fffe) | ((value & 0x1f) << 16);
      return true;
    }
    if (offset >= 0x120 && offset < 0x140) {
      const sprite = (offset - 0x120) >> 2;
      if (offset & 2) this.sprpt[sprite] = (this.sprpt[sprite] & 0x1f0000) | (value & 0xfffe);
      else this.sprpt[sprite] = (this.sprpt[sprite] & 0x00fffe) | ((value & 0x1f) << 16);
      return true;
    }
    return false;
  }
}
