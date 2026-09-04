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
// L'altra metà è la grafica, e la CGA ne ha due: 320 per 200 con quattro
// colori scelti da una tavolozza fissa — quella dei tramonti magenta e ciano
// che tutti ricordano — e 640 per 200 in bianco e nero. Sotto sono la stessa
// cosa: i bit dei pixel uno dietro l'altro nella stessa memoria del testo, con
// una stranezza che si portano dietro tutte e due, e cioè che i righi pari e
// quelli dispari stanno in due metà separate. Non è un capriccio: serviva a
// far tornare i conti al pennello senza aggiungere un contatore.
//
// I caratteri, invece, non sono qui. Sulla scheda vera c'è una ROM con il
// disegno di ogni lettera, e nemmeno quella si può distribuire; ma il BIOS ne
// porta una sua per la grafica — quella che usa quando deve scrivere dove non
// c'è modo testo — e questa scheda si fa prestare quella. È lo stesso disegno
// di lettere che si vede nel POST.

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

/** Quanto grande viene fuori un quadro: ottanta caratteri per venticinque. */
export const SCREEN_WIDTH = 640;
export const SCREEN_HEIGHT = 200;

/**
 * I sedici colori, che sono tre bit di colore più uno di intensità e non una
 * tavolozza scelta da qualcuno: rosso, verde e blu accesi o spenti, e poi
 * tutto un po' più chiaro. L'unico ritocco è il sesto, che sarebbe un giallo
 * scuro e che IBM ha fatto marrone perché il giallo scuro non esiste.
 */
export const PALETTE = [
  0xff000000, // 0  nero
  0xffaa0000, // 1  blu
  0xff00aa00, // 2  verde
  0xffaaaa00, // 3  ciano
  0xff0000aa, // 4  rosso
  0xffaa00aa, // 5  magenta
  0xff0055aa, // 6  marrone: il giallo scuro che IBM ha dovuto inventarsi
  0xffaaaaaa, // 7  grigio chiaro
  0xff555555, // 8  grigio scuro
  0xffff5555, // 9  blu chiaro
  0xff55ff55, // 10 verde chiaro
  0xffffff55, // 11 ciano chiaro
  0xff5555ff, // 12 rosso chiaro
  0xffff55ff, // 13 magenta chiaro
  0xff55ffff, // 14 giallo
  0xffffffff, // 15 bianco
];

/** Dove sta il disegno delle lettere dentro la ROM del BIOS: 128 caratteri. */
export const FONT_OFFSET = 0x1a6e;
export const FONT_CHARS = 128;
const CHAR_HEIGHT = 8;

/** I bit del registro di modo (3D8h). */
const MODE_TEXT_80 = 0x01;
const MODE_GRAPHICS = 0x02;
const MODE_MONO = 0x04;
const MODE_ENABLE = 0x08;
const MODE_HIRES = 0x10;
const MODE_BLINK = 0x20;

export class CGA {
  constructor(font = null) {
    this.ram = new Uint8Array(CGA_SIZE);
    this.crtc = new Uint8Array(18);
    /** Il generatore di caratteri: otto byte per lettera, uno per rigo. */
    this.font = font ?? new Uint8Array(FONT_CHARS * CHAR_HEIGHT);
    this.framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    this.reset();
  }

  /** Prende il disegno delle lettere dalla ROM del BIOS. */
  useFontFrom(bios) {
    const font = bios.subarray(FONT_OFFSET, FONT_OFFSET + FONT_CHARS * CHAR_HEIGHT);
    if (font.length === FONT_CHARS * CHAR_HEIGHT) this.font = font;
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
    /** Quanti quadri sono passati: il lampeggio del cursore si conta in quadri. */
    this.frames = 0;
  }

  /** Fa correre il pennello di `dots` punti; l'immagine si compone alla fine. */
  advance(dots) {
    const next = this.dot + dots;
    if (next >= DOTS_PER_FRAME) this.frames += Math.floor(next / DOTS_PER_FRAME);
    this.dot = next % DOTS_PER_FRAME;
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
   * Compone il quadro: quello che si vedrebbe adesso su un monitor.
   *
   * Non è una fotografia del pennello — il pennello qui serve solo a far
   * tornare i tempi — ma il contenuto della memoria letto come lo leggerebbe
   * il pennello in un quadro intero. Su una macchina vera le due cose
   * coincidono, tranne che per la neve.
   *
   * @returns {Uint32Array} 640 per 200 punti, pronti per una canvas
   */
  render() {
    const pixels = this.framebuffer;
    if (!(this.mode & MODE_ENABLE)) {
      pixels.fill(PALETTE[0]);
      return pixels;
    }
    if (this.mode & MODE_GRAPHICS) this.renderGraphics(pixels);
    else this.renderText(pixels);
    return pixels;
  }

  /**
   * Il modo testo. Ogni carattere sono due byte — il codice e l'attributo — e
   * l'attributo sono due colori di quattro bit: sfondo e primo piano. Il bit
   * più alto dello sfondo però ha due mestieri, e quale dei due lo decide un
   * bit del registro di modo: o è l'intensità del colore di fondo, o dice che
   * il carattere deve lampeggiare. Quasi tutti sceglievano il lampeggio, ed è
   * per questo che sul DOS non si è mai visto uno sfondo giallo chiaro.
   */
  renderText(pixels) {
    const columns = this.mode & MODE_TEXT_80 ? 80 : 40;
    const rows = 25;
    const width = SCREEN_WIDTH;
    const cellWidth = width / columns;
    const blinkOn = (this.frames >> 4) & 1;
    const cursorOn = (this.frames >> 3) & 1;
    const cursorStart = this.crtc[10] & 0x1f;
    const cursorEnd = this.crtc[11] & 0x1f;
    const cursorHidden = (this.crtc[10] & 0x60) === 0x20 || cursorStart > cursorEnd;
    const cursorAt = this.cursorAddress;

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const cell = (this.startAddress + row * columns + column) & 0x1fff;
        const code = this.ram[(cell * 2) & (CGA_SIZE - 1)];
        const attribute = this.ram[(cell * 2 + 1) & (CGA_SIZE - 1)];
        const blinking = (this.mode & MODE_BLINK) !== 0 && (attribute & 0x80) !== 0;
        const ink = PALETTE[attribute & 0x0f];
        const paper = PALETTE[(attribute >> 4) & (this.mode & MODE_BLINK ? 0x07 : 0x0f)];
        const hidden = blinking && blinkOn;
        const glyph = code < FONT_CHARS ? code : 0;
        const cursorHere = !cursorHidden && cursorOn && cell === cursorAt;

        for (let line = 0; line < CHAR_HEIGHT; line++) {
          const bits = hidden ? 0 : this.font[glyph * CHAR_HEIGHT + line];
          const onCursor = cursorHere && line >= cursorStart && line <= cursorEnd;
          let offset = (row * CHAR_HEIGHT + line) * width + column * cellWidth;
          for (let x = 0; x < 8; x++) {
            const lit = onCursor || (bits & (0x80 >> x)) !== 0;
            const color = lit ? ink : paper;
            // In quaranta colonne ogni punto è largo due: la scheda non
            // cambia risoluzione, raddoppia i punti.
            for (let repeat = 0; repeat < cellWidth / 8; repeat++) {
              pixels[offset++] = color;
            }
          }
        }
      }
    }
  }

  /**
   * La grafica. Due bit per punto in bassa risoluzione, uno in alta, e in
   * mezzo la stranezza dei righi: i pari stanno nei primi ottomila byte, i
   * dispari negli ottomila dopo. Chi scriveva giochi lo sapeva a memoria.
   */
  renderGraphics(pixels) {
    const hires = (this.mode & MODE_HIRES) !== 0;
    const background = PALETTE[this.color & 0x0f];
    // La tavolozza non si sceglie: se ne sceglie una delle due (o tre, con il
    // bit del bianco e nero), e il colore 0 è quello di sfondo.
    const bright = (this.color & 0x10) !== 0;
    const palette = (this.color & 0x20) || this.mode & MODE_MONO
      ? [3, 4, 7] // ciano, magenta, bianco
      : [2, 4, 6]; // verde, rosso, marrone
    const colors = [
      background,
      PALETTE[palette[0] | (bright ? 8 : 0)],
      PALETTE[palette[1] | (bright ? 8 : 0)],
      PALETTE[palette[2] | (bright ? 8 : 0)],
    ];
    const white = PALETTE[bright ? 15 : 7];

    for (let y = 0; y < SCREEN_HEIGHT; y++) {
      const bank = (y & 1) * 0x2000;
      const line = bank + (y >> 1) * 80;
      let offset = y * SCREEN_WIDTH;
      for (let byte = 0; byte < 80; byte++) {
        const bits = this.ram[(line + byte) & (CGA_SIZE - 1)];
        if (hires) {
          for (let bit = 7; bit >= 0; bit--) {
            pixels[offset++] = bits & (1 << bit) ? white : PALETTE[0];
          }
        } else {
          for (let pair = 6; pair >= 0; pair -= 2) {
            const color = colors[(bits >> pair) & 3];
            pixels[offset++] = color;
            pixels[offset++] = color;
          }
        }
      }
    }
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
