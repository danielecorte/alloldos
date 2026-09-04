// La ULA, che è tutto lo Spectrum tranne il processore e la memoria.
//
// Dentro un ZX Spectrum ci sono tre cose: uno Z80, 64 KB fra ROM e RAM, e un
// solo chip fatto fare apposta — un array logico non impegnato, cioè un
// pezzo di silicio generico che Ferranti programmava su commissione. Quel
// chip fa il video, la tastiera, l'altoparlante, il nastro e il bordo. Non
// c'è nient'altro: nessun chip sonoro, nessun generatore di sprite, nessun
// controllore di interruzioni. Costava 125 sterline, e questo è il motivo.
//
// Il video è la parte che si ricorda, per il modo strano in cui è messa in
// memoria. I 6144 byte dei pixel non stanno per righe: stanno in tre blocchi
// da 2048, e dentro ogni blocco si va prima di otto righe in otto righe e poi
// dentro il carattere. Il conto è che l'indirizzo si compone dai bit della
// riga rimescolati — due bit di terzo, tre di riga dentro il carattere, tre
// di riga di caratteri — e questo perché così l'incremento del contatore
// video costava meno porte logiche. È lo stesso motivo per cui i colori sono
// altrove e sono pochi: 768 byte di attributi, uno per ogni quadretto di otto
// per otto, con due colori dentro. Due colori per quadretto è la ragione di
// tutte le macchie che hanno i giochi dello Spectrum quando due cose si
// sovrappongono — il famoso «attribute clash», che nessuno ha mai chiamato
// così mentre ci giocava.
//
// La tastiera è quaranta tasti su otto mezze righe, lette da una porta sola:
// l'indirizzo alto dice quale mezza riga guardare, e i cinque bit bassi
// tornano a zero per i tasti premuti. Il bordo, l'altoparlante e il nastro
// stanno tutti sulla stessa porta, in scrittura.

/** Il quarzo, diviso per due: 3,5 MHz per il processore. */
export const CPU_CLOCK = 3500000;

/** Un quadro PAL: 312 righe da 224 T-state, che fanno 50,08 Hz. */
export const LINE_CYCLES = 224;
export const LINES_PER_FRAME = 312;
export const FRAME_CYCLES = LINE_CYCLES * LINES_PER_FRAME;
export const FPS = CPU_CLOCK / FRAME_CYCLES;

/** Quanto se ne vede: l'immagine, più il bordo che qui teniamo. */
export const BORDER_X = 32;
export const BORDER_Y = 24;
export const SCREEN_WIDTH = 256 + BORDER_X * 2;
export const SCREEN_HEIGHT = 192 + BORDER_Y * 2;

/** Da che rigo comincia l'immagine: prima ci sono 64 righi di bordo. */
const FIRST_DISPLAY_LINE = 64;

/** La memoria video, dove la ULA va a leggere: pixel e poi attributi. */
export const SCREEN_BASE = 0x4000;
export const ATTRIBUTE_BASE = 0x5800;

/**
 * Gli otto colori, ognuno in due luminosità. Non è una tavolozza scelta: sono
 * i tre fili di rosso, verde e blu accesi o spenti, più un quarto filo che li
 * alza tutti insieme — e il nero brillante è nero come l'altro, perché
 * alzare zero non cambia niente.
 */
export const PALETTE = [
  0xff000000, 0xffd70000, 0xff0000d7, 0xffd700d7,
  0xff00d700, 0xffd7d700, 0xff00d7d7, 0xffd7d7d7,
  0xff000000, 0xffff0000, 0xff0000ff, 0xffff00ff,
  0xff00ff00, 0xffffff00, 0xff00ffff, 0xffffffff,
];

/**
 * La matrice della tastiera: otto mezze righe da cinque tasti, nell'ordine in
 * cui rispondono ai bit. La riga la sceglie un bit a zero nell'indirizzo alto.
 */
export const KEY_ROWS = [
  ['Shift', 'Z', 'X', 'C', 'V'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'],
  ['P', 'O', 'I', 'U', 'Y'],
  ['Enter', 'L', 'K', 'J', 'H'],
  ['Space', 'SymbolShift', 'M', 'N', 'B'],
];

export class ULA {
  /**
   * @param {Uint8Array} memory i 64 KB della macchina, da cui legge i pixel
   */
  constructor(memory) {
    this.memory = memory;
    this.framebuffer = new Uint32Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    /** Le cinque righe di tasti premuti, un bit per tasto. */
    this.keys = new Uint8Array(8);
    this.reset();
  }

  reset() {
    this.border = 7;
    /** Il filo dell'altoparlante e quello che va al nastro. */
    this.speaker = 0;
    this.mic = 0;
    /** Quello che arriva dal nastro, se c'è un nastro che suona. */
    this.ear = 0;
    this.keys.fill(0);
    /** Il joystick Kempston, che è una scheda ma la leggono tutti. */
    this.joystick = 0;
    /**
     * I cambi del bit dell'altoparlante dentro il quadro, con l'ora di
     * ognuno: è tutto quello che serve per rifare il suono, perché il suono è
     * esattamente quel bit.
     */
    this.audioEvents = [{ t: 0, level: 0 }];
    this.speakerChanges = 0;
    /** I cambi di colore del bordo dentro il quadro, con l'ora di ognuno. */
    this.borderChanges = [{ t: 0, colour: 7 }];
    this.frames = 0;
  }

  /** Un quadro nuovo: il bordo riparte da dov'era rimasto. */
  startFrame() {
    const last = this.borderChanges[this.borderChanges.length - 1];
    this.borderChanges = [{ t: 0, colour: last ? last.colour : this.border }];
    this.audioEvents = [{ t: 0, level: this.speaker }];
    this.frames++;
  }

  // ------------------------------------------------------------- le porte

  /**
   * La scrittura sulla porta FEh, che è tre cose insieme: il colore del bordo
   * nei tre bit bassi, l'altoparlante nel bit 4, e il filo che scrive sul
   * nastro nel bit 3.
   */
  write(value, t) {
    const colour = value & 7;
    if (colour !== this.border) {
      this.border = colour;
      this.borderChanges.push({ t, colour });
    }
    const speaker = (value >> 4) & 1;
    if (speaker !== this.speaker) {
      this.speakerChanges++;
      this.audioEvents.push({ t, level: speaker });
    }
    this.speaker = speaker;
    this.mic = (value >> 3) & 1;
  }

  /**
   * La lettura della porta FEh. L'indirizzo alto dice quali mezze righe
   * guardare — un bit a zero per ognuna — e i cinque bit bassi tornano con
   * uno zero per ogni tasto premuto in quelle righe. Il bit 6 è il nastro.
   *
   * Che le righe si possano guardare in più di una alla volta non è una
   * stranezza: è come si leggono le combinazioni di tasti, e come il BASIC
   * controlla se è stato premuto qualcosa senza sapere cosa.
   */
  read(port) {
    let result = 0x1f;
    const high = (port >> 8) & 0xff;
    for (let row = 0; row < 8; row++) {
      if (!(high & (1 << row))) result &= ~this.keys[row];
    }
    return (result & 0x1f) | 0xa0 | (this.ear ? 0x40 : 0);
  }

  /** Il tasto premuto o lasciato, dato il posto che ha nella matrice. */
  setKey(row, bit, down) {
    if (row < 0 || row > 7) return;
    if (down) this.keys[row] |= 1 << bit;
    else this.keys[row] &= ~(1 << bit);
  }

  clearKeys() {
    this.keys.fill(0);
  }

  // ------------------------------------------------------------ l'immagine

  /** Di che colore era il bordo quando il pennello era a `t`. */
  borderAt(t) {
    let colour = this.borderChanges[0].colour;
    for (const change of this.borderChanges) {
      if (change.t > t) break;
      colour = change.colour;
    }
    return colour;
  }

  /**
   * L'indirizzo del byte di pixel di una riga. È il rimescolamento di bit che
   * ha reso famoso questo schermo: la riga 1 non sta sotto la riga 0, sta
   * 2048 byte più in là.
   */
  static pixelAddress(y, column) {
    return (
      SCREEN_BASE +
      ((y & 0xc0) << 5) +
      ((y & 0x07) << 8) +
      ((y & 0x38) << 2) +
      column
    );
  }

  /**
   * Compone il quadro. Il lampeggio è un bit dell'attributo e un contatore
   * che gira ogni sedici quadri: quando è acceso, inchiostro e fondo si
   * scambiano — che è tutta l'animazione che la ULA sa fare da sola.
   */
  render() {
    const pixels = this.framebuffer;
    const flash = (this.frames >> 4) & 1;

    for (let line = 0; line < SCREEN_HEIGHT; line++) {
      const screenLine = line - BORDER_Y;
      const rowT = (FIRST_DISPLAY_LINE - BORDER_Y + line) * LINE_CYCLES;
      let offset = line * SCREEN_WIDTH;

      if (screenLine < 0 || screenLine >= 192) {
        // Riga tutta di bordo: il colore può cambiare mentre il pennello la
        // percorre, ed è così che si fanno le bande dei caricamenti.
        for (let x = 0; x < SCREEN_WIDTH; x += 8) {
          const colour = PALETTE[this.borderAt(rowT + (x >> 1))];
          for (let i = 0; i < 8; i++) pixels[offset++] = colour;
        }
        continue;
      }

      for (let x = 0; x < BORDER_X; x += 8) {
        const colour = PALETTE[this.borderAt(rowT + (x >> 1))];
        for (let i = 0; i < 8; i++) pixels[offset++] = colour;
      }

      const attributeRow = ATTRIBUTE_BASE + (screenLine >> 3) * 32;
      for (let column = 0; column < 32; column++) {
        const bits = this.memory[ULA.pixelAddress(screenLine, column)];
        const attribute = this.memory[attributeRow + column];
        const bright = (attribute >> 6) & 1 ? 8 : 0;
        let ink = PALETTE[(attribute & 7) | bright];
        let paper = PALETTE[((attribute >> 3) & 7) | bright];
        if (attribute & 0x80 && flash) {
          const swap = ink;
          ink = paper;
          paper = swap;
        }
        for (let bit = 7; bit >= 0; bit--) {
          pixels[offset++] = bits & (1 << bit) ? ink : paper;
        }
      }

      for (let x = 0; x < BORDER_X; x += 8) {
        const colour = PALETTE[this.borderAt(rowT + ((BORDER_X + 256 + x) >> 1))];
        for (let i = 0; i < 8; i++) pixels[offset++] = colour;
      }
    }
    return pixels;
  }

  /**
   * Lo schermo come testo, per chi lo sta provando a schermo spento. Non è
   * quello che il BASIC crede di aver scritto — sullo Spectrum non c'è nessuna
   * memoria di caratteri, ci sono solo pixel — ma i pixel riconosciuti uno per
   * uno contro il disegno delle lettere che sta nella ROM.
   *
   * @param {Uint8Array} rom la ROM, dove a 3D00h c'è il disegno dei caratteri
   */
  text(rom) {
    const lines = [];
    for (let row = 0; row < 24; row++) {
      let line = '';
      for (let column = 0; column < 32; column++) {
        const glyph = [];
        for (let y = 0; y < 8; y++) {
          glyph.push(this.memory[ULA.pixelAddress(row * 8 + y, column)]);
        }
        line += matchCharacter(glyph, rom);
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines;
  }
}

/** Cerca fra i 96 caratteri della ROM quello disegnato in questi otto byte. */
function matchCharacter(glyph, rom) {
  if (glyph.every((byte) => byte === 0)) return ' ';
  const inverted = glyph.map((byte) => ~byte & 0xff);
  for (let code = 32; code < 128; code++) {
    const base = 0x3d00 + (code - 32) * 8;
    let normal = true;
    let reverse = true;
    for (let y = 0; y < 8; y++) {
      if (rom[base + y] !== glyph[y]) normal = false;
      if (rom[base + y] !== inverted[y]) reverse = false;
    }
    if (normal || reverse) return String.fromCharCode(code);
  }
  return '?';
}
