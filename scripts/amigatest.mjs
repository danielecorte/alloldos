#!/usr/bin/env node
// Headless tests for the Amiga: the 68000 first, then the MFM the disk
// hardware reads, then the whole machine with a hand-written ROM in it.
//
// There is no Kickstart here to boot — it cannot be distributed and is not in
// the repository — so the machine is checked the other way round: small 68000
// programs are assembled by hand, put in a ROM, and run against the real chips
// until a picture comes out. Run with `node scripts/amigatest.mjs`.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CPU68000 } from '../src/systems/amiga/cpu68000.js';
import { Amiga, CHIP_RAM_SIZE } from '../src/systems/amiga/machine.js';
import {
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  FIRST_VISIBLE_LINE,
  FIRST_VISIBLE_X,
} from '../src/systems/amiga/denise.js';

/**
 * Where a raster line starts in the framebuffer. Every line gets two rows,
 * because an interlaced screen puts a different field on each of them.
 */
const rowOf = (line) => (line - FIRST_VISIBLE_LINE) * 2 * SCREEN_WIDTH;
import {
  encodeTrack,
  decodeTrack,
  applySectors,
  SECTORS_PER_TRACK,
  BYTES_PER_SECTOR,
  ADF_SIZE,
  MFM_TRACK_LENGTH,
  SYNC,
  volumeName,
} from '../src/systems/amiga/adf.js';
import { romVersion } from '../src/systems/amiga/roms.js';
import { makeDisk, readFile, checkDisk } from './ofs.mjs';
import { AUTOCONFIG_BASE } from '../src/systems/amiga/autoconfig.js';

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

function section(title) {
  console.log(`\n${title}\n${'-'.repeat(title.length)}`);
}

const hex = (value, width = 8) => `$${(value >>> 0).toString(16).padStart(width, '0')}`;

// --------------------------------------------------------------- a flat bus

/** 1 MB of RAM and nothing else, for exercising the CPU on its own. */
class FlatBus {
  constructor() {
    this.memory = new Uint8Array(0x100000);
    this.view = new DataView(this.memory.buffer);
  }
  read8(addr) {
    return this.memory[addr & 0xfffff];
  }
  read16(addr) {
    return this.view.getUint16(addr & 0xffffe, false);
  }
  read32(addr) {
    // Even but unaligned long accesses are ordinary on a 68000, so this must
    // not round the address down to a multiple of four.
    return this.view.getUint32(addr & 0xffffe, false) >>> 0;
  }
  write8(addr, value) {
    this.memory[addr & 0xfffff] = value;
  }
  write16(addr, value) {
    this.view.setUint16(addr & 0xffffe, value & 0xffff, false);
  }
  write32(addr, value) {
    this.view.setUint32(addr & 0xffffe, value >>> 0, false);
  }
}

const PROGRAM = 0x1000;

/**
 * Assembles nothing: the words are given as they are. Loads them at $1000,
 * points the CPU at them and runs.
 * @param {number[]} words
 * @param {number} steps how many instructions to run
 * @param {(cpu:CPU68000, bus:FlatBus)=>void} [setup]
 */
function run(words, steps, setup) {
  const bus = new FlatBus();
  const cpu = new CPU68000(bus);
  cpu.a[7] = 0x4000;
  cpu.ssp = 0x4000;
  cpu.pc = PROGRAM;
  for (let i = 0; i < words.length; i++) bus.write16(PROGRAM + i * 2, words[i]);
  setup?.(cpu, bus);
  for (let i = 0; i < steps; i++) cpu.step();
  return { cpu, bus };
}

// ------------------------------------------------------------------- the CPU

section('68000');

{
  // MOVEQ sign-extends its byte into the whole register, and says so in N.
  const { cpu } = run([0x7eff], 1); // moveq #-1,d7
  check('MOVEQ sign-extends', cpu.d[7] === 0xffffffff, hex(cpu.d[7]));
  check('and sets N', cpu.n === true && cpu.z === false);
}

{
  // add.l d1,d0 with the carry coming out of the top
  const { cpu } = run([0xd081], 1, (c) => {
    c.d[0] = 0xffffffff;
    c.d[1] = 1;
  });
  check('ADD.L wraps to zero', cpu.d[0] === 0, hex(cpu.d[0]));
  check('and carries out', cpu.c === true && cpu.z === true && cpu.x === true);
}

{
  // add.w: $7fff + 1 is the classic signed overflow
  const { cpu } = run([0xd041], 1, (c) => {
    c.d[0] = 0x00007fff;
    c.d[1] = 1;
  });
  check('ADD.W overflows into V', cpu.v === true && cpu.n === true && cpu.c === false);
  check('and leaves the high word alone', (cpu.d[0] & 0xffff) === 0x8000, hex(cpu.d[0]));
}

{
  // sub.b, and the borrow it produces
  const { cpu } = run([0x9001], 1, (c) => {
    c.d[0] = 0x00000010;
    c.d[1] = 0x00000020;
  });
  check('SUB.B borrows', (cpu.d[0] & 0xff) === 0xf0 && cpu.c === true, hex(cpu.d[0]));
}

{
  // A 64-bit add, which is what ADDX is for: add.l then addx.l
  const words = [0xd282, 0xd101]; // add.l d2,d1 ; addx.l d1,d0  (see below)
  const { cpu } = run(words, 2, (c) => {
    c.d[0] = 0x00000000; // high word of the destination
    c.d[1] = 0xffffffff; // low word
    c.d[2] = 0x00000001;
    c.d[3] = 0;
  });
  check('ADD.L into the low half carried', cpu.d[1] === 0, hex(cpu.d[1]));
  check('and ADDX brought it up', cpu.d[0] === 1, hex(cpu.d[0]));
}

{
  // cmp.l compares without writing, and orders signed values properly
  const { cpu } = run([0xb081], 1, (c) => {
    c.d[0] = 0xfffffffe; // -2
    c.d[1] = 0x00000001;
  });
  check('CMP leaves the register alone', cpu.d[0] === 0xfffffffe);
  check('CMP of -2 against 1 is negative', cpu.n === true && cpu.v === false);
}

{
  // (a0)+ and -(a1), byte at a time
  const words = [0x12d8, 0x12d8]; // move.b (a0)+,(a1)+  twice
  const { cpu, bus } = run(words, 2, (c, b) => {
    c.a[0] = 0x2000;
    c.a[1] = 0x3000;
    b.write8(0x2000, 0x41);
    b.write8(0x2001, 0x42);
  });
  check('postincrement copied two bytes', bus.read8(0x3000) === 0x41 && bus.read8(0x3001) === 0x42);
  check('and moved both pointers', cpu.a[0] === 0x2002 && cpu.a[1] === 0x3002);
}

{
  // A7 always moves in twos, even for a byte
  const { cpu } = run([0x1f00], 1, (c) => {
    c.a[7] = 0x4000;
    c.d[0] = 0x12;
  });
  check('a byte pushed on the stack still moves it two', cpu.a[7] === 0x3ffe, hex(cpu.a[7]));
}

{
  // d16(An) and d8(An,Dn)
  const words = [0x3028, 0x0004, 0x3030, 0x0002]; // move.w 4(a0),d0 ; move.w 2(a0,d0.w),d0
  const { cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write16(0x2004, 0x1234);
  });
  check('displacement addressing', (cpu.d[0] & 0xffff) === 0x1234, hex(cpu.d[0]));
}

{
  // The indexed mode, with a sign-extended word index
  const words = [0x3030, 0x1002]; // move.w 2(a0,d1.w),d0
  const { cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    c.d[1] = 0xffff0004; // the high half must be ignored
    b.write16(0x2006, 0xbeef);
  });
  check('indexed addressing uses the word index', (cpu.d[0] & 0xffff) === 0xbeef, hex(cpu.d[0]));
}

{
  // movem saves and restores a register set through -(sp) and (sp)+
  const words = [0x48e7, 0xc000, 0x4cdf, 0x0003]; // movem.l d0-d1,-(sp) ; movem.l (sp)+,d0-d1
  const { cpu } = run(words, 1, (c) => {
    c.d[0] = 0x11111111;
    c.d[1] = 0x22222222;
  });
  check('MOVEM pushed two longs', cpu.a[7] === 0x3ff8, hex(cpu.a[7]));
  const after = run(words, 2, (c) => {
    c.d[0] = 0x11111111;
    c.d[1] = 0x22222222;
  });
  check(
    'and got them back in the right order',
    after.cpu.d[0] === 0x11111111 && after.cpu.d[1] === 0x22222222,
    `${hex(after.cpu.d[0])} ${hex(after.cpu.d[1])}`,
  );
  check('with the stack where it started', after.cpu.a[7] === 0x4000);
}

{
  // dbra counts a loop down to -1 and falls out
  const words = [0x5340, 0x51c9, 0xfffc]; // subq.w #1,d0 ; dbra d1,-4
  const { cpu } = run(words, 21, (c) => {
    c.d[1] = 9; // ten times round
  });
  check('DBRA went round ten times', (cpu.d[0] & 0xffff) === 0xfff6, hex(cpu.d[0] & 0xffff, 4));
  check('and left the counter at -1', (cpu.d[1] & 0xffff) === 0xffff);
}

{
  // bsr and rts
  const words = [0x6100, 0x0004, 0x4e71, 0x7001, 0x4e75]; // bsr .sub ; nop ; .sub moveq #1,d0 ; rts
  const { cpu } = run(words, 3, () => {});
  check('BSR and RTS came back', cpu.d[0] === 1 && cpu.pc === PROGRAM + 4, hex(cpu.pc));
}

{
  // muls of two negative words
  const { cpu } = run([0xc1c1], 1, (c) => {
    c.d[0] = 0x0000fffe; // -2
    c.d[1] = 0x0000fffb; // -5
  });
  check('MULS multiplies signed', cpu.d[0] === 10, hex(cpu.d[0]));
}

{
  // divu, and the remainder it puts in the top half
  const { cpu } = run([0x80c1], 1, (c) => {
    c.d[0] = 100;
    c.d[1] = 7;
  });
  check('DIVU quotient', (cpu.d[0] & 0xffff) === 14, String(cpu.d[0] & 0xffff));
  check('DIVU remainder', (cpu.d[0] >>> 16) === 2, String(cpu.d[0] >>> 16));
}

{
  // A divide by zero is an exception, not a wrong answer
  const { cpu, bus } = run([0x80c1], 1, (c, b) => {
    c.d[0] = 100;
    c.d[1] = 0;
    b.write32(5 * 4, 0x8000); // the vector
  });
  check('divide by zero traps', cpu.pc === 0x8000, hex(cpu.pc));
  check('and leaves the dividend alone', cpu.d[0] === 100);
  void bus;
}

{
  // asl.l #1 with the sign changing sets V, which nothing else does
  const { cpu } = run([0xe380], 1, (c) => {
    c.d[0] = 0x40000000;
  });
  check('ASL.L shifted', cpu.d[0] === 0x80000000, hex(cpu.d[0]));
  check('and noticed the sign change', cpu.v === true);
}

{
  // lsr.w #4 brings the bottom nibble out through the carry
  const { cpu } = run([0xe848], 1, (c) => {
    c.d[0] = 0x0000ffff;
  });
  check('LSR.W', (cpu.d[0] & 0xffff) === 0x0fff, hex(cpu.d[0], 4));
  check('with the last bit out in C', cpu.c === true);
}

{
  // roxl.w rotates through the X bit, which is what makes it chainable
  const { cpu } = run([0xe350], 1, (c) => {
    c.d[0] = 0x00008000;
    c.x = false;
  });
  check('ROXL.W put X in at the bottom', (cpu.d[0] & 0xffff) === 0x0000, hex(cpu.d[0], 4));
  check('and the top bit out into X', cpu.x === true && cpu.c === true);
}

{
  // bset on memory works a byte at a time
  const words = [0x08d0, 0x0003]; // bset #3,(a0)
  const { bus, cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write8(0x2000, 0x01);
  });
  check('BSET set the bit', bus.read8(0x2000) === 0x09, hex(bus.read8(0x2000), 2));
  check('and Z said it had been clear', cpu.z === true);
}

{
  // swap and ext
  const words = [0x4840, 0x4880]; // swap d0 ; ext.w d0
  const { cpu } = run(words, 1, (c) => {
    c.d[0] = 0x12345678;
  });
  check('SWAP', cpu.d[0] === 0x56781234, hex(cpu.d[0]));
  const extended = run([0x48c0], 1, (c) => {
    c.d[0] = 0x000000ff;
  });
  check('EXT.L sign-extends a word', extended.cpu.d[0] === 0x000000ff, hex(extended.cpu.d[0]));
  const byteExt = run([0x4880], 1, (c) => {
    c.d[0] = 0x000000ff;
  });
  check('EXT.W sign-extends a byte', (byteExt.cpu.d[0] & 0xffff) === 0xffff);
}

{
  // exg swaps a data register with an address register
  const { cpu } = run([0xc38a], 1, (c) => {
    c.d[1] = 0x11111111;
    c.a[2] = 0x22222222;
  });
  check('EXG Dn,An', cpu.d[1] === 0x22222222 && cpu.a[2] === 0x11111111);
}

{
  // abcd adds two packed decimals and carries at ten, not sixteen
  const { cpu } = run([0xc101], 1, (c) => {
    c.d[0] = 0x28;
    c.d[1] = 0x14;
    c.x = false;
  });
  check('ABCD 28 + 14 = 42', (cpu.d[0] & 0xff) === 0x42, hex(cpu.d[0], 2));
  const carried = run([0xc101], 1, (c) => {
    c.d[0] = 0x99;
    c.d[1] = 0x01;
    c.x = false;
  });
  check('and carries past 99', (carried.cpu.d[0] & 0xff) === 0x00 && carried.cpu.c === true);
}

{
  // scc writes all ones or all zeroes, which is the whole point of it
  const { cpu } = run([0x57c0], 1, (c) => {
    c.z = true;
  });
  check('SEQ with Z set writes $ff', (cpu.d[0] & 0xff) === 0xff);
}

{
  // link and unlk build and take down a stack frame
  const words = [0x4e56, 0xfff0, 0x4e5e]; // link a6,#-16 ; unlk a6
  const { cpu } = run(words, 1, (c) => {
    c.a[6] = 0x12345678;
  });
  check('LINK made room', cpu.a[7] === 0x3fec, hex(cpu.a[7]));
  const undone = run(words, 2, (c) => {
    c.a[6] = 0x12345678;
  });
  check('UNLK put it all back', undone.cpu.a[7] === 0x4000 && undone.cpu.a[6] === 0x12345678);
}

{
  // trap #0 goes through vector 32 and rte comes back
  const words = [0x4e40, 0x7042]; // trap #0 ; moveq #$42,d0
  const { cpu, bus } = run(words, 1, (c, b) => {
    b.write32(32 * 4, 0x8000);
    b.write16(0x8000, 0x4e73); // rte
  });
  check('TRAP #0 took vector 32', cpu.pc === 0x8000, hex(cpu.pc));
  check('and pushed SR and PC', bus.read32(cpu.a[7] + 2) === PROGRAM + 2, hex(bus.read32(cpu.a[7] + 2)));

  const returned = run(words, 3, (c, b) => {
    b.write32(32 * 4, 0x8000);
    b.write16(0x8000, 0x4e73);
  });
  check('RTE came back and carried on', returned.cpu.d[0] === 0x42, hex(returned.cpu.d[0]));
}

{
  // A user-mode program may not touch the status register
  const words = [0x46fc, 0x2700]; // move #$2700,sr
  const { cpu } = run(words, 1, (c, b) => {
    c.setSR(0x0000); // out of supervisor mode
    c.a[7] = 0x5000; // a user stack
    c.ssp = 0x4000;
    b.write32(8 * 4, 0x9000);
  });
  check('a privileged instruction traps in user mode', cpu.pc === 0x9000, hex(cpu.pc));
  check('and the trap runs in supervisor mode', cpu.supervisor === true);
  check('on the supervisor stack', cpu.a[7] === 0x4000 - 6, hex(cpu.a[7]));
}

{
  // movep, which spreads a register over every other byte — the shape of a
  // peripheral that only ever answers on half the data bus
  const words = [0x0188, 0x0000, 0x0108, 0x0000]; // movep.w d0,0(a0) ; movep.w 0(a0),d0
  const { cpu, bus } = run(words, 1, (c) => {
    c.a[0] = 0x2000;
    c.d[0] = 0x1234;
  });
  check('MOVEP writes every other byte', bus.read8(0x2000) === 0x12 && bus.read8(0x2002) === 0x34);
  check('and nothing in between', bus.read8(0x2001) === 0);
  const back = run(words, 2, (c) => {
    c.a[0] = 0x2000;
    c.d[0] = 0x1234;
  });
  check('and reads them back the same way', (back.cpu.d[0] & 0xffff) === 0x1234, hex(back.cpu.d[0], 4));
  void cpu;
}

{
  // cmpm, the instruction a string comparison is built out of
  const words = [0xb508]; // cmpm.b (a0)+,(a2)+
  const { cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    c.a[2] = 0x2100;
    b.write8(0x2000, 0x41);
    b.write8(0x2100, 0x41);
  });
  check('CMPM finds two equal bytes equal', cpu.z === true);
  check('and moves both pointers on', cpu.a[0] === 0x2001 && cpu.a[2] === 0x2101);
}

{
  // A shift straight through memory, which is only ever one bit and one word
  const words = [0xe0d0]; // asr.w (a0)
  const { bus, cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write16(0x2000, 0x8002);
  });
  check('ASR on memory keeps the sign', bus.read16(0x2000) === 0xc001, hex(bus.read16(0x2000), 4));
  check('and reports it', cpu.n === true && cpu.c === false);
}

{
  // tas: read, test, and set the top bit — the 68000's one atomic instruction
  const words = [0x4ad0]; // tas (a0)
  const { bus, cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write8(0x2000, 0x00);
  });
  check('TAS says the byte was zero', cpu.z === true);
  check('and sets its top bit anyway', bus.read8(0x2000) === 0x80);
}

{
  // negx, which is how a multi-word negation carries its borrow along
  const words = [0x4040]; // negx.w d0
  const { cpu } = run(words, 1, (c) => {
    c.d[0] = 0x00000001;
    c.x = true;
    c.z = true;
  });
  check('NEGX takes the extend bit with it', (cpu.d[0] & 0xffff) === 0xfffe, hex(cpu.d[0], 4));
  check('and only ever clears Z', cpu.z === false);
}

{
  // Scc into memory, and a conditional that is false
  const words = [0x56d0]; // sne (a0)
  const { bus } = run(words, 1, (c) => {
    c.a[0] = 0x2000;
    c.z = true;
  });
  check('SNE with Z set writes zero', bus.read8(0x2000) === 0x00);
}

{
  // movem (a0)+,regs — the load half, which sign-extends words into longs
  const words = [0x4c98, 0x0005]; // movem.w (a0)+,d0/d2
  const { cpu } = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write16(0x2000, 0xffff);
    b.write16(0x2002, 0x0001);
  });
  check('MOVEM.W sign-extends what it loads', cpu.d[0] === 0xffffffff, hex(cpu.d[0]));
  check('into the registers the mask named', cpu.d[2] === 1 && cpu.a[0] === 0x2004);
}

{
  // lea with an index, which is how a compiler reaches into an array
  const words = [0x43f0, 0x0808]; // lea 8(a0,d0.w),a1
  const { cpu } = run(words, 1, (c) => {
    c.a[0] = 0x2000;
    c.d[0] = 0x10;
  });
  check('LEA computes without touching memory', cpu.a[1] === 0x2018, hex(cpu.a[1]));
}

{
  // chk, which is a bounds check with a trap on the end of it
  const words = [0x4180, 0x4e71]; // chk d0,d0 — against itself, so it passes
  const { cpu } = run(words, 1, (c, b) => {
    c.d[0] = 0x0005;
    b.write32(6 * 4, 0xd000);
  });
  check('CHK inside its bounds does nothing', cpu.pc === PROGRAM + 2, hex(cpu.pc));
  const failed = run([0x4181], 1, (c, b) => {
    c.d[0] = 0x0010;
    c.d[1] = 0x0005;
    b.write32(6 * 4, 0xd000);
  });
  check('and outside them it traps', failed.cpu.pc === 0xd000, hex(failed.cpu.pc));
}

{
  // A bit number on a data register runs the full 32, not just 8
  const words = [0x0840, 0x001f]; // bchg #31,d0
  const { cpu } = run(words, 1, (c) => {
    c.d[0] = 0x00000000;
  });
  check('BCHG on a register reaches bit 31', cpu.d[0] === 0x80000000, hex(cpu.d[0]));
  const inMemory = run([0x0850, 0x0009], 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write8(0x2000, 0x00);
  });
  check('but on memory it wraps into a byte', inMemory.bus.read8(0x2000) === 0x02, hex(inMemory.bus.read8(0x2000), 2));
}

{
  // ror.b, and the bit that comes round the back
  const { cpu } = run([0xe218], 1, (c) => {
    c.d[0] = 0x00000001;
  });
  check('ROR.B brings the bottom bit round to the top', (cpu.d[0] & 0xff) === 0x80, hex(cpu.d[0], 2));
  check('and shows it in C', cpu.c === true);
}

{
  // not, clr and tst on memory
  const words = [0x4650, 0x4250, 0x4a50]; // not.w (a0) ; clr.w (a0) ; tst.w (a0)
  const first = run(words, 1, (c, b) => {
    c.a[0] = 0x2000;
    b.write16(0x2000, 0x0f0f);
  });
  check('NOT inverts', first.bus.read16(0x2000) === 0xf0f0, hex(first.bus.read16(0x2000), 4));
  const cleared = run(words, 3, (c, b) => {
    c.a[0] = 0x2000;
    b.write16(0x2000, 0x0f0f);
  });
  check('CLR clears and TST agrees', cleared.bus.read16(0x2000) === 0 && cleared.cpu.z === true);
}

{
  // suba.w sign-extends before it subtracts, and touches no flags at all
  const words = [0x90fc, 0xffff]; // suba.w #-1,a0
  const { cpu } = run(words, 1, (c) => {
    c.a[0] = 0x1000;
    c.z = true;
  });
  check('SUBA.W sign-extends its operand', cpu.a[0] === 0x1001, hex(cpu.a[0]));
  check('and leaves the flags alone', cpu.z === true);
}

{
  // The status register, read out and put back through the condition codes
  const words = [0x40c0, 0x44c0]; // move sr,d0 ; move d0,ccr
  const { cpu } = run(words, 1, (c) => {
    c.setSR(0x2704);
  });
  check('MOVE from SR is not privileged on a 68000', (cpu.d[0] & 0xffff) === 0x2704, hex(cpu.d[0], 4));
  const restored = run(words, 2, (c) => {
    c.setSR(0x2700);
    c.z = true;
  });
  check('and MOVE to CCR puts the flags back', restored.cpu.z === true);
}

{
  // A word read from an odd address is an address error on a 68000
  const words = [0x3039, 0x0000, 0x2001]; // move.w $2001,d0
  const { cpu, bus } = run(words, 1, (c, b) => {
    b.write32(3 * 4, 0xa000);
  });
  check('an odd word address is an address error', cpu.pc === 0xa000, hex(cpu.pc));
  check('with the long frame the 68000 pushes', bus.read32(cpu.a[7] + 2) === 0x2001, hex(bus.read32(cpu.a[7] + 2)));
}

{
  // An interrupt is taken between instructions, through its autovector
  const words = [0x4e71, 0x4e71]; // nop ; nop
  const { cpu } = run(words, 1, (c, b) => {
    c.setSR(0x2000); // supervisor, interrupts unmasked
    b.write32((24 + 3) * 4, 0xb000);
    c.setInterruptLevel(3);
  });
  check('a level 3 interrupt goes through vector 27', cpu.pc === 0xb000, hex(cpu.pc));
  check('and masks its own level out', cpu.interruptMask === 3);

  const masked = run(words, 1, (c) => {
    c.setSR(0x2700); // all levels masked
    c.setInterruptLevel(3);
  });
  check('a masked interrupt waits its turn', masked.cpu.pc === PROGRAM + 2, hex(masked.cpu.pc));
}

{
  // STOP parks the CPU until something interrupts it
  const words = [0x4e72, 0x2000, 0x7001]; // stop #$2000 ; moveq #1,d0
  const { cpu } = run(words, 4, () => {});
  check('STOP stops', cpu.stopped === true && cpu.d[0] === 0);
  const woken = run(words, 4, (c, b) => {
    b.write32((24 + 2) * 4, 0xc000);
    setTimeout(() => {}, 0);
    c.pendingWake = true;
  });
  woken.cpu.setInterruptLevel(2);
  woken.cpu.step();
  check('and an interrupt wakes it', woken.cpu.stopped === false && woken.cpu.pc === 0xc000);
}

{
  // The stack pointer really is two registers wearing one name
  const { cpu } = run([0x4e71], 0, (c) => {
    c.setSR(0x2000);
    c.a[7] = 0x4000;
  });
  cpu.setSR(0x0000); // to user mode
  cpu.a[7] = 0x9000;
  cpu.setSR(0x2000); // and back
  check('the supervisor stack survived a trip to user mode', cpu.a[7] === 0x4000, hex(cpu.a[7]));
  cpu.setSR(0x0000);
  check('and so did the user one', cpu.a[7] === 0x9000, hex(cpu.a[7]));
}

// ------------------------------------------------------------------ the MFM

section('MFM e immagini .adf');

{
  // A disk full of a recognisable pattern, encoded and read back the way
  // trackdisk.device reads it: find a sync, decode odd and even halves, check
  // the checksums. If this works, the format is right.
  const image = new Uint8Array(ADF_SIZE);
  for (let i = 0; i < image.length; i++) image[i] = (i * 7 + (i >> 9)) & 0xff;

  const track = encodeTrack(image, 3);
  check('a track is a whole revolution long', track.length === MFM_TRACK_LENGTH);

  let syncs = 0;
  for (let i = 0; i < track.length - 1; i += 2) {
    if (((track[i] << 8) | track[i + 1]) === SYNC) syncs++;
  }
  check('with two sync words per sector', syncs === SECTORS_PER_TRACK * 2, `${syncs} sync`);

  const readLong = (at) =>
    ((track[at % track.length] << 24) |
      (track[(at + 1) % track.length] << 16) |
      (track[(at + 2) % track.length] << 8) |
      track[(at + 3) % track.length]) >>>
    0;

  let decoded = 0;
  let badHeader = 0;
  let badData = 0;
  let wrongBytes = 0;

  for (let sector = 0; sector < SECTORS_PER_TRACK; sector++) {
    const at = sector * 1088 + 8; // just past the two sync words
    const info = (((readLong(at) & 0x55555555) << 1) | (readLong(at + 4) & 0x55555555)) >>> 0;
    const headerChecksum = (readLong(at + 40) ^ readLong(at + 44)) & 0x55555555;
    let computed = 0;
    for (let i = 0; i < 10; i++) computed ^= readLong(at + i * 4);
    if ((computed & 0x55555555) !== headerChecksum) badHeader++;

    const dataAt = at + 56;
    let dataChecksum = 0;
    for (let i = 0; i < 256; i++) dataChecksum ^= readLong(dataAt + i * 4);
    const storedData = (readLong(at + 48) ^ readLong(at + 52)) & 0x55555555;
    if ((dataChecksum & 0x55555555) !== storedData) badData++;

    const number = (info >>> 8) & 0xff;
    if (number !== sector) continue;
    decoded++;

    const source = (3 * SECTORS_PER_TRACK + sector) * BYTES_PER_SECTOR;
    for (let i = 0; i < 128; i++) {
      const odd = readLong(dataAt + i * 4) & 0x55555555;
      const even = readLong(dataAt + 512 + i * 4) & 0x55555555;
      const value = (((odd << 1) >>> 0) | even) >>> 0;
      const expected =
        ((image[source + i * 4] << 24) |
          (image[source + i * 4 + 1] << 16) |
          (image[source + i * 4 + 2] << 8) |
          image[source + i * 4 + 3]) >>>
        0;
      if (value !== expected) wrongBytes++;
    }
  }

  check('every sector announces its own number', decoded === SECTORS_PER_TRACK, `${decoded}/11`);
  check('every header checksum agrees', badHeader === 0, `${badHeader} sbagliati`);
  check('every data checksum agrees', badData === 0, `${badData} sbagliati`);
  check('and the data comes back byte for byte', wrongBytes === 0, `${wrongBytes} long diversi`);

  // Nothing in the encoded stream may accidentally look like a sync word.
  let strays = 0;
  for (let sector = 0; sector < SECTORS_PER_TRACK; sector++) {
    for (let i = 8; i < 1088; i += 2) {
      const at = sector * 1088 + i;
      if (((track[at] << 8) | track[at + 1]) === SYNC) strays++;
    }
  }
  check('and nothing else in the track can be mistaken for one', strays === 0, `${strays} falsi sync`);
}

{
  // The volume name AmigaDOS keeps in the root block
  const image = new Uint8Array(ADF_SIZE);
  const root = 880 * BYTES_PER_SECTOR;
  const name = 'Workbench1.3';
  image[root + 432] = name.length;
  for (let i = 0; i < name.length; i++) image[root + 433 + i] = name.charCodeAt(i);
  check('the volume name is read out of the root block', volumeName(image) === name, volumeName(image));
}

{
  // The way back: MFM the machine wrote, read as sectors again.
  //
  // This is the whole of saving a game. What comes off the machine is a bit
  // stream that says nothing about where it belongs — the sector headers in it
  // do, and they are what puts each 512 bytes back in the right place in the
  // image.
  const image = new Uint8Array(ADF_SIZE);
  for (let i = 0; i < image.length; i++) image[i] = (i * 11 + (i >> 7)) & 0xff;

  const sectors = decodeTrack(encodeTrack(image, 7));
  check('a written track gives back all eleven sectors', sectors.length === SECTORS_PER_TRACK, `${sectors.length}`);
  check('all of them from the track they were written to', sectors.every((s) => s.track === 7));
  check('numbered nought to ten', sectors.map((s) => s.sector).join() === '0,1,2,3,4,5,6,7,8,9,10');
  check(
    'and holding the bytes that went in',
    sectors.every((s) => {
      const source = (s.track * SECTORS_PER_TRACK + s.sector) * BYTES_PER_SECTOR;
      return s.data.every((byte, i) => byte === image[source + i]);
    }),
  );

  // Put them into an empty image and it is the disk again.
  const copy = new Uint8Array(ADF_SIZE);
  const touched = applySectors(copy, sectors);
  const from = 7 * SECTORS_PER_TRACK * BYTES_PER_SECTOR;
  const size = SECTORS_PER_TRACK * BYTES_PER_SECTOR;
  check('putting them back rebuilds the track exactly', copy.subarray(from, from + size).every((b, i) => b === image[from + i]));
  check('and says which track changed', touched.size === 1 && touched.has(7));

  // A stream that starts three bits off a byte boundary is still readable, and
  // has to be: a loader that syncs on $4891 leaves every word shifted.
  const track = encodeTrack(image, 7);
  const shifted = new Uint8Array(track.length + 1);
  for (let i = 0; i < track.length; i++) {
    shifted[i] |= track[i] >> 3;
    shifted[i + 1] = (track[i] << 5) & 0xff;
  }
  check('a stream shifted off the byte boundary decodes too', decodeTrack(shifted).length === SECTORS_PER_TRACK);

  // One flipped bit in the data, and the sector is thrown away rather than
  // written back over something good.
  const damaged = encodeTrack(image, 7);
  damaged[1088 * 3 + 700] ^= 0x40; // a data bit of sector 3
  const survivors = decodeTrack(damaged);
  check('a sector with a bad checksum is dropped', survivors.length === SECTORS_PER_TRACK - 1, `${survivors.length}`);
  check('and it is the damaged one that is missing', !survivors.some((s) => s.sector === 3));

  // Nothing in a track of gap bytes, and nothing said about it either.
  check('gap bytes decode to nothing at all', decodeTrack(new Uint8Array(MFM_TRACK_LENGTH).fill(0xaa)).length === 0);
}

// -------------------------------------------------------------- the machine

section('La macchina intera');

/**
 * Builds a 256 KB ROM out of instruction words, with the reset vectors the
 * 68000 goes looking for at power-on in front of them.
 */
function buildROM(words) {
  const rom = new Uint8Array(262144);
  const view = new DataView(rom.buffer);
  view.setUint32(0, CHIP_RAM_SIZE, false); // initial stack pointer, top of chip RAM
  // The 68000's address bus is 24 bits wide, so the ROM's own address is
  // $00fc0000 and not $fc000000 — a long with anything in its top byte would
  // send the machine somewhere else entirely.
  view.setUint32(4, 0x00fc0008, false); // and the first instruction
  for (let i = 0; i < words.length; i++) view.setUint16(8 + i * 2, words[i], false);
  return rom;
}

/** move.w #value,$dffxxx */
const moveWordToCustom = (value, register) => [0x33fc, value, 0x00df, 0xf000 | register];
/** move.l #value,$dffxxx */
const moveLongToCustom = (value, register) => [
  0x23fc,
  (value >>> 16) & 0xffff,
  value & 0xffff,
  0x00df,
  0xf000 | register,
];

const forever = [0x60fe]; // bra to itself

{
  // One bitplane of solid ones, a standard display window, and the DMA on.
  const program = [
    ...moveWordToCustom(0x2c81, 0x08e), // DIWSTRT
    ...moveWordToCustom(0x2cc1, 0x090), // DIWSTOP: 256 PAL lines
    ...moveWordToCustom(0x0038, 0x092), // DDFSTRT
    ...moveWordToCustom(0x00d0, 0x094), // DDFSTOP
    ...moveLongToCustom(0x00020000, 0x0e0), // BPL1PT = $20000
    ...moveWordToCustom(0x0000, 0x108), // BPL1MOD
    ...moveWordToCustom(0x1200, 0x100), // BPLCON0: one plane, colour on
    ...moveWordToCustom(0x0000, 0x180), // COLOR00 black
    ...moveWordToCustom(0x0fff, 0x182), // COLOR01 white
    ...moveWordToCustom(0x8380, 0x096), // DMACON: master, bitplanes, copper
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  for (let i = 0x20000; i < 0x20000 + 0x8000; i += 2) amiga.poke16(i, 0xffff);

  amiga.runFrame();
  amiga.runFrame();

  const white = 0xffffffff;
  const framebuffer = amiga.denise.framebuffer;
  const row = rowOf(100);
  let lit = 0;
  for (let x = 0; x < SCREEN_WIDTH; x++) if (framebuffer[row + x] === white) lit++;

  check('the ROM ran and turned the display on', amiga.denise.planeCount === 1);
  check('bitplane DMA drew a line', lit > 600, `${lit} pixel bianchi`);

  // The window starts at lores 129, which is where the border has to stop.
  const left = 129 * 2 - FIRST_VISIBLE_X;
  check(
    'and it starts where the display window says',
    framebuffer[row + left - 4] !== white && framebuffer[row + left + 4] === white,
    `bordo a ${left}`,
  );

  const above = rowOf(30);
  check(
    'with nothing above the top of the window',
    framebuffer[above + left + 4] !== white,
  );
}

{
  // A copper list that changes the background colour twice down the screen.
  const COPPER = 0x00030000;
  const program = [
    ...moveWordToCustom(0x2c81, 0x08e),
    ...moveWordToCustom(0x2cc1, 0x090),
    ...moveWordToCustom(0x0000, 0x180),
    ...moveLongToCustom(COPPER, 0x080), // COP1LC
    ...moveWordToCustom(0x0000, 0x088), // COPJMP1: start it now
    ...moveWordToCustom(0x8280, 0x096), // DMACON: master and copper
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  const list = [
    0x0180, 0x0000, // COLOR00 = black, at the top of every frame
    0x3c07, 0xfffe, // wait for line $3c
    0x0180, 0x0f00, // COLOR00 = red
    0x9607, 0xfffe, // wait for line $96
    0x0180, 0x00f0, // COLOR00 = green
    0xffff, 0xfffe, // and stop
  ];
  list.forEach((word, i) => amiga.poke16(COPPER + i * 2, word));

  amiga.runFrame();
  amiga.runFrame();

  const framebuffer = amiga.denise.framebuffer;
  const at = (line) => framebuffer[rowOf(line) + 300];
  const red = 0xff0000ff;
  const green = 0xff00ff00;

  check('the copper ran without any bitplanes', amiga.agnus.copperPC !== 0);
  check('black above its first wait', at(0x30) === 0xff000000, hex(at(0x30)));
  check('red after it', at(0x50) === red, hex(at(0x50)));
  check('and green after the second', at(0xa0) === green, hex(at(0xa0)));
}

{
  // Halfway across a line, not at the start of it: the copper's own trick.
  const COPPER = 0x00030000;
  const program = [
    ...moveWordToCustom(0x0000, 0x180),
    ...moveLongToCustom(COPPER, 0x080),
    ...moveWordToCustom(0x0000, 0x088),
    ...moveWordToCustom(0x8280, 0x096),
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  const list = [
    0x0180, 0x0000, // COLOR00 = black to start with
    0x6461, 0xfffe, // wait for line $64, colour clock $60
    0x0180, 0x0f0f, // COLOR00 = magenta
    0xffff, 0xfffe,
  ];
  list.forEach((word, i) => amiga.poke16(COPPER + i * 2, word));
  amiga.runFrame();
  amiga.runFrame();

  const row = rowOf(0x64);
  const framebuffer = amiga.denise.framebuffer;
  const magenta = 0xffff00ff;
  const split = 0x60 * 4 - FIRST_VISIBLE_X;
  check(
    'a mid-line copper move changes the colour mid-line',
    framebuffer[row + split - 20] === 0xff000000 && framebuffer[row + split + 20] === magenta,
    `taglio a ${split}`,
  );
}

{
  // The blitter, doing the one thing it does most: copying a rectangle.
  const SOURCE = 0x00010000;
  const DEST = 0x00020000;
  const program = [
    ...moveWordToCustom(0x8240, 0x096), // DMACON: master and blitter
    ...moveWordToCustom(0x09f0, 0x040), // BLTCON0: use A and D, minterm $f0 (D = A)
    ...moveWordToCustom(0x0000, 0x042), // BLTCON1
    ...moveWordToCustom(0xffff, 0x044), // BLTAFWM
    ...moveWordToCustom(0xffff, 0x046), // BLTALWM
    ...moveWordToCustom(0x0000, 0x064), // BLTAMOD
    ...moveWordToCustom(0x0000, 0x066), // BLTDMOD
    ...moveLongToCustom(SOURCE, 0x050), // BLTAPT
    ...moveLongToCustom(DEST, 0x054), // BLTDPT
    ...moveWordToCustom((4 << 6) | 2, 0x058), // BLTSIZE: four rows of two words
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  for (let i = 0; i < 8; i++) amiga.poke16(SOURCE + i * 2, 0x1000 + i);
  amiga.runFrame();

  let copied = 0;
  for (let i = 0; i < 8; i++) if (amiga.peek16(DEST + i * 2) === 0x1000 + i) copied++;
  check('the blitter copied its rectangle', copied === 8, `${copied}/8 word`);
  check('and said it was finished', (amiga.paula.intreq & 0x0040) !== 0);
  check('with the zero flag clear, because it was not', amiga.blitter.zero === false);
}

{
  // The same blitter, masking and shifting — which is what makes it able to
  // put a rectangle down anywhere rather than only on word boundaries.
  const SOURCE = 0x00010000;
  const DEST = 0x00020000;
  const program = [
    ...moveWordToCustom(0x8240, 0x096),
    ...moveWordToCustom(0x49f0, 0x040), // shift A right four, use A and D, D = A
    ...moveWordToCustom(0x0000, 0x042),
    ...moveWordToCustom(0xffff, 0x044),
    ...moveWordToCustom(0xffff, 0x046),
    ...moveWordToCustom(0x0000, 0x064),
    ...moveWordToCustom(0x0000, 0x066),
    ...moveLongToCustom(SOURCE, 0x050),
    ...moveLongToCustom(DEST, 0x054),
    ...moveWordToCustom((1 << 6) | 2, 0x058), // one row, two words
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  amiga.poke16(SOURCE, 0xf000);
  amiga.poke16(SOURCE + 2, 0x000f);
  amiga.runFrame();
  check(
    'a shifted blit carries bits into the next word',
    amiga.peek16(DEST) === 0x0f00 && amiga.peek16(DEST + 2) === 0x0000,
    `${hex(amiga.peek16(DEST), 4)} ${hex(amiga.peek16(DEST + 2), 4)}`,
  );
}

{
  // Sprite 0: the mouse pointer's own piece of hardware.
  const SPRITE = 0x00030000;
  const program = [
    ...moveWordToCustom(0x2c81, 0x08e),
    ...moveWordToCustom(0x2cc1, 0x090),
    ...moveWordToCustom(0x0000, 0x180), // COLOR00 black
    ...moveWordToCustom(0x0f00, 0x1a2), // COLOR17: sprite 0, colour 1
    ...moveLongToCustom(SPRITE, 0x120), // SPR0PT
    ...moveWordToCustom(0x8220, 0x096), // DMACON: master and sprites
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  // Starts on line $50 at lores 320 — SPRxPOS holds all but the bottom bit of
  // the horizontal position — and is four lines tall.
  amiga.poke16(SPRITE, 0x50a0);
  amiga.poke16(SPRITE + 2, 0x5400);
  for (let line = 0; line < 4; line++) {
    amiga.poke16(SPRITE + 4 + line * 4, 0xffff);
    amiga.poke16(SPRITE + 6 + line * 4, 0x0000);
  }
  amiga.poke16(SPRITE + 20, 0x0000);
  amiga.poke16(SPRITE + 22, 0x0000);

  // One frame only: nothing here rewrites SPR0PT, and on real hardware the
  // sprite pointers are reloaded by the copper at the top of every frame.
  amiga.runFrame();

  const framebuffer = amiga.denise.framebuffer;
  const at = (line, lores) => framebuffer[rowOf(line) + lores * 2 - FIRST_VISIBLE_X];
  const red = 0xff0000ff;
  check('the sprite is on the lines it asked for', at(0x51, 322) === red, hex(at(0x51, 322)));
  check('and not above them', at(0x4e, 322) !== red);
  check('and not below them', at(0x56, 322) !== red);
  check('and not to the left of them', at(0x51, 300) !== red);
  check('and it stops after sixteen pixels', at(0x51, 340) !== red);
}

/**
 * Picks a drive and turns its motor on, the way trackdisk.device does before it
 * touches the DMA at all: everything is deselected first, because the motor is
 * latched on the edge where a drive becomes selected.
 */
function selectDrive(amiga, unit, motorOn = true) {
  // The lines go high before they are made outputs, or the drive takes a step
  // the moment the port wakes up: a port full of zeroes is /STEP held low.
  amiga.write8(0xbfd100, 0xff);
  amiga.write8(0xbfd300, 0xff); // CIA-B port B: all outputs
  amiga.write8(0xbfd100, 0xff); // nothing selected, motor line high
  let value = 0xff & ~(unit === 0 ? 0x08 : 0x10);
  if (motorOn) value &= ~0x80;
  amiga.write8(0xbfd100, value & 0xff);
}

{
  // The whole disk path, driven the way trackdisk drives it: select the drive
  // through CIA-B, look at the status pins through CIA-A, then let the DMA run.
  const amiga = new Amiga(buildROM([...forever]));
  const image = new Uint8Array(ADF_SIZE);
  image[0] = 0x44; // 'D'
  image[1] = 0x4f; // 'O'
  image[2] = 0x53; // 'S'
  for (let i = 0; i < 512; i++) image[i + 4] = (i * 3) & 0xff;
  amiga.drives[0].insert(image, 'prova');

  const CIAA_PRA = 0xbfe001;
  const CIAB_PRB = 0xbfd100;
  // /STEP and /SEL0 are active low, and the direction line is high to step
  // outward, towards track 0.
  const IDLE = 0x7f; // nothing selected, motor line high
  const SELECTED = 0x75; // /SEL0 low, /STEP high, direction inward
  const selectAndMotor = (motorOn) => {
    amiga.write8(CIAB_PRB, IDLE | 0x80); // deselect, so the latch can see the edge
    amiga.write8(CIAB_PRB, (motorOn ? 0x00 : 0x80) | SELECTED);
  };
  const step = (outward) => {
    const base = SELECTED | (outward ? 0x02 : 0x00);
    amiga.write8(CIAB_PRB, base & ~0x01); // the pulse
    amiga.write8(CIAB_PRB, base);
  };

  // Port B is driven high before it is made an output, which is the order that
  // keeps the drive from stepping the moment the machine wakes up.
  amiga.write8(CIAB_PRB, 0xff);
  amiga.write8(0xbfd300, 0xff); // CIA-B port B is all outputs
  selectAndMotor(false);
  check('with the motor off the drive is "ready", which is its identity', (amiga.read8(CIAA_PRA) & 0x20) === 0);

  selectAndMotor(true);
  check('with a disk in and the motor on it is ready for real', (amiga.read8(CIAA_PRA) & 0x20) === 0);
  check('and the disk goes in unprotected, which is what lets a game save', (amiga.read8(CIAA_PRA) & 0x08) !== 0);
  check('and the head is at track zero', (amiga.read8(CIAA_PRA) & 0x10) === 0);

  // Two steps inwards, which is where cylinder 1 and 2 are.
  step(false);
  step(false);
  check('two steps inward reach cylinder 2', amiga.drives[0].cylinder === 2, `cilindro ${amiga.drives[0].cylinder}`);
  check('so track zero stops answering', (amiga.read8(CIAA_PRA) & 0x10) !== 0);
  check('and the disk-changed line has cleared', (amiga.read8(CIAA_PRA) & 0x04) !== 0);

  // Back out to track 0 the way a driver finds it: step until the pin says so.
  for (let i = 0; i < 90 && (amiga.read8(CIAA_PRA) & 0x10) !== 0; i++) step(true);
  check('stepping outward finds track zero again', amiga.drives[0].cylinder === 0);

  // Now read a track: word sync on, DMA on, DSKLEN written twice.
  amiga.write16(0xdff09e, 0x8400); // ADKCON: WORDSYNC
  amiga.write16(0xdff07e, 0x4489); // DSKSYNC
  amiga.write16(0xdff096, 0x8210); // DMACON: master and disk
  amiga.write32(0xdff020, 0x00040000); // DSKPT
  amiga.write16(0xdff024, 0x9900); // DSKLEN: $1900 words, DMA on
  amiga.write16(0xdff024, 0x9900); // twice, as the hardware insists

  // The sync goes past at once, because the head is already over the track.
  // The data behind it does not: the drive has to turn.
  check('the sync interrupt fired straight away', (amiga.paula.intreq & 0x1000) !== 0);
  check('but the transfer has not finished yet', (amiga.paula.intreq & 0x0002) === 0);
  check('and nothing has landed in memory', amiga.peek16(0x00040000) === 0);

  // This is what a game's own trackloader does between arming the DMA and
  // watching for it: clear the interrupt still standing from the last read. It
  // only works if the transfer is genuinely still under way.
  amiga.write16(0xdff09c, 0x0002); // INTREQ: clear DSKBLK

  // $1900 words at two words a scan line is 3200 lines, which is a bit over ten
  // frames — one revolution of the drive, near enough.
  let frames = 0;
  while (frames < 40 && (amiga.paula.intreq & 0x0002) === 0) {
    amiga.runFrame();
    frames++;
    if (frames === 1) {
      check(
        'a frame in, some of it has arrived and the rest has not',
        amiga.peek16(0x00040000) !== 0 && amiga.diskDMA.transferring,
      );
    }
  }
  check('the disk interrupt fired when the transfer ended', (amiga.paula.intreq & 0x0002) !== 0);
  check('after about a revolution of the drive', frames === 11, `${frames} quadri`);
  check('and the drive is idle again', amiga.diskDMA.transferring === false);

  // Now read the buffer the way trackdisk.device does: find a sync word, and
  // take the two longs after the last of them as the sector's header. Its top
  // byte is $ff, then the track, the sector, and how many are left to the gap.
  let at = 0x00040000;
  const end = at + 0x1900 * 2;
  while (at < end && amiga.peek16(at) !== 0x4489) at += 2;
  while (at < end && amiga.peek16(at) === 0x4489) at += 2;
  const header =
    (((amiga.peek32(at) & 0x55555555) << 1) | (amiga.peek32(at + 4) & 0x55555555)) >>> 0;
  check('the DMA brought back sync words', at < end, `sync a ${hex(at)}`);
  check('the header behind one is a header', (header >>> 24) === 0xff, hex(header));
  check('for track zero', ((header >>> 16) & 0xff) === 0, hex(header));
  check('with a sector number that makes sense', ((header >>> 8) & 0xff) < 11, hex(header));
  check(
    'and eleven of them came back in one go',
    (() => {
      let syncs = 0;
      for (let i = 0x00040000; i < end; i += 2) if (amiga.peek16(i) === 0x4489) syncs++;
      return syncs >= 22;
    })(),
  );

  amiga.drives[0].eject();
  selectAndMotor(true);
  check('an empty drive is never ready', (amiga.read8(CIAA_PRA) & 0x20) !== 0);
}

{
  // Saving a game: a track written out, and where it ends up.
  //
  // trackdisk.device writes whole tracks — it reads one, changes the sectors it
  // wants, and writes all eleven back — so this is that, done through the DMA
  // with the write bit in DSKLEN set. What has to come out the far end is an
  // image with the new bytes in it and nothing else touched.
  const amiga = new Amiga(buildROM([...forever]));
  const image = new Uint8Array(ADF_SIZE);
  for (let i = 0; i < image.length; i++) image[i] = (i * 5) & 0xff;
  amiga.drives[0].insert(image, 'prova');
  selectDrive(amiga, 0);

  // What the machine means to leave on track 0: sector 5, rewritten.
  const wanted = image.slice();
  const sector5 = 5 * BYTES_PER_SECTOR;
  for (let i = 0; i < BYTES_PER_SECTOR; i++) wanted[sector5 + i] = (0xa5 + i) & 0xff;

  const mfm = encodeTrack(wanted, 0);
  const words = mfm.length / 2;
  const buffer = 0x00030000;
  for (let i = 0; i < words; i++) amiga.poke16(buffer + i * 2, (mfm[i * 2] << 8) | mfm[i * 2 + 1]);

  amiga.write16(0xdff096, 0x8210); // DMACON: master and disk
  amiga.write32(0xdff020, buffer); // DSKPT
  amiga.write16(0xdff024, 0xc000 | words); // DSKLEN: DMA on, WRITE, a whole track
  amiga.write16(0xdff024, 0xc000 | words);
  check('a write transfer starts', amiga.diskDMA.transferring && amiga.diskDMA.writing);
  check('and nothing has reached the disk yet', amiga.drives[0].writeCount === 0);

  let frames = 0;
  while (frames < 40 && amiga.diskDMA.transferring) {
    amiga.runFrame();
    frames++;
  }
  check('the track takes about a revolution to write', frames === 11, `${frames} quadri`);
  check('the disk interrupt fired at the end of it', (amiga.paula.intreq & 0x0002) !== 0);
  check('and the drive counted one write', amiga.drives[0].writeCount === 1);
  check('the disk knows it has been written to', amiga.drives[0].modified === true);
  check('in a format it recognised', amiga.drives[0].foreignWrites === 0);
  check(
    'the sector that changed is in the image',
    amiga.drives[0].image.subarray(sector5, sector5 + BYTES_PER_SECTOR).every((b, i) => b === wanted[sector5 + i]),
  );
  check(
    'and every other sector of the disk is untouched',
    amiga.drives[0].image.every((b, i) => b === (i >= sector5 && i < sector5 + BYTES_PER_SECTOR ? wanted[i] : image[i])),
  );

  // Reading it back now has to see the new bytes: the encoded copy of the track
  // the drive was holding is no longer the track.
  const reread = amiga.drives[0].currentTrack();
  const back = decodeTrack(reread).find((s) => s.sector === 5);
  check('and the head reads back what was written, not what was there', back !== undefined && back.data.every((b, i) => b === wanted[sector5 + i]));

  // Now the tab, across. The transfer still happens — the drive has no idea —
  // but nothing of it reaches the disk.
  amiga.drives[0].writeProtected = true;
  const before = amiga.drives[0].image.slice();
  for (let i = 0; i < BYTES_PER_SECTOR; i++) wanted[sector5 + i] = 0x11;
  const second = encodeTrack(wanted, 0);
  for (let i = 0; i < words; i++) amiga.poke16(buffer + i * 2, (second[i * 2] << 8) | second[i * 2 + 1]);
  amiga.write32(0xdff020, buffer);
  amiga.write16(0xdff024, 0xc000 | words);
  amiga.write16(0xdff024, 0xc000 | words);
  for (let i = 0; i < 40 && amiga.diskDMA.transferring; i++) amiga.runFrame();
  check('a protected disk still takes the transfer', amiga.diskDMA.transferring === false);
  check('but keeps every byte it had', amiga.drives[0].image.every((b, i) => b === before[i]));
  check('and counts no write', amiga.drives[0].writeCount === 1);

  // A reset is not an eject: the machine forgets everything, the disk does not.
  amiga.reset();
  check('a reset leaves the disk in the drive', amiga.drives[0].inserted);
  check('with the writes still in it', amiga.drives[0].modified && amiga.drives[0].image.every((b, i) => b === before[i]));
}

{
  // Saving a program, all the way through.
  //
  // Everything above is about sectors. This is about a file: an AmigaDOS disk
  // with a BASIC program on it, the program made longer the way saving over it
  // would, and the whole track written back through the DMA. What comes out has
  // to be a disk whose filesystem still adds up and whose file is the new one —
  // which is the difference between "the sectors changed" and "it saved".
  const text = (bytes) => new TextDecoder().decode(bytes);
  const first = '10 PRINT "CIAO"\n20 END\n';
  const second = '10 PRINT "CIAO, MONDO!"\n20 PRINT "SALVATO SU DF0:"\n30 END\n';
  const disk = makeDisk({ name: 'Ciao', files: [{ name: 'Ciao.bas', data: first }] });
  const saved = makeDisk({ name: 'Ciao', files: [{ name: 'Ciao.bas', data: second }] });

  const amiga = new Amiga(buildROM([...forever]));
  amiga.drives[0].insert(disk, 'ciao');
  selectDrive(amiga, 0);
  check('the disk we made says what it is called', amiga.drives[0].label === 'Ciao', amiga.drives[0].label);
  check('and has the program on it', text(readFile(amiga.drives[0].image, 'Ciao.bas')) === first);

  // Blocks 880 to 890 are one track: the root, the bitmap, the file's header
  // and its data all sit on it, which is why saving a small file is one write.
  const TRACK = 80;
  amiga.drives[0].cylinder = TRACK >> 1;
  amiga.drives[0].head = TRACK & 1;
  const mfm = encodeTrack(saved, TRACK);
  const words = mfm.length / 2;
  const buffer = 0x00030000;
  for (let i = 0; i < words; i++) amiga.poke16(buffer + i * 2, (mfm[i * 2] << 8) | mfm[i * 2 + 1]);
  amiga.write16(0xdff096, 0x8210);
  amiga.write32(0xdff020, buffer);
  amiga.write16(0xdff024, 0xc000 | words);
  amiga.write16(0xdff024, 0xc000 | words);
  for (let i = 0; i < 40 && amiga.diskDMA.transferring; i++) amiga.runFrame();

  check('the track went onto the disk', amiga.drives[0].writeCount === 1 && amiga.drives[0].modified);
  check('the filesystem still adds up', checkDisk(amiga.drives[0].image).length === 0, `${checkDisk(amiga.drives[0].image)}`);
  check('the volume is still called Ciao', amiga.drives[0].label === 'Ciao');
  check(
    'and the program on it is the one that was saved',
    text(readFile(amiga.drives[0].image, 'Ciao.bas')) === second,
    text(readFile(amiga.drives[0].image, 'Ciao.bas') ?? new Uint8Array()).split('\n')[0],
  );

  // And it is on the disk, not just in the image we happen to be holding: the
  // head reads it back out of the MFM the drive is turning.
  amiga.drives[0].track = null;
  const back = decodeTrack(amiga.drives[0].currentTrack());
  const data = back.find((sector) => sector.sector === 3); // block 883, the file's data
  check('and the head reads it back off the track', text(data.data.subarray(24, 24 + second.length)) === second);
}

{
  // DF1:, the second drive.
  //
  // One motor line, one set of four status pins and one DMA channel, shared by
  // both drives: everything that tells them apart is the select line. So this
  // is really a test about who is listening — that the pins answer for the
  // selected drive and nobody else, that a step moves one head and not the
  // other, and that the DMA reads and writes the disk that was selected when
  // it started rather than the one that happens to be first.
  const amiga = new Amiga(buildROM([...forever]));
  const CIAA_PRA = 0xbfe001;

  const inDF0 = new Uint8Array(ADF_SIZE);
  const inDF1 = new Uint8Array(ADF_SIZE);
  for (let i = 0; i < ADF_SIZE; i++) {
    inDF0[i] = (i * 3) & 0xff;
    inDF1[i] = (0xff - i * 3) & 0xff;
  }
  amiga.drives[0].insert(inDF0, 'uno');
  amiga.drives[1].insert(inDF1, 'due');
  check('the machine has two drives', amiga.drives.length === 2);
  check('and they know which is which', amiga.drives[0].title === 'DF0:' && amiga.drives[1].title === 'DF1:');

  selectDrive(amiga, 0);
  check('selecting DF0: leaves DF1: alone', amiga.drives[0].selected && !amiga.drives[1].selected);
  check('and DF0: with a disk in it is ready', (amiga.read8(CIAA_PRA) & 0x20) === 0);

  selectDrive(amiga, 1);
  check('selecting DF1: makes DF0: let go', !amiga.drives[0].selected && amiga.drives[1].selected);
  check('and now it is DF1: answering the pins', (amiga.read8(CIAA_PRA) & 0x20) === 0);

  // An empty DF1: says so on the same four wires DF0: was using a moment ago.
  amiga.drives[1].eject();
  check('an empty selected drive is never ready', (amiga.read8(CIAA_PRA) & 0x20) !== 0);
  amiga.drives[1].insert(inDF1, 'due');

  // Two steps inward, with DF1: selected: only its head moves.
  const step = (unit) => {
    const base = 0xff & ~(unit === 0 ? 0x08 : 0x10) & ~0x80;
    amiga.write8(0xbfd100, base & ~0x02); // direction: inward
    amiga.write8(0xbfd100, base & ~0x02 & ~0x01); // /STEP down
    amiga.write8(0xbfd100, base & ~0x02); // and up again
  };
  step(1);
  step(1);
  check('two steps move the selected head', amiga.drives[1].cylinder === 2, `DF1: al cilindro ${amiga.drives[1].cylinder}`);
  check('and leave the other one where it was', amiga.drives[0].cylinder === 0);
  check('so track zero answers for DF0: and not for DF1:', (amiga.read8(CIAA_PRA) & 0x10) !== 0);

  // Reading, with DF1: selected: what lands in memory is DF1:'s disk.
  const buffer = 0x00040000;
  const words = 0x1900;
  amiga.write16(0xdff09e, 0x8400); // ADKCON: WORDSYNC
  amiga.write16(0xdff07e, 0x4489); // DSKSYNC
  amiga.write16(0xdff096, 0x8210); // DMACON: master and disk
  amiga.write32(0xdff020, buffer);
  amiga.write16(0xdff024, 0x8000 | words);
  amiga.write16(0xdff024, 0x8000 | words);
  for (let i = 0; i < 40 && amiga.diskDMA.transferring; i++) amiga.runFrame();

  const got = new Uint8Array(words * 2);
  for (let i = 0; i < got.length; i += 2) {
    const word = amiga.peek16(buffer + i);
    got[i] = (word >> 8) & 0xff;
    got[i + 1] = word & 0xff;
  }
  const read = decodeTrack(got);
  check('the DMA brought back whole sectors', read.length > 0, `${read.length} settori`);
  check('from the cylinder DF1:\'s head is on', read.every((sector) => sector.track === 4), `traccia ${read[0]?.track}`);
  check(
    'and they are the disk in DF1:, not the one in DF0:',
    read.every((sector) => {
      const source = (sector.track * SECTORS_PER_TRACK + sector.sector) * BYTES_PER_SECTOR;
      return sector.data.every((byte, i) => byte === inDF1[source + i]);
    }),
  );

  // Writing, with DF1: still selected: it lands on DF1: and nowhere else.
  const wanted = inDF1.slice();
  const sector0 = 4 * SECTORS_PER_TRACK * BYTES_PER_SECTOR;
  for (let i = 0; i < BYTES_PER_SECTOR; i++) wanted[sector0 + i] = (0x5a + i) & 0xff;
  const mfm = encodeTrack(wanted, 4);
  const trackWords = mfm.length / 2;
  for (let i = 0; i < trackWords; i++) amiga.poke16(buffer + i * 2, (mfm[i * 2] << 8) | mfm[i * 2 + 1]);
  amiga.write32(0xdff020, buffer);
  amiga.write16(0xdff024, 0xc000 | trackWords);
  amiga.write16(0xdff024, 0xc000 | trackWords);
  for (let i = 0; i < 40 && amiga.diskDMA.transferring; i++) amiga.runFrame();

  check('the write went to DF1:', amiga.drives[1].writeCount === 1 && amiga.drives[1].modified);
  check('and DF0: never noticed', amiga.drives[0].writeCount === 0 && amiga.drives[0].modified === false);
  check(
    'the sector changed on the disk in DF1:',
    amiga.drives[1].image.subarray(sector0, sector0 + BYTES_PER_SECTOR).every((b, i) => b === wanted[sector0 + i]),
  );
  check('and the disk in DF0: is byte for byte what it was', amiga.drives[0].image.every((b, i) => b === inDF0[i]));

  // The motor is latched when a drive is selected, so it keeps turning after
  // the select line goes away: that is how one wire runs two motors.
  check('DF0:\'s motor is still running from when it was picked', amiga.drives[0].motor === true);
  selectDrive(amiga, 0, false);
  check('and stops when it is selected again with the motor line high', amiga.drives[0].motor === false);
  check('while DF1: keeps turning', amiga.drives[1].motor === true);
}

{
  // Sync happens at a bit, not at a word.
  //
  // A loader that wants its data on a different boundary than AmigaDOS put it
  // asks to sync on $4891, which is the ordinary $4489 seen three bits early.
  // The hardware finds it because the head shifts the stream along one bit at a
  // time; every word after it then arrives shifted to match, and the loader
  // knows that and undoes it. Looking only at whole words would find nothing at
  // all, and the read would never even start.
  const image = new Uint8Array(ADF_SIZE);
  for (let i = 0; i < BYTES_PER_SECTOR * 2; i++) image[i] = (i * 7) & 0xff;
  const track = encodeTrack(image, 0);

  // The stream, read by hand, so the drive has something to be checked against.
  const bitAt = (bit) => (track[(bit >> 3) % MFM_TRACK_LENGTH] >> (7 - (bit & 7))) & 1;
  const wordAtBit = (bit) => {
    let word = 0;
    for (let i = 0; i < 16; i++) word = ((word << 1) | bitAt(bit + i)) & 0xffff;
    return word;
  };

  let firstOddSync = -1;
  for (let bit = 0; bit < MFM_TRACK_LENGTH * 8 && firstOddSync < 0; bit++) {
    if (wordAtBit(bit) === 0x4891) firstOddSync = bit;
  }
  check('the odd sync is really in a perfectly ordinary track', firstOddSync === 29, `bit ${firstOddSync}`);
  check('and it is the usual one, three bits early', wordAtBit(firstOddSync + 3) === SYNC);

  const amiga = new Amiga(buildROM([...forever]));
  amiga.drives[0].insert(image, 'prova');
  selectDrive(amiga, 0);
  amiga.write16(0xdff09e, 0x8400); // ADKCON: WORDSYNC
  amiga.write16(0xdff07e, 0x4891); // DSKSYNC: the odd one
  amiga.write16(0xdff096, 0x8210); // DMACON: master and disk
  amiga.write32(0xdff020, 0x00050000); // DSKPT
  amiga.write16(0xdff024, 0x8010); // DSKLEN: 16 words
  amiga.write16(0xdff024, 0x8010);

  check('the drive found it and started reading', amiga.diskDMA.transferring);
  let frames = 0;
  while (frames < 10 && amiga.diskDMA.transferring) {
    amiga.runFrame();
    frames++;
  }
  check('and the read finished', (amiga.paula.intreq & 0x0002) !== 0);

  // What landed is the stream from just past the sync, shifted bits and all.
  let same = true;
  for (let i = 0; i < 16; i++) {
    if (amiga.peek16(0x00050000 + i * 2) !== wordAtBit(firstOddSync + 16 + i * 16)) same = false;
  }
  check('and every word of it came off the right bit', same, hex(amiga.peek16(0x00050000), 4));

  // The same track, asked for the ordinary way, still lands where it always did.
  const plain = new Amiga(buildROM([...forever]));
  plain.drives[0].insert(image, 'prova');
  selectDrive(plain, 0);
  plain.write8(0xbfd100, 0xff);
  plain.write8(0xbfd100, 0x75);
  plain.write16(0xdff09e, 0x8400);
  plain.write16(0xdff07e, 0x4489);
  plain.write16(0xdff096, 0x8210);
  plain.write32(0xdff020, 0x00050000);
  plain.write16(0xdff024, 0x8010);
  plain.write16(0xdff024, 0x8010);
  for (let i = 0; i < 10 && plain.diskDMA.transferring; i++) plain.runFrame();
  check('and a plain $4489 read is still word aligned', plain.peek16(0x00050000) === SYNC, hex(plain.peek16(0x00050000), 4));
}

{
  // Interrupts: the vertical blank is what drives the whole machine, so it had
  // better arrive once a frame and reach the CPU at level 3.
  const VECTOR = 0x00040000;
  const program = [
    // The ROM is still lying over the bottom of memory, where the vectors go:
    // driving CIA-A's port A bit 0 low is what moves it out of the way.
    0x13fc, 0x0003, 0x00bf, 0xe201, // move.b #3,$bfe201  (DDRA: two outputs)
    0x13fc, 0x0002, 0x00bf, 0xe001, // move.b #2,$bfe001  (OVL low, LED off)
    0x46fc, 0x2000, // move #$2000,sr — supervisor, and interrupts let in
    ...moveWordToCustom(0xc020, 0x09a), // INTENA: master and VERTB
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program));
  // The vector table is in chip RAM at the bottom, where exec puts it.
  amiga.poke16((24 + 3) * 4, (VECTOR >>> 16) & 0xffff);
  amiga.poke16((24 + 3) * 4 + 2, VECTOR & 0xffff);
  // The handler counts, clears the interrupt and returns — an interrupt that
  // is never cleared would simply be taken again the moment RTE ran.
  amiga.poke16(VECTOR, 0x5278); // addq.w #1,$0100.w
  amiga.poke16(VECTOR + 2, 0x0100);
  amiga.poke16(VECTOR + 4, 0x33fc); // move.w #$0020,$dff09c
  amiga.poke16(VECTOR + 6, 0x0020);
  amiga.poke16(VECTOR + 8, 0x00df);
  amiga.poke16(VECTOR + 10, 0xf09c);
  amiga.poke16(VECTOR + 12, 0x4e73); // rte

  amiga.runFrame();
  check('the overlay came off, so RAM is at address zero', amiga.overlay === false);
  amiga.runFrame();
  amiga.runFrame();
  // Three: one for each of the two frames since, plus the one that was already
  // waiting from before the program got round to enabling interrupts at all.
  check('the vertical blank interrupt arrives once a frame', amiga.peek16(0x0100) === 3, `${amiga.peek16(0x0100)} volte`);
  check('and the beam counters went round', amiga.agnus.vpos === 311, `vpos ${amiga.agnus.vpos}`);
}

{
  // ColdReboot: the RESET instruction has to put the ROM back over address
  // zero, because `movea.l #2,a0; reset; jmp (a0)` is how every Amiga reboots
  // itself and $2 is only a jump into the ROM once the overlay is back on.
  const program = [
    0x13fc, 0x0003, 0x00bf, 0xe201, // move.b #3,$bfe201  (DDRA: two outputs)
    0x13fc, 0x0002, 0x00bf, 0xe001, // move.b #2,$bfe001  (OVL low: RAM at zero)
    0x33fc, 0xdead, 0x0000, 0x0100, // move.w #$dead,$0100 — something to survive
    0x4e70, // reset
    ...forever,
  ];
  const rom = buildROM(program);
  const amiga = new Amiga(rom);
  amiga.runFrame();

  check('the RESET instruction puts the ROM back over address zero', amiga.overlay === true);
  // On a real Kickstart the word at $2 is the $4ef9 of a JMP whose target is
  // the ROM's entry point, so `jmp (a0)` with a0 = 2 restarts the machine.
  check(
    'so reading $2 reads the ROM again, which is what ColdReboot jumps into',
    amiga.read16(2) === ((rom[2] << 8) | rom[3]),
    hex(amiga.read16(2)),
  );
  check('and RAM is left alone, so what a program parked there survives', amiga.peek16(0x0100) === 0xdead);
  check('no drive is selected any more', amiga.drives[0].selected === false);
}

{
  // The game port, which is where a joystick goes.
  //
  // The port was wired for a mouse, so what comes back is a pair of quadrature
  // counters and a stick has to be read out of them sideways. Every game does
  // it the same way: take the word, shift it right one, exclusive-or it with
  // itself, and up and down fall out at bits 0 and 8 — while left and right
  // were plain bits 9 and 1 all along. So this checks the arithmetic a game
  // actually does, not the bits we happened to set.
  const amiga = new Amiga(buildROM([...forever]));
  const keyboard = amiga.keyboard;
  keyboard.setJoystick(true);

  const stick = () => {
    const value = amiga.read16(0xdff00c);
    const crossed = (value ^ (value >> 1)) & 0xffff;
    return {
      right: (value & 0x0002) !== 0,
      left: (value & 0x0200) !== 0,
      up: (crossed & 0x0001) !== 0,
      down: (crossed & 0x0100) !== 0,
    };
  };
  const push = (code) => keyboard.handleKeyDown({ code });
  const release = (code) => keyboard.handleKeyUp({ code });
  const only = (...directions) => {
    const s = stick();
    for (const way of ['up', 'down', 'left', 'right']) {
      if (s[way] !== directions.includes(way)) return false;
    }
    return true;
  };

  check('a stick nobody is touching reads as centred', only());

  push('ArrowRight');
  check('pushed right, a game reads right', only('right'));
  push('ArrowUp');
  check('and a diagonal is both, not one or neither', only('up', 'right'));
  release('ArrowRight');
  check('letting go of one leaves the other', only('up'));
  release('ArrowUp');

  push('ArrowLeft');
  check('left is the other plain bit', only('left'));
  push('ArrowDown');
  check('and the other diagonal works too', only('down', 'left'));
  release('ArrowLeft');
  check('down on its own survives the crossing', only('down'));
  release('ArrowDown');
  check('and it centres again', only());

  // Fire is not in that word at all: it is a CIA pin, and it is active low.
  const CIAA_PRA = 0xbfe001;
  check('the fire button starts up', (amiga.read8(CIAA_PRA) & 0x80) !== 0);
  push('Space');
  check('and pulls its pin low when pressed', (amiga.read8(CIAA_PRA) & 0x80) === 0);
  check('without disturbing the mouse button next door', (amiga.read8(CIAA_PRA) & 0x40) !== 0);
  release('Space');
  check('and lets go again', (amiga.read8(CIAA_PRA) & 0x80) !== 0);

  // Unplugged, every one of those keys is its own key again — which is the
  // whole reason the stick has to be asked for.
  push('ArrowUp');
  keyboard.setJoystick(false);
  check('unplugging it centres the port', only());
  keyboard.queue.length = 0;
  check('and now the cursor keys reach the Amiga', keyboard.handleKeyDown({ code: 'ArrowUp' }) === true && keyboard.queue.length === 1);
  check('as themselves', keyboard.queue[0] === (~(0x4c << 1) & 0xff), String(keyboard.queue[0]));
}

{
  // The CIA time-of-day counters, which AmigaDOS turns into a clock.
  const amiga = new Amiga(buildROM([...forever]));
  for (let i = 0; i < 50; i++) amiga.runFrame();
  check('CIA-A counts one tick per frame', amiga.ciaa.tod === 50, `${amiga.ciaa.tod} tick`);
  check('and CIA-B one per line', amiga.ciab.tod > 15000, `${amiga.ciab.tod} tick`);
}

{
  // Paula: one channel of DMA-driven sound, playing a square wave out of chip
  // RAM. Nothing here listens to it, so the check is that samples come out at
  // the host's rate, that they are not silence, and that they are on the left.
  const SAMPLE = 0x00030000;
  const program = [
    ...moveLongToCustom(SAMPLE, 0x0a0), // AUD0LC
    ...moveWordToCustom(8, 0x0a4), // AUD0LEN: eight words
    ...moveWordToCustom(320, 0x0a6), // AUD0PER: about 11 kHz
    ...moveWordToCustom(64, 0x0a8), // AUD0VOL: as loud as it goes
    ...moveWordToCustom(0x8201, 0x096), // DMACON: master and audio channel 0
    ...forever,
  ];
  const amiga = new Amiga(buildROM(program), 44100);
  for (let i = 0; i < 8; i++) amiga.poke16(SAMPLE + i * 2, i < 4 ? 0x7f7f : 0x8181);

  for (let i = 0; i < 5; i++) amiga.runFrame();
  const samples = amiga.paula.drain(amiga.paula.pendingSamples);

  check('Paula produced samples', samples.length > 4000, `${samples.length >> 1} frame stereo`);
  let loudest = 0;
  let right = 0;
  for (let i = 0; i < samples.length; i += 2) {
    loudest = Math.max(loudest, Math.abs(samples[i]));
    right = Math.max(right, Math.abs(samples[i + 1]));
  }
  check('and they are not silence', loudest > 0.2, `picco ${loudest.toFixed(2)}`);
  check('with channel 0 on the left and nothing on the right', right === 0);
  check('and the end of the sample interrupted', (amiga.paula.intreq & 0x0080) !== 0);
}

{
  // The trapdoor expansion, which is not chip RAM and is not autoconfigured:
  // the ROM finds it by writing to it and reading it back.
  const amiga = new Amiga(buildROM([...forever]));

  // Chip RAM first, because where the top of it falls is what decides whether
  // a program that puts its screen up there has the place to itself. The ROM
  // is lying over the bottom of memory until OVL is driven low, so do that
  // first, exactly as the ROM does when it has finished with it.
  amiga.write8(0x00bfe201, 0x03); // DDRA: OVL and the LED are outputs
  amiga.write8(0x00bfe001, 0x02); // PRA: OVL low, and RAM appears
  amiga.write16(0x00000400, 0xf00d);
  amiga.write16(0x000ffffe, 0xd00d);
  check('the custom chips share a whole megabyte', CHIP_RAM_SIZE === 0x100000);
  check('and it answers all the way to the top', amiga.read16(0x000ffffe) === 0xd00d);
  check('which Agnus can reach too', amiga.chipRead(0x000ffffe) === 0xd00d);
  check('and the bottom of it is still there', amiga.read16(0x00000400) === 0xf00d);

  amiga.write32(0x00c00000, 0x12345678);
  amiga.write16(0x00c7fffe, 0xbeef);
  check('the A501 answers at $c00000', amiga.read32(0x00c00000) === 0x12345678, hex(amiga.read32(0x00c00000)));
  check('for its whole 512 KB', amiga.read16(0x00c7fffe) === 0xbeef);
  amiga.write16(0x00c80000, 0x1234);
  check('and nothing above it pretends to be memory', amiga.read16(0x00c80000) === 0xffff, hex(amiga.read16(0x00c80000), 4));
  check('nor does the empty middle of the map', amiga.read16(0x00300000) === 0xffff);
}

{
  // The card on the side expansion bus, which announces itself rather than
  // waiting to be probed. Reading a byte of the description means reading two
  // nibbles four bytes apart, and everything but er_Type is stored inverted.
  const amiga = new Amiga(buildROM([...forever]));
  const board = amiga.fast;
  const descriptionByte = (index) => {
    const high = amiga.read8(AUTOCONFIG_BASE + index * 4) & 0xf0;
    const low = (amiga.read8(AUTOCONFIG_BASE + index * 4 + 2) & 0xf0) >> 4;
    return high | low;
  };

  // er_Type: a Zorro II board (bits 7-6), whose memory belongs on the free
  // list (bit 5), of the largest size Zorro II has a code for (bits 2-0 = 0).
  check('the expansion card says what it is', descriptionByte(0) === 0xe0, hex(descriptionByte(0), 2));
  check('and who made it', ((~descriptionByte(4) & 0xff) << 8 | (~descriptionByte(5) & 0xff)) === 2011);
  check('and it is nowhere in the map yet', amiga.read16(0x00200000) === 0xffff);

  // Placing it: the top byte of the address goes to $48, and that is the write
  // that moves the board.
  amiga.write8(AUTOCONFIG_BASE + 0x4a, 0x00);
  amiga.write8(AUTOCONFIG_BASE + 0x48, 0x20);
  check('once told where to go, it is there', board.configured && board.base === 0x200000, hex(board.base));
  amiga.write32(0x00200000, 0xcafebabe);
  amiga.write16(0x009ffffe, 0x1234);
  check('and answers across its whole 8 MB', amiga.read32(0x00200000) === 0xcafebabe && amiga.read16(0x009ffffe) === 0x1234);
  check('but not past the end of it', amiga.read16(0x00a00000) === 0xffff);
  check('and it has stopped answering at $e80000, so the next card can be seen',
    amiga.read16(AUTOCONFIG_BASE) === 0xffff);

  // A reboot deconfigures the chain: that is why the system autoconfigures
  // again every time, and why what is in the RAM has to survive it.
  amiga.write32(0x00200004, 0x0d15ea5e);
  amiga.resetDevices();
  check('a RESET puts it back to announcing itself', board.configured === false);
  check('and what was in its RAM is still there', board.view.getUint32(4, false) === 0x0d15ea5e);
}

{
  // The second ROM socket. A real Kickstart is the whole system on its own and
  // leaves it empty; AROS keeps half of itself in there.
  const extended = new Uint8Array(524288);
  new DataView(extended.buffer).setUint32(0, 0x11144ef9, false);
  extended[0x100] = 0x5a;
  const withExt = new Amiga(buildROM([...forever]), 44100, extended);
  check('an extended ROM answers at $e00000', withExt.read8(0x00e00100) === 0x5a);
  check('and its header is where the ROM scan looks', withExt.read16(0x00e00000) === 0x1114);
  const without = new Amiga(buildROM([...forever]));
  check('an empty socket reads as nothing at all', without.read16(0x00e00000) === 0xffff);
}

{
  // A CIA timer in one-shot mode starts when its high byte is written, with
  // nothing ever setting the run bit. AmigaOS builds its keyboard handshake
  // out of exactly that, and waits forever if the timer does not start.
  const amiga = new Amiga(buildROM([...forever]));
  const CRA = 0xbfee01, TALO = 0xbfe401, TAHI = 0xbfe501, ICR = 0xbfed01;
  amiga.write8(ICR, 0x81); // let timer A interrupt
  amiga.write8(CRA, 0x08); // one-shot, stopped
  check('the timer is stopped to begin with', (amiga.ciaa.cra & 1) === 0);
  amiga.write8(TALO, 0x20);
  amiga.write8(TAHI, 0x00);
  check('writing the high byte starts it', (amiga.ciaa.cra & 1) === 1);

  amiga.runLine(0);
  check('and it counts down and underflows', (amiga.ciaa.icrData & 0x01) !== 0);
  check('then stops itself, because one shot is one shot', (amiga.ciaa.cra & 1) === 0);
  check('and asks for an interrupt on the way out', (amiga.paula.intreq & 0x0008) !== 0);
}

{
  // The fetch runs in blocks of eight colour clocks, and a DDFSTOP that lands
  // in the middle of one does not cut it short. Get this wrong by a single
  // word and every line of a screen slides sideways from the one above it.
  const amiga = new Amiga(buildROM([...forever]));
  const words = (strt, stop, hires) => {
    amiga.agnus.ddfstrt = strt;
    amiga.agnus.ddfstop = stop;
    amiga.agnus.dmacon = 0x0300;
    amiga.agnus.diwstrt = 0x2c81;
    amiga.agnus.diwstop = 0x2cc1;
    amiga.denise.bplcon0 = hires ? 0x9200 : 0x1200;
    amiga.agnus.fetchBitplanes(100);
    return amiga.agnus.lineWords;
  };
  check('the standard lores screen fetches 20 words', words(0x38, 0xd0, false) === 20, `${words(0x38, 0xd0, false)}`);
  check('the standard hires one fetches 40', words(0x3c, 0xd4, true) === 40, `${words(0x3c, 0xd4, true)}`);
  check(
    'and a hires stop four colour clocks early still fetches 40',
    words(0x3c, 0xd0, true) === 40,
    `${words(0x3c, 0xd0, true)}`,
  );
}

{
  // Interlace: the two fields land on alternate rows of the picture rather
  // than on top of each other.
  const amiga = new Amiga(buildROM([...forever]));
  amiga.denise.bplcon0 = 0x1204; // one plane, lores, LACE
  amiga.agnus.diwstrt = 0x2c81;
  amiga.agnus.diwstop = 0x2cc1;
  amiga.denise.setColor(0, 0x000);
  amiga.denise.setColor(1, 0xfff);
  amiga.agnus.planeWords[0].fill(0xffff);

  const rowFor = (field) => {
    amiga.denise.startLine(100, amiga.agnus.planeWords, 20, 0x38, amiga.agnus.window, field);
    amiga.denise.endLine();
    return amiga.denise.rowBase / SCREEN_WIDTH;
  };
  const even = rowFor(0);
  const odd = rowFor(1);
  check('the two fields go to two different rows', odd === even + 1, `${even} e ${odd}`);
  check('and a non-interlaced line fills both', (() => {
    amiga.denise.bplcon0 = 0x1200;
    amiga.denise.startLine(100, amiga.agnus.planeWords, 20, 0x38, amiga.agnus.window, 0);
    amiga.denise.endLine();
    return amiga.denise.rowSpan === 2;
  })());
}

// ------------------------------------------------------- a real operating system

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const kickstartPath = join(ROOT, 'roms', 'amiga', 'kickstart.rom');
const extendedPath = join(ROOT, 'roms', 'amiga', 'extended.rom');

if (!existsSync(kickstartPath)) {
  console.log(`
Nessuna Kickstart in roms/amiga: la prova di avvio vero è stata saltata.
La ROM libera di AROS si prende con \`npm run fetch-roms\`.`);
} else {
  section('Avvio vero');

  // Everything above proves the chips do what the manual says. This proves the
  // only thing that really matters: that an operating system written for this
  // machine, by people who never saw this emulator, comes up on it.
  const kickstart = new Uint8Array(readFileSync(kickstartPath));
  const extended = existsSync(extendedPath) ? new Uint8Array(readFileSync(extendedPath)) : null;
  const amiga = new Amiga(kickstart, 44100, extended);

  // The ROM's own boot log comes out of the serial port, which nothing here
  // has anything plugged into. It is the machine talking about itself.
  let serial = '';
  const writeCustom = amiga.writeCustom.bind(amiga);
  amiga.writeCustom = (offset, value) => {
    if (offset === 0x030) serial += String.fromCharCode(value & 0xff);
    return writeCustom(offset, value);
  };

  const started = Date.now();
  let displayUp = -1;
  for (let frame = 0; frame < 900; frame++) {
    amiga.runFrame();
    if (displayUp < 0 && amiga.denise.planeCount > 0 && amiga.agnus.dmaOn(0x100)) displayUp = frame;
  }
  const elapsed = Date.now() - started;

  const version = romVersion(kickstart);
  console.log(
    `  ROM ${version ? `${version.name} (${version.version}.${version.revision})` : 'sconosciuta'}` +
      `, ${extended ? 'con' : 'senza'} ROM di estensione` +
      `  —  900 quadri in ${elapsed} ms (${(elapsed / 900).toFixed(1)} ms/quadro)`,
  );

  check('la macchina non si è piantata', amiga.cpu.halted === false);
  check('il sistema ha tolto la ROM dall\'indirizzo zero', amiga.overlay === false);
  check('ha acceso la DMA e messo su un display', displayUp > 0, `al quadro ${displayUp}`);
  check('con dei bitplane veri', amiga.denise.planeCount > 0, `${amiga.denise.planeCount} piani`);
  check('e una copper list che gira', amiga.agnus.cop1lc !== 0, hex(amiga.agnus.cop1lc));
  check('la memoria dello sportello è stata trovata', /RAM upper: 00c7ffff/.test(serial) || serial === '');
  check(
    'e la chip RAM è stata contata fino in fondo',
    /RAM upper: 000fffff/.test(serial) || serial === '',
  );
  check(
    'e la scheda di espansione si è fatta trovare e sistemare',
    amiga.fast.configured && amiga.fast.base === 0x200000,
    hex(amiga.fast.base),
  );
  // With somewhere roomier to be, the system moves out of the memory the
  // custom chips share and leaves it to whatever is being run.
  const execBase = amiga.read32(4) >>> 0;
  check(
    'e il sistema ci si è trasferito, lasciando libera la chip RAM',
    execBase >= amiga.fast.base && execBase < amiga.fast.end,
    hex(execBase),
  );

  const background = amiga.denise.palette[0];
  let lit = 0;
  for (const pixel of amiga.denise.framebuffer) if (pixel !== background) lit++;
  check('e c\'è davvero un\'immagine sullo schermo', lit > 2000, `${lit} pixel disegnati`);

  // A picture that is only a few horizontal bands is a picture whose bitplane
  // pointers are drifting: every line would come from a different place in the
  // bitmap than the one above it.
  let rowsWithInk = 0;
  for (let row = 0; row < SCREEN_HEIGHT; row++) {
    let ink = 0;
    for (let x = 0; x < SCREEN_WIDTH; x++) if (amiga.denise.framebuffer[row * SCREEN_WIDTH + x] !== background) ink++;
    if (ink > 8) rowsWithInk++;
  }
  check('spalmata su tutto lo schermo e non in due righe', rowsWithInk > 60, `${rowsWithInk} righe disegnate`);

  if (serial) {
    const lines = serial.split('\n').filter((line) => line.trim());
    console.log(`\n  la ROM ha detto ${lines.length} righe sulla seriale, fra cui:`);
    for (const line of lines.slice(0, 3)) console.log(`    ${line.trim()}`);
  }
}

console.log(failures === 0 ? '\nAmiga OK.' : `\n${failures} problema/i.`);
process.exit(failures === 0 ? 0 : 1);
