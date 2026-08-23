// DF0: — one 3.5" drive, and the DMA channel that reads it.
//
// The drive is worked entirely through side doors: CIA-B's port B turns the
// motor, picks the side and pulses the stepper, CIA-A's port A reads back the
// four status pins, and Paula's DSKPT/DSKLEN pair streams raw MFM into chip
// RAM. trackdisk.device does the rest in software, which is why the emulator
// has to be honest about the flux rather than about the sectors.

import { encodeTrack, MFM_TRACK_LENGTH, SYNC, volumeName, isBootable } from './adf.js';

const CIAB_STEP = 0x01;
const CIAB_DIRECTION = 0x02;
const CIAB_SIDE = 0x04;
const CIAB_SELECT0 = 0x08;
const CIAB_MOTOR = 0x80;

const CYLINDERS = 80;

export class DiskDrive {
  /**
   * @param {object} hooks
   * @param {(addr:number,value:number)=>void} hooks.write chip RAM
   * @param {()=>boolean} hooks.dmaEnabled disk DMA, master switch included
   * @param {()=>number} hooks.adkcon for the word-sync bit
   * @param {()=>void} hooks.onBlockFinished
   * @param {()=>void} hooks.onSyncFound
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.image = null;
    this.name = '';
    this.label = '';
    this.bootable = false;
    this.reset();
  }

  reset() {
    this.selected = false;
    this.motor = false;
    this.cylinder = 0;
    this.head = 0;
    this.previousControl = 0xff;
    this.diskChanged = true;

    this.dskpt = 0;
    this.dsklen = 0;
    this.dmaArmed = false;
    this.dsksync = 0x4489;
    this.lastByte = 0;

    this.track = null; // the MFM of the cylinder and side under the head
    this.trackNumber = -1;
    this.position = 0;
  }

  /** @param {Uint8Array} bytes a whole .adf */
  insert(bytes, name) {
    this.image = bytes;
    this.name = name;
    this.label = volumeName(bytes);
    this.bootable = isBootable(bytes);
    this.track = null;
    this.trackNumber = -1;
    this.diskChanged = true;
  }

  eject() {
    this.image = null;
    this.name = '';
    this.label = '';
    this.bootable = false;
    this.track = null;
    this.trackNumber = -1;
    this.diskChanged = true;
  }

  get inserted() {
    return this.image !== null;
  }

  /** Always: nothing here can write a disk back, so nothing is allowed to try. */
  get writeProtected() {
    return true;
  }

  // ------------------------------------------------------------- the drive

  /**
   * CIA-B's port B, which is the whole of the drive's control panel. The motor
   * is latched on the edge where the drive is selected, not while it is: that
   * is how one motor line drives four drives independently.
   */
  writeControl(value) {
    const wasSelected = this.selected;
    this.selected = (value & CIAB_SELECT0) === 0;

    if (this.selected && !wasSelected) this.motor = (value & CIAB_MOTOR) === 0;
    if (!this.selected) {
      this.previousControl = value;
      return;
    }

    this.head = value & CIAB_SIDE ? 0 : 1;

    // A step happens on the falling edge of /STEP, and goes towards track 0
    // when the direction line is high.
    const stepping = (this.previousControl & CIAB_STEP) !== 0 && (value & CIAB_STEP) === 0;
    if (stepping) {
      if (value & CIAB_DIRECTION) {
        if (this.cylinder > 0) this.cylinder--;
      } else if (this.cylinder < CYLINDERS - 1) this.cylinder++;
      // Any step at all is enough to clear the disk-changed line, as long as
      // there is a disk in there to clear it with.
      if (this.inserted) this.diskChanged = false;
      this.track = null;
    }
    this.previousControl = value;
  }

  /**
   * The four status pins, in the bits CIA-A's port A reads them on. An
   * unselected drive drives none of them, and the pull-ups make them ones.
   *
   * /RDY does double duty: with the motor off it clocks out the drive's
   * identity, and a plain double-density drive answers all ones — which is a
   * pin held low on every read.
   */
  get statusBits() {
    if (!this.selected) return 0x3c;
    let bits = 0;
    if (!this.diskChanged) bits |= 0x04; // /CHNG
    if (!this.writeProtected) bits |= 0x08; // /WPRO
    if (this.cylinder !== 0) bits |= 0x10; // /TK0
    const ready = this.motor ? this.inserted : true;
    if (!ready) bits |= 0x20; // /RDY
    return bits;
  }

  // ---------------------------------------------------------------- the DMA

  /** Encodes the track under the head, if it is not encoded already. */
  currentTrack() {
    if (!this.inserted) return null;
    const number = this.cylinder * 2 + this.head;
    if (this.track && this.trackNumber === number) return this.track;
    this.track = encodeTrack(this.image, number);
    this.trackNumber = number;
    this.position = 0;
    return this.track;
  }

  writeRegister(offset, value) {
    switch (offset) {
      case 0x020:
        this.dskpt = (this.dskpt & 0xfffe) | ((value & 0x1f) << 16);
        return true;
      case 0x022:
        this.dskpt = (this.dskpt & 0x1f0000) | (value & 0xfffe);
        return true;
      case 0x024:
        // Two writes with the DMA bit set, in a row, is the arming sequence:
        // one write on its own is how the driver makes sure it is disarmed.
        if (value & 0x8000) {
          if (this.dmaArmed) this.transfer(value);
          else this.dmaArmed = true;
        } else this.dmaArmed = false;
        this.dsklen = value;
        return true;
      case 0x026: // DSKDAT, for the CPU-driven writes nothing here does
        return true;
      case 0x07e:
        this.dsksync = value;
        return true;
      default:
        return false;
    }
  }

  readRegister(offset) {
    if (offset === 0x01a) {
      // DSKBYTR: a byte is always ready, because the DMA is never in the middle
      // of a transfer by the time anyone gets to look.
      return 0x8000 | (this.hooks.dmaEnabled() ? 0x4000 : 0) | (this.lastByte & 0xff);
    }
    if (offset === 0x008) return 0x0000; // DSKDATR
    return 0xffff;
  }

  /**
   * One whole DSKLEN's worth of transfer, at once. The real drive would take a
   * revolution over it and interrupt at the end; the software waits for that
   * interrupt either way.
   */
  transfer(length) {
    this.dmaArmed = false;
    if (!this.hooks.dmaEnabled()) return;

    const words = length & 0x3fff;
    if (length & 0x4000) {
      // A write. The disk is protected, so the bytes go nowhere — but the
      // pointer and the interrupt still have to behave.
      this.dskpt = (this.dskpt + words * 2) & 0x1ffffe;
      this.hooks.onBlockFinished();
      return;
    }

    const track = this.currentTrack();
    if (!track) return; // no disk: the transfer never finishes, and DOS times out

    let at = this.position;
    if (this.hooks.adkcon() & 0x0400) {
      // Word sync: the DMA does not start until the sync word goes past, and
      // the sync word itself is not part of what lands in memory.
      const found = this.findSync(track, at);
      if (found < 0) return;
      at = found;
      this.hooks.onSyncFound();
    }

    let pointer = this.dskpt;
    for (let i = 0; i < words; i++) {
      const high = track[at];
      const low = track[(at + 1) % MFM_TRACK_LENGTH];
      this.hooks.write(pointer, (high << 8) | low);
      pointer = (pointer + 2) & 0x1ffffe;
      at = (at + 2) % MFM_TRACK_LENGTH;
      this.lastByte = low;
    }
    this.dskpt = pointer;
    this.position = at;
    this.hooks.onBlockFinished();
  }

  /** @returns {number} the byte just past the next sync word, or -1 */
  findSync(track, from) {
    const target = this.dsksync === 0 ? SYNC : this.dsksync;
    for (let i = 0; i < MFM_TRACK_LENGTH; i += 2) {
      const at = (from + i) % MFM_TRACK_LENGTH;
      const word = (track[at] << 8) | track[(at + 1) % MFM_TRACK_LENGTH];
      if (word === target) return (at + 2) % MFM_TRACK_LENGTH;
    }
    return -1;
  }
}
