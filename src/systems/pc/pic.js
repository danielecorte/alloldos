// L'8259A, che decide chi parla e quando.
//
// Sul bus di un PC ci sono otto fili di richiesta e un solo piedino di
// interrupt sul processore. Il compito di questo chip è tutto qui: guardare
// quali fili sono alzati, scartare quelli che il programma ha mascherato,
// scegliere il più urgente — e urgente vuol dire semplicemente "con il numero
// più basso", il timer prima della tastiera, la tastiera prima del resto — e
// dire al processore quale vettore andare a leggere.
//
// Il pezzo che sorprende è l'ultimo: dopo aver servito una richiesta il
// programma deve dire al chip che ha finito, scrivendo un EOI sulla porta 20h.
// Se se ne dimentica, quella riga resta "in servizio" per sempre e il chip non
// lascia più passare niente di pari o minore priorità. È il modo più classico
// di piantare un PC, ed è per questo che ogni gestore di interrupt del DOS
// finisce con quelle due istruzioni.
//
// Sulla scheda XT il chip è uno solo: otto interruzioni in tutto, numerate da
// 8 a 15 nella tabella dei vettori. Il secondo 8259 in cascata — quello che
// porta le IRQ da 8 a 15 — è dell'AT, e questa macchina non lo è.

/** Le porte del chip: comandi e maschera. */
export const PIC_COMMAND = 0x20;
export const PIC_MASK = 0x21;

export class PIC8259 {
  constructor() {
    this.reset();
  }

  reset() {
    /** Le richieste arrivate e non ancora servite. */
    this.irr = 0;
    /** Quelle che il programma non vuole vedere. */
    this.imr = 0xff;
    /** Quelle in corso di servizio, in attesa di un EOI. */
    this.isr = 0;

    /** Il vettore della IRQ 0: il BIOS ci mette 8, e da lì in poi si conta. */
    this.base = 8;

    /** Lo stato delle righe fisiche: il chip scatta sul fronte, non sul livello. */
    this.lines = 0;

    /** A che punto è la sequenza di inizializzazione (ICW1, ICW2, ICW4). */
    this.initStep = 0;
    this.needICW4 = false;
    /** Quale registro risponde sulla porta 20h: 0 = IRR, 1 = ISR. */
    this.readISR = false;
  }

  /**
   * Alza o abbassa una delle otto righe.
   *
   * La richiesta viene registrata sul fronte di salita: una periferica che
   * tiene il filo alto non viene servita due volte finché non lo riabbassa.
   */
  setLine(irq, active) {
    const bit = 1 << (irq & 7);
    const was = (this.lines & bit) !== 0;
    if (active === was) return;
    if (active) {
      this.lines |= bit;
      this.irr |= bit;
    } else {
      this.lines &= ~bit;
    }
  }

  /** Un impulso: alza e riabbassa, che è quello che fa quasi ogni periferica. */
  pulse(irq) {
    this.setLine(irq, true);
    this.setLine(irq, false);
  }

  /**
   * La richiesta che il chip presenterebbe adesso al processore, o -1.
   *
   * Passa solo chi non è mascherato e chi ha priorità migliore di quanto è già
   * in servizio: è quella seconda condizione a fare la differenza fra un
   * gestore interrotto da qualcosa di più urgente e uno interrotto da sé stesso.
   */
  request() {
    const pending = this.irr & ~this.imr;
    if (!pending) return -1;
    for (let irq = 0; irq < 8; irq++) {
      const bit = 1 << irq;
      if (this.isr & bit) return -1; // qualcosa di più urgente è ancora dentro
      if (pending & bit) return irq;
    }
    return -1;
  }

  /** Il processore accetta: la richiesta passa da "in attesa" a "in servizio". */
  acknowledge(irq) {
    const bit = 1 << (irq & 7);
    this.irr &= ~bit;
    this.isr |= bit;
    return (this.base + (irq & 7)) & 0xff;
  }

  read(port) {
    if (port & 1) return this.imr;
    return this.readISR ? this.isr : this.irr;
  }

  write(port, value) {
    value &= 0xff;
    if (port & 1) {
      // Durante l'inizializzazione questa porta riceve le altre parole di
      // comando; dopo, e per tutta la vita della macchina, è la maschera.
      if (this.initStep === 1) {
        this.base = value & 0xf8;
        this.initStep = this.needICW4 ? 2 : 0;
        return;
      }
      if (this.initStep === 2) {
        this.initStep = 0; // ICW4: modo 8086, che è l'unico che ci interessa
        return;
      }
      this.imr = value;
      return;
    }

    if (value & 0x10) {
      // ICW1: azzera tutto e apre la sequenza di inizializzazione.
      this.imr = 0xff;
      this.isr = 0;
      this.irr = 0;
      this.readISR = false;
      this.needICW4 = (value & 1) !== 0;
      this.initStep = 1;
      return;
    }

    if (value & 0x08) {
      // OCW3: cambia quale registro si legge dalla porta dei comandi.
      if (value & 0x02) this.readISR = (value & 1) !== 0;
      return;
    }

    // OCW2: la fine del servizio, specifica o generica.
    const command = value >> 5;
    if (command === 1) {
      // EOI non specifico: chiude la più urgente fra quelle in servizio.
      for (let irq = 0; irq < 8; irq++) {
        const bit = 1 << irq;
        if (this.isr & bit) {
          this.isr &= ~bit;
          return;
        }
      }
      return;
    }
    if (command === 3) this.isr &= ~(1 << (value & 7)); // EOI specifico
  }
}
