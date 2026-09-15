// Il PC Pentium come lo vede alloldos: la macchina del 1995, con SeaBIOS.
//
// La pagina è la stessa del 386 — la scheda madre è la stessa — e qui c'è solo
// quello che cambia: il processore è un Pentium a sessantasei megahertz con
// trentadue mega, il firmware è SeaBIOS, e la ROM della scheda video non si
// affaccia a C0000 ma la passa al BIOS la scheda madre, dal canale di
// configurazione, come fa QEMU.

import { Pentium } from './machine.js';
import { BoardSession } from './session.js';
import * as roms from './roms.js';

/**
 * Accende la macchina con i suoi pezzi: la usano la pagina e le prove.
 *
 * @param {Uint8Array} bios
 * @param {object} [options]
 * @param {?Uint8Array} [options.video]
 * @param {?object} [options.disk]
 * @param {?Uint8Array} [options.floppy]
 * @param {?Uint8Array} [options.cd] un'immagine ISO nel lettore di CD
 */
export function buildPentium(bios, { video = null, disk = null, floppy = null, cd = null } = {}) {
  return new Pentium(bios, {
    videoROMs: video ? [{ name: roms.VIDEO_SPEC.file, bytes: video }] : [],
    disk,
    floppy,
    cd,
  });
}

const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

/** Quello che distingue il Pentium dal 386, per la pagina che hanno in comune. */
const PROFILE = {
  roms,
  build: buildPentium,
  // Il setup dichiara il lettore solo se all'accensione c'è un dischetto —
  // risparmia a SeaBIOS cinque secondi — e quindi un dischetto infilato dopo
  // vuole una riaccensione per avere un A: in cui comparire.
  resetForNewDrive: true,
  diskName: 'disco fisso Pentium',
  promptTitle: 'Trascina qui SeaBIOS',
  promptHTML: `
    <p>alloldos non imita un PC: ne esegue il firmware. Per il Pentium è
    ${link(roms.SEABIOS_URL, 'SeaBIOS')} (LGPLv3), quello che accende ogni
    macchina virtuale di QEMU. Il progetto pubblica i sorgenti, e i due file già
    compilati stanno nel repository di QEMU: <b>scaricali dai due link e
    trascinali sulla finestra</b>, e restano salvati in questo browser.</p>
    <ul>
      <li>${link(roms.BIOS_SPEC.source, 'bios.bin')} — il BIOS di sistema, 128 KB, obbligatorio</li>
      <li>${link(roms.VIDEO_SPEC.source, 'vgabios.bin')} — SeaVGABIOS, il BIOS della
      scheda video: senza la macchina parte ma lo schermo resta nero</li>
    </ul>
  `,
};

/**
 * Accende la macchina dentro `container`.
 * @returns {Promise<{dispose():void}>}
 */
export async function boot(container, options) {
  const session = new BoardSession(container, options, PROFILE);
  await session.start();
  return session;
}
