// L'8255, tre porte parallele che sull'XT fanno da centralino.
//
// È il chip meno nobile della scheda e quello che tocca più cose: da una parte
// arrivano gli otto bit che la tastiera ha appena finito di far entrare a
// pettine, dall'altra ci sono gli interruttori a slitta con cui si diceva alla
// macchina quanta memoria aveva e che scheda video montava, in mezzo passano
// il cancello del terzo contatore e il filo dell'altoparlante.
//
//   - porta A (60h), in ingresso: l'ultimo codice arrivato dalla tastiera.
//   - porta B (61h), in uscita: il bit 0 apre il contatore 2, il bit 1 collega
//     l'altoparlante, il bit 3 sceglie quale metà degli interruttori guardare,
//     i bit 6 e 7 tengono la tastiera zitta e ne svuotano il registro.
//   - porta C (62h), in ingresso: mezzi interruttori per volta, più l'uscita
//     del contatore 2 sul bit 5.
//
// Gli interruttori sono la parte che oggi suona più strana: la macchina non si
// accorgeva di quello che aveva dentro, glielo si diceva a mano aprendo il
// coperchio, e se si sbagliava a dire che scheda video c'era il BIOS partiva
// parlando a un pezzo di memoria dove non c'era nessuno.

export const PPI_A = 0x60;
export const PPI_B = 0x61;
export const PPI_C = 0x62;
export const PPI_CONTROL = 0x63;

/** Il bit 3 della porta B: quale metà degli interruttori risponde sulla porta C. */
const PB_SWITCH_HIGH = 0x08;
/** I due bit che tengono ferma la tastiera: clock a terra e registro da svuotare. */
const PB_KEYBOARD_CLEAR = 0x80;
const PB_KEYBOARD_HOLD = 0x40;
/** Il cancello del contatore 2 e il filo che porta all'altoparlante. */
const PB_TIMER2_GATE = 0x01;
const PB_SPEAKER_DATA = 0x02;

/** I codici del tipo di video negli interruttori, come li legge ogni BIOS XT. */
export const VIDEO_OPTION_ROM = 0; // scheda con il suo BIOS: EGA, VGA
export const VIDEO_CGA_40 = 1;
export const VIDEO_CGA_80 = 2;
export const VIDEO_MDA = 3;

export class PPI8255 {
  /**
   * @param {object} hooks
   * @param {()=>number} hooks.readKeyboard il byte fermo nel registro della tastiera
   * @param {(hold:boolean, clear:boolean)=>void} hooks.setKeyboardLines
   * @param {()=>number} hooks.timer2Output l'uscita del contatore 2, bit 5 della porta C
   * @param {(gate:boolean, data:boolean)=>void} hooks.setSpeaker
   * @param {object} switches gli interruttori della scheda madre
   */
  constructor(hooks, switches = {}) {
    this.hooks = hooks;
    this.switches = {
      floppies: 1,
      video: VIDEO_CGA_80,
      fpu: false,
      banks: 3, // quattro banchi popolati: 256 KB sulla scheda madre
      ...switches,
    };
    this.reset();
  }

  reset() {
    this.control = 0x99; // A e C in ingresso, B in uscita: come lo mette il BIOS
    this.portB = 0;
  }

  /** Gli otto interruttori, nella metà che la porta B sta chiedendo. */
  switchNibble() {
    const sw = this.switches;
    if (this.portB & PB_SWITCH_HIGH) {
      const drives = Math.max(0, Math.min(3, sw.floppies - 1));
      return (drives << 2) | (sw.video & 3);
    }
    return ((sw.banks & 3) << 2) | (sw.fpu ? 2 : 0) | (sw.floppies > 0 ? 1 : 0);
  }

  read(port) {
    switch (port & 3) {
      case 0:
        return this.hooks.readKeyboard() & 0xff;
      case 2:
        return this.switchNibble() | (this.hooks.timer2Output() ? 0x20 : 0);
      default:
        // La porta B si rilegge come è stata scritta, e il BIOS ci conta:
        // legge, cambia un bit e riscrive, decine di volte durante il POST.
        return this.portB;
    }
  }

  write(port, value) {
    value &= 0xff;
    switch (port & 3) {
      case 1: {
        this.portB = value;
        this.hooks.setSpeaker((value & PB_TIMER2_GATE) !== 0, (value & PB_SPEAKER_DATA) !== 0);
        this.hooks.setKeyboardLines((value & PB_KEYBOARD_HOLD) === 0, (value & PB_KEYBOARD_CLEAR) !== 0);
        return;
      }
      case 3:
        this.control = value;
        return;
      default:
        // A e C sono in ingresso: quello che ci si scrive non arriva da nessuna
        // parte, e il BIOS lo fa lo stesso per prendere tempo fra due OUT.
    }
  }
}
