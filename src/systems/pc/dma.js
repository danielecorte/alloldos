// L'8237, che sposta byte senza chiedere il permesso al processore.
//
// Il controllore di accesso diretto alla memoria è il pezzo che rende il PC una
// macchina e non un microcontrollore: il disco non passa i suoi byte per un
// registro del processore, li scrive in memoria da solo mentre il processore fa
// altro. Si programma con un indirizzo, un conteggio e un modo, si toglie la
// maschera al canale, e da lì in poi è la periferica che chiede il bus.
//
// I quattro canali dell'XT hanno anche loro mestieri fissi: lo zero rinfresca
// la memoria dinamica — non trasferisce niente, conta e basta, ma è il conto
// che tiene viva la RAM — il due è del disco, gli altri due liberi sulle
// fessure di espansione.
//
// L'errore di progetto che tutti ricordano è l'indirizzo: i registri sono di
// sedici bit, e i quattro bit alti stanno in un chip a parte, il registro di
// pagina. Non c'è un sommatore in mezzo, c'è una giunzione: un trasferimento
// che arriva alla fine di un blocco da 64 KB non passa nella pagina dopo,
// ricomincia da capo dentro la stessa. È per quello che ogni driver di disco
// del DOS controlla se il buffer "attraversa un confine di DMA".

/** I registri di pagina, uno per canale, sparsi come li ha lasciati IBM. */
const PAGE_PORTS = { 0x87: 0, 0x83: 1, 0x81: 2, 0x82: 3 };

export class DMA8237 {
  /**
   * @param {object} bus
   * @param {(addr:number)=>number} bus.read8
   * @param {(addr:number,value:number)=>void} bus.write8
   */
  constructor(bus) {
    this.bus = bus;
    this.channels = [];
    for (let i = 0; i < 4; i++) {
      this.channels.push({
        address: 0,
        count: 0,
        baseAddress: 0,
        baseCount: 0,
        mode: 0,
        page: 0,
        terminal: false,
      });
    }
    this.reset();
  }

  reset() {
    for (const channel of this.channels) {
      channel.address = 0;
      channel.count = 0;
      channel.baseAddress = 0;
      channel.baseCount = 0;
      channel.mode = 0;
      channel.page = 0;
      channel.terminal = false;
    }
    this.command = 0;
    /** I bit di fine conteggio, che si azzerano appena qualcuno li legge. */
    this.status = 0;
    /** La maschera: a uno il canale è fermo. Dopo un reset sono fermi tutti. */
    this.mask = 0x0f;
    /**
     * Il registro a sedici bit si scrive un byte per volta, e a decidere quale
     * è un singolo bistabile condiviso da tutti i canali: è per questo che ogni
     * driver scrive prima sulla porta 0Ch per rimetterlo a zero.
     */
    this.flipFlop = false;
  }

  /** L'indirizzo fisico a cui è arrivato un canale: pagina più offset, senza riporto. */
  physical(index) {
    const channel = this.channels[index];
    return ((channel.page << 16) | (channel.address & 0xffff)) & 0xfffff;
  }

  read(port) {
    port &= 0x0f;
    if (port < 8) {
      const channel = this.channels[port >> 1];
      const value = port & 1 ? channel.count : channel.address;
      const byte = this.flipFlop ? (value >> 8) & 0xff : value & 0xff;
      this.flipFlop = !this.flipFlop;
      return byte;
    }
    if (port === 0x08) {
      const status = this.status;
      this.status = 0; // leggerlo lo consuma: è il solo modo di saperlo
      return status;
    }
    if (port === 0x0f) return this.mask;
    return 0xff;
  }

  write(port, value) {
    port &= 0x0f;
    value &= 0xff;

    if (port < 8) {
      const channel = this.channels[port >> 1];
      const counting = (port & 1) !== 0;
      const current = counting ? channel.count : channel.address;
      const merged = this.flipFlop
        ? ((value << 8) | (current & 0xff)) & 0xffff
        : (current & 0xff00) | value;
      if (counting) {
        channel.count = merged;
        channel.baseCount = merged;
        channel.terminal = false; // un conteggio nuovo è un blocco nuovo
      } else {
        channel.address = merged;
        channel.baseAddress = merged;
      }
      this.flipFlop = !this.flipFlop;
      return;
    }

    switch (port) {
      case 0x08:
        this.command = value;
        return;
      case 0x09: {
        // Registro di richiesta: una richiesta via software, che qui nessuno usa.
        return;
      }
      case 0x0a: {
        const bit = 1 << (value & 3);
        if (value & 4) this.mask |= bit;
        else this.mask &= ~bit;
        return;
      }
      case 0x0b:
        this.channels[value & 3].mode = value;
        return;
      case 0x0c:
        this.flipFlop = false;
        return;
      case 0x0d:
        // Reset generale: come all'accensione, con tutti i canali in maschera.
        this.command = 0;
        this.status = 0;
        this.mask = 0x0f;
        this.flipFlop = false;
        return;
      case 0x0e:
        this.mask = 0;
        return;
      case 0x0f:
        this.mask = value & 0x0f;
        return;
      default:
    }
  }

  /** Le porte di pagina stanno altrove sul bus, e ci arrivano da lì. */
  readPage(port) {
    const index = PAGE_PORTS[port];
    return index === undefined ? 0xff : this.channels[index].page & 0x0f;
  }

  writePage(port, value) {
    const index = PAGE_PORTS[port];
    if (index !== undefined) this.channels[index].page = value & 0x0f;
  }

  /**
   * Un colpo di rinfresco: il canale 0 non tocca la memoria, scala il suo
   * conteggio e basta. Quando arriva in fondo accende il bit di fine conteggio,
   * e il BIOS lo controlla per sapere che la macchina si sta rinfrescando
   * davvero — è la prova che la RAM non si sta dimenticando di sé stessa.
   */
  refresh(pulses = 1) {
    const channel = this.channels[0];
    if (this.mask & 1 || this.command & 0x04) return;
    let count = channel.count - pulses;
    while (count < 0) {
      this.status |= 0x01;
      if (channel.mode & 0x10) {
        channel.count = channel.baseCount;
        channel.address = channel.baseAddress;
        count += (channel.baseCount & 0xffff) + 1;
      } else {
        this.mask |= 1;
        count = 0xffff;
        break;
      }
    }
    channel.count = count & 0xffff;
  }

  /**
   * Un byte verso la memoria o dalla memoria, per conto di una periferica.
   *
   * Il canale scala il conteggio a ogni byte e alla fine accende il suo bit di
   * fine conteggio; se è in auto-inizializzazione riparte da solo, altrimenti
   * si rimette in maschera e aspetta che qualcuno lo riprogrammi.
   *
   * @param {number} index il canale
   * @param {number|null} value il byte da scrivere in memoria, o null per leggerlo
   * @returns {number} il byte letto (o quello scritto), -1 se il canale è fermo
   */
  transfer(index, value = null) {
    const channel = this.channels[index];
    if (this.mask & (1 << index)) return -1;

    const address = this.physical(index);
    // I due bit del modo dicono in che verso va il byte, e uno dei quattro
    // versi è "in nessun verso": la verifica conta i byte senza toccare la
    // memoria, ed è così che il DOS controlla un disco senza avere dove
    // metterlo.
    const direction = (channel.mode >> 2) & 3;
    let byte = 0xff;
    if (direction === 1) {
      byte = value === null ? 0xff : value & 0xff;
      this.bus.write8(address, byte);
    } else if (direction === 2) {
      byte = this.bus.read8(address);
    }

    const step = channel.mode & 0x20 ? -1 : 1;
    channel.address = (channel.address + step) & 0xffff;
    channel.count = (channel.count - 1) & 0xffff;
    if (channel.count === 0xffff) {
      this.status |= 1 << index;
      channel.terminal = true;
      if (channel.mode & 0x10) {
        channel.address = channel.baseAddress;
        channel.count = channel.baseCount;
      } else {
        this.mask |= 1 << index;
      }
    }
    return byte;
  }

  /**
   * Se il canale ha finito il suo blocco. Il bit di stato è quello che legge
   * il processore, e leggerlo lo consuma; il filo TC che arriva alla
   * periferica è un'altra cosa, e resta alzato finché non le si dà un altro
   * blocco da fare. Sono due domande diverse e hanno due risposte diverse.
   */
  terminalCount(index) {
    return (this.status & (1 << index)) !== 0;
  }

  /** Il filo TC come lo vede la periferica: "questo byte era l'ultimo". */
  terminal(index) {
    return this.channels[index].terminal;
  }
}
