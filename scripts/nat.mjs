// La rete dall'altra parte del cavo: un router finto, come quello di QEMU.
//
// Dal browser non si mandano pacchetti ethernet da nessuna parte: si aprono
// connessioni, e basta. Quindi il cavo della scheda di rete arriva fin qui, al
// server, un pacchetto per messaggio, e qui c'è una rete piccola e sempre
// uguale — quella che QEMU chiama «user networking», e che viene da slirp:
//
//   10.0.2.2   il router, che è anche questo computer (127.0.0.1)
//   10.0.2.3   il DNS, che gira le domande a quello del sistema
//   10.0.2.15  la macchina emulata, che lo scopre col DHCP
//
// Il router non instrada niente. Ogni connessione TCP che la macchina apre viene
// **terminata qui** — si fa l'handshake con lei, e intanto se ne apre una vera
// verso la stessa destinazione — e i byte passano da una all'altra. Lo stesso per
// l'UDP, un socket per ogni coppia di porte. Il ping va solo verso il router: per
// mandarne uno vero fuori servirebbero i permessi di root.

import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';

const ip = (a, b, c, d) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

export const NETWORK = ip(10, 0, 2, 0);
export const GATEWAY = ip(10, 0, 2, 2);
export const NAMESERVER = ip(10, 0, 2, 3);
export const GUEST = ip(10, 0, 2, 15);
export const GATEWAY_MAC = Uint8Array.from([0x52, 0x55, 0x0a, 0x00, 0x02, 0x02]);
const BROADCAST_MAC = Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

const ETH_ARP = 0x0806;
const ETH_IP = 0x0800;
const PROTO_ICMP = 1;
const PROTO_TCP = 6;
const PROTO_UDP = 17;

const FIN = 0x01;
const SYN = 0x02;
const RST = 0x04;
const PSH = 0x08;
const ACK = 0x10;

/** La finestra che il router annuncia, e il pezzo più grande che manda. */
const WINDOW = 65535;
const MSS = 1460;
/** Oltre questi byte in attesa di conferma, si smette di leggere dal socket vero. */
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
/** Dopo quanto un pezzo non confermato si rimanda. */
const RETRANSMIT_MS = 400;
const UDP_IDLE_MS = 60000;

export const ipString = (value) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');

const seqLess = (a, b) => ((a - b) | 0) < 0;

function checksum(bytes, start, end, initial = 0) {
  let sum = initial;
  for (let i = start; i + 1 < end; i += 2) sum += (bytes[i] << 8) | bytes[i + 1];
  if ((end - start) & 1) sum += bytes[end - 1] << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return sum;
}

function pseudoHeader(src, dst, proto, length) {
  return (src >>> 16) + (src & 0xffff) + (dst >>> 16) + (dst & 0xffff) + proto + length;
}

export class NAT {
  /**
   * @param {object} options
   * @param {(frame:Uint8Array)=>void} options.send un pacchetto verso la macchina
   * @param {string} [options.loopback] dove porta 10.0.2.2
   * @param {(message:string)=>void} [options.log]
   */
  constructor({ send, loopback = '127.0.0.1', log = () => {} }) {
    this.send = send;
    this.loopback = loopback;
    this.log = log;
    this.guestMAC = BROADCAST_MAC;
    this.ipID = 0;
    /** @type {Map<string, TCPConnection>} */
    this.tcp = new Map();
    /** @type {Map<string, UDPFlow>} */
    this.udp = new Map();
    this.closed = false;
  }

  close() {
    this.closed = true;
    for (const connection of this.tcp.values()) connection.destroy();
    for (const flow of this.udp.values()) flow.close();
    this.tcp.clear();
    this.udp.clear();
  }

  /** Dove va davvero una connessione verso un indirizzo della rete finta. */
  realHost(address) {
    if (address === GATEWAY || address === NAMESERVER) return this.loopback;
    if ((address & 0xffffff00) === NETWORK) return null; // altre macchine sulla rete finta: non ce ne sono
    return ipString(address);
  }

  // ---------------------------------------------------------------- ingresso

  /** Un pacchetto dalla scheda della macchina. */
  receive(frame) {
    if (this.closed || frame.length < 14) return;
    const type = (frame[12] << 8) | frame[13];
    if (type === ETH_ARP) this.arp(frame);
    else if (type === ETH_IP) this.ipv4(frame);
  }

  arp(frame) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (frame.length < 42 || view.getUint16(20) !== 1) return; // solo le domande
    const sender = view.getUint32(28);
    const target = view.getUint32(38);
    this.guestMAC = frame.slice(22, 28);
    if ((target & 0xffffff00) !== NETWORK || target === sender || target === GUEST) return;
    const reply = new Uint8Array(42);
    reply.set(frame.subarray(22, 28), 0);
    reply.set(GATEWAY_MAC, 6);
    reply.set([0x08, 0x06, 0x00, 0x01, 0x08, 0x00, 6, 4, 0x00, 0x02], 12);
    reply.set(GATEWAY_MAC, 22);
    reply.set(frame.subarray(38, 42), 28);
    reply.set(frame.subarray(22, 32), 32);
    this.send(reply);
  }

  ipv4(frame) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (frame.length < 34 || frame[14] >> 4 !== 4) return;
    const headerLength = (frame[14] & 0x0f) * 4;
    const total = view.getUint16(16);
    // I pezzi di un pacchetto spezzato non si rimettono insieme: con 1500 byte
    // per pacchetto nessuno li manda.
    if (view.getUint16(20) & 0x3fff) return;
    const end = Math.min(frame.length, 14 + total);
    const src = view.getUint32(26);
    const dst = view.getUint32(30);
    const payload = frame.subarray(14 + headerLength, end);
    this.guestMAC = frame.slice(6, 12);
    switch (frame[23]) {
      case PROTO_ICMP:
        return this.icmp(src, dst, payload);
      case PROTO_UDP:
        return this.udpIn(src, dst, payload);
      case PROTO_TCP:
        return this.tcpIn(src, dst, payload);
      default:
        return undefined;
    }
  }

  icmp(src, dst, payload) {
    // Solo il ping, e solo verso gli indirizzi del router: risponde lui.
    if (payload.length < 8 || payload[0] !== 8) return;
    if (dst !== GATEWAY && dst !== NAMESERVER) return;
    const reply = payload.slice();
    reply[0] = 0;
    reply[2] = reply[3] = 0;
    const sum = ~checksum(reply, 0, reply.length) & 0xffff;
    reply[2] = sum >> 8;
    reply[3] = sum & 0xff;
    this.sendIP(dst, src, PROTO_ICMP, reply);
  }

  // ---------------------------------------------------------------- uscita

  /** Un pacchetto IP verso la macchina, già dentro la sua busta ethernet. */
  sendIP(src, dst, proto, payload, mac = this.guestMAC) {
    const frame = new Uint8Array(14 + 20 + payload.length);
    const view = new DataView(frame.buffer);
    frame.set(mac, 0);
    frame.set(GATEWAY_MAC, 6);
    view.setUint16(12, ETH_IP);
    view.setUint8(14, 0x45);
    view.setUint16(16, 20 + payload.length);
    view.setUint16(18, this.ipID++ & 0xffff);
    view.setUint16(20, 0x4000); // da non spezzare
    view.setUint8(22, 64);
    view.setUint8(23, proto);
    view.setUint32(26, src);
    view.setUint32(30, dst);
    view.setUint16(24, ~checksum(frame, 14, 34) & 0xffff);
    frame.set(payload, 34);
    if (proto === PROTO_UDP || proto === PROTO_TCP) {
      const at = 34 + (proto === PROTO_UDP ? 6 : 16);
      const sum = ~checksum(frame, 34, frame.length, pseudoHeader(src, dst, proto, payload.length)) & 0xffff;
      view.setUint16(at, proto === PROTO_UDP && sum === 0 ? 0xffff : sum);
    }
    this.send(frame);
  }

  sendUDP(src, srcPort, dst, dstPort, data, mac) {
    const packet = new Uint8Array(8 + data.length);
    const view = new DataView(packet.buffer);
    view.setUint16(0, srcPort);
    view.setUint16(2, dstPort);
    view.setUint16(4, packet.length);
    packet.set(data, 8);
    this.sendIP(src, dst, PROTO_UDP, packet, mac);
  }

  // ------------------------------------------------------------------- UDP

  udpIn(src, dst, payload) {
    if (payload.length < 8) return;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const srcPort = view.getUint16(0);
    const dstPort = view.getUint16(2);
    const data = payload.subarray(8, Math.min(payload.length, view.getUint16(4)));
    if (dstPort === 67) {
      this.dhcp(data);
      return;
    }
    let host;
    let port = dstPort;
    if (dst === NAMESERVER && dstPort === 53) {
      // Il DNS del router è quello del sistema: le domande vanno là così come sono.
      host = dns.getServers()[0] ?? '127.0.0.53';
      const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(host);
      if (match && !net.isIPv6(host)) {
        host = match[1];
        port = match[2] ? Number(match[2]) : 53;
      }
    } else host = this.realHost(dst);
    if (!host) return;
    const key = `${srcPort}>${ipString(dst)}:${dstPort}`;
    let flow = this.udp.get(key);
    if (!flow) {
      flow = new UDPFlow(this, key, { guestPort: srcPort, address: dst, port: dstPort, host, hostPort: port });
      this.udp.set(key, flow);
    }
    flow.send(data);
  }

  // ------------------------------------------------------------------ DHCP

  /**
   * Il DHCP: a qualunque domanda, la stessa risposta. La macchina è una sola e
   * l'indirizzo è sempre 10.0.2.15; il resto dice dov'è il router e dov'è il DNS.
   */
  dhcp(request) {
    if (request.length < 240 || request[0] !== 1) return;
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    if (view.getUint32(236) !== 0x63825363) return;
    let type = 0;
    for (let at = 240; at < request.length; ) {
      const code = request[at];
      if (code === 255) break;
      if (code === 0) {
        at++;
        continue;
      }
      if (code === 53) type = request[at + 2];
      at += 2 + request[at + 1];
    }
    const kind = { 1: 2, 3: 5, 8: 5 }[type]; // DISCOVER → OFFER, REQUEST e INFORM → ACK
    if (!kind) return;
    const reply = new Uint8Array(300);
    const out = new DataView(reply.buffer);
    reply[0] = 2;
    reply[1] = 1;
    reply[2] = 6;
    reply.set(request.subarray(4, 8), 4); // lo stesso numero di transazione
    reply.set(request.subarray(10, 12), 10); // e le stesse bandierine
    if (type !== 8) out.setUint32(16, GUEST);
    out.setUint32(20, GATEWAY);
    reply.set(request.subarray(28, 44), 28); // l'indirizzo ethernet di chi chiede
    out.setUint32(236, 0x63825363);
    const options = [
      [53, [kind]],
      [54, bytes32(GATEWAY)],
      [51, bytes32(86400)],
      [1, bytes32(0xffffff00)],
      [3, bytes32(GATEWAY)],
      [6, bytes32(NAMESERVER)],
    ];
    let at = 240;
    for (const [code, value] of options) {
      reply[at++] = code;
      reply[at++] = value.length;
      reply.set(value, at);
      at += value.length;
    }
    reply[at] = 255;
    this.sendUDP(GATEWAY, 67, 0xffffffff, 68, reply, BROADCAST_MAC);
    this.log(`DHCP: ${kind === 2 ? 'offerto' : 'assegnato'} ${ipString(GUEST)}`);
  }

  // ------------------------------------------------------------------- TCP

  tcpIn(src, dst, segment) {
    if (segment.length < 20) return;
    const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
    const srcPort = view.getUint16(0);
    const dstPort = view.getUint16(2);
    const key = `${srcPort}>${ipString(dst)}:${dstPort}`;
    const flags = segment[13];
    let connection = this.tcp.get(key);
    // Un SYN nuovo su una connessione che c'era: la macchina si è riavviata e
    // ha ripreso la stessa porta. Quella vecchia non la ricorda più nessuno.
    if (connection && (flags & (SYN | ACK)) === SYN && connection.irs !== view.getUint32(4)) {
      connection.destroy();
      connection = null;
    }
    if (connection) {
      connection.segment(segment);
      return;
    }
    if (flags & RST) return;
    const seq = view.getUint32(4);
    if ((flags & (SYN | ACK)) !== SYN) {
      // Un pezzo di una connessione che non c'è: la si chiude, come farebbe
      // un computer vero riavviato nel frattempo.
      const length = segment.length - (segment[12] >> 4) * 4;
      const ack = flags & ACK ? view.getUint32(8) : 0;
      this.reset(src, srcPort, dst, dstPort, ack, (seq + length + (flags & FIN ? 1 : 0)) >>> 0, !(flags & ACK));
      return;
    }
    const host = this.realHost(dst);
    if (!host) {
      this.reset(src, srcPort, dst, dstPort, 0, (seq + 1) >>> 0, true);
      return;
    }
    const opened = new TCPConnection(this, key, { guest: src, guestPort: srcPort, address: dst, port: dstPort, host, segment });
    this.tcp.set(key, opened);
  }

  reset(guest, guestPort, address, port, seq, ack, withAck) {
    const packet = tcpHeader(port, guestPort, seq, withAck ? ack : 0, RST | (withAck ? ACK : 0), 0);
    this.sendIP(address, guest, PROTO_TCP, packet);
  }
}

function bytes32(value) {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function tcpHeader(srcPort, dstPort, seq, ack, flags, window, options = [], data = null) {
  const length = 20 + options.length;
  const packet = new Uint8Array(length + (data?.length ?? 0));
  const view = new DataView(packet.buffer);
  view.setUint16(0, srcPort);
  view.setUint16(2, dstPort);
  view.setUint32(4, seq >>> 0);
  view.setUint32(8, ack >>> 0);
  packet[12] = (length / 4) << 4;
  packet[13] = flags;
  view.setUint16(14, window);
  packet.set(options, 20);
  if (data) packet.set(data, length);
  return packet;
}

/**
 * Un flusso UDP: un socket vero per ogni porta della macchina e ogni
 * destinazione, e le risposte tornano come se venissero da dove erano state
 * mandate le domande — anche quelle del DNS, che in realtà risponde il sistema.
 */
class UDPFlow {
  constructor(nat, key, { guestPort, address, port, host, hostPort }) {
    this.nat = nat;
    this.key = key;
    this.guestPort = guestPort;
    this.address = address;
    this.port = port;
    this.socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    this.socket.on('message', (data) => {
      this.touch();
      this.nat.sendUDP(this.address, this.port, GUEST, this.guestPort, data);
    });
    this.socket.on('error', () => this.close());
    this.socket.connect(hostPort, host);
    this.ready = new Promise((resolve) => this.socket.once('connect', resolve));
    this.touch();
  }

  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), UDP_IDLE_MS);
  }

  async send(data) {
    this.touch();
    await this.ready;
    if (!this.closed) this.socket.send(Buffer.from(data));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try {
      this.socket.close();
    } catch {
      // già chiuso
    }
    this.nat.udp.delete(this.key);
  }
}

/**
 * Una connessione TCP, spezzata in due: da una parte la macchina, con cui il
 * router parla TCP a mano — numeri di sequenza, conferme, finestre — e
 * dall'altra un socket vero, con cui parla il sistema. I byte che arrivano dal
 * socket restano in `unacked` finché la macchina non li conferma: se la scheda
 * ha perso un pacchetto perché il suo anello era pieno, si rimandano da lì.
 */
class TCPConnection {
  constructor(nat, key, { guest, guestPort, address, port, host, segment }) {
    this.nat = nat;
    this.key = key;
    this.guest = guest;
    this.guestPort = guestPort;
    this.address = address;
    this.port = port;

    const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
    /** Il numero da cui è partita la macchina. */
    this.irs = view.getUint32(4);
    this.rcvNxt = (this.irs + 1) >>> 0;
    this.window = view.getUint16(14);
    this.mss = 536;
    const optionsEnd = (segment[12] >> 4) * 4;
    for (let at = 20; at < optionsEnd; ) {
      const kind = segment[at];
      if (kind === 0) break;
      if (kind === 1) {
        at++;
        continue;
      }
      if (kind === 2) this.mss = Math.min(MSS, view.getUint16(at + 2));
      at += Math.max(2, segment[at + 1]);
    }

    this.iss = (Math.random() * 0x100000000) >>> 0;
    this.sndUna = this.iss;
    this.sndNxt = this.iss;
    /** Il numero di sequenza del primo byte di `unacked`. */
    this.dataStart = (this.iss + 1) >>> 0;
    this.unacked = Buffer.alloc(0);
    this.state = 'connecting';
    this.remoteEnded = false; // il socket vero ha finito di mandare
    this.finSent = false;
    this.guestFin = false;
    this.backoff = RETRANSMIT_MS;

    this.socket = net.connect({ host, port });
    this.socket.setNoDelay(true);
    this.socket.on('connect', () => {
      this.state = 'syn-received';
      this.sendSynAck();
    });
    this.socket.on('data', (chunk) => {
      this.unacked = Buffer.concat([this.unacked, chunk]);
      if (this.unacked.length > HIGH_WATER) this.socket.pause();
      this.pump();
    });
    this.socket.on('end', () => {
      this.remoteEnded = true;
      this.pump();
    });
    this.socket.on('error', () => {
      if (this.state === 'connecting') {
        this.nat.reset(this.guest, this.guestPort, this.address, this.port, 0, this.rcvNxt, true);
      } else this.abort();
      this.destroy();
    });
    this.socket.on('close', () => {
      if (this.state === 'connecting') this.destroy();
      else this.maybeFinished();
    });
  }

  send(flags, seq, data = null, options = []) {
    const packet = tcpHeader(this.port, this.guestPort, seq, this.rcvNxt, flags, WINDOW, options, data);
    this.nat.sendIP(this.address, this.guest, PROTO_TCP, packet);
  }

  sendSynAck() {
    this.send(SYN | ACK, this.iss, null, [2, 4, MSS >> 8, MSS & 0xff]);
    this.sndNxt = (this.iss + 1) >>> 0;
    this.arm();
  }

  /** Un pezzo dalla macchina. */
  segment(segment) {
    const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
    const flags = segment[13];
    const seq = view.getUint32(4);
    const data = segment.subarray((segment[12] >> 4) * 4);
    if (flags & RST) {
      this.destroy();
      return;
    }
    if (flags & SYN) {
      // La macchina rimanda il SYN: la nostra risposta si è persa.
      if (this.state === 'syn-received') this.sendSynAck();
      return;
    }
    if (this.state === 'connecting') return;
    if (flags & ACK) this.acknowledge(view.getUint32(8), view.getUint16(14));

    let fresh = data;
    const behind = (this.rcvNxt - seq) | 0;
    if (behind > 0) fresh = behind < data.length ? data.subarray(behind) : data.subarray(data.length);
    const inOrder = behind >= 0;
    if (inOrder && fresh.length) {
      this.rcvNxt = (this.rcvNxt + fresh.length) >>> 0;
      if (!this.socket.destroyed) this.socket.write(Buffer.from(fresh));
    }
    const finInOrder = flags & FIN && inOrder && ((seq + data.length - this.rcvNxt) | 0) === 0;
    if (finInOrder && !this.guestFin) {
      this.guestFin = true;
      this.rcvNxt = (this.rcvNxt + 1) >>> 0;
      this.socket.end();
    }
    // Ogni pezzo con qualcosa dentro si conferma, anche quelli fuori ordine:
    // la conferma ripetuta è quello che dice alla macchina che cosa manca.
    if (data.length || flags & FIN) this.send(ACK, this.sndNxt);
    this.pump();
    this.maybeFinished();
  }

  acknowledge(ack, window) {
    this.window = window;
    const acked = (ack - this.sndUna) | 0;
    if (acked <= 0 || ((ack - this.sndNxt) | 0) > 0) return;
    if (this.state === 'syn-received') this.state = 'established';
    this.sndUna = ack;
    const dataAcked = Math.min(this.unacked.length, Math.max(0, (ack - this.dataStart) | 0));
    if (dataAcked) {
      this.unacked = this.unacked.subarray(dataAcked);
      this.dataStart = (this.dataStart + dataAcked) >>> 0;
      if (this.unacked.length < LOW_WATER && this.socket.isPaused()) this.socket.resume();
    }
    this.backoff = RETRANSMIT_MS;
    if (this.sndUna === this.sndNxt) this.disarm();
    else this.arm(true);
  }

  /** Manda quello che la finestra della macchina lascia passare. */
  pump() {
    if (this.state !== 'established') return;
    for (;;) {
      const sent = (this.sndNxt - this.dataStart) | 0;
      const pending = this.unacked.length - sent;
      const room = this.window - ((this.sndNxt - this.sndUna) | 0);
      if (pending <= 0 || room <= 0) break;
      const length = Math.min(pending, room, this.mss);
      this.send(ACK | PSH, this.sndNxt, this.unacked.subarray(sent, sent + length));
      this.sndNxt = (this.sndNxt + length) >>> 0;
      this.arm();
    }
    const allSent = ((this.sndNxt - this.dataStart) | 0) >= this.unacked.length;
    if (this.remoteEnded && allSent && !this.finSent) {
      this.finSent = true;
      this.send(FIN | ACK, this.sndNxt);
      this.sndNxt = (this.sndNxt + 1) >>> 0;
      this.arm();
    }
    // Finestra chiusa e dati in attesa: il timer farà da sonda.
    if (this.unacked.length && this.window === 0) this.arm();
  }

  arm(restart = false) {
    if (this.timer && !restart) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.retransmit(), this.backoff);
  }

  disarm() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Niente conferme per un po': si ricomincia dal primo byte non confermato. */
  retransmit() {
    this.timer = null;
    if (this.closed) return;
    this.backoff = Math.min(this.backoff * 2, 8000);
    if (this.state === 'syn-received') {
      this.sendSynAck();
      return;
    }
    if (this.sndUna === this.sndNxt && this.window !== 0) return;
    if (this.window === 0) {
      // La sonda: un pezzo vecchio, che la macchina conferma dicendo la sua finestra.
      this.send(ACK, (this.sndUna - 1) >>> 0);
      this.arm();
      return;
    }
    this.sndNxt = this.sndUna;
    this.finSent = false;
    this.pump();
  }

  maybeFinished() {
    const finAcked = this.finSent && this.sndUna === this.sndNxt;
    if (this.guestFin && finAcked) this.destroy();
  }

  abort() {
    this.send(RST | ACK, this.sndNxt);
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.disarm();
    this.socket.destroy();
    this.nat.tcp.delete(this.key);
  }
}
