// Il canale da cui il firmware chiede alla macchina che macchina è.
//
// Su un PC vero il BIOS e la scheda madre sono la stessa cosa: chi ha scritto il
// firmware sapeva quanti banchi di memoria c'erano e dove. Su una macchina
// emulata no — il firmware è uno e le macchine sono mille — e allora serve un
// posto dove l'una possa raccontarsi all'altro. In QEMU quel posto si chiama
// **fw_cfg**, e sono due porte: nella 510h si scrive *cosa* si vuole sapere, dalla
// 511h si leggono i byte della risposta, uno per volta.
//
// Le prime voci sono numeri fissi — la firma, quanti processori ci sono, quanta
// memoria — ma la voce che conta davvero è la 19h: **l'elenco dei file**. Da lì
// passano le ROM delle schede, le tabelle ACPI, l'ordine di avvio. È il motivo per
// cui questa macchina può dare al firmware la ROM della scheda video senza che
// quella ROM sia dentro una scheda: gliela passa come file, ed è esattamente
// quello che fa QEMU con una VGA ISA.
//
// La firma è quattro lettere, "QEMU", e sono la parola d'ordine: se il firmware
// non le trova alla prima voce lascia perdere il canale e va avanti a indovinare.
// Dirle non è una bugia — questa macchina non finge di essere QEMU, si presenta
// per quello che è: una macchina emulata che parla il protocollo che quel
// firmware conosce.

export const FWCFG_SELECTOR = 0x510;
export const FWCFG_DATA = 0x511;

const SIGNATURE = 0x0000;
const ID = 0x0001;
const UUID = 0x0002;
const RAM_SIZE = 0x0003;
const NOGRAPHIC = 0x0004;
const NB_CPUS = 0x0005;
const NUMA = 0x000d;
const BOOT_MENU = 0x000e;
const MAX_CPUS = 0x000f;
const FILE_DIR = 0x0019;

/** Da dove cominciano le chiavi dei file: le prime trentadue sono dei numeri. */
const FIRST_FILE_KEY = 0x20;

/** Un intero, nell'ordine di Intel, di tanti byte quanti si dice. */
function little(value, bytes) {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((BigInt(value) >> BigInt(i * 8)) & 0xffn);
  return out;
}

/** E uno nell'ordine della rete, che è quello in cui è scritto l'elenco dei file. */
function big(value, bytes) {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[bytes - 1 - i] = (value >>> (i * 8)) & 0xff;
  return out;
}

export class FirmwareConfig {
  /**
   * @param {object} [options]
   * @param {number} [options.ram] quanta memoria dichiarare
   * @param {number} [options.cpus]
   */
  constructor({ ram = 32 * 1024 * 1024, cpus = 1 } = {}) {
    /** Le voci, ognuna una fila di byte già pronta. */
    this.items = new Map();
    /** I file, in ordine: l'elenco li racconta in quest'ordine. */
    this.files = [];
    this.selected = 0;
    this.position = 0;
    this.selectorBytes = new Uint8Array(2);

    this.items.set(SIGNATURE, new TextEncoder().encode('QEMU'));
    // Il bit 0 dice "so parlare a porte"; il bit 1 direbbe "e anche in DMA", che
    // qui non c'è: il firmware userà le porte, che sono un byte per volta e
    // bastano per qualche decina di KB.
    this.items.set(ID, little(1, 4));
    this.items.set(UUID, new Uint8Array(16));
    this.items.set(RAM_SIZE, little(ram, 8));
    this.items.set(NOGRAPHIC, little(0, 2));
    this.items.set(NB_CPUS, little(cpus, 2));
    this.items.set(MAX_CPUS, little(cpus, 2));
    this.items.set(NUMA, little(0, 8));
    this.items.set(BOOT_MENU, little(0, 2));
    this.rebuildDirectory();
  }

  /**
   * Aggiunge un file. Il nome conta: il firmware guarda il prefisso per sapere
   * cosa farne — `vgaroms/` vuol dire "questa è la ROM di una scheda video,
   * eseguila prima di tutto il resto".
   *
   * @param {string} name
   * @param {Uint8Array} bytes
   */
  addFile(name, bytes) {
    const key = FIRST_FILE_KEY + this.files.length;
    this.files.push({ name, bytes, key });
    this.items.set(key, bytes);
    this.rebuildDirectory();
    return key;
  }

  /**
   * L'elenco dei file, che è l'unica voce scritta nell'ordine della rete: prima
   * quanti sono, poi per ognuno quanto è grande, con che chiave si chiede, e come
   * si chiama in cinquantasei byte.
   */
  rebuildDirectory() {
    const entries = new Uint8Array(4 + this.files.length * 64);
    entries.set(big(this.files.length, 4), 0);
    this.files.forEach((file, index) => {
      const at = 4 + index * 64;
      entries.set(big(file.bytes.length, 4), at);
      entries.set(big(file.key, 2), at + 4);
      entries.set(big(0, 2), at + 6);
      const name = new TextEncoder().encode(file.name).subarray(0, 55);
      entries.set(name, at + 8);
    });
    this.items.set(FILE_DIR, entries);
  }

  read(port) {
    if (port === FWCFG_SELECTOR) return 0xff; // la porta dell'indice non si rilegge
    const item = this.items.get(this.selected);
    if (!item) return 0x00;
    const value = this.position < item.length ? item[this.position] : 0x00;
    this.position++;
    return value;
  }

  write(port, value) {
    if (port !== FWCFG_SELECTOR && port !== FWCFG_SELECTOR + 1) return;
    // Il selettore è di sedici bit, e il processore lo scrive in due byte: si
    // riparte da capo a leggere appena è arrivato quello alto.
    this.selectorBytes[port - FWCFG_SELECTOR] = value & 0xff;
    this.selected = this.selectorBytes[0] | (this.selectorBytes[1] << 8);
    this.position = 0;
  }
}
