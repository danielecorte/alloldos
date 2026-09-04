// Guidare il PC da fuori: accenderlo, aspettare che dica qualcosa, battere.
//
// Il PC è l'unica macchina di alloldos che si usa scrivendo, e quindi l'unica
// che si può provare — e installare — battendo comandi come farebbe una
// persona. Questo modulo è il paio di mani: monta le ROM e i dischi, guarda lo
// schermo finché non compare quello che si aspettava, e preme i tasti uno alla
// volta lasciando passare qualche quadro fra l'uno e l'altro.
//
// Quel ritardo non è una precauzione superflua. Il DOS, prima di fare una
// domanda, svuota il buffer della tastiera: chi risponde troppo in fretta —
// prima che la domanda sia comparsa — si sente ignorare. Otto quadri per
// tasto sono centotrenta millesimi di secondo, cioè un dattilografo veloce, e
// bastano perché ogni programma faccia in tempo a sentire.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PC } from '../src/systems/pc/machine.js';
import { HardDisk, DISK_SIZE } from '../src/systems/pc/ata.js';
import { padOptionROM, BIOS_SPEC, CARD_SPEC, CARD_ROM_BASE } from '../src/systems/pc/roms.js';
import { FREEDOS_SPEC, HDD_SPEC } from '../src/systems/pc/media.js';
import { keyFor, SHIFT } from '../src/systems/pc/scancodes.js';

export const ROMS = join(fileURLToPath(import.meta.url), '..', '..', 'roms', 'pc');

const path = (spec) => join(ROMS, spec.file);

export const have = {
  get bios() {
    return existsSync(path(BIOS_SPEC));
  },
  get card() {
    return existsSync(path(CARD_SPEC));
  },
  get floppy() {
    return existsSync(path(FREEDOS_SPEC));
  },
  get hdd() {
    return existsSync(path(HDD_SPEC));
  },
};

const read = (spec) => new Uint8Array(readFileSync(path(spec)));

/**
 * Una macchina accesa, con dentro quello che c'è.
 *
 * @param {object} [options]
 * @param {boolean} [options.card] montare la scheda del disco fisso
 * @param {boolean} [options.floppy] mettere il dischetto di FreeDOS in A:
 * @param {'blank'|'installed'|null} [options.disk] cosa c'è sul disco fisso
 */
export function bootPC(options = {}) {
  const { card = true, floppy = true, disk = 'blank' } = options;
  const cards = [];
  if (card && have.card) {
    cards.push({ base: CARD_ROM_BASE, bytes: padOptionROM(read(CARD_SPEC)) });
  }
  let hard = null;
  if (disk === 'installed' && have.hdd) {
    const image = new Uint8Array(DISK_SIZE);
    image.set(read(HDD_SPEC).subarray(0, DISK_SIZE));
    hard = new HardDisk(image);
  } else if (disk) {
    hard = new HardDisk();
  }
  const pc = new PC(read(BIOS_SPEC), { disk: hard, cards });
  if (floppy && have.floppy) pc.fdc.drives[0].insert(read(FREEDOS_SPEC));
  return pc;
}

export class Session {
  /**
   * @param {PC} pc
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
    return this.pc.cga
      .text()
      .join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n+$/, '');
  }

  /** L'ultima riga con qualcosa sopra: di solito è dove la macchina è arrivata. */
  lastLine() {
    const lines = this.screen().split('\n').filter((line) => line.trim());
    return lines[lines.length - 1] ?? '';
  }

  /**
   * Manda avanti la macchina finché sullo schermo non compare qualcosa.
   * @param {RegExp} pattern
   * @param {number} [limit] quanti quadri al massimo
   * @returns {boolean} se è comparso
   */
  waitFor(pattern, limit = 4000) {
    for (let i = 0; i < limit; i++) {
      this.pc.runFrame();
      this.frames++;
      if (pattern.test(this.screen())) return true;
    }
    return false;
  }

  /** Come sopra, ma se non compare niente si ferma tutto. */
  expect(pattern, limit = 4000, label = '') {
    if (this.waitFor(pattern, limit)) return true;
    this.log(this.screen());
    throw new Error(`la macchina non ha mai detto ${pattern}${label ? ` (${label})` : ''}`);
  }

  /** Batte del testo, un tasto per volta. */
  type(text, gap = 2) {
    for (const char of text) {
      const key = keyFor(char);
      if (!key) continue;
      if (key.shift) {
        this.pc.keyboard.press(SHIFT);
        this.run(gap);
      }
      this.pc.keyboard.press(key.code);
      this.run(gap);
      this.pc.keyboard.release(key.code);
      this.run(gap);
      if (key.shift) {
        this.pc.keyboard.release(SHIFT);
        this.run(gap);
      }
    }
  }

  /** Batte una riga e aspetta che il DOS torni a chiedere. */
  command(line, { prompt = /[A-C]:\\[^\n]*>$/m, limit = 4000, settle = 60 } = {}) {
    this.type(`${line}\n`);
    this.run(settle);
    this.expect(prompt, limit, line);
  }

  /**
   * Riaccende la macchina e sceglie da dove partire. La scheda del disco fisso
   * mette una barra in cima allo schermo con le lettere delle unità: premere A
   * o C è come premerlo davvero, e risparmia i trenta secondi che il menu
   * aspetterebbe da solo.
   *
   * @param {'a'|'c'} drive
   */
  reboot(drive) {
    this.pc.reset();
    this.expect(/Master at 300h/, 2000, 'la scheda del disco non si è presentata');
    this.run(30);
    this.type(drive);
  }

  /**
   * Il dischetto di FreeDOS si accende sul programma di installazione, che
   * chiede se si vuole installare: qui si risponde di no e si resta al
   * prompt, che è quello che serve per fare le cose a mano.
   */
  toFloppyPrompt() {
    this.expect(/proceed \[Y,N\]/, 5000, 'il dischetto non è partito');
    this.type('n\n');
    this.expect(/A:\\>/, 3000, 'FreeDOS non è arrivato al prompt');
    this.run(30);
  }
}
