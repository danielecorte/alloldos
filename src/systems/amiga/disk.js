// DF0: e DF1:, e il canale DMA che li legge e li scrive.
//
// The drives are worked entirely through side doors: CIA-B's port B turns the
// motor, picks the side, pulses the stepper and chooses which drive is
// listening, CIA-A's port A reads back the four status pins, and Paula's
// DSKPT/DSKLEN pair streams raw MFM into chip RAM. trackdisk.device does the
// rest in software, which is why the emulator has to be honest about the flux
// rather than about the sectors.
//
// Writing runs the same way backwards: the machine hands out a whole track of
// MFM, and the drive reads it back the way a head would to find out which
// sectors it was.
//
// There are two drives and one DMA channel, and that is the shape of the real
// machine too: Paula has a single set of disk registers, and which drive they
// are talking to is decided elsewhere, by a select line on a CIA that Paula
// knows nothing about. So the channel is a class of its own that asks, every
// time it matters, which drive is listening.

import {
  encodeTrack,
  decodeTrack,
  applySectors,
  MFM_TRACK_LENGTH,
  SYNC,
  volumeName,
  isBootable,
} from './adf.js';

const CIAB_STEP = 0x01;
const CIAB_DIRECTION = 0x02;
const CIAB_SIDE = 0x04;
const CIAB_MOTOR = 0x80;

/**
 * /SEL0 and /SEL1, the two lines that pick a drive. The A500 has four of them —
 * the other two go to the external connector — and they are the reason one
 * motor line and four status pins are enough for the whole daisy chain: only
 * the selected drive listens, and only the selected drive answers.
 */
const CIAB_SELECT = [0x08, 0x10];

const CYLINDERS = 80;

/**
 * How long one word takes to come off the head, in CPU cycles.
 *
 * A double density track is one revolution of a drive turning at 300 rpm: 200
 * milliseconds for the twelve and a half thousand bytes of it, which works out
 * at a bit every two microseconds and so a word every thirty-two. At 7.09 MHz
 * that is 227 cycles — exactly two words per scan line, which is the same fact
 * said the other way round.
 *
 * It matters that this is a real duration and not nothing. Software that goes
 * through trackdisk.device never notices either way, because it waits on an
 * interrupt. A game with its own trackloader does notice: the usual shape is to
 * arm the DMA, clear the disk interrupt that is still set from last time, and
 * only then start watching for it. A transfer that finished instantly would set
 * that interrupt before the clearing write, and the loader would wait for
 * something that had already happened and given up.
 */
const CYCLES_PER_WORD = 227;

/**
 * The head reads a bit stream, not bytes: where a word starts is decided by
 * where the sync was found, and that can be at any bit at all.
 *
 * This is not a detail. A loader that wants its data on a different boundary
 * than AmigaDOS puts it asks for a sync value that is the ordinary $4489 seen a
 * few bits early — $4891 is $4489 shifted along by three — and every word after
 * it arrives shifted to match. Looking only at whole words would never find it.
 */
const TRACK_BITS = MFM_TRACK_LENGTH * 8;

/** One 3.5" drive: a motor, a head that steps, and whatever is in the slot. */
export class DiskDrive {
  /** @param {number} unit 0 for DF0:, 1 for DF1: */
  constructor(unit = 0) {
    this.unit = unit;
    this.title = `DF${unit}:`;
    this.select = CIAB_SELECT[unit] ?? CIAB_SELECT[0];

    this.image = null;
    this.name = '';
    this.label = '';
    this.bootable = false;

    // The write-protect tab, and what has happened since the disk went in.
    // None of this is machine state: a reset does not push the tab across, and
    // it certainly does not un-write what has been written.
    this.writeProtected = false;
    this.modified = false;
    this.writeCount = 0;
    this.foreignWrites = 0;
    this.reset();
  }

  reset() {
    this.selected = false;
    this.motor = false;
    this.cylinder = 0;
    this.head = 0;
    this.previousControl = 0xff;
    this.diskChanged = true;

    this.track = null; // the MFM of the cylinder and side under the head
    this.trackNumber = -1;
    this.position = 0; // where the head is in the bit stream, in bits
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
    this.writeProtected = false;
    this.modified = false;
    this.writeCount = 0;
    this.foreignWrites = 0;
  }

  eject() {
    this.image = null;
    this.name = '';
    this.label = '';
    this.bootable = false;
    this.track = null;
    this.trackNumber = -1;
    this.diskChanged = true;
    this.modified = false;
    this.writeCount = 0;
    this.foreignWrites = 0;
  }

  get inserted() {
    return this.image !== null;
  }

  // ------------------------------------------------------------- the drive

  /**
   * CIA-B's port B, which is the whole control panel of every drive at once.
   * Each one watches its own select line and ignores the rest of the world
   * while that line is high; the motor is latched on the edge where the drive
   * is selected, not while it is, which is how one motor line drives four
   * drives independently.
   */
  writeControl(value) {
    const wasSelected = this.selected;
    this.selected = (value & this.select) === 0;

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
   * unselected drive drives none of them, and the pull-ups make them ones —
   * which is what lets two drives share four wires: whoever is selected pulls
   * them down, and everybody else lets go.
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

  // -------------------------------------------------------------- the medium

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

  /**
   * The sixteen bits of the stream starting at a bit, wrapping round the end of
   * the track the way the head does when the disk comes round again.
   */
  wordAt(track, bit) {
    const byte = (bit >> 3) % MFM_TRACK_LENGTH;
    const shift = bit & 7;
    const high = track[byte];
    const middle = track[(byte + 1) % MFM_TRACK_LENGTH];
    const low = track[(byte + 2) % MFM_TRACK_LENGTH];
    return (((high << 16) | (middle << 8) | low) >> (8 - shift)) & 0xffff;
  }

  /** @returns {number} the bit just past the next sync word, or -1 */
  findSync(track, from, sync) {
    const target = sync === 0 ? SYNC : sync;
    for (let i = 0; i < TRACK_BITS; i++) {
      const bit = (from + i) % TRACK_BITS;
      if (this.wordAt(track, bit) === target) return (bit + 16) % TRACK_BITS;
    }
    return -1;
  }

  /**
   * The end of a write: the MFM that went past the head, back into the image.
   *
   * A track is written whole, so the way to find out what was written is to
   * read it back exactly as the machine would — sync, header, checksums — and
   * keep the sectors that check out. Each one says which track and which sector
   * it is, so where it goes in the image is not a matter of where the head
   * happens to be: it is written on the disk, which is the entire point of a
   * sector header.
   *
   * A track that yields nothing was written in a format of its own, and there
   * is no room for it in an .adf. That gets counted rather than hidden.
   *
   * @param {Uint8Array} mfm what went out of the DMA
   */
  acceptWrite(mfm) {
    if (!this.inserted || this.writeProtected) return;

    const sectors = decodeTrack(mfm);
    if (sectors.length === 0) {
      this.foreignWrites++;
      return;
    }

    const touched = applySectors(this.image, sectors);
    this.modified = true;
    this.writeCount++;

    // The disk under the head has changed, so the encoded copy of it is stale.
    // The bit the head is on is not: the drive kept turning throughout.
    if (touched.has(this.trackNumber)) {
      const at = this.position;
      this.track = null;
      this.currentTrack();
      this.position = at;
    }

    // Writing to the boot block can make a disk bootable, or stop it being.
    this.bootable = isBootable(this.image);
    this.label = volumeName(this.image) || this.label;
  }
}

/**
 * Paula's disk DMA: one channel, one pointer, one length, for however many
 * drives are hanging off the machine.
 *
 * It has no idea which drive it is talking to. The select lines are on CIA-B,
 * where trackdisk.device sets them before it touches DSKLEN at all, so the
 * channel simply asks the drives which of them is listening and streams from
 * that one. Nobody selected means nobody answers: the transfer never finishes,
 * and the software times out — which is exactly what a real Amiga does when a
 * loader asks DF1: for a disk that is not there.
 */
export class DiskController {
  /**
   * @param {DiskDrive[]} drives
   * @param {object} hooks
   * @param {(addr:number,value:number)=>void} hooks.write chip RAM
   * @param {(addr:number)=>number} hooks.read chip RAM, for what is written out
   * @param {()=>boolean} hooks.dmaEnabled disk DMA, master switch included
   * @param {()=>number} hooks.adkcon for the word-sync bit
   * @param {()=>void} hooks.onBlockFinished
   * @param {()=>void} hooks.onSyncFound
   */
  constructor(drives, hooks) {
    this.drives = drives;
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.dskpt = 0;
    this.dsklen = 0;
    this.dmaArmed = false;
    this.dsksync = 0x4489;
    this.lastByte = 0;

    // A transfer in flight: which drive it is with, how much of it is left, and
    // the cycles banked towards the next word of it.
    this.transferring = false;
    this.transferWords = 0;
    this.writing = false;
    this.cycleDebt = 0;
    this.drive = null;

    // What is being written out, gathered as it goes past: the machine hands
    // over MFM a word at a time, and only a whole track's worth of it says
    // anything about which sectors these are.
    this.writeBuffer = null;
    this.writeAt = 0;
  }

  /** Whichever drive is holding the shared lines down, or none. */
  get selectedDrive() {
    return this.drives.find((drive) => drive.selected) ?? null;
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
          if (this.dmaArmed) this.start(value);
          else this.dmaArmed = true;
        } else {
          this.dmaArmed = false;
          // Taking the DMA bit away stops a transfer where it stands, and no
          // interrupt comes: this is how a loader tidies up after itself.
          this.transferring = false;
        }
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
   * Sets a DSKLEN's worth of transfer going. Nothing is moved here: the head
   * has to get to the data first, and the words arrive under tick().
   */
  start(length) {
    this.dmaArmed = false;
    this.transferring = false;
    if (!this.hooks.dmaEnabled()) return;

    const words = length & 0x3fff;
    this.writing = (length & 0x4000) !== 0;
    this.transferWords = words;
    this.cycleDebt = 0;
    this.writeBuffer = this.writing && words > 0 ? new Uint8Array(words * 2) : null;
    this.writeAt = 0;

    // Which drive this transfer is with is decided now, once: the select lines
    // were set long before DSKLEN was touched, and nothing sane moves them
    // while the head is streaming.
    this.drive = this.selectedDrive;

    if (!this.writing) {
      const track = this.drive?.currentTrack();
      if (!track) return; // no drive, no disk: the transfer never finishes

      if (this.hooks.adkcon() & 0x0400) {
        // Word sync: the DMA does not start until the sync word goes past, and
        // the sync word itself is not part of what lands in memory.
        const found = this.drive.findSync(track, this.drive.position, this.dsksync);
        if (found < 0) return;
        this.drive.position = found;
        this.hooks.onSyncFound();
      }
    }

    // Asking for nothing is over before it starts, but it still interrupts.
    if (words === 0) {
      this.hooks.onBlockFinished();
      return;
    }
    this.transferring = true;
  }

  /**
   * The drive turning, for however many CPU cycles have gone by. Words come off
   * the head at their own rate whatever the processor is doing, and the
   * interrupt at the end of them arrives when the last one does.
   *
   * @param {number} cycles CPU cycles since the last call
   */
  tick(cycles) {
    if (!this.transferring) return;
    if (!this.hooks.dmaEnabled()) {
      // The DMA was switched off underneath it. The transfer stops where it is
      // and says nothing, exactly as the hardware would.
      this.transferring = false;
      return;
    }

    this.cycleDebt += cycles;
    let words = (this.cycleDebt / CYCLES_PER_WORD) | 0;
    if (words <= 0) return;
    this.cycleDebt -= words * CYCLES_PER_WORD;
    if (words > this.transferWords) words = this.transferWords;

    if (this.writing) {
      // The words go past the head at the same rate they would come off it, and
      // they are kept: what the machine writes is MFM, and it takes a whole
      // transfer of it before anything can be said about which sectors it is.
      let pointer = this.dskpt;
      for (let i = 0; i < words; i++) {
        const word = this.hooks.read(pointer);
        if (this.writeBuffer && this.writeAt + 1 < this.writeBuffer.length) {
          this.writeBuffer[this.writeAt++] = (word >> 8) & 0xff;
          this.writeBuffer[this.writeAt++] = word & 0xff;
        }
        pointer = (pointer + 2) & 0x1ffffe;
        this.lastByte = word & 0xff;
      }
      this.dskpt = pointer;
      if (this.drive) this.drive.position = (this.drive.position + words * 16) % TRACK_BITS;
    } else {
      const track = this.drive?.currentTrack();
      if (!track) {
        // Ejected mid-transfer. Nothing more is coming, and nothing says so.
        this.transferring = false;
        return;
      }
      let at = this.drive.position;
      let pointer = this.dskpt;
      for (let i = 0; i < words; i++) {
        const word = this.drive.wordAt(track, at);
        this.hooks.write(pointer, word);
        pointer = (pointer + 2) & 0x1ffffe;
        at = (at + 16) % TRACK_BITS;
        this.lastByte = word & 0xff;
      }
      this.dskpt = pointer;
      this.drive.position = at;
    }

    this.transferWords -= words;
    if (this.transferWords === 0) {
      this.transferring = false;
      if (this.writing) {
        const buffer = this.writeBuffer;
        this.writeBuffer = null;
        if (buffer) this.drive?.acceptWrite(buffer.subarray(0, this.writeAt));
      }
      this.hooks.onBlockFinished();
    }
  }
}
