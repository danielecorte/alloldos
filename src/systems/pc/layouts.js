// Le tastiere: quale disegno c'è sopra i tasti, detto al DOS.
//
// Una tastiera italiana e una americana sono lo stesso pezzo di ferro con dei
// disegni diversi sopra, e mandano gli stessi numeri: il tasto accanto alla P
// manda 1Ah su tutte e due, e sull'una c'è stampata una «è», sull'altra una
// parentesi quadra. Chi traduce il numero in un carattere è il software, e sul
// DOS quel software è KEYB: un programma residente che si mette davanti al
// BIOS e sa, per ogni paese, che cosa c'è disegnato su ogni tasto.
//
// Scegliere la tastiera, qui, vuol dire quindi fare quello che si faceva
// allora: scrivere `KEYB IT` in fondo all'AUTOEXEC.BAT e riaccendere. Nessuna
// traduzione nascosta nell'emulatore — la macchina riceve i numeri dei tasti
// come li manderebbe una tastiera vera, e a dar loro un significato è KEYB,
// quello di FreeDOS, che sta sul disco fisso insieme alle sue tastiere.
//
// Il disco è lo stesso per il 286 e per il Pentium, e quindi anche questa
// scelta: è scritta sul disco, non nella macchina. Sul 286 però KEYB ha
// bisogno di un aiuto, KB16 (vedi `scripts/kb16.mjs`), perché usa un servizio
// del BIOS che un BIOS XT non ha — e la riga di KB16 va nell'AUTOEXEC insieme
// a quella di KEYB. Sul Pentium KB16 si accorge di non servire e se ne va.

import { FAT16 } from './fat.js';

/**
 * Le tastiere che si possono scegliere: quelle di KEYBOARD.SYS che vanno
 * d'accordo con la codepage 437, cioè con le lettere che la CGA ha nella ROM e
 * che la VGA si porta dietro. Il nome è quello che KEYB vuole sulla riga di
 * comando — «gr» per la Germania, «sp» per la Spagna, «su» per la Finlandia —
 * e l'etichetta è quella che si riconosce oggi.
 */
export const LAYOUTS = [
  { id: 'us', label: 'US', name: 'americana' },
  { id: 'it', label: 'IT', name: 'italiana' },
  { id: 'uk', label: 'UK', name: 'inglese' },
  { id: 'gr', label: 'DE', name: 'tedesca' },
  { id: 'fr', label: 'FR', name: 'francese' },
  { id: 'sp', label: 'ES', name: 'spagnola' },
  { id: 'sg', label: 'CH-DE', name: 'svizzera tedesca' },
  { id: 'sf', label: 'CH-FR', name: 'svizzera francese' },
  { id: 'be', label: 'BE', name: 'belga' },
  { id: 'nl', label: 'NL', name: 'olandese' },
  { id: 'sv', label: 'SE', name: 'svedese' },
  { id: 'su', label: 'FI', name: 'finlandese' },
  { id: 'la', label: 'LA', name: 'latinoamericana' },
  { id: 'br', label: 'BR', name: 'brasiliana' },
];

/**
 * Quella che il DOS conosce da sé, senza KEYB: la tabella dentro il BIOS è
 * americana, come la tastiera dell'IBM PC del 1981.
 */
export const DEFAULT_LAYOUT = 'us';

export function layoutNamed(id) {
  return LAYOUTS.find((layout) => layout.id === id) ?? null;
}

// ------------------------------------------------------------- i due pacchetti

/**
 * Da dove vengono KEYB e le sue tastiere: due pacchetti del repository di
 * FreeDOS 1.3, lo stesso da cui viene tutto il resto del disco. `npm run
 * fetch-roms` li scarica accanto alle ROM e `npm run make-hdd` ne tira fuori i
 * due file che servono. I sorgenti viaggiano dentro i pacchetti stessi.
 */
const PACKAGES_URL = 'https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.3/base';

export const KEYB_PACKAGES = [
  { file: 'keyb.zip', source: `${PACKAGES_URL}/keyb.zip`, members: ['BIN/KEYB.EXE'] },
  { file: 'keyb_lay.zip', source: `${PACKAGES_URL}/keyb_lay.zip`, members: ['BIN/KEYBOARD.SYS'] },
];

/** Dove stanno sul disco che viaggia con alloldos: accanto agli altri comandi. */
export const PROGRAMS_DIR = 'FDOS\\BIN';

/**
 * Dove si cerca KEYB su un disco che non è il nostro: prima al posto nostro,
 * poi dove lo mette l'installazione di FreeDOS, poi dove lo metteva il DOS di
 * Microsoft.
 */
const KEYB_PLACES = ['FDOS\\BIN\\KEYB.EXE', 'FREEDOS\\BIN\\KEYB.EXE', 'DOS\\KEYB.COM', 'DOS\\KEYB.EXE'];

// ------------------------------------------------------------- l'AUTOEXEC.BAT

const AUTOEXEC = 'AUTOEXEC.BAT';

/** Una riga che carica KEYB, con o senza percorso davanti; il nome dopo, se c'è. */
const KEYB_LINE = /^\s*@?(?:[a-z]:)?(?:\S*\\)?keyb(?:\.(?:exe|com))?(?:\s+([a-z]{2}[0-9]*))?/i;

/** E una che carica KB16. */
const KB16_LINE = /^\s*@?(?:[a-z]:)?(?:\S*\\)?kb16(?:\.com)?\s*$/i;

/** La riga che imposta il PATH: KEYB va dopo, così si trova anche senza percorso. */
const PATH_LINE = /^\s*@?(?:path\b|set\s+path\s*=)/i;

/** L'AUTOEXEC è testo DOS: un byte per carattere, e le righe finiscono in CR LF. */
const decode = (bytes) => String.fromCharCode(...bytes);
const encode = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

function readAutoexec(volume) {
  const bytes = volume.read(AUTOEXEC);
  // Un ^Z in fondo era il modo in cui il DOS di una volta segnava la fine di
  // un file di testo, e qualche AUTOEXEC se lo porta ancora dietro.
  return bytes ? decode(bytes).replace(/\x1a[\s\S]*$/, '') : '';
}

/**
 * Quale tastiera dice il disco: quella della riga di KEYB nell'AUTOEXEC,
 * americana se non c'è, null se sul disco non c'è nemmeno un filesystem.
 *
 * @param {Uint8Array} image l'immagine del disco fisso
 * @returns {?string}
 */
export function layoutOf(image) {
  const volume = FAT16.of(image);
  if (!volume) return null;
  for (const line of readAutoexec(volume).split(/\r?\n/)) {
    const match = KEYB_LINE.exec(line);
    if (match) return (match[1] ?? DEFAULT_LAYOUT).toLowerCase();
  }
  return DEFAULT_LAYOUT;
}

/**
 * Scrive la tastiera nell'AUTOEXEC.BAT: toglie le righe di KEYB e di KB16
 * che c'erano, e se la tastiera non è quella americana ne mette due nuove dopo
 * il PATH — KEYB con il suo paese, e KB16 se sul disco c'è. Il resto del file
 * resta com'era, riga per riga.
 *
 * Il DOS legge l'AUTOEXEC solo all'accensione, quindi dopo va riacceso; e va
 * fatto a macchina ferma o subito prima di un reset, perché il DOS si tiene in
 * memoria pezzi di FAT e un file cambiato sotto il naso non lo vedrebbe.
 *
 * @param {Uint8Array} image l'immagine del disco fisso
 * @param {string} id il nome di KEYB, come in LAYOUTS
 * @returns {{changed:boolean, missing?:'filesystem'|'keyb'}}
 */
export function setLayout(image, id) {
  const volume = FAT16.of(image);
  if (!volume) return { changed: false, missing: 'filesystem' };

  const before = readAutoexec(volume);
  const lines = before.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const kept = lines.filter((line) => !KEYB_LINE.test(line) && !KB16_LINE.test(line));

  if (id !== DEFAULT_LAYOUT) {
    const keyb = KEYB_PLACES.find((place) => volume.locate(place) >= 0);
    if (!keyb) return { changed: false, missing: 'keyb' };
    const dir = keyb.slice(0, keyb.lastIndexOf('\\'));
    const added = [`c:\\${dir.toLowerCase()}\\keyb ${id}`];
    if (volume.locate(`${dir}\\KB16.COM`) >= 0) added.push(`c:\\${dir.toLowerCase()}\\kb16`);

    let at = kept.length;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (PATH_LINE.test(kept[i])) {
        at = i + 1;
        break;
      }
    }
    kept.splice(at, 0, ...added);
  }

  const after = kept.length ? `${kept.join('\r\n')}\r\n` : '';
  if (after === before) return { changed: false };
  volume.writeFile(null, AUTOEXEC, encode(after));
  return { changed: true };
}

// ----------------------------------------------------------------- la scelta

const PREFERENCE_KEY = 'alloldos.dos.keyboard';

/**
 * La tastiera che ha scelto chi sta davanti al browser. È una sola per le due
 * macchine DOS, perché la tastiera sotto le dita è una sola.
 *
 * @returns {string}
 */
export function preferredLayout() {
  try {
    const stored = localStorage.getItem(PREFERENCE_KEY);
    if (stored && layoutNamed(stored)) return stored;
  } catch {
    /* un browser senza deposito: si resta sull'americana */
  }
  return DEFAULT_LAYOUT;
}

export function storePreferredLayout(id) {
  try {
    localStorage.setItem(PREFERENCE_KEY, id);
  } catch {
    /* la scelta vale finché la pagina resta aperta */
  }
}
