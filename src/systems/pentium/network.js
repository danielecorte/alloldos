// Il cavo della scheda di rete: un WebSocket verso il server di alloldos.
//
// Dall'altra parte c'è il router finto di `scripts/nat.mjs`, che dà alla
// macchina un indirizzo col DHCP e le apre le connessioni verso fuori. Se il
// server non c'è — la pagina pubblicata è solo file statici — la scheda resta
// nella macchina col cavo staccato, e il sistema operativo lo vede così.
//
// I pacchetti che arrivano non entrano subito: aspettano in fila che l'anello
// della scheda abbia posto. Una scheda vera li perderebbe, e il TCP li
// rimanderebbe; qui si può fare di meglio, perché il cavo è nostro.

/** Quanti pacchetti possono aspettare prima di cominciare a buttarli. */
const QUEUE_LIMIT = 1024;
/** Dopo quanto si riprova, se il server si era spento. */
const RETRY_MS = 5000;

export class NetworkLink {
  /**
   * @param {(connected:boolean)=>void} onChange
   * @param {string} [url]
   */
  constructor(onChange, url = null) {
    this.url = url;
    this.onChange = onChange;
    this.queue = [];
    this.connected = false;
    this.closed = false;
    this.nic = null;
    this.open();
  }

  open() {
    let socket;
    try {
      socket = new WebSocket(this.url ?? defaultURL());
    } catch {
      return; // una pagina senza indirizzo, o un browser senza WebSocket: cavo staccato
    }
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.connected = true;
      this.onChange(true);
    };
    socket.onmessage = (event) => {
      if (this.queue.length < QUEUE_LIMIT) this.queue.push(new Uint8Array(event.data));
    };
    socket.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.queue = [];
      if (was) this.onChange(false);
      // Si riprova solo se il cavo c'era: senza server, un tentativo basta.
      if (was && !this.closed) this.retry = setTimeout(() => this.open(), RETRY_MS);
    };
    this.socket = socket;
  }

  /**
   * Fra un fotogramma e l'altro: si collega la scheda della macchina di adesso —
   * che cambia quando la macchina si riaccende da capo — e le si passa quello
   * che ci sta.
   *
   * @param {?import('./ne2000.js').NE2000} nic
   */
  pump(nic) {
    if (!nic) return;
    if (nic !== this.nic) {
      this.nic = nic;
      nic.onTransmit = (frame) => {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
      };
    }
    // Con la scheda ferma non c'è nessuno ad ascoltare, e quello che arriva
    // sarebbe vecchio quando il driver la accende.
    if (nic.stopped) this.queue.length = 0;
    while (this.queue.length && nic.ready) nic.receive(this.queue.shift());
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}

/** Lo stesso server che ha dato la pagina, alla voce `net`. */
function defaultURL() {
  const url = new URL('net', document.baseURI);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
