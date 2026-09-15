// Il PC 386 come lo vede alloldos: accenderlo, mettergli la sua immagine su una
// canvas, dargli tastiera, mouse e suono, e lasciargli infilare dentro i dischi.
//
// La scheda è quella del Pentium qui accanto — i chip sono gli stessi, con gli
// stessi indirizzi, dal 1984 in poi — con sopra un 386 a trentatré milioni di
// cicli, il suo 387 e otto mega di memoria, e il BIOS di Bochs al posto di
// SeaBIOS, perché SeaBIOS su un 386 non parte. È la macchina su cui è uscito
// Windows 3.1. La pagina è quella del Pentium: qui c'è solo quello che cambia.

import { Pentium } from '../pentium/machine.js';
import { BoardSession } from '../pentium/session.js';
import * as roms from './roms.js';

/** Il 386DX a trentatré megahertz, e la memoria di una macchina da lavoro del 1990. */
export const CLOCK = 33000000;
export const RAM = 8 * 1024 * 1024;

/**
 * Accende la macchina con i suoi pezzi. È una funzione a parte perché la usano
 * sia la pagina sia le prove: il 386 è la scheda del Pentium con un altro
 * processore, un altro BIOS e la ROM video affacciata dove la cerca un BIOS di
 * allora.
 *
 * @param {Uint8Array} bios
 * @param {object} [options]
 * @param {?Uint8Array} [options.video]
 * @param {?object} [options.disk]
 * @param {?Uint8Array} [options.floppy]
 * @param {?Uint8Array} [options.cd] un'immagine ISO nel lettore di CD
 */
export function build386(bios, { video = null, disk = null, floppy = null, cd = null } = {}) {
  const machine = new Pentium(bios, {
    model: 386,
    clock: CLOCK,
    ram: RAM,
    cards: video ? [{ base: roms.VIDEO_ROM_BASE, bytes: video }] : [],
    disk,
    floppy,
    cd,
  });
  declareFloppyDrive(machine);
  return machine;
}

/**
 * Il lettore da 1,44 MB c'è sempre, anche vuoto: sulla scheda del Pentium la
 * macchina dichiara il lettore solo se c'è un dischetto, per risparmiare a
 * SeaBIOS cinque secondi, ma su un 386 del 1990 il lettore era avvitato nel
 * case. E il DOS conta i lettori una volta sola, all'accensione: se non ci
 * fosse, un dischetto infilato dopo non avrebbe nessun A: in cui comparire.
 */
function declareFloppyDrive(machine) {
  if ((machine.cmos.bytes[0x10] & 0xf0) === 0) machine.cmos.bytes[0x10] = 0x40;
  machine.cmos.bytes[0x14] |= 0x01;
}

const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

/** Quello che distingue il 386 dal Pentium, per la pagina che hanno in comune. */
const PROFILE = {
  roms,
  build: build386,
  afterFloppy: declareFloppyDrive,
  diskName: 'disco fisso 386',
  promptTitle: 'Trascina qui il BIOS di Bochs',
  promptHTML: `
    <p>alloldos non imita un PC: ne esegue il firmware. Per un 386 il BIOS
    libero è quello di ${link(roms.BOCHS_URL, 'Bochs')} (LGPL), nella versione
    «legacy», tutta a sedici bit: SeaBIOS, quello del Pentium, su un 386 non
    parte. Servono due file, che il repository di Bochs tiene già compilati:
    <b>scaricali dai due link e trascinali sulla finestra</b>, e restano salvati
    in questo browser.</p>
    <ul>
      <li>${link(roms.BIOS_SPEC.source, 'BIOS-bochs-legacy')} — il BIOS di sistema, 64 KB, obbligatorio</li>
      <li>${link(roms.VIDEO_SPEC.source, 'VGABIOS-lgpl-latest')} — il ${link(roms.VGABIOS_URL, 'VGABIOS LGPL')},
      il BIOS della scheda video: senza la macchina parte ma lo schermo resta nero</li>
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
