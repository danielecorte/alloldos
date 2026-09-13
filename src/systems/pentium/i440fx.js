// Il chipset: due chip, e fra loro c'è tutta la macchina.
//
// Su una scheda madre del 1995 non ci sono più venti chip logici: ce ne sono due,
// e si chiamano ponte nord e ponte sud. Il **ponte nord** — qui un Intel 82441FX,
// il "Natoma" — sta fra il processore, la memoria e il bus PCI, e decide chi
// risponde a ogni indirizzo. Il **ponte sud** — un PIIX3 — porta tutto quello che
// c'era prima: le due catene di interruzioni, i contatori, il DMA, l'orologio, i
// dischi IDE. È letteralmente un PC del 1984 dentro un chip, appeso al PCI.
//
// La cosa più interessante che fa il ponte nord sono i **PAM**, sette byte nello
// spazio di configurazione che decidono, per ogni pezzo da sedici KB fra C0000 e
// FFFFF, se lì risponde la ROM o la memoria. È il pezzo di silicio che permette a
// un BIOS di copiare sé stesso in RAM e poi continuare a eseguirsi da lì: la ROM
// è lenta — otto bit e nessuna cache — e la RAM no, e da questo "shadowing" veniva
// buona parte della differenza di velocità fra due PC identici. Sono anche il
// motivo per cui il BIOS può tenere variabili scrivibili nel proprio segmento, e
// per cui l'ultima cosa che fa all'avvio è richiudere quella porta.

import { PCIFunction, HEADER_TYPE } from './pci.js';

/** Il primo dei sette PAM, quello del segmento del BIOS. */
export const PAM0 = 0x59;

/**
 * Le dodici regioni che i PAM governano, in ordine: prima F0000-FFFFF (che è
 * governata da mezzo byte da sola), poi le undici da sedici KB da C0000 a EFFFF.
 * Ogni mezzo byte ha due bit che contano: uno dice se le *letture* vanno in
 * memoria invece che alla ROM, l'altro se le scritture arrivano da qualche parte.
 */
export const PAM_REGIONS = [
  { at: PAM0, high: true, base: 0xf0000, size: 0x10000 },
  { at: PAM0 + 1, high: false, base: 0xc0000, size: 0x4000 },
  { at: PAM0 + 1, high: true, base: 0xc4000, size: 0x4000 },
  { at: PAM0 + 2, high: false, base: 0xc8000, size: 0x4000 },
  { at: PAM0 + 2, high: true, base: 0xcc000, size: 0x4000 },
  { at: PAM0 + 3, high: false, base: 0xd0000, size: 0x4000 },
  { at: PAM0 + 3, high: true, base: 0xd4000, size: 0x4000 },
  { at: PAM0 + 4, high: false, base: 0xd8000, size: 0x4000 },
  { at: PAM0 + 4, high: true, base: 0xdc000, size: 0x4000 },
  { at: PAM0 + 5, high: false, base: 0xe0000, size: 0x4000 },
  { at: PAM0 + 5, high: true, base: 0xe4000, size: 0x4000 },
  { at: PAM0 + 6, high: false, base: 0xe8000, size: 0x4000 },
  { at: PAM0 + 6, high: true, base: 0xec000, size: 0x4000 },
];

/**
 * Il ponte nord. Di suo non fa quasi niente che si veda: dichiara chi è, e tiene
 * i sette byte che decidono la mappa della memoria alta.
 *
 * I due numeri di sottosistema non sono un dettaglio estetico. Il firmware libero
 * che questa macchina esegue — SeaBIOS — guarda lì per capire su che macchina sta
 * girando: se trova 1af4:1100 sa di essere su una macchina emulata e non su una
 * scheda madre vera, e si comporta di conseguenza (per esempio va a chiedere la
 * misura della memoria all'orologio invece di contarla a mano). Dichiararsi per
 * quello che si è, qui, è la cosa che fa partire tutto.
 */
export class HostBridge extends PCIFunction {
  /**
   * @param {(region:object, readable:boolean, writable:boolean)=>void} onRemap
   */
  constructor(onRemap) {
    super({
      name: 'Intel 82441FX',
      vendor: 0x8086,
      device: 0x1237,
      classCode: 0x0600, // ponte, ponte ospite
      revision: 0x02,
      subsystemVendor: 0x1af4, // Red Hat / Qumranet: «sono una macchina emulata»
      subsystemId: 0x1100,
    });
    this.onRemap = onRemap;
    for (let i = 0; i < 7; i++) this.writable[PAM0 + i] = 0xff;
    this.writable[0x72] = 0xff; // il registro della memoria di sistema (SMRAM)
    this.config[0x72] = 0x02;
    this.remapAll();
  }

  onWrite(offset) {
    if (offset >= PAM0 && offset < PAM0 + 7) this.remapAll();
  }

  /** Rileggere i sette byte e raccontare alla scheda madre com'è la mappa adesso. */
  remapAll() {
    for (const region of PAM_REGIONS) {
      const nibble = region.high ? this.config[region.at] >> 4 : this.config[region.at] & 0x0f;
      this.onRemap?.(region, (nibble & 1) !== 0, (nibble & 2) !== 0);
    }
  }
}

/**
 * Il ponte sud, funzione 0: il ponte verso ISA, che è il chip in cui è finito
 * tutto il PC di prima. Qui dentro non c'è niente da emulare a parte i quattro
 * byte con cui si dice quale filo di interrupt del PCI finisce su quale IRQ —
 * perché il PCI ha quattro fili condivisi (A, B, C, D) e l'8259 otto righe, e
 * qualcuno deve decidere l'instradamento.
 */
export class ISABridge extends PCIFunction {
  constructor() {
    super({
      name: 'Intel 82371SB PIIX3',
      vendor: 0x8086,
      device: 0x7000,
      classCode: 0x0601,
      revision: 0x00,
    });
    this.config[HEADER_TYPE] = 0x80; // il bit che dice «ci sono altre funzioni dentro»
    for (let i = 0x60; i <= 0x63; i++) {
      this.writable[i] = 0xff;
      this.config[i] = 0x80; // instradamento spento, come all'accensione
    }
    this.writable[0x4c] = 0xff;
    this.writable[0x4e] = 0xff;
    this.writable[0x4f] = 0xff;
    // Il registro che apre e chiude la finestra della memoria di sistema.
    this.writable[0x72] = 0xff;
  }
}

/**
 * Il ponte sud, funzione 1: i due canali IDE.
 *
 * La cosa da capire è che questo chip, che sta sul PCI, risponde alle porte
 * 1F0h e 170h — cioè esattamente dove rispondeva la scheda AT del 1984. Si
 * chiama "modo compatibilità", lo dichiara il byte di interfaccia
 * programmatica, e ha tenuto in vita trent'anni di software che credeva di
 * parlare a un disco del 1984. Le finestre di indirizzi del PCI qui servono
 * solo per la quinta, quella del padrone del bus, che serve a farsi portare i
 * dati in memoria senza passare dal processore.
 */
export class IDEFunction extends PCIFunction {
  constructor() {
    super({
      name: 'Intel 82371SB IDE',
      vendor: 0x8086,
      device: 0x7010,
      classCode: 0x0101, // memoria di massa, IDE
      progIf: 0x80, // entrambi i canali alle porte di sempre, e c'è il bus master
      revision: 0x00,
    });
    this.addBAR(4, 16, { io: true }); // la finestra del padrone del bus
    for (const at of [0x40, 0x41, 0x42, 0x43, 0x44, 0x48, 0x4a, 0x4b]) this.writable[at] = 0xff;
  }
}
