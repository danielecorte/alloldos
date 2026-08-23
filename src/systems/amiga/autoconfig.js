// A Zorro II RAM board, and the handshake that finds it.
//
// The A501 under the trapdoor is found by probing: the ROM writes somewhere and
// sees whether the value comes back. Anything on the side expansion bus is
// found the other way round — the board announces itself. At reset every
// unconfigured board sits at $e80000 with a small ROM describing what it is and
// how big; the system reads that, picks somewhere in the Zorro II window at
// $200000 to put it, writes the address back to the board, and the board moves
// there and stops answering at $e80000 so the next one in the chain can be
// seen. A board that says ERTF_MEMLIST also gets its memory added to the free
// list, which is the whole reason for doing any of this: it gives the operating
// system somewhere to live that is not the memory the custom chips share.
//
// The description is read a nibble at a time — the bus only wires up the top
// four data lines — and everything except the first byte is stored inverted.

/** Where an unconfigured board waits to be asked what it is. */
export const AUTOCONFIG_BASE = 0xe80000;
export const AUTOCONFIG_SIZE = 0x10000;

/** The window Zorro II boards are placed in, below the I/O quarter of the map. */
export const ZORRO2_BASE = 0x200000;
export const ZORRO2_END = 0xa00000;

const ERT_ZORROII = 0xc0;
const ERTF_MEMLIST = 0x20;
const ERFF_MEMSPACE = 0x80;

/** er_Type's bottom three bits, which are a size and not a number. */
const SIZE_CODES = new Map([
  [0x800000, 0],
  [0x010000, 1],
  [0x020000, 2],
  [0x040000, 3],
  [0x080000, 4],
  [0x100000, 5],
  [0x200000, 6],
  [0x400000, 7],
]);

export class AutoconfigRAMError extends Error {}

export class FastRAM {
  /** @param {number} size a power of two between 64 KB and 8 MB */
  constructor(size) {
    if (!SIZE_CODES.has(size)) {
      throw new AutoconfigRAMError(
        `una scheda Zorro II può essere di 64K, 128K, 256K, 512K, 1M, 2M, 4M o 8M, non di ${size} byte`,
      );
    }
    this.size = size;
    this.ram = new Uint8Array(size);
    this.view = new DataView(this.ram.buffer);

    // The board's little ROM, one byte per entry, in the order the system
    // reads them. Manufacturer 2011 is the number the unofficial expansions
    // answer with, which is what this is.
    this.description = [
      ERT_ZORROII | ERTF_MEMLIST | SIZE_CODES.get(size), // er_Type
      1, // er_Product
      ERFF_MEMSPACE, // er_Flags: it wants to be somewhere a program can use it
      0,
      0x07, 0xdb, // er_Manufacturer, 2011
      0, 0, 0, 1, // er_SerialNumber
      0, 0, // er_InitDiagVec: no diagnostic ROM
    ];

    this.reset();
  }

  /**
   * The /RESET line reaches the expansion bus too, so a board forgets where it
   * was put and goes back to answering at $e80000 — which is why the system
   * autoconfigures the chain again after every reboot. What is in the RAM is
   * not disturbed.
   */
  reset() {
    this.configured = false;
    this.shutUp = false;
    this.base = 0;
    this.end = 0;
    this.addressLow = 0;
  }

  /** Power-on, where the RAM has nothing in it yet. */
  clear() {
    this.ram.fill(0);
    this.reset();
  }

  /** True while the board is still sitting at $e80000 waiting to be placed. */
  get answering() {
    return !this.configured && !this.shutUp;
  }

  // --------------------------------------------------------- the description

  /**
   * One nibble of the description, in the top four bits of the word — which is
   * where the four data lines the board is wired to end up.
   */
  readConfig(addr) {
    if (!this.answering) return 0xffff;
    const offset = addr & 0xff;
    const byte = this.description[offset >> 2] ?? 0;
    // er_Type is the one byte stored the right way up; the rest are inverted,
    // so that a board that is not there reads as zeroes rather than as a
    // plausible answer.
    const stored = offset < 4 ? byte : ~byte & 0xff;
    const nibble = offset & 2 ? stored & 0x0f : stored >> 4;
    return (nibble << 12) & 0xffff;
  }

  /**
   * The two registers that are written rather than read: $48 places the board,
   * $4c tells it to shut up and go away. A Zorro II board takes the top byte of
   * its new address from $48 and the next nibble down from $4a.
   */
  writeConfig(addr, value, size) {
    if (!this.answering) return;
    const offset = addr & 0xff;
    const byte = size === 1 ? value & 0xff : (value >> 8) & 0xff;

    if (offset === 0x4a) {
      this.addressLow = byte & 0xf0;
      return;
    }
    if (offset === 0x48) {
      this.place(((byte << 16) | (this.addressLow << 12)) >>> 0);
      return;
    }
    if (offset === 0x4c) this.shutUp = true;
  }

  place(base) {
    this.base = base >>> 0;
    this.end = (this.base + this.size) >>> 0;
    this.configured = true;
  }

  contains(addr) {
    return this.configured && addr >= this.base && addr < this.end;
  }

  // ----------------------------------------------------------------- the RAM

  read8(addr) {
    return this.ram[addr - this.base];
  }

  read16(addr) {
    return this.view.getUint16(addr - this.base, false);
  }

  write8(addr, value) {
    this.ram[addr - this.base] = value;
  }

  write16(addr, value) {
    this.view.setUint16(addr - this.base, value & 0xffff, false);
  }
}
