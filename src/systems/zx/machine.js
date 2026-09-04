// Lo ZX Spectrum 48K: tre chip, un cavo di alimentazione e nient'altro.
//
// La mappa di memoria è la più semplice che si possa fare: sedici KB di ROM
// in fondo, quarantotto di RAM sopra, e basta. Non c'è banking, non c'è
// nessun registro di configurazione, non c'è niente da programmare
// all'accensione. Il processore parte da zero, che è la prima istruzione
// della ROM, e da lì in poi è tutto BASIC.
//
// Le porte sono ancora più semplici, e in un modo che oggi fa impressione:
// non sono decodificate. La ULA risponde a *tutte* le porte pari — guarda un
// filo solo, quello del bit 0 dell'indirizzo — e le schede che si
// aggiungevano guardavano altri bit sperando di non pestarsi i piedi. È per
// questo che sullo Spectrum si scrive `OUT 254` e si legge `IN 254`, ma
// funzionano anche 65278 e qualunque altro numero pari: sono tutti la stessa
// porta.
//
// Il tempo è una cosa sola per tutti: 69888 T-state per quadro, cinquanta
// quadri al secondo, e a ogni quadro la ULA tira giù la linea di interrupt
// per un attimo. Quell'interrupt è tutto l'orologio che la macchina ha —
// il BASIC ci conta i quinti di secondo, i giochi ci contano i fotogrammi.

import { Z80 } from './cpuz80.js';
import { ULA, CPU_CLOCK, FRAME_CYCLES, LINE_CYCLES, FPS } from './ula.js';

export { CPU_CLOCK, FRAME_CYCLES, FPS };

export const ROM_SIZE = 0x4000;
export const RAM_TOP = 0x10000;

/**
 * Per quanti T-state la ULA tiene giù la linea di interrupt. Se il processore
 * in quel momento ha le interruzioni chiuse, il quadro se lo perde: non c'è
 * nessuno che tenga la richiesta in attesa.
 */
const INTERRUPT_LENGTH = 32;

export class Spectrum {
  /**
   * @param {Uint8Array} rom i sedici KB della ROM
   */
  constructor(rom) {
    this.rom = rom;
    this.memory = new Uint8Array(RAM_TOP);
    this.ula = new ULA(this.memory);
    /** Il nastro, quando ce n'è uno che sta suonando. */
    this.tape = null;
    this.cpu = new Z80({
      read8: (addr) => this.memory[addr],
      write8: (addr, value) => {
        // La ROM è una ROM: scriverci non è un errore, semplicemente non
        // succede niente. Mezzo BASIC ci scrive sopra per sbaglio.
        if (addr >= ROM_SIZE) this.memory[addr] = value;
      },
      inb: (port) => this.inb(port),
      outb: (port, value) => this.outb(port, value),
    });
    this.reset();
  }

  reset() {
    this.memory.fill(0);
    this.memory.set(this.rom.subarray(0, ROM_SIZE));
    this.ula.reset();
    this.cpu.reset();
    /** Il tempo dentro il quadro, in T-state. */
    this.frameCycles = 0;
    /** Quanti quadri sono passati da quando è accesa. */
    this.frames = 0;
  }

  // --------------------------------------------------------------- le porte

  inb(port) {
    if (!(port & 1)) {
      // La ULA. Il bit 6 è quello che arriva dal nastro, e il nastro va
      // portato all'istante in cui il processore sta leggendo: il caricamento
      // misura la durata degli impulsi contando cicli, e mezzo impulso di
      // ritardo è un byte sbagliato.
      if (this.tape) this.ula.ear = this.tape.levelAt(this.time) ? 1 : 0;
      return this.ula.read(port);
    }
    // Il joystick Kempston, che si riconosce dal bit 5 dell'indirizzo basso.
    if (!(port & 0x20)) return this.ula.joystick;
    // Nessuno risponde. Su una macchina vera il bus non resta alto: resta
    // l'ultimo byte che la ULA stava leggendo per disegnare, e qualche gioco
    // ci legge dentro per sapere dov'è il pennello.
    return 0xff;
  }

  outb(port, value) {
    if (!(port & 1)) this.ula.write(value, this.frameCycles);
  }

  // ----------------------------------------------------- il tempo che passa

  /** Il tempo assoluto in T-state, che è quello che il nastro deve sapere. */
  get time() {
    return this.frames * FRAME_CYCLES + this.frameCycles;
  }

  /**
   * Un quadro intero. Comincia con l'interruzione — che è il battito di tutta
   * la macchina — e finisce quando il pennello è tornato in cima.
   */
  runFrame() {
    this.ula.startFrame();
    this.frameCycles = 0;

    // La ULA chiede l'interruzione all'inizio del quadro e la tiene per una
    // trentina di cicli: se il processore è in mezzo a un'istruzione lunga
    // fa in tempo lo stesso, se ha chiuso le interruzioni no.
    let asked = false;
    while (this.frameCycles < FRAME_CYCLES) {
      if (!asked && this.frameCycles < INTERRUPT_LENGTH) {
        const taken = this.cpu.interrupt();
        if (taken) {
          this.frameCycles += taken;
          asked = true;
          continue;
        }
        if (this.frameCycles >= INTERRUPT_LENGTH) asked = true;
      }
      this.frameCycles += this.cpu.step();
      if (this.frameCycles >= INTERRUPT_LENGTH) asked = true;
    }

    this.frames++;
    return this.frameCycles;
  }

  /** Manda avanti la macchina di tanti T-state, senza badare ai quadri. */
  runCycles(cycles) {
    const end = this.frameCycles + cycles;
    while (this.frameCycles < end) this.frameCycles += this.cpu.step();
  }

  /** Dove sta il processore: l'unica cosa che serve a chi lo sta guardando. */
  get location() {
    return this.cpu.location;
  }

  /** Lo schermo come testo, riconoscendo i pixel contro il font della ROM. */
  text() {
    return this.ula.text(this.rom);
  }

  /**
   * Il riquadro dello schermo dove il BASIC scrive: sullo Spectrum non c'è
   * una memoria di caratteri, quindi «cosa c'è scritto» si può solo guardare.
   */
  screenText() {
    return this.text().join('\n');
  }

  /** Quante righe di caratteri stanno in un quadro: ventiquattro. */
  get lineCycles() {
    return LINE_CYCLES;
  }
}
