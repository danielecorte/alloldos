// Il lettore di CD come lo vede il DOS: due programmi e due righe.
//
// Il DOS da solo non sa cosa sia un CD. Per vederlo servivano due pezzi, e
// ognuno veniva dal suo fornitore: il **driver del lettore**, che sapeva
// parlare con quel lettore — lo si caricava dal CONFIG.SYS — e **MSCDEX**, che
// faceva comparire il CD come una lettera, D:, e traduceva il suo filesystem in
// quello che il DOS capisce. Qui i due pezzi sono quelli liberi di FreeDOS:
// UDVD2, che parla con qualunque lettore ATAPI, e SHSUCDX, che fa quello che
// faceva MSCDEX. E un terzo: UDVD2 si tiene i dati letti in 128 KB di memoria
// estesa, e senza un gestore della memoria XMS non si carica — su un DOS del
// 1995 quel gestore era HIMEM.SYS, qui è HIMEMX di FreeDOS.
//
// Stanno sul disco fisso che viaggia con alloldos, ma le due righe che li
// caricano no: le mette la pagina del Pentium e del 386, che hanno il lettore,
// e non quella del 286, che non ce l'ha. È lo stesso modo in cui si sceglie la
// tastiera.

import { FAT16 } from './fat.js';

const REPOSITORY = 'https://www.ibiblio.org/pub/micro/pc-stuff/freedos/files/repositories/1.3';

/** I tre pacchetti, e dentro il file che serve. I sorgenti viaggiano con loro. */
export const CD_PACKAGES = [
  { file: 'himemx.zip', source: `${REPOSITORY}/base/himemx.zip`, members: ['BIN/HIMEMX.EXE'] },
  { file: 'udvd2.zip', source: `${REPOSITORY}/drivers/udvd2.zip`, members: ['BIN/UDVD2.SYS'] },
  { file: 'shsucdx.zip', source: `${REPOSITORY}/base/shsucdx.zip`, members: ['BIN/SHSUCDX.COM'] },
];

/** Il nome con cui il driver si presenta e con cui SHSUCDX lo cerca. */
export const CD_DEVICE = 'CDROM001';

const CONFIG = 'CONFIG.SYS';
const AUTOEXEC = 'AUTOEXEC.BAT';
const DIR = 'FDOS\\BIN';

const DRIVER_LINE = /^\s*device(?:high)?\s*=\s*\S*udvd2\.sys\b/i;
/** La riga di HIMEMX che mettiamo noi: solo quella si toglie. */
const XMS_OURS = `DEVICE=C:\\${DIR}\\HIMEMX.EXE`;
/** Un gestore della memoria estesa che c'è già, messo da qualcun altro. */
const XMS_LINE = /^\s*device(?:high)?\s*=\s*\S*(?:himem\w*|jemmex|qemm\w*|xmgr)\.(?:sys|exe)\b/i;
const EXTENSION_LINE = /^\s*@?(?:[a-z]:)?(?:\S*\\)?shsucdx(?:\.com)?\b/i;
const PATH_LINE = /^\s*@?(?:path\b|set\s+path\s*=)/i;

const decode = (bytes) => String.fromCharCode(...bytes).replace(/\x1a[\s\S]*$/, '');
const encode = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);

function readLines(volume, name) {
  const bytes = volume.read(name);
  const lines = bytes ? decode(bytes).split(/\r?\n/) : [];
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function writeLines(volume, name, before, lines) {
  const after = lines.length ? `${lines.join('\r\n')}\r\n` : '';
  const old = before.length ? `${before.join('\r\n')}\r\n` : '';
  if (after === old) return false;
  volume.writeFile(null, name, encode(after));
  return true;
}

/**
 * Mette o toglie le righe del lettore di CD: HIMEMX in cima al CONFIG.SYS, se
 * un gestore della memoria estesa non c'è già, il driver in fondo, e SHSUCDX
 * nell'AUTOEXEC.BAT subito dopo il PATH. Il resto dei due
 * file resta com'era, riga per riga. Come per la tastiera, va fatto a macchina
 * spenta o subito prima di riaccenderla.
 *
 * @param {Uint8Array} image l'immagine del disco fisso
 * @param {boolean} on
 * @returns {{changed:boolean, missing?:'filesystem'|'driver'}}
 */
export function setCDROM(image, on) {
  const volume = FAT16.of(image);
  if (!volume) return { changed: false, missing: 'filesystem' };
  const needed = ['HIMEMX.EXE', 'UDVD2.SYS', 'SHSUCDX.COM'];
  if (on && needed.some((name) => volume.locate(`${DIR}\\${name}`) < 0)) {
    return { changed: false, missing: 'driver' };
  }

  const config = readLines(volume, CONFIG);
  const newConfig = config.filter((line) => !DRIVER_LINE.test(line) && line.trim().toUpperCase() !== XMS_OURS);
  if (on) {
    if (!newConfig.some((line) => XMS_LINE.test(line))) newConfig.unshift(XMS_OURS);
    newConfig.push(`DEVICE=C:\\${DIR}\\UDVD2.SYS /D:${CD_DEVICE}`);
  }
  const autoexec = readLines(volume, AUTOEXEC);
  const newAutoexec = autoexec.filter((line) => !EXTENSION_LINE.test(line));
  if (on) {
    let at = newAutoexec.length;
    for (let i = newAutoexec.length - 1; i >= 0; i--) {
      if (PATH_LINE.test(newAutoexec[i])) {
        at = i + 1;
        break;
      }
    }
    newAutoexec.splice(at, 0, `c:\\${DIR.toLowerCase()}\\shsucdx /D:${CD_DEVICE}`);
  }
  const changedConfig = writeLines(volume, CONFIG, config, newConfig);
  const changedAutoexec = writeLines(volume, AUTOEXEC, autoexec, newAutoexec);
  return { changed: changedConfig || changedAutoexec };
}
