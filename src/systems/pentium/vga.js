// La VGA, che è l'ultima scheda video che tutti hanno avuto uguale.
//
// Dal 1987 al 1995 ogni PC ne ha avuta una, e ogni scheda uscita dopo — Cirrus,
// Trident, S3, Matrox, fino alle schede 3D — comincia comportandosi come questa,
// perché è così che si accende il DOS. Anche il computer su cui stai leggendo,
// se lo si accende senza driver, fa ancora questi registri.
//
// Dentro non è un chip: sono cinque, e si parla a ognuno da una coppia di porte
// con lo stesso trucco di sempre — si scrive quale registro nella prima e il
// valore nella seconda. Il **CRTC** (3D4h) dice la forma del quadro: quante
// colonne, quante righe, dove comincia la memoria, dov'è il cursore. Il
// **sequencer** (3C4h) dice come è organizzata la memoria. Il **graphics
// controller** (3CEh) sta fra il processore e i quattro piani di memoria, e è la
// parte difficile. L'**attribute controller** (3C0h) traduce i colori logici in
// colori veri. Il **DAC** (3C8h) tiene i 256 colori.
//
// La parte difficile è la memoria, e vale la pena spiegarla perché è la cosa più
// strana di tutto il PC. La VGA ha 256 KB, ma la finestra che il processore vede
// è di 64: perché la memoria è divisa in **quattro piani paralleli**, e a ogni
// indirizzo ci sono quattro byte, uno per piano. Quando si scrive un byte, quel
// byte va in tutti i piani che il sequencer lascia aperti; e poiché ogni piano
// tiene un bit del colore di ogni punto, un byte scritto una volta accende otto
// punti. È il modo con cui una scheda del 1987 riusciva a riempire uno schermo a
// sedici colori con un bus a sedici bit — e il motivo per cui i giochi in modo
// 12h erano così difficili da scrivere.
//
// Il modo testo usa la stessa memoria in un modo diverso ancora: il piano 0 tiene
// i caratteri, il piano 1 gli attributi, e il piano 2 il **disegno delle
// lettere** — che quindi non è in una ROM ma in RAM, ed è per questo che sul DOS
// si potevano ridefinire i caratteri.

/** Dove si affaccia la memoria, e quanta ce n'è. */
export const VIDEO_BASE = 0xa0000;
export const VIDEO_SIZE = 0x20000;
export const VRAM_SIZE = 256 * 1024;
const PLANE = 64 * 1024;

/**
 * I sedici colori della EGA, che la VGA si tiene per compatibilità: sono i 64
 * colori possibili di un DAC a sei bit per canale, e questi sedici sono quelli
 * che il BIOS carica all'avvio. Il grigio scuro al posto del nero brillante è il
 * dettaglio che tutti ricordano senza saperlo.
 */
const DEFAULT_DAC = [
  [0, 0, 0], [0, 0, 42], [0, 42, 0], [0, 42, 42],
  [42, 0, 0], [42, 0, 42], [42, 21, 0], [42, 42, 42],
  [21, 21, 21], [21, 21, 63], [21, 63, 21], [21, 63, 63],
  [63, 21, 21], [63, 21, 63], [63, 63, 21], [63, 63, 63],
];

/** Il quadro, a settanta al secondo come lo manda una VGA in modo testo. */
const FRAME_RATE = 70;
/** Quanta parte del quadro è ritorno verticale: è l'unico tempo morto che conta. */
const VBLANK_FRACTION = 0.06;

export class VGA {
  /**
   * @param {number} clock i cicli al secondo del processore, per contare i quadri
   */
  constructor(clock) {
    this.clock = clock;
    /** I quattro piani, uno dietro l'altro: 64 KB per piano. */
    this.memory = new Uint8Array(VRAM_SIZE);
    this.framebuffer = new Uint32Array(0);
    /** La finestra lineare, che una VGA vera non ha: la avrà la scheda dopo. */
    this.linearBase = 0;
    this.linearSize = 0;
    this.reset();
  }

  reset() {
    this.memory.fill(0);
    this.crtc = new Uint8Array(32);
    this.sequencer = new Uint8Array(8);
    this.graphics = new Uint8Array(16);
    this.attribute = new Uint8Array(32);
    this.dac = new Uint8Array(768);
    for (let i = 0; i < 16; i++) {
      const [r, g, b] = DEFAULT_DAC[i];
      this.dac[i * 3] = r;
      this.dac[i * 3 + 1] = g;
      this.dac[i * 3 + 2] = b;
    }

    this.crtcIndex = 0;
    this.sequencerIndex = 0;
    this.graphicsIndex = 0;
    this.attributeIndex = 0;
    /**
     * L'attribute controller ha una porta sola per l'indice e il dato, e si
     * alterna: prima scrittura l'indice, seconda il valore. Il bistabile che
     * ricorda dove siamo si azzera leggendo il registro di stato — ed è la
     * ragione per cui ogni programma che tocca i colori legge prima 3DAh.
     */
    this.attributeFlipFlop = false;
    this.dacIndex = 0;
    this.dacLatch = 0;
    this.dacWriteIndex = 0;
    this.dacReadIndex = 0;

    /** Il registro di uscita generale: dove risponde il CRTC, e il quarzo. */
    this.misc = 0x01;
    this.featureControl = 0;
    /** I quattro byte che il processore ha letto per ultimi, uno per piano. */
    this.latch = new Uint8Array(4);
    this.cycles = 0;
    this.frames = 0;
    this.sequencer[2] = 0x0f; // all'accensione tutti i piani sono aperti
    this.sequencer[4] = 0x00;
    this.graphics[6] = 0x00;
    // La maschera dei bit lascia passare tutto: a zero non passerebbe niente, e
    // una scheda che si sveglia incapace di scrivere non sarebbe una scheda.
    this.graphics[8] = 0xff;
  }

  // ------------------------------------------------------------ il tempo

  advance(cycles) {
    this.cycles += cycles;
    const perFrame = this.clock / FRAME_RATE;
    while (this.cycles >= perFrame) {
      this.cycles -= perFrame;
      this.frames++;
    }
  }

  /** Se in questo momento il pennello è tornato in cima. */
  get inVBlank() {
    return this.cycles > (this.clock / FRAME_RATE) * (1 - VBLANK_FRACTION);
  }

  // ------------------------------------------------------------ le porte

  /** Il CRTC risponde a 3D4h o a 3B4h, e lo decide un bit del registro generale. */
  get colorPorts() {
    return (this.misc & 1) !== 0;
  }

  readPort(port) {
    // Con il bit del colore spento le porte si spostano di 20h, come su una
    // scheda monocromatica: è il modo in cui una macchina con due schede video
    // teneva separate quella a colori e quella verde.
    const at = this.colorPorts ? port : port + 0x20;
    switch (at) {
      case 0x3c0:
        return this.attributeIndex;
      case 0x3c1:
        return this.attribute[this.attributeIndex & 0x1f];
      case 0x3c2:
        // Lo stato zero: il bit 4 dice al BIOS che il monitor è a colori.
        return 0x10;
      case 0x3c4:
        return this.sequencerIndex;
      case 0x3c5:
        return this.sequencer[this.sequencerIndex & 7];
      case 0x3c6:
        return this.dacMask ?? 0xff;
      case 0x3c7:
        return this.dacState ?? 0;
      case 0x3c8:
        return this.dacWriteIndex;
      case 0x3c9: {
        const value = this.dac[this.dacReadIndex * 3 + this.dacLatch];
        this.dacLatch++;
        if (this.dacLatch === 3) {
          this.dacLatch = 0;
          this.dacReadIndex = (this.dacReadIndex + 1) & 0xff;
        }
        return value;
      }
      case 0x3cc:
        return this.misc;
      case 0x3ca:
        return this.featureControl;
      case 0x3ce:
        return this.graphicsIndex;
      case 0x3cf:
        return this.graphics[this.graphicsIndex & 0x0f];
      case 0x3d4:
        return this.crtcIndex;
      case 0x3d5:
        return this.crtc[this.crtcIndex & 0x1f];
      case 0x3da: {
        // Il registro di stato, e l'atto di leggerlo azzera il bistabile
        // dell'attribute controller. Due mestieri in una lettura, come sempre.
        this.attributeFlipFlop = false;
        const vblank = this.inVBlank;
        return (vblank ? 0x08 : 0) | (vblank || this.cycles % 100 < 20 ? 0x01 : 0);
      }
      default:
        return 0xff;
    }
  }

  writePort(port, value) {
    value &= 0xff;
    const at = this.colorPorts || port === 0x3c2 ? port : port + 0x20;
    switch (at) {
      case 0x3c0:
        if (!this.attributeFlipFlop) {
          this.attributeIndex = value & 0x3f;
          this.attributeFlipFlop = true;
        } else {
          this.attribute[this.attributeIndex & 0x1f] = value;
          this.attributeFlipFlop = false;
        }
        return;
      case 0x3c2:
        this.misc = value;
        return;
      case 0x3c4:
        this.sequencerIndex = value & 7;
        return;
      case 0x3c5:
        this.sequencer[this.sequencerIndex & 7] = value;
        return;
      case 0x3c6:
        this.dacMask = value;
        return;
      case 0x3c7:
        this.dacReadIndex = value;
        this.dacLatch = 0;
        this.dacState = 3;
        return;
      case 0x3c8:
        this.dacWriteIndex = value;
        this.dacLatch = 0;
        this.dacState = 0;
        return;
      case 0x3c9:
        this.dac[this.dacWriteIndex * 3 + this.dacLatch] = value & 0x3f;
        this.dacLatch++;
        if (this.dacLatch === 3) {
          this.dacLatch = 0;
          this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xff;
        }
        return;
      case 0x3ca:
        this.featureControl = value;
        return;
      case 0x3ce:
        this.graphicsIndex = value & 0x0f;
        return;
      case 0x3cf:
        this.graphics[this.graphicsIndex & 0x0f] = value;
        return;
      case 0x3d4:
        this.crtcIndex = value & 0x1f;
        return;
      case 0x3d5:
        // I due registri in cima sono protetti da un bit: è il modo in cui la
        // VGA impedisce a un programma EGA di sballare la sincronia verticale.
        if (this.crtcIndex <= 7 && this.crtc[0x11] & 0x80 && this.crtcIndex !== 7) return;
        this.crtc[this.crtcIndex & 0x1f] = value;
        return;
      default:
    }
  }

  // ---------------------------------------------------------- la memoria

  /** La finestra: A0000-AFFFF, B0000-B7FFF o B8000-BFFFF, secondo il registro 6. */
  window() {
    switch ((this.graphics[6] >> 2) & 3) {
      case 0:
        return { base: 0x00000, size: 0x20000 }; // tutti i 128 KB
      case 1:
        return { base: 0x00000, size: 0x10000 };
      case 2:
        return { base: 0x10000, size: 0x8000 };
      default:
        return { base: 0x18000, size: 0x8000 };
    }
  }

  /** Da indirizzo nella finestra a indirizzo dentro un piano, o -1 se fuori. */
  offsetOf(offset) {
    const { base, size } = this.window();
    if (offset < base || offset >= base + size) return -1;
    let at = offset - base;
    if (this.chain4) return at; // in chain-4 l'indirizzo sceglie anche il piano
    if (this.oddEven) at >>= 1; // in odd/even due indirizzi condividono un byte
    return at & 0xffff;
  }

  get chain4() {
    return (this.sequencer[4] & 0x08) !== 0;
  }

  /** Se i piani vanno a coppie pari/dispari, che è come funziona il modo testo. */
  get oddEven() {
    return (this.sequencer[4] & 0x04) === 0;
  }

  read(offset) {
    const at = this.offsetOf(offset);
    if (at < 0) return 0xff;
    if (this.chain4) {
      // Chain-4: i due bit bassi dell'indirizzo scelgono il piano, ed è così che
      // 320×200 a 256 colori diventa un byte per punto in fila.
      return this.memory[(at >> 2) + (at & 3) * PLANE];
    }
    let plane = this.graphics[4] & 3;
    if (this.oddEven) plane = (plane & 2) | (offset & 1);
    // Le quattro latch si caricano a ogni lettura, tutte e quattro: è da lì che
    // le scritture prendono i bit che non cambiano.
    for (let i = 0; i < 4; i++) this.latch[i] = this.memory[at + i * PLANE];
    if ((this.graphics[5] & 0x08) !== 0) {
      // Modo di lettura 1: non consegna i byte, consegna il confronto con un
      // colore — un bit per punto, acceso dove il colore combacia.
      const care = this.graphics[7] & 0x0f;
      const want = this.graphics[2] & 0x0f;
      let result = 0;
      for (let bit = 0; bit < 8; bit++) {
        let colour = 0;
        for (let i = 0; i < 4; i++) colour |= ((this.latch[i] >> (7 - bit)) & 1) << i;
        if (((colour ^ want) & care) === 0) result |= 0x80 >> bit;
      }
      return result;
    }
    return this.latch[plane];
  }

  /**
   * Scrivere un byte, che è la cosa che sembra facile e non lo è.
   *
   * Ci sono quattro modi di scrittura, e ognuno è nato per un mestiere diverso.
   * Il **modo 0** è il generale: il byte si fa ruotare, si mescola con quello che
   * c'era secondo una funzione logica, e passa solo dove la maschera dei bit
   * lascia passare — e dove il "set/reset" dice, va invece un colore fisso al
   * posto del byte. Il **modo 1** ricopia le quattro latch così come sono, e serve
   * a spostare pezzi di schermo alla velocità della memoria. Il **modo 2** prende i
   * quattro bit bassi del byte come un *colore* e li spalma sui punti che la
   * maschera lascia passare: è il modo con cui si disegna una linea. Il **modo 3**
   * usa il byte come maschera e il set/reset come colore.
   */
  write(offset, value) {
    const at = this.offsetOf(offset);
    if (at < 0) return;
    value &= 0xff;

    if (this.chain4) {
      const plane = at & 3;
      if ((this.sequencer[2] >> plane) & 1) this.memory[(at >> 2) + plane * PLANE] = value;
      return;
    }

    const mode = this.graphics[5] & 3;
    const rotate = this.graphics[3] & 7;
    const operation = (this.graphics[3] >> 3) & 3;
    const setReset = this.graphics[0] & 0x0f;
    const enableSetReset = this.graphics[1] & 0x0f;
    const bitMask = this.graphics[8];
    let enabled = this.sequencer[2] & 0x0f;
    if (this.oddEven) enabled &= offset & 1 ? 0x0a : 0x05;

    const rotated = ((value >> rotate) | (value << (8 - rotate))) & 0xff;
    for (let plane = 0; plane < 4; plane++) {
      if (!((enabled >> plane) & 1)) continue;
      let source;
      let mask = bitMask;
      switch (mode) {
        case 0:
          source = (enableSetReset >> plane) & 1 ? ((setReset >> plane) & 1 ? 0xff : 0x00) : rotated;
          break;
        case 1:
          this.memory[at + plane * PLANE] = this.latch[plane];
          continue;
        case 2:
          source = (value >> plane) & 1 ? 0xff : 0x00;
          break;
        default:
          source = (setReset >> plane) & 1 ? 0xff : 0x00;
          mask = bitMask & rotated;
      }
      const latched = this.latch[plane];
      let combined = source;
      if (mode !== 3) {
        if (operation === 1) combined = source & latched;
        else if (operation === 2) combined = source | latched;
        else if (operation === 3) combined = source ^ latched;
      }
      this.memory[at + plane * PLANE] = (combined & mask) | (latched & ~mask);
    }
  }

  /** La finestra lineare, che questa scheda non ha: risponde per non far male. */
  readLinear() {
    return 0xff;
  }

  writeLinear() {}

  // ------------------------------------------------------ comporre il quadro

  /** Se lo schermo è accesso: il bit del sequencer che spegne tutto. */
  get enabled() {
    return (this.sequencer[1] & 0x20) === 0 && (this.attribute[0x10] !== undefined);
  }

  get graphicsMode() {
    return (this.graphics[6] & 1) !== 0;
  }

  /** L'altezza di un carattere: quanti righi di scansione, dal registro 9. */
  get charHeight() {
    return (this.crtc[9] & 0x1f) + 1;
  }

  /** Quante colonne di testo, dal registro 1 del CRTC. */
  get columns() {
    return this.crtc[1] + 1;
  }

  get rows() {
    const height = this.charHeight;
    return Math.floor((this.visibleLines + 1) / height);
  }

  /** Quanti righi si vedono, dai registri della fine dello schermo. */
  get visibleLines() {
    const overflow = this.crtc[7];
    return this.crtc[18] | ((overflow & 0x02) << 7) | ((overflow & 0x40) << 3);
  }

  /** La larghezza di un carattere in punti: nove o otto, e la sceglie un bit. */
  get charWidth() {
    return this.sequencer[1] & 0x01 ? 8 : 9;
  }

  get startAddress() {
    return ((this.crtc[12] << 8) | this.crtc[13]) & 0xffff;
  }

  get cursorAddress() {
    return ((this.crtc[14] << 8) | this.crtc[15]) & 0xffff;
  }

  get cursorVisible() {
    return (this.crtc[10] & 0x20) === 0;
  }

  /**
   * Quanto si sposta l'indirizzo passando da una riga alla successiva, contato
   * nelle unità con cui la scheda indirizza la memoria: caratteri nel modo testo,
   * byte di un piano in grafica. Il registro tiene la metà del numero — il
   * contatore degli indirizzi lavora a parole — e per una riga da 80 colonne ci
   * sta scritto 40.
   */
  get rowUnits() {
    return (this.crtc[19] || 40) * 2;
  }

  /** Il colore vero di un colore logico, passando dalla tavolozza e dal DAC. */
  colour(index) {
    const palette = this.attribute[index & 0x0f] & 0x3f;
    const select = this.attribute[0x14] ?? 0;
    // Il registro di selezione presta i due o i quattro bit alti: è il trucco con
    // cui si cambiavano tutti i colori di una schermata in una scrittura sola.
    const entry =
      (this.attribute[0x10] & 0x80
        ? (palette & 0x0f) | ((select & 0x0f) << 4)
        : palette | ((select & 0x0c) << 4)) & 0xff;
    return this.dacColour(entry);
  }

  dacColour(entry) {
    const at = (entry & 0xff) * 3;
    // Sei bit per canale diventano otto: si ricopiano i due alti in fondo, che è
    // quello che fa un convertitore vero quando gli si chiede più di quello che ha.
    const expand = (value) => ((value << 2) | (value >> 4)) & 0xff;
    return (
      (0xff000000 | (expand(this.dac[at + 2]) << 16) | (expand(this.dac[at + 1]) << 8) | expand(this.dac[at])) >>> 0
    );
  }

  get width() {
    if (this.graphicsMode) {
      const dots = this.columns * 8;
      return this.shiftMode === 1 ? dots >> 1 : dots;
    }
    return this.columns * this.charWidth;
  }

  get height() {
    const lines = this.visibleLines + 1;
    // Il bit di raddoppio dei righi: 200 righi disegnati due volte fanno 400, ed
    // è così che il modo 13h riempie uno schermo da 480.
    return this.crtc[9] & 0x80 ? lines >> 1 : lines;
  }

  get shiftMode() {
    return (this.graphics[5] >> 5) & 3;
  }

  /**
   * Il quadro come lo si vedrebbe adesso.
   * @returns {Uint32Array} width per height punti
   */
  render() {
    const width = Math.max(1, Math.min(this.width, 1024));
    const height = Math.max(1, Math.min(this.height, 768));
    if (this.framebuffer.length !== width * height) {
      this.framebuffer = new Uint32Array(width * height);
      this.renderWidth = width;
      this.renderHeight = height;
    }
    const pixels = this.framebuffer;
    if (!this.enabled) {
      pixels.fill(0xff000000);
      return pixels;
    }
    if (this.graphicsMode) this.renderGraphics(pixels, width, height);
    else this.renderText(pixels, width, height);
    return pixels;
  }

  /**
   * Il modo testo. Due byte per carattere — il codice e l'attributo — presi dai
   * piani 0 e 1, e il disegno delle lettere dal piano 2, dove ce l'ha messo il
   * BIOS della scheda: trentadue byte per carattere, di cui se ne usano quanti
   * ne è alto il carattere.
   */
  renderText(pixels, width, height) {
    const cellWidth = this.charWidth;
    const cellHeight = this.charHeight;
    const columns = this.columns;
    const stride = this.rowUnits;
    const blink = (this.frames >> 4) & 1;
    // Il banco del disegno delle lettere: il sequencer ne può tenere fino a otto
    // in memoria, e il registro 3 dice quale si usa.
    const select = this.sequencer[3];
    const map = ((select & 0x0c) >> 2) | ((select & 0x20) >> 3);
    const fontBase = 2 * PLANE + [0, 0x4000, 0x8000, 0xc000, 0x2000, 0x6000, 0xa000, 0xe000][map];
    const cursorRow = this.crtc[10] & 0x1f;
    const cursorEnd = this.crtc[11] & 0x1f;
    const cursor = this.cursorAddress;
    const blinkAttribute = (this.attribute[0x10] & 0x08) !== 0;

    for (let row = 0; row * cellHeight < height; row++) {
      for (let column = 0; column < columns; column++) {
        const at = (this.startAddress + row * stride + column) & 0xffff;
        const code = this.memory[at];
        const attribute = this.memory[at + PLANE];
        const glyph = fontBase + code * 32;
        let foreground = attribute & 0x0f;
        const background = blinkAttribute ? (attribute >> 4) & 7 : (attribute >> 4) & 0x0f;
        // Il bit alto dell'attributo: o è il lampeggio, o è l'intensità dello
        // sfondo. È la stessa scelta che c'era sulla CGA, e la si fa con un bit.
        if (blinkAttribute && attribute & 0x80 && blink) foreground = background;
        const ink = this.colour(foreground);
        const paper = this.colour(background);

        for (let line = 0; line < cellHeight; line++) {
          const y = row * cellHeight + line;
          if (y >= height) break;
          let bits = this.memory[glyph + (line % 32)];
          // La nona colonna di un carattere da nove punti: per i caratteri
          // semigrafici ripete l'ottava, e per tutti gli altri è sfondo. È il
          // dettaglio che fa combaciare le linee delle cornici del DOS.
          for (let dot = 0; dot < cellWidth; dot++) {
            const x = column * cellWidth + dot;
            if (x >= width) break;
            const on =
              dot < 8
                ? (bits >> (7 - dot)) & 1
                : code >= 0xc0 && code <= 0xdf && (this.attribute[0x10] & 0x04)
                  ? bits & 1
                  : 0;
            pixels[y * width + x] = on ? ink : paper;
          }
        }

        // Il cursore, che è due righi di scansione accesi in fondo alla cella e
        // lampeggia perché lo fa lampeggiare la scheda, non il programma.
        if (this.cursorVisible && at === cursor && (this.frames >> 3) & 1) {
          for (let line = cursorRow; line <= Math.min(cursorEnd, cellHeight - 1); line++) {
            const y = row * cellHeight + line;
            if (y >= height) break;
            for (let dot = 0; dot < cellWidth; dot++) {
              const x = column * cellWidth + dot;
              if (x < width) pixels[y * width + x] = this.colour(attribute & 0x0f);
            }
          }
        }
      }
    }
  }

  /**
   * I modi grafici, che sono due famiglie. Nei modi a sedici colori il colore di
   * un punto sta *a cavallo dei quattro piani*, un bit per piano: per disegnarne
   * uno bisogna toccare quattro byte, ed è per questo che la VGA ha tutta quella
   * macchineria di maschere e latch. Nel modo a 256 colori invece ogni byte è un
   * punto e i piani si comportano come una memoria normale — che è la ragione per
   * cui il modo 13h è quello in cui sono stati scritti tutti i giochi.
   */
  renderGraphics(pixels, width, height) {
    const stride = this.rowUnits;
    if (this.shiftMode === 2 || this.chain4) {
      for (let y = 0; y < height; y++) {
        const row = this.startAddress + y * stride;
        for (let x = 0; x < width; x++) {
          const at = (row + (x >> 2)) & 0xffff;
          const byte = this.memory[at + (x & 3) * PLANE];
          pixels[y * width + x] = this.dacColour(byte);
        }
      }
      return;
    }
    for (let y = 0; y < height; y++) {
      const row = (this.startAddress + y * stride) & 0xffff;
      for (let x = 0; x < width; x++) {
        const at = (row + (x >> 3)) & 0xffff;
        const bit = 7 - (x & 7);
        let colour = 0;
        for (let plane = 0; plane < 4; plane++) {
          colour |= ((this.memory[at + plane * PLANE] >> bit) & 1) << plane;
        }
        pixels[y * width + x] = this.colour(colour);
      }
    }
  }

  /**
   * Lo schermo come testo, che serve a chi guarda da fuori — le prove, e chi
   * vuole sapere cos'è scritto senza guardare i pixel.
   * @returns {string[]}
   */
  text() {
    if (this.graphicsMode) return [];
    const columns = this.columns;
    const rows = Math.max(1, this.rows);
    const stride = this.rowUnits;
    const lines = [];
    for (let row = 0; row < rows; row++) {
      let line = '';
      for (let column = 0; column < columns; column++) {
        const at = (this.startAddress + row * stride + column) & 0xffff;
        const code = this.memory[at];
        line += code >= 32 && code < 127 ? String.fromCharCode(code) : code === 0 ? ' ' : '.';
      }
      lines.push(line);
    }
    return lines;
  }
}
