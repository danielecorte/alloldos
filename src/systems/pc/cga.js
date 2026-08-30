// La scheda video, per la metà che c'è dall'inizio: il testo.
//
// Una CGA è un 6845 — lo stesso controllore di schermo di mezza informatica
// degli anni Ottanta — sedici KB di memoria a B800:0000 e un paio di registri.
// In modo testo la memoria è la pagina: due byte per carattere, il codice e
// l'attributo, ottanta per venticinque, e scrivere sullo schermo vuol dire
// scrivere in memoria. Non c'è nessuna chiamata da fare, ed è per questo che i
// programmi DOS che scrivono "a mano" a B800 sono istantanei e quelli che
// passano dal BIOS no.
//
// Il registro che qui conta più di tutti è quello di stato, 3DAh, e conta per
// un difetto: sulla CGA vera il processore e il pennello si contendono la stessa
// memoria, e un byte scritto mentre il pennello legge diventa un puntino bianco
// sullo schermo — la famosa neve. L'unico rimedio è aspettare che il pennello
// sia fuori dallo schermo, e si aspetta leggendo 3DAh in un ciclo stretto. Il
// BIOS lo fa prima di ogni singolo carattere, e quindi qui il pennello deve
// muoversi davvero: se il bit 0 non cambia mai, la macchina non stampa una A.
//
// La scheda che questa macchina monterà davvero è una VGA, ma una VGA accesa è
// una CGA con più registri intorno: il testo sta dove sta qui, e questa metà
// resta.

/** Il quarzo del video, da cui esce tutto il resto del segnale. */
export const DOT_CLOCK = 14318180;
/** Un rigo di scansione, in punti, e un quadro in righi: 912 x 262 fa 59,92 Hz. */
export const DOTS_PER_LINE = 912;
export const LINES_PER_FRAME = 262;
const DOTS_PER_FRAME = DOTS_PER_LINE * LINES_PER_FRAME;

/** Quanto se ne vede: 640 punti per 200 righi, il resto è margine e ritorno. */
const VISIBLE_DOTS = 640;
const VISIBLE_LINES = 200;
/** Dove cade il ritorno verticale: sedici righi, poco dopo la fine dell'immagine. */
const VSYNC_START = 224;
const VSYNC_END = 240;

export const CGA_BASE = 0xb8000;
export const CGA_SIZE = 0x4000;

export class CGA {
  constructor() {
    this.ram = new Uint8Array(CGA_SIZE);
    this.crtc = new Uint8Array(18);
    this.reset();
  }

  reset() {
    this.ram.fill(0);
    this.crtc.fill(0);
    this.index = 0;
    /** Il registro di modo (3D8h): 80 colonne, video acceso, e come. */
    this.mode = 0;
    /** Il colore di sfondo e la tavolozza in grafica (3D9h). */
    this.color = 0;
    this.dot = 0;
  }

  /** Fa correre il pennello di `dots` punti, e basta: qui non si disegna niente. */
  advance(dots) {
    this.dot = (this.dot + dots) % DOTS_PER_FRAME;
  }

  /** Dov'è il pennello adesso, in righi e punti dentro il rigo. */
  get line() {
    return (this.dot / DOTS_PER_LINE) | 0;
  }

  /**
   * Il registro di stato. Il bit 0 dice che in questo momento la memoria è
   * libera — cioè che il pennello non sta leggendo — e il bit 3 che siamo nel
   * ritorno verticale, quando è libera per un pezzo lungo.
   */
  get status() {
    const line = this.line;
    const x = this.dot % DOTS_PER_LINE;
    const displaying = line < VISIBLE_LINES && x < VISIBLE_DOTS;
    const vsync = line >= VSYNC_START && line < VSYNC_END;
    return (displaying ? 0 : 0x01) | (vsync ? 0x08 : 0);
  }

  read(port) {
    switch (port & 0x0f) {
      case 5:
        // Dei registri del 6845 se ne rileggono solo due, quelli del cursore.
        return this.index >= 14 && this.index <= 17 ? this.crtc[this.index] : 0;
      case 10:
        return this.status;
      default:
        return 0xff;
    }
  }

  write(port, value) {
    value &= 0xff;
    switch (port & 0x0f) {
      case 4:
        this.index = value & 0x1f;
        return;
      case 5:
        if (this.index < this.crtc.length) this.crtc[this.index] = value;
        return;
      case 8:
        this.mode = value;
        return;
      case 9:
        this.color = value;
        return;
      default:
    }
  }

  readMemory(offset) {
    return this.ram[offset & (CGA_SIZE - 1)];
  }

  writeMemory(offset, value) {
    this.ram[offset & (CGA_SIZE - 1)] = value & 0xff;
  }

  /** L'indirizzo da cui il 6845 comincia a leggere: due registri, in caratteri. */
  get startAddress() {
    return ((this.crtc[12] << 8) | this.crtc[13]) & 0x3fff;
  }

  /** Dove sta il cursore, nello stesso conto. */
  get cursorAddress() {
    return ((this.crtc[14] << 8) | this.crtc[15]) & 0x3fff;
  }

  /**
   * Lo schermo come testo, una stringa per riga. Non è come lo vedrebbe un
   * monitor — i colori e la forma delle lettere non c'entrano — ma è quello che
   * il programma crede di aver scritto, e serve a poterglielo chiedere.
   */
  text(columns = 80, rows = 25) {
    const lines = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let column = 0; column < columns; column++) {
        const offset = ((this.startAddress + row * columns + column) * 2) & (CGA_SIZE - 1);
        const code = this.ram[offset];
        line += code >= 32 && code < 127 ? String.fromCharCode(code) : code === 0 ? ' ' : '.';
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }
}
