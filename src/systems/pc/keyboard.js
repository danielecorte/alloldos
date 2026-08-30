// La tastiera dell'XT, che è una tastiera con dentro un processore.
//
// Nel cavo a spirale passano due fili, dati e clock, e i byte arrivano uno alla
// volta a pettine dentro un registro a scorrimento sulla scheda madre. Quando
// il byte è pieno la scheda alza la IRQ 1 e lo mette sulla porta A della PPI; il
// gestore lo legge, poi alza e riabbassa il bit 7 della porta 61h per dire
// "preso", e solo allora il registro può ricevere il byte dopo.
//
// L'altro filo, il clock, la scheda madre può tenerlo a terra: finché è a terra
// la tastiera non parla. È così che il BIOS la fa tacere durante il POST, ed è
// anche il modo in cui le si ordina di ripartire — venti millesimi di secondo
// con il clock a terra sono il segnale di reset, e la tastiera risponde con AAh
// per dire che il suo test interno è andato bene.
//
// I codici non sono lettere: sono il numero del tasto nella matrice, uno alla
// pressione e lo stesso con il bit 7 acceso al rilascio. Che il tasto 30 sia la
// A lo decide il BIOS, e lo decide guardando se nel frattempo è stato premuto
// anche il 42.

/** La risposta della tastiera al reset: "sto bene". */
export const KB_SELF_TEST_OK = 0xaa;

export class XTKeyboard {
  /**
   * @param {object} hooks
   * @param {(active:boolean)=>void} hooks.onInterrupt la IRQ 1 verso il PIC
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    /** Il byte fermo nel registro a scorrimento, quello che legge la porta 60h. */
    this.latch = 0;
    /** I codici che la tastiera ha già battuto e che aspettano il loro turno. */
    this.queue = [];
    /** Il clock a terra: la tastiera è zitta. */
    this.held = true;
    /** Il bit 7 della porta B alto: il registro è tenuto azzerato. */
    this.cleared = true;
    this.irq = false;
  }

  /** I due fili come li mette la porta B della PPI. */
  setLines(held, cleared) {
    if (this.held && !held) {
      // Il clock torna libero dopo essere stato a terra: la tastiera si è
      // riavviata, e la prima cosa che dice è che il suo test è andato bene.
      this.queue.push(KB_SELF_TEST_OK);
    }
    this.held = held;
    if (cleared) {
      this.latch = 0;
      this.setInterrupt(false);
    }
    const wasCleared = this.cleared;
    this.cleared = cleared;
    if (wasCleared && !cleared) this.deliver();
  }

  setInterrupt(active) {
    if (this.irq === active) return;
    this.irq = active;
    this.hooks.onInterrupt?.(active);
  }

  /** Il prossimo codice entra nel registro, se c'è posto e se il clock è libero. */
  deliver() {
    if (this.cleared || this.held || this.irq || this.queue.length === 0) return;
    this.latch = this.queue.shift() & 0xff;
    this.setInterrupt(true);
  }

  /** Il byte sulla porta 60h. Resta lì finché non arriva il "preso". */
  read() {
    return this.latch;
  }

  /** Un tasto premuto: il suo numero nella matrice. */
  press(code) {
    this.queue.push(code & 0x7f);
    this.deliver();
  }

  /** Lo stesso tasto lasciato andare: lo stesso numero con il bit 7 acceso. */
  release(code) {
    this.queue.push((code & 0x7f) | 0x80);
    this.deliver();
  }
}
