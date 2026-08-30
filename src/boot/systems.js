// The boot menu's list of machines.
//
// Everything the menu needs to draw an entry lives here, so nothing has to be
// downloaded until a machine is actually booted. Adding a system means writing
// a module that exports `boot(container, options)` and pointing `load` at it.
// Entries without a loader still appear, the same way GRUB lists a partition it
// cannot read.

export const SYSTEMS = [
  {
    id: 'c64',
    label: 'Commodore 64 — KERNAL / BASIC V2 (PAL)',
    year: 1982,
    cpu: 'MOS 6510 @ 0,985 MHz',
    memory: '64 KB RAM, 20 KB ROM',
    notes: 'VIC-II, SID 6581, due CIA 6526. Si accende sul BASIC.',
    available: true,
    load: () => import('../systems/c64/index.js'),
  },
  {
    id: 'amiga',
    label: 'Commodore Amiga 500 — Kickstart / Workbench 1.3',
    year: 1987,
    cpu: 'Motorola 68000 @ 7,09 MHz',
    memory: '1 MB Chip + 512 KB A501 + 8 MB Fast in autoconfig',
    notes: 'Agnus, Denise e Paula: multitasking preemptivo nel 1987.',
    available: true,
    load: () => import('../systems/amiga/index.js'),
  },
  {
    id: 'zx-spectrum',
    label: 'Sinclair ZX Spectrum 48K — Sinclair BASIC',
    year: 1982,
    cpu: 'Zilog Z80A @ 3,5 MHz',
    memory: '48 KB RAM, 16 KB ROM',
    notes: 'ULA, beeper a un bit, tastiera a gomma.',
    available: false,
  },
  {
    id: 'apple2',
    label: 'Apple II — Applesoft BASIC',
    year: 1977,
    cpu: 'MOS 6502 @ 1,023 MHz',
    memory: '48 KB RAM',
    notes: 'Grafica hi-res a colori ottenuta da artefatti NTSC.',
    available: false,
  },
  {
    id: 'pc',
    label: 'PC 286 — GLaBIOS / FreeDOS',
    year: 1988,
    cpu: 'Intel 80286 @ 8 MHz',
    memory: '640 KB convenzionali',
    notes: 'Scheda XT, BIOS libero, VGA: la macchina su cui gira tutto il DOS.',
    available: false,
  },
  // Not a machine, but it boots like one — the way GRUB keeps its own entries
  // at the bottom of the list, under the systems.
  {
    id: 'about',
    label: 'About alloldos — licenza, crediti e sorgenti',
    year: 2026,
    details: [
      ['licenza', 'GNU GPL v3'],
      ['autori', 'Daniele Corte e Claude Code'],
      ['sorgenti', 'github.com/danielecorte/alloldos'],
    ],
    available: true,
    load: () => import('../about/index.js'),
  },
];

export const DEFAULT_SYSTEM = 'c64';
