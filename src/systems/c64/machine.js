// The Commodore 64 itself: 64K of RAM, the three ROMs, the PLA banking logic
// and the bus that ties CPU, VIC-II, SID and the two CIAs together.

import { CPU6502 } from './cpu6502.js';
import { VICII, CYCLES_PER_LINE, LINES_PER_FRAME } from './vic2.js';
import { CIA6526 } from './cia.js';
import { SID } from './sid.js';
import { Keyboard } from './keyboard.js';
import { Datasette } from './datasette.js';

export const CLOCK_PAL = 985248; // phi2 in Hz
export const FRAME_CYCLES = CYCLES_PER_LINE * LINES_PER_FRAME;
export const FPS = CLOCK_PAL / FRAME_CYCLES; // 50.125

const IRQ_VIC = 0x01;
const IRQ_CIA1 = 0x02;

export class C64 {
  /**
   * @param {{kernal:Uint8Array, basic:Uint8Array, chargen:Uint8Array}} roms
   * @param {number} sampleRate host audio sample rate
   */
  constructor(roms, sampleRate = 44100) {
    this.ram = new Uint8Array(0x10000);
    this.colorRam = new Uint8Array(0x400);
    this.kernal = roms.kernal;
    this.basic = roms.basic;
    this.chargen = roms.chargen;

    this.cpu = new CPU6502(this);
    this.keyboard = new Keyboard();
    this.sid = new SID(CLOCK_PAL, sampleRate);
    this.datasette = new Datasette({ onPulse: () => this.cia1.triggerFlag() });

    this.vic = new VICII({
      read: (addr) => this.vicRead(addr),
      readColor: (index) => this.colorRam[index & 0x3ff] & 0x0f,
      onInterrupt: (active) => this.cpu.setIRQ(IRQ_VIC, active),
    });

    this.cia1 = new CIA6526({
      onInterrupt: (active) => this.cpu.setIRQ(IRQ_CIA1, active),
      readPortA: (cia) => this.keyboard.readPortA(cia.portBOutput) & cia.portAOutput,
      readPortB: (cia) => this.keyboard.readPortB(cia.portAOutput) & cia.portBOutput,
    });

    this.nmiLine = false;
    this.cia2 = new CIA6526({
      onInterrupt: (active) => {
        if (active && !this.nmiLine) this.cpu.triggerNMI();
        this.nmiLine = active;
      },
      writePortA: (value) => this.vic.setBank(~value & 0x03),
    });

    this.keyboard.onRestore = () => this.cpu.triggerNMI();

    this.cycleCarry = 0;
    this.frameCount = 0;
    this.cycles = 0; // monotonic phi2 count, used to time the tape
    /** How often game code has read each joystick port, indexed 1 and 2. */
    this.joystickPolls = [0, 0, 0];
    /** Whether the program itself drove a keyboard row low on CIA 1 port A. */
    this.rowSelectedByProgram = false;
    this.reset();
  }

  reset() {
    // Power-on RAM pattern: alternating blocks of $00 and $ff, like the real thing.
    for (let i = 0; i < this.ram.length; i++) {
      this.ram[i] = i & 0x40 ? 0xff : 0x00;
    }
    this.colorRam.fill(0);

    // Both 6510 port registers start as inputs, so the pull-ups select the
    // BASIC + KERNAL + I/O configuration the reset vector needs.
    this.portDirection = 0x00;
    this.portData = 0x00;
    this.updateBanking();

    this.vic.reset();
    this.cia1.reset();
    this.cia2.reset();
    this.sid.reset();
    this.keyboard.reset();
    this.datasette.rewind();
    this.nmiLine = false;
    this.cycleCarry = 0;
    this.joystickPolls = [0, 0, 0];
    this.rowSelectedByProgram = false;
    this.cpu.reset();
  }

  // ---------------------------------------------------------------- banking

  updateBanking() {
    // Undriven lines read high, which is why a reset lands in mode 7.
    const bits = (this.portData & this.portDirection) | (~this.portDirection & 0x07);
    this.loram = (bits & 0x01) !== 0;
    this.hiram = (bits & 0x02) !== 0;
    this.charen = (bits & 0x04) !== 0;

    this.basicVisible = this.loram && this.hiram;
    this.kernalVisible = this.hiram;
    this.ioVisible = this.charen && (this.loram || this.hiram);
    this.charVisible = !this.charen && (this.loram || this.hiram);

    // Port bit 5 drives the cassette motor, and drives it low to run.
    this.datasette.setMotor((this.portDirection & 0x20) !== 0 && (this.portData & 0x20) === 0);
  }

  read(addr) {
    if (addr < 0x0002) {
      if (addr === 0) return this.portDirection;
      // Bits 4/6/7 are inputs. Bit 4 is the datasette's button switch, which
      // reads low while a button is down; the others float high.
      const sense = this.datasette.senseClosed ? 0x00 : 0x10;
      return (this.portData & this.portDirection) | (sense & ~this.portDirection);
    }
    if (addr < 0xa000) return this.ram[addr];
    if (addr < 0xc000) return this.basicVisible ? this.basic[addr - 0xa000] : this.ram[addr];
    if (addr < 0xd000) return this.ram[addr];
    if (addr < 0xe000) {
      if (this.charVisible) return this.chargen[addr - 0xd000];
      if (!this.ioVisible) return this.ram[addr];
      return this.readIO(addr);
    }
    return this.kernalVisible ? this.kernal[addr - 0xe000] : this.ram[addr];
  }

  write(addr, value) {
    if (addr < 0x0002) {
      if (addr === 0) this.portDirection = value;
      else this.portData = value;
      this.updateBanking();
      this.ram[addr] = value;
      // Port bit 3 is the cassette write line; the datasette times its edges.
      this.datasette.writeEdge((this.portData & this.portDirection & 0x08) !== 0, this.cycles);
      return;
    }
    if (addr >= 0xd000 && addr < 0xe000 && this.ioVisible) {
      this.writeIO(addr, value);
      return;
    }
    // Writes always land in RAM, even where a ROM is currently visible.
    this.ram[addr] = value;
  }

  readIO(addr) {
    if (addr < 0xd400) return this.vic.read(addr & 0x3f);
    if (addr < 0xd800) return this.sid.read(addr & 0x1f);
    // Colour RAM is four bits wide. On real hardware the top nibble comes from
    // whatever the VIC last put on the bus, but software reads these cells as
    // plain colour numbers, so returning the nibble alone is what works.
    if (addr < 0xdc00) return this.colorRam[addr & 0x3ff] & 0x0f;
    if (addr < 0xdd00) {
      // Note which joystick port a game keeps looking at. Nothing on a tape says
      // which one it expects, so the only way to know is to watch it ask.
      // Port B carries joystick 1 and the keyboard columns both, so a read only
      // counts as a joystick read when the program is not itself selecting a
      // keyboard row: a scan drives one port A line low first, a joystick read
      // takes port B as it finds it.
      const register = addr & 0x0f;
      if (register < 2 && this.cpu.pc < 0xc000 && !(register === 1 && this.rowSelectedByProgram)) {
        this.joystickPolls[register === 0 ? 2 : 1]++;
      }
      return this.cia1.read(register);
    }
    if (addr < 0xde00) return this.cia2.read(addr & 0x0f);
    return 0xff; // unexpanded cartridge port
  }

  writeIO(addr, value) {
    if (addr < 0xd400) this.vic.write(addr & 0x3f, value);
    else if (addr < 0xd800) this.sid.write(addr & 0x1f, value);
    else if (addr < 0xdc00) this.colorRam[addr & 0x3ff] = value & 0x0f;
    else if (addr < 0xdd00) {
      // Remember whether the row now selected on port A was chosen by the
      // program itself, which is what tells a keyboard scan from a joystick read.
      if ((addr & 0x0f) === 0) {
        this.rowSelectedByProgram = this.cpu.pc < 0xc000 && (value & 0xff) !== 0xff;
      }
      this.cia1.write(addr & 0x0f, value);
    } else if (addr < 0xde00) this.cia2.write(addr & 0x0f, value);
  }

  /** The VIC's own view of memory: 16K bank, with the character ROM overlaid. */
  vicRead(addr) {
    addr &= 0xffff;
    if ((addr & 0x7000) === 0x1000) return this.chargen[addr & 0x0fff];
    return this.ram[addr];
  }

  // ------------------------------------------------------------------ timing

  /** Runs exactly one PAL frame and leaves a finished picture in vic.framebuffer. */
  runFrame() {
    for (let line = 0; line < LINES_PER_FRAME; line++) {
      const stolen = this.vic.beginLine(line);
      this.runCycles(CYCLES_PER_LINE - stolen);
      // The cycles the VIC stole from the CPU still pass for everything else.
      if (stolen) this.tickDevices(stolen);
      this.sid.clock(CYCLES_PER_LINE);

      this.vic.renderLine(line);
      this.vic.endLine();
    }

    const seconds = FRAME_CYCLES / CLOCK_PAL;
    this.cia1.tickTOD(seconds);
    this.cia2.tickTOD(seconds);
    this.frameCount++;
  }

  runCycles(budget) {
    // Cycles overshot by the last instruction are paid back here.
    let remaining = budget - this.cycleCarry;
    while (remaining > 0) {
      const used = this.cpu.step();
      remaining -= used;
      this.tickDevices(used);
    }
    this.cycleCarry = -remaining;
  }

  /**
   * Everything that counts phi2. Driven one instruction at a time rather than
   * one raster line at a time, because reading a tape means measuring the gap
   * between pulses with a CIA timer, and a whole line is far too coarse.
   */
  tickDevices(cycles) {
    this.cycles += cycles;
    this.cia1.tick(cycles);
    this.cia2.tick(cycles);
    this.datasette.tick(cycles);
  }

  // -------------------------------------------------------- program loading

  /** Reads a byte of RAM directly, ignoring the current banking. */
  peek(addr) {
    return this.ram[addr & 0xffff];
  }

  poke(addr, value) {
    this.ram[addr & 0xffff] = value & 0xff;
  }

  pokeWord(addr, value) {
    this.poke(addr, value & 0xff);
    this.poke(addr + 1, (value >> 8) & 0xff);
  }

  peekWord(addr) {
    return this.peek(addr) | (this.peek(addr + 1) << 8);
  }

  /**
   * Copies a program into RAM the way LOAD would.
   * @param {Uint8Array} bytes the whole .prg, load address first
   * @param {boolean} relocate true = ",8" style load to the address in the file
   * @returns {{start:number, end:number}}
   */
  loadPRG(bytes, relocate = true) {
    const start = relocate ? bytes[0] | (bytes[1] << 8) : this.basicStart;
    const data = bytes.subarray(2);
    this.ram.set(data, start);
    const end = start + data.length;

    if (start === this.basicStart) this.fixBasicPointers(end);
    return { start, end };
  }

  get basicStart() {
    return this.peekWord(0x2b) || 0x0801;
  }

  /** Rewrites the BASIC start/variable pointers after a program is injected. */
  fixBasicPointers(end) {
    this.pokeWord(0x2d, end); // start of variables
    this.pokeWord(0x2f, end); // start of arrays
    this.pokeWord(0x31, end); // end of arrays
    this.pokeWord(0xae, end); // end of last load
  }

  /** Feeds text into the KERNAL keyboard buffer, exactly as if it were typed. */
  typeIntoBuffer(petscii) {
    const max = 10;
    const count = Math.min(petscii.length, max);
    for (let i = 0; i < count; i++) this.poke(0x0277 + i, petscii[i]);
    this.poke(0xc6, count); // number of characters in the buffer
    return count;
  }
}
