// The Amiga 500 itself: 1 MB of chip RAM, a Kickstart in ROM, the three custom
// chips, two CIAs and a floppy drive, all hanging off one bus.
//
// The frame is run a line at a time, and each line in eight-colour-clock
// chunks: the copper gets its turn, then the CPU gets its turn, and Denise is
// told how far the beam had gone before either of them touched a register. That
// is what makes a copper list change colours in the middle of a line without
// changing them for the whole of it.

import { CPU68000 } from './cpu68000.js';
import { CIA8520 } from './cia.js';
import { Agnus, LINES_PER_FRAME, CPU_CYCLES_PER_LINE, DMA_DISK, DMA_MASTER } from './agnus.js';
import { Blitter } from './blitter.js';
import { Denise, COLOR_CLOCKS_PER_LINE } from './denise.js';
import { Paula, INT_VERTB, INT_BLIT, INT_PORTS, INT_EXTER, INT_DSKBLK, INT_DSKSYNC } from './paula.js';
import { DiskDrive } from './disk.js';
import { AmigaKeyboard } from './keyboard.js';
import { romBase, EXTENDED_ROM_BASE, EXTENDED_ROM_SIZE } from './roms.js';
import { FastRAM, AUTOCONFIG_BASE, AUTOCONFIG_SIZE } from './autoconfig.js';

export const CPU_CLOCK = 7093790; // PAL, in Hz
export const FRAME_CYCLES = CPU_CYCLES_PER_LINE * LINES_PER_FRAME;
export const FPS = CPU_CLOCK / FRAME_CYCLES; // 50.06

/**
 * Chip RAM: the memory the custom chips can reach, and the only memory a
 * program can put a screen or a sample in.
 *
 * A stock A500 had half this, and the Agnus in it could not address more. This
 * is the later one — the 8372A that came in the A500+, and that plenty of A500s
 * were upgraded to — because where the top of chip RAM falls decides whether a
 * program that puts its screen there collides with the operating system sitting
 * above it. At 512 KB, AROS's supervisor stack lands at $7d000 and a game that
 * blits to the top of memory writes straight through it.
 */
export const CHIP_RAM_SIZE = 0x100000; // 1 MB

/**
 * The trapdoor expansion. An A501 under the machine put another 512 KB here,
 * which is not chip RAM — the custom chips cannot reach it — but is otherwise
 * ordinary memory, and the ROM finds it by probing rather than by autoconfig.
 */
export const SLOW_RAM_BASE = 0xc00000;
export const SLOW_RAM_SIZE = 0x80000; // 512 KB

/**
 * How much RAM the card on the side expansion bus offers. A stock A500 has
 * none of this; it is here because AROS is a far bigger operating system than
 * the Kickstart the machine was sold with, and fills the trapdoor 512 KB
 * entirely. Given somewhere else to live it leaves the chip RAM to the program,
 * which is where a program needs it.
 */
export const FAST_RAM_SIZE = 0x800000; // 8 MB, the most Zorro II can address

/** How much of a line the copper and the CPU take turns over. */
const CHUNK_CLOCKS = 8;

export class Amiga {
  /**
   * @param {Uint8Array} kickstart 256 or 512 KB of ROM
   * @param {number} sampleRate the host's audio rate
   * @param {?Uint8Array} [extended] a second ROM for the $e00000 socket
   * @param {number} [fastRamSize] the card on the expansion bus, 0 for none
   */
  constructor(kickstart, sampleRate = 44100, extended = null, fastRamSize = FAST_RAM_SIZE) {
    this.chip = new Uint8Array(CHIP_RAM_SIZE);
    this.chipView = new DataView(this.chip.buffer);
    this.slow = new Uint8Array(SLOW_RAM_SIZE);
    this.slowView = new DataView(this.slow.buffer);
    this.fast = fastRamSize ? new FastRAM(fastRamSize) : null;
    this.rom = kickstart;
    this.romView = new DataView(kickstart.buffer, kickstart.byteOffset, kickstart.byteLength);
    this.romBase = romBase(kickstart.length);
    this.romMask = kickstart.length - 1;

    // The extended ROM socket. Empty on a plain A500, and the machine boots
    // perfectly well without it — but AROS keeps half of itself in there.
    this.extended = extended;
    this.extendedView = extended
      ? new DataView(extended.buffer, extended.byteOffset, extended.byteLength)
      : null;
    this.extendedMask = extended ? extended.length - 1 : 0;

    this.keyboard = new AmigaKeyboard();

    this.denise = new Denise();
    this.paula = new Paula(
      {
        read: (addr) => this.chipRead(addr),
        onInterruptLevel: (level) => this.cpu?.setInterruptLevel(level),
        audioDMA: (channel) => this.agnus.dmaOn(1 << channel),
      },
      sampleRate,
    );
    this.blitter = new Blitter({
      read: (addr) => this.chipRead(addr),
      write: (addr, value) => this.chipWrite(addr, value),
      onFinished: () => this.paula.raise(INT_BLIT),
    });
    this.agnus = new Agnus({
      read: (addr) => this.chipRead(addr),
      writeRegister: (offset, value) => this.writeCustom(offset, value),
      beam: (hpos) => this.denise.renderUpTo(hpos),
      planeCount: () => this.denise.planeCount,
      hires: () => this.denise.hires,
      interlaced: () => this.denise.interlaced,
    });
    this.disk = new DiskDrive({
      write: (addr, value) => this.chipWrite(addr, value),
      read: (addr) => this.chipRead(addr),
      dmaEnabled: () => this.agnus.dmaOn(DMA_DISK),
      adkcon: () => this.paula.adkcon,
      onBlockFinished: () => this.paula.raise(INT_DSKBLK),
      onSyncFound: () => this.paula.raise(INT_DSKSYNC),
    });

    this.ciaa = new CIA8520('A', {
      onInterrupt: (active) => {
        if (active) this.paula.raise(INT_PORTS);
        else this.paula.clear(INT_PORTS);
      },
      readPortA: () => this.readCIAAPortA(),
      writePortA: () => this.updateOverlay(),
    });
    this.ciab = new CIA8520('B', {
      onInterrupt: (active) => {
        if (active) this.paula.raise(INT_EXTER);
        else this.paula.clear(INT_EXTER);
      },
      writePortB: (value) => this.disk.writeControl(value),
    });

    this.cpu = new CPU68000(this);
    this.overlay = true;
    this.frameCount = 0;
    this.cycles = 0;
    this.cycleCarry = 0;
    this.hpos = 0;
    this.vpos = 0;
    this.reset();
  }

  reset() {
    this.chip.fill(0);
    this.slow.fill(0);
    this.fast?.clear();
    this.agnus.reset();
    this.blitter.reset();
    this.denise.reset();
    this.paula.reset();
    this.disk.reset();
    this.ciaa.reset();
    this.ciab.reset();
    this.keyboard.reset();

    // Out of reset nothing drives the overlay line, and a floating line is a
    // high one: the ROM is at address zero, which is where the 68000 goes
    // looking for its stack pointer and its first instruction.
    this.overlay = true;
    this.cycleCarry = 0;
    this.cpu.reset(true);
  }

  /**
   * The RESET instruction pulses the line to the chips but not to the CPU.
   *
   * The line reaches the CIAs as well, and that is the whole point of it: their
   * data direction registers go back to zero, nothing drives OVL any more, and
   * the pull-up puts the ROM over address zero again. That is what makes
   * ColdReboot work — `movea.l #2,a0; reset; jmp (a0)` only lands anywhere at
   * all if $2 has become the ROM's `jmp` to its own entry point by the time the
   * jump happens. RAM is left alone, so anything a program parked there to
   * survive the reboot still survives it.
   */
  resetDevices() {
    this.agnus.reset();
    this.blitter.reset();
    this.paula.reset();
    this.denise.reset();

    this.ciaa.reset();
    this.ciab.reset();
    this.keyboard.reset();
    this.fast?.reset();
    this.updateOverlay();
    // A reset CIA-B drives every drive line high: no drive selected, no motor.
    // The head does not move, because nothing resets the drive itself.
    this.disk.writeControl(this.ciab.portBOutput);
  }

  updateOverlay() {
    this.overlay = (this.ciaa.portAOutput & 0x01) !== 0;
  }

  // --------------------------------------------------------------- the bus

  /** Chip RAM as Agnus and the blitter see it: words, and nothing else. */
  chipRead(addr) {
    return this.chipView.getUint16(addr & (CHIP_RAM_SIZE - 2), false);
  }

  chipWrite(addr, value) {
    this.chipView.setUint16(addr & (CHIP_RAM_SIZE - 2), value & 0xffff, false);
  }

  read8(addr) {
    if (addr < 0x200000) {
      if (this.overlay && addr < 0x100000) return this.rom[addr & this.romMask];
      return this.chip[addr & (CHIP_RAM_SIZE - 1)];
    }
    if (this.fast?.contains(addr)) return this.fast.read8(addr);
    if (addr >= SLOW_RAM_BASE && addr < SLOW_RAM_BASE + SLOW_RAM_SIZE) {
      return this.slow[addr - SLOW_RAM_BASE];
    }
    if (addr >= this.romBase) return this.rom[addr & this.romMask];
    if (this.extended && addr >= EXTENDED_ROM_BASE && addr < EXTENDED_ROM_BASE + EXTENDED_ROM_SIZE) {
      return this.extended[addr & this.extendedMask];
    }
    if (addr >= 0xa00000 && addr < 0xc00000) return this.readCIA(addr);
    if (addr >= 0xdf0000 && addr < 0xe00000) {
      const value = this.readCustom(addr & 0x1fe);
      return addr & 1 ? value & 0xff : (value >> 8) & 0xff;
    }
    if (this.fast && addr >= AUTOCONFIG_BASE && addr < AUTOCONFIG_BASE + AUTOCONFIG_SIZE) {
      const value = this.fast.readConfig(addr);
      return addr & 1 ? value & 0xff : (value >> 8) & 0xff;
    }
    return 0xff;
  }

  read16(addr) {
    if (addr < 0x200000) {
      if (this.overlay && addr < 0x100000) return this.romView.getUint16(addr & this.romMask, false);
      return this.chipView.getUint16(addr & (CHIP_RAM_SIZE - 2), false);
    }
    if (this.fast?.contains(addr)) return this.fast.read16(addr);
    if (addr >= SLOW_RAM_BASE && addr < SLOW_RAM_BASE + SLOW_RAM_SIZE) {
      return this.slowView.getUint16(addr - SLOW_RAM_BASE, false);
    }
    if (addr >= this.romBase) return this.romView.getUint16(addr & this.romMask, false);
    if (this.extended && addr >= EXTENDED_ROM_BASE && addr < EXTENDED_ROM_BASE + EXTENDED_ROM_SIZE) {
      return this.extendedView.getUint16(addr & this.extendedMask, false);
    }
    if (addr >= 0xa00000 && addr < 0xc00000) {
      return ((this.readCIA(addr) << 8) | this.readCIA(addr + 1)) & 0xffff;
    }
    if (addr >= 0xdf0000 && addr < 0xe00000) return this.readCustom(addr & 0x1fe);
    if (this.fast && addr >= AUTOCONFIG_BASE && addr < AUTOCONFIG_BASE + AUTOCONFIG_SIZE) {
      return this.fast.readConfig(addr);
    }
    // Nothing there. An unexpanded A500 leaves these lines floating, and the
    // memory sizing in the ROM depends on them not looking like RAM.
    return 0xffff;
  }

  read32(addr) {
    return ((this.read16(addr) << 16) | this.read16(addr + 2)) >>> 0;
  }

  write8(addr, value) {
    if (addr < 0x200000) {
      if (this.overlay && addr < 0x100000) return; // ROM: writes fall on the floor
      this.chip[addr & (CHIP_RAM_SIZE - 1)] = value;
      return;
    }
    if (this.fast?.contains(addr)) {
      this.fast.write8(addr, value);
      return;
    }
    if (addr >= SLOW_RAM_BASE && addr < SLOW_RAM_BASE + SLOW_RAM_SIZE) {
      this.slow[addr - SLOW_RAM_BASE] = value;
      return;
    }
    if (addr >= this.romBase) return;
    if (addr >= 0xa00000 && addr < 0xc00000) {
      this.writeCIA(addr, value);
      return;
    }
    if (addr >= 0xdf0000 && addr < 0xe00000) {
      const offset = addr & 0x1fe;
      this.writeCustom(offset, addr & 1 ? value : value << 8);
      return;
    }
    if (this.fast && addr >= AUTOCONFIG_BASE && addr < AUTOCONFIG_BASE + AUTOCONFIG_SIZE) {
      this.fast.writeConfig(addr, value, 1);
    }
  }

  write16(addr, value) {
    if (addr < 0x200000) {
      if (this.overlay && addr < 0x100000) return;
      this.chipView.setUint16(addr & (CHIP_RAM_SIZE - 2), value & 0xffff, false);
      return;
    }
    if (this.fast?.contains(addr)) {
      this.fast.write16(addr, value);
      return;
    }
    if (addr >= SLOW_RAM_BASE && addr < SLOW_RAM_BASE + SLOW_RAM_SIZE) {
      this.slowView.setUint16(addr - SLOW_RAM_BASE, value & 0xffff, false);
      return;
    }
    if (addr >= this.romBase) return;
    if (addr >= 0xa00000 && addr < 0xc00000) {
      this.writeCIA(addr, (value >> 8) & 0xff);
      this.writeCIA(addr + 1, value & 0xff);
      return;
    }
    if (addr >= 0xdf0000 && addr < 0xe00000) {
      this.writeCustom(addr & 0x1fe, value & 0xffff);
      return;
    }
    if (this.fast && addr >= AUTOCONFIG_BASE && addr < AUTOCONFIG_BASE + AUTOCONFIG_SIZE) {
      this.fast.writeConfig(addr, value, 2);
    }
  }

  write32(addr, value) {
    this.write16(addr, (value >>> 16) & 0xffff);
    this.write16(addr + 2, value & 0xffff);
  }

  // ------------------------------------------------------------------- CIAs

  /**
   * The two CIAs share the same quarter of the address space and are told
   * apart by two address lines and by which half of the data bus they answer
   * on: CIA-A on the odd bytes, CIA-B on the even ones.
   */
  readCIA(addr) {
    const register = (addr >> 8) & 0x0f;
    if (!(addr & 0x1000) && addr & 1) return this.ciaa.read(register);
    if (!(addr & 0x2000) && !(addr & 1)) return this.ciab.read(register);
    return 0xff;
  }

  writeCIA(addr, value) {
    const register = (addr >> 8) & 0x0f;
    if (!(addr & 0x1000) && addr & 1) this.ciaa.write(register, value);
    else if (!(addr & 0x2000) && !(addr & 1)) this.ciab.write(register, value);
  }

  /**
   * CIA-A's port A: the overlay line and the power LED going out, the four
   * drive status pins coming back, and the two fire buttons on top — the mouse
   * port's on bit 6, the game port's on bit 7.
   */
  readCIAAPortA() {
    const driven = this.ciaa.portAOutput & 0x03;
    return (
      (driven | this.disk.statusBits | this.keyboard.fireBit | this.keyboard.joystickFireBit) & 0xff
    );
  }

  // --------------------------------------------------------- custom chips

  readCustom(offset) {
    switch (offset) {
      case 0x002: // DMACONR carries the blitter's two status bits with it
        return (this.agnus.dmacon & 0x07ff) | this.blitter.statusBits;
      case 0x004:
      case 0x006:
        return this.agnus.readRegister(offset);
      case 0x008:
      case 0x01a:
        return this.disk.readRegister(offset);
      case 0x00a:
        return this.keyboard.joy0dat;
      case 0x00c:
        return this.keyboard.joy1dat;
      case 0x00e:
        return 0x0000; // collisions, which nothing here reports
      case 0x012:
      case 0x014:
        return 0x0000;
      case 0x016:
        return this.keyboard.potgor;
      case 0x010:
      case 0x018:
      case 0x01c:
      case 0x01e:
        return this.paula.readRegister(offset);
      default:
        return 0xffff;
    }
  }

  /**
   * One write, offered to each chip in turn. The copper comes through here too,
   * which is the point: a copper MOVE and a CPU write are the same thing to
   * everything downstream of them.
   */
  writeCustom(offset, value) {
    const word = value & 0xffff;
    if (offset >= 0x180 || (offset >= 0x100 && offset <= 0x106) || (offset >= 0x140 && offset < 0x180)) {
      this.denise.writeRegister(offset, word);
      return;
    }
    if (offset >= 0x040 && offset <= 0x074) {
      if (this.blitter.writeRegister(offset, word)) return;
    }
    if (this.agnus.writeRegister(offset, word)) {
      if (offset === 0x096) this.paula.updateAudioDMA();
      return;
    }
    if (this.disk.writeRegister(offset, word)) return;
    if (this.paula.writeRegister(offset, word)) return;
    if (offset === 0x034) return; // POTGO: the pot counters nothing here counts
    if (offset === 0x032) return; // SERPER
    if (offset === 0x098) return; // CLXCON
  }

  // ------------------------------------------------------------------ frame

  /** Runs one PAL frame and leaves a finished picture in denise.framebuffer. */
  runFrame() {
    this.agnus.startFrame();
    for (let vpos = 0; vpos < LINES_PER_FRAME; vpos++) this.runLine(vpos);
    this.frameCount++;
  }

  runLine(vpos) {
    this.vpos = vpos;
    this.agnus.startLine(vpos);
    this.denise.startLine(
      vpos,
      this.agnus.planeWords,
      this.agnus.lineWords,
      this.agnus.ddfstrt,
      this.agnus.window,
      this.agnus.longFrame ? 0 : 1,
    );

    // The vertical blank interrupt is the heartbeat of the whole machine: it is
    // what moves the mouse pointer and blinks the cursor.
    if (vpos === 0) {
      this.paula.raise(INT_VERTB);
      this.ciaa.tickTOD();
    }
    this.ciab.tickTOD();

    for (let clock = 0; clock < COLOR_CLOCKS_PER_LINE; clock += CHUNK_CLOCKS) {
      const until = Math.min(clock + CHUNK_CLOCKS, COLOR_CLOCKS_PER_LINE);
      this.hpos = clock;
      this.agnus.runCopper(until);
      this.agnus.hpos = until;
      this.hpos = until;
      // The drive turns before the CPU gets its slice, so a program that is
      // watching the buffer fill sees it filling rather than already full.
      this.disk.tick((until - clock) * 2);
      this.runCycles((until - clock) * 2);
    }

    this.denise.endLine();
    this.ciaa.tick(CPU_CYCLES_PER_LINE);
    this.ciab.tick(CPU_CYCLES_PER_LINE);
    this.paula.clock(COLOR_CLOCKS_PER_LINE);

    const byte = this.keyboard.tick(CPU_CYCLES_PER_LINE);
    if (byte >= 0) this.ciaa.receiveSerial(byte);
  }

  runCycles(budget) {
    let remaining = budget - this.cycleCarry;
    while (remaining > 0) {
      const used = this.cpu.step();
      remaining -= used;
      this.cycles += used;
    }
    this.cycleCarry = -remaining;
  }

  // -------------------------------------------------------------- for tests

  /** Reads a long out of chip RAM, whatever the bus is currently showing. */
  peek32(addr) {
    return ((this.chipRead(addr) << 16) | this.chipRead(addr + 2)) >>> 0;
  }

  peek16(addr) {
    return this.chipRead(addr);
  }

  poke16(addr, value) {
    this.chipWrite(addr, value);
  }

  get dmaMaster() {
    return (this.agnus.dmacon & DMA_MASTER) !== 0;
  }
}
