// Guidare il Pentium da fuori: accenderlo, aspettare che dica qualcosa, battere.
//
// È il paio di mani che serve per provare — e domani per installare — un sistema
// operativo su questa macchina, ed è lo stesso mestiere che fa `pcsession.mjs`
// per il 286, con due differenze che vengono dalla macchina e non dal codice: la
// tastiera passa dall'8042 invece che dai due fili di una tastiera XT, e lo
// schermo è una VGA che va letta come testo dai suoi piani di memoria.
//
// I codici dei tasti sono gli stessi: il controllore della tastiera di un AT, con
// la traduzione accesa — che è come lo lascia ogni BIOS — consegna al bus gli
// stessi codici che consegnava la tastiera dell'XT nel 1981. Quindi la tabella è
// quella di `../src/systems/pc/scancodes.js`, la stessa che usa il browser.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Pentium, CPU_CLOCK, FPS } from '../src/systems/pentium/machine.js';
import { BIOS_SPEC, VIDEO_SPEC } from '../src/systems/pentium/roms.js';
import { HardDisk, geometryFor } from '../src/systems/pc/ata.js';
import { HDD_SPEC, FREEDOS_SPEC } from '../src/systems/pc/media.js';
import { keyFor, SHIFT } from '../src/systems/pc/scancodes.js';

export const ROMS = join(fileURLToPath(import.meta.url), '..', '..', 'roms', 'pentium');
export const PC_ROMS = join(fileURLToPath(import.meta.url), '..', '..', 'roms', 'pc');

const romPath = (spec) => join(ROMS, spec.file);

export const have = {
  get bios() {
    return existsSync(romPath(BIOS_SPEC));
  },
  get video() {
    return existsSync(romPath(VIDEO_SPEC));
  },
  /** Il disco del 286, che è un disco IDE come un altro e ha il DOS sopra. */
  get disk() {
    return existsSync(join(PC_ROMS, HDD_SPEC.file));
  },
  get floppy() {
    return existsSync(join(PC_ROMS, FREEDOS_SPEC.file));
  },
};

/**
 * Il disco del repository, montato come disco IDE. È lo stesso file che il 286
 * avvia dalla sua scheda XT-CF: venti mega con FreeDOS installato sopra, e la
 * geometria scritta dentro la sua tabella delle partizioni. Che lo stesso disco
 * si accenda su due macchine diverse non è un caso: è quello che vuol dire che
 * un disco è un disco.
 *
 * @returns {HardDisk}
 */
export function installedDisk() {
  const image = new Uint8Array(readFileSync(join(PC_ROMS, HDD_SPEC.file)));
  return new HardDisk(image, geometryFor(image));
}

/**
 * Una macchina accesa, con dentro quello che c'è.
 *
 * @param {object} [options]
 * @param {boolean} [options.video] montare la ROM della scheda video
 * @param {'installed'|HardDisk|null} [options.disk]
 * @param {boolean} [options.floppy] mettere il dischetto di FreeDOS in A:
 * @returns {Pentium}
 */
export function bootPentium(options = {}) {
  const { video = true, disk = 'installed', floppy = false, cd = null } = options;
  const videoROMs = [];
  if (video && have.video) {
    videoROMs.push({ name: VIDEO_SPEC.file, bytes: new Uint8Array(readFileSync(romPath(VIDEO_SPEC))) });
  }
  const hard = disk === 'installed' ? (have.disk ? installedDisk() : null) : disk;
  return new Pentium(new Uint8Array(readFileSync(romPath(BIOS_SPEC))), {
    videoROMs,
    disk: hard,
    floppy: floppy && have.floppy ? new Uint8Array(readFileSync(join(PC_ROMS, FREEDOS_SPEC.file))) : null,
    cd,
  });
}

export class Session {
  /**
   * @param {Pentium} pc
   * @param {(message:string)=>void} [log]
   */
  constructor(pc, log = () => {}) {
    this.pc = pc;
    this.log = log;
    this.frames = 0;
  }

  run(frames) {
    for (let i = 0; i < frames; i++) this.pc.runFrame();
    this.frames += frames;
  }

  /** Lo schermo come testo, senza gli spazi in fondo alle righe. */
  screen() {
    return this.pc.video
      .text()
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '');
  }

  lastLine() {
    const lines = this.screen().split('\n').filter((line) => line.trim());
    return lines[lines.length - 1] ?? '';
  }

  /** Il racconto che il firmware fa dalla sua porta di servizio. */
  get trace() {
    return this.pc.log;
  }

  /**
   * Manda avanti la macchina finché sullo schermo non compare qualcosa.
   * @returns {boolean}
   */
  waitFor(pattern, limit = 600) {
    for (let i = 0; i < limit; i++) {
      this.pc.runFrame();
      this.frames++;
      if (pattern.test(this.screen())) return true;
    }
    return false;
  }

  expect(pattern, limit = 600, label = '') {
    if (this.waitFor(pattern, limit)) return true;
    this.log(this.screen());
    throw new Error(`la macchina non ha mai detto ${pattern}${label ? ` (${label})` : ''}`);
  }

  /**
   * Batte del testo, un tasto per volta, passando dal controllore.
   *
   * Un fotogramma fra un movimento e l'altro basta e avanza: qui dentro ce ne
   * stanno più di un milione di cicli, e l'interruzione della tastiera viene
   * guardata fra un'istruzione e l'altra. Non è pignoleria al contrario — su
   * questa macchina un fotogramma costa tempo vero a chi la sta emulando, e
   * battere una riga a due fotogrammi per tasto è mezzo minuto buttato.
   */
  type(text, gap = 1) {
    for (const char of text) {
      const key = keyFor(char);
      if (!key) continue;
      if (key.shift) {
        this.press(SHIFT);
        this.run(gap);
      }
      this.press(key.code);
      this.run(gap);
      this.release(key.code);
      this.run(gap);
      if (key.shift) {
        this.release(SHIFT);
        this.run(gap);
      }
    }
  }

  press(code) {
    this.pc.kbc.fromKeyboard(code & 0x7f);
  }

  release(code) {
    // Il codice di rilascio è quello di pressione col bit alto acceso: è la
    // convenzione della tastiera dell'XT, e il controllore dell'AT la traduce
    // fedelmente perché il software di prima non sapeva fare altro.
    this.pc.kbc.fromKeyboard((code & 0x7f) | 0x80);
  }

  /** Batte una riga e aspetta che il DOS torni a chiedere. */
  command(line, { prompt = /[A-C]:\\[^\n]*>$/m, limit = 600, settle = 30 } = {}) {
    this.type(`${line}\n`);
    this.run(settle);
    this.expect(prompt, limit, line);
  }

  /** Spegne e riaccende, che è quello che fa il piedino di reset. */
  reboot() {
    this.pc.resetMachine();
  }
}

export { CPU_CLOCK, FPS };
