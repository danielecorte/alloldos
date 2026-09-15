// L'8042, che è il chip a cui hanno dato in mano tutto quello che avanzava.
//
// Nasce come controllore di tastiera e diventa il tuttofare della scheda madre. Su
// un AT dentro c'è un microprocessore intero — programmato da IBM, con il suo
// firmware — che parla con la tastiera su due fili in seriale e la traduce per il
// bus. Ma siccome era lì, e siccome aveva dei piedini liberi, gli hanno attaccato
// altre due cose che con la tastiera non c'entrano niente:
//
//  - il **filo A20**, cioè il ventunesimo bit dell'indirizzo. L'8086 ne aveva venti
//    e riavvolgeva; il 286 ne ha ventiquattro e non riavvolge più, e del software
//    che contava su quel riavvolgimento ce n'era. Quindi hanno messo un cancello su
//    quel filo, e l'interruttore in mano al controllore della tastiera. Ogni
//    sistema operativo protetto degli anni successivi ha dovuto cominciare
//    scrivendo un comando a un chip di tastiera per poter usare la memoria.
//  - il **riavvio**. Il 286 non ha un modo di tornare in real mode da sé: l'unico
//    è resettarlo. Il piedino di reset arriva qui, e per anni "riavviare il
//    computer" ha voluto dire mandare 0xFE alla porta 64h.
//
// Poi è arrivato il mouse PS/2, e gli hanno attaccato anche quello.

/** Le due porte: i dati, e lo stato che in scrittura diventa comandi. */
export const KBC_DATA = 0x60;
export const KBC_STATUS = 0x64;

/** I bit dello stato. */
const ST_OUTPUT_FULL = 0x01; // c'è un byte da leggere
const ST_SYSTEM = 0x04; // il chip ha passato il suo autotest
const ST_MOUSE_DATA = 0x20; // quello che c'è da leggere viene dal mouse

/**
 * Due segnaposto che non sono comandi: vogliono dire «il prossimo byte è un
 * parametro di cui non ci importa il valore, e va risposto con un sì».
 */
const PARAM_KEYBOARD = 0x101;
const PARAM_MOUSE = 0x102;

export class KBC8042 {
  /**
   * @param {object} hooks
   * @param {(active:boolean)=>void} hooks.onKeyboardInterrupt IRQ 1
   * @param {(active:boolean)=>void} hooks.onMouseInterrupt IRQ 12
   * @param {(open:boolean)=>void} hooks.onA20 il cancello sul ventunesimo bit
   * @param {()=>void} hooks.onReset il piedino di reset del processore
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    /** Quello che il chip ha da consegnare, in fila. */
    this.output = [];
    this.fromMouse = false;
    /**
     * Il byte di comando: cosa fa il chip da sé senza che glielo si chieda. Le
     * due interruzioni accese, la traduzione accesa, e il mouse spento — che è
     * come lo lascia il POST di un AT, e come se lo aspetta chi accende dopo.
     */
    this.command = 0x65;
    /** Dove va il prossimo byte scritto sulla porta dei dati. */
    this.expecting = 0;
    this.a20 = true;
    /** Il modo in cui il mouse risponde: quattro numeri e una risoluzione. */
    this.mouse = { reporting: false, resolution: 2, sampleRate: 100, scaling: 1 };
    this.lastByte = 0;
  }

  // ------------------------------------------------------------------ la fila

  /**
   * Se le due porte sono aperte.
   *
   * Non sono due interruttori a parte: sono **due bit del byte di comando**, e
   * questo è il genere di dettaglio che non si vede finché non si accende
   * qualcosa di vero sopra. I comandi ADh e AEh — «spegni la tastiera», «riaccendila»
   * — non fanno altro che alzare e abbassare il bit 4; ma un firmware può anche
   * riscrivere il byte intero, e allora la tastiera si riaccende senza che nessuno
   * abbia mai mandato AEh. È esattamente quello che fa SeaBIOS: spegne la
   * tastiera per fare il suo autotest in pace, e poi la riaccende scrivendo il
   * byte nuovo. Chi tiene lo stato da un'altra parte resta con una tastiera
   * spenta per sempre, e non se ne accorge finché non prova a battere qualcosa.
   */
  get keyboardEnabled() {
    return (this.command & 0x10) === 0;
  }

  get mouseEnabled() {
    return (this.command & 0x20) === 0;
  }

  /** Un byte dalla tastiera, che il chip mette in fila e annuncia con la IRQ 1. */
  fromKeyboard(byte) {
    if (!this.keyboardEnabled) return;
    this.push(byte, false);
  }

  push(byte, mouse) {
    this.output.push({ byte, mouse });
    this.raise();
  }

  raise() {
    const next = this.output[0];
    if (!next) return;
    // Le due interruzioni si accendono solo se il byte di comando le lascia
    // passare: è il bit con cui un sistema operativo che legge a domanda e
    // risposta si toglie di mezzo gli interrupt.
    if (next.mouse) this.hooks.onMouseInterrupt?.((this.command & 0x02) !== 0);
    else this.hooks.onKeyboardInterrupt?.((this.command & 0x01) !== 0);
  }

  get status() {
    const next = this.output[0];
    return (next ? ST_OUTPUT_FULL : 0) | ST_SYSTEM | (next?.mouse ? ST_MOUSE_DATA : 0);
  }

  // ------------------------------------------------------------------ le porte

  read(port) {
    if ((port & 0x04) !== 0) return this.status;
    const next = this.output.shift();
    this.hooks.onKeyboardInterrupt?.(false);
    this.hooks.onMouseInterrupt?.(false);
    if (!next) return this.lastByte;
    this.lastByte = next.byte;
    this.raise();
    return next.byte;
  }

  write(port, value) {
    value &= 0xff;
    if ((port & 0x04) !== 0) return this.doCommand(value);
    return this.doData(value);
  }

  /** Un byte scritto in 60h: o è il parametro di un comando, o è per la tastiera. */
  doData(value) {
    const expecting = this.expecting;
    this.expecting = 0;
    switch (expecting) {
      case 0x60: // il byte di comando
        this.command = value;
        this.raise();
        return;
      case 0xd1: {
        // La porta di uscita: il bit 1 è A20, il bit 0 è il reset. Sono i due
        // fili che non hanno niente a che fare con la tastiera.
        this.setA20((value & 0x02) !== 0);
        if (!(value & 0x01)) this.hooks.onReset?.();
        return;
      }
      case 0xd2:
        this.push(value, false); // rimetti in fila come se venisse dalla tastiera
        return;
      case 0xd3:
        this.push(value, true);
        return;
      case 0xd4:
        return this.toMouse(value);
      case PARAM_KEYBOARD:
        this.push(0xfa, false);
        return;
      case PARAM_MOUSE:
        this.push(0xfa, true);
        return;
      default:
        return this.toKeyboard(value);
    }
  }

  /** Un comando scritto in 64h: questi sono del controllore, non della tastiera. */
  doCommand(value) {
    switch (value) {
      case 0x20:
        this.push(this.command, false);
        return;
      case 0x60:
      case 0xd1:
      case 0xd2:
      case 0xd3:
      case 0xd4:
        this.expecting = value; // il byte dopo è il parametro
        return;
      case 0xa7:
        this.command |= 0x20; // mouse spento
        return;
      case 0xa8:
        this.command &= ~0x20;
        return;
      case 0xa9:
        this.push(0x00, false); // la porta del mouse c'è e funziona
        return;
      case 0xaa:
        this.output.length = 0;
        this.push(0x55, false); // l'autotest, che dice sempre sì
        return;
      case 0xab:
        this.push(0x00, false); // e la prova della porta della tastiera
        return;
      case 0xad:
        this.command |= 0x10;
        return;
      case 0xae:
        this.command &= ~0x10;
        return;
      case 0xc0:
        this.push(0x00, false); // la porta di ingresso, che qui non dice niente
        return;
      case 0xd0:
        this.push((this.a20 ? 0x02 : 0) | 0x01, false);
        return;
      case 0xfe:
        // Il riavvio, che è il modo in cui si tornava in real mode.
        this.hooks.onReset?.();
        return;
      default:
        if (value >= 0xf0 && value <= 0xff) this.hooks.onReset?.();
        return;
    }
  }

  setA20(open) {
    if (this.a20 === open) return;
    this.a20 = open;
    this.hooks.onA20?.(open);
  }

  /**
   * Un comando per la tastiera vera, che sta dall'altra parte di due fili. Qui
   * non c'è nessuna tastiera con un microprocessore dentro, quindi si risponde
   * quello che risponderebbe: sì, ho capito.
   */
  toKeyboard(value) {
    switch (value) {
      case 0xff:
        this.push(0xfa, false);
        this.push(0xaa, false); // e poi "sono qui e sto bene"
        return;
      case 0xf2:
        this.push(0xfa, false);
        this.push(0xab, false);
        this.push(0x83, false); // che tastiera sono: una MF2
        return;
      case 0xed:
      case 0xf0:
      case 0xf3:
        this.push(0xfa, false);
        this.expecting = PARAM_KEYBOARD; // un parametro, che si accetta e si butta
        return;
      case 0xfe:
        this.push(this.lastByte, false);
        return;
      default:
        this.push(0xfa, false);
    }
  }

  /**
   * Il mouse si è mosso, o è cambiato un tasto: tre byte, come li manda un
   * mouse PS/2. Il primo dice i tasti e i segni, gli altri due di quanto — in
   * orizzontale verso destra e in verticale **verso l'alto**, al contrario di
   * come conta lo schermo. Il mouse parla solo se gli è stato chiesto (F4h) e
   * se la sua porta è aperta; altrimenti il movimento si perde, come su una
   * macchina vera con il driver non caricato.
   *
   * @param {number} dx
   * @param {number} dy positivo verso l'alto
   * @param {number} buttons bit 0 sinistro, bit 1 destro, bit 2 centrale
   * @returns {boolean} se il pacchetto è partito
   */
  mouseMoved(dx, dy, buttons) {
    if (!this.mouse.reporting || !this.mouseEnabled) return false;
    const clamp = (value) => Math.max(-255, Math.min(255, Math.round(value)));
    const x = clamp(dx);
    const y = clamp(dy);
    // Il bit 3 è sempre acceso: è quello da cui un driver capisce dove comincia
    // un pacchetto, se ha perso il conto.
    this.push(0x08 | (buttons & 7) | (x < 0 ? 0x10 : 0) | (y < 0 ? 0x20 : 0), true);
    this.push(x & 0xff, true);
    this.push(y & 0xff, true);
    return true;
  }

  /** Quanti byte del mouse aspettano ancora di essere letti. */
  get mouseBacklog() {
    return this.output.filter((entry) => entry.mouse).length;
  }

  /**
   * Un comando per il mouse. Il mouse PS/2 è tre byte per movimento e non sa
   * niente di dove sia il puntatore: dice solo di quanto si è spostato da quando
   * gliel'hanno chiesto l'ultima volta.
   */
  toMouse(value) {
    switch (value) {
      case 0xff:
        this.push(0xfa, true);
        this.push(0xaa, true);
        this.push(0x00, true); // il numero di identificazione: mouse semplice
        return;
      case 0xf2:
        this.push(0xfa, true);
        this.push(0x00, true);
        return;
      case 0xf4:
        this.mouse.reporting = true;
        this.push(0xfa, true);
        return;
      case 0xf5:
        this.mouse.reporting = false;
        this.push(0xfa, true);
        return;
      case 0xe8:
      case 0xf3:
        this.push(0xfa, true);
        this.expecting = PARAM_MOUSE; // il parametro arriva dopo, e lo si accetta
        return;
      case 0xe9:
        this.push(0xfa, true);
        this.push(0x00, true);
        this.push(this.mouse.resolution, true);
        this.push(this.mouse.sampleRate, true);
        return;
      default:
        this.push(0xfa, true);
    }
  }
}
