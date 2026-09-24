#!/usr/bin/env node
// La rete, provata a pezzi e poi tutta insieme.
//
// Prima la scheda da sola, pilotata come la pilota un driver: il reset, la PROM
// con l'indirizzo, l'anello che si riempie, un pacchetto che parte. Poi il filo
// dell'interruzione, che sul PCI scatta sul livello. Poi il router di
// `nat.mjs`, con dall'altra parte una macchina finta scritta qui — che fa ARP,
// chiede l'indirizzo col DHCP, apre una connessione TCP verso un server vero su
// questo computer e ci scarica duecento KB perdendone un pezzo per strada. E
// alla fine la scheda e il router attaccati: un Pentium con SeaBIOS che trova la
// scheda sul PCI e le dà una finestra di porte e una riga d'interruzione.

import net from 'node:net';
import dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NE2000, ISR_RX, ISR_TX } from '../src/systems/pentium/ne2000.js';
import { PIC8259 } from '../src/systems/pc/pic.js';
import { NAT, GATEWAY, GUEST, NAMESERVER, GATEWAY_MAC, ipString } from './nat.mjs';

let failures = 0;
function check(label, condition, detail = '') {
  console.log(`${condition ? '  ok' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

const MAC = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

// ------------------------------------------------------------- la scheda

console.log('La scheda');
{
  let line = false;
  const nic = new NE2000({ setIRQ: (active) => (line = active) });
  const sent = [];
  nic.onTransmit = (frame) => sent.push(frame);

  nic.read(0x1f); // la porta del reset
  check('dopo il reset il chip lo dice', (nic.read(0x07) & 0x80) !== 0);

  // La PROM, letta a sedici bit come fa ogni driver: ogni byte sta due volte.
  nic.write(0x00, 0x21); // fermo, niente DMA, pagina 0
  nic.write(0x0e, 0x49); // a parole
  nic.write(0x0a, 32);
  nic.write(0x0b, 0);
  nic.write(0x08, 0);
  nic.write(0x09, 0);
  nic.write(0x00, 0x0a); // leggi
  const prom = [];
  for (let i = 0; i < 16; i++) prom.push(nic.readData(2) & 0xff);
  check('la PROM dice l\'indirizzo della scheda', MAC.every((byte, i) => prom[i] === byte), prom.slice(0, 6).map((b) => b.toString(16)).join(':'));
  check('e i due W che vogliono dire «sedici bit»', prom[14] === 0x57 && prom[15] === 0x57);
  check('a DMA finito si alza RDC', (nic.read(0x07) & 0x40) !== 0);

  // E come la legge Linux: a sedici bit, ma con `inb`. Il chip conta a parole
  // lo stesso, e ogni byte letto è la metà bassa di una parola.
  nic.write(0x0a, 12);
  nic.write(0x0b, 0);
  nic.write(0x08, 0);
  nic.write(0x09, 0);
  nic.write(0x00, 0x0a);
  const bytes = [];
  for (let i = 0; i < 6; i++) bytes.push(nic.read(0x10));
  check('letta a byte con la scheda a parole, la PROM è la stessa', MAC.every((byte, i) => bytes[i] === byte), bytes.map((b) => b.toString(16)).join(':'));

  // L'accensione, come la fa il driver di Linux.
  nic.write(0x00, 0x21);
  nic.write(0x01, 0x46); // l'anello comincia dopo sei pagine per trasmettere
  nic.write(0x02, 0x80);
  nic.write(0x03, 0x46);
  nic.write(0x07, 0xff);
  nic.write(0x0f, 0x3f);
  nic.write(0x0c, 0x04); // anche i broadcast
  nic.write(0x00, 0x61); // pagina 1
  MAC.forEach((byte, i) => nic.write(0x01 + i, byte));
  nic.write(0x07, 0x47);
  nic.write(0x00, 0x22); // via
  check('acceso, il chip non è più fermo', !nic.stopped && nic.ready);

  const frame = new Uint8Array(100);
  frame.set(BROADCAST);
  frame.set(MAC.map((b) => b ^ 1), 6);
  for (let i = 14; i < frame.length; i++) frame[i] = i;
  nic.receive(frame);
  check('un broadcast arriva e alza il filo', line && (nic.read(0x07) & ISR_RX) !== 0);

  const readRemote = (address, count) => {
    nic.write(0x0a, count & 0xff);
    nic.write(0x0b, count >> 8);
    nic.write(0x08, address & 0xff);
    nic.write(0x09, address >> 8);
    nic.write(0x00, 0x0a);
    const out = [];
    for (let i = 0; i < count; i += 2) {
      const word = nic.readData(2);
      out.push(word & 0xff, word >> 8);
    }
    return out.slice(0, count);
  };
  const header = readRemote(0x4700, 4);
  check('l\'intestazione dice «ricevuto, broadcast»', header[0] === 0x21, header[0].toString(16));
  check('e la lunghezza, con i quattro byte del CRC', header[2] + (header[3] << 8) === 104, `${header[2] + (header[3] << 8)}`);
  check('e la pagina dove comincia il prossimo', header[1] === 0x48, header[1].toString(16));
  const body = readRemote(0x4704, 100);
  check('il pacchetto è quello', body.every((byte, i) => byte === frame[i]));

  nic.write(0x07, ISR_RX | 0x40);
  check('servito il bit, il filo scende', !line);

  const stranger = frame.slice();
  stranger.set([0x02, 0, 0, 0, 0, 1]);
  nic.receive(stranger);
  check('un pacchetto per un altro non entra', (nic.read(0x07) & ISR_RX) === 0);

  // Riempire l'anello senza che il driver legga: a un certo punto non c'è posto.
  let taken = 0;
  const big = new Uint8Array(1514);
  big.set(BROADCAST);
  while (nic.ready && taken < 100) {
    nic.receive(big);
    taken++;
  }
  check('l\'anello si riempie e la scheda lo dice', !nic.ready && taken > 5 && taken < 30, `${taken} pacchetti`);
  check('e un pacchetto in più resta fuori', nic.receive(big) === false);

  // Trasmettere: scrivere il pacchetto nella memoria della scheda e dare il via.
  const out = new Uint8Array(60).map((_, i) => 255 - i);
  nic.write(0x0a, out.length);
  nic.write(0x0b, 0);
  nic.write(0x08, 0x00);
  nic.write(0x09, 0x40);
  nic.write(0x00, 0x12);
  for (let i = 0; i < out.length; i += 2) nic.writeData(out[i] | (out[i + 1] << 8), 2);
  nic.write(0x04, 0x40);
  nic.write(0x05, out.length);
  nic.write(0x06, 0);
  nic.write(0x00, 0x26);
  check('il pacchetto parte', sent.length === 1 && sent[0].every((byte, i) => byte === out[i]));
  check('e il chip dice che è partito', (nic.read(0x07) & ISR_TX) !== 0 && (nic.read(0x04) & 1) === 1);
}

// ---------------------------------------------------- il filo del PCI

console.log('\nL\'interruzione a livello');
{
  const pic = new PIC8259();
  pic.write(0x20, 0x11);
  pic.write(0x21, 0x08);
  pic.write(0x21, 0x04);
  pic.write(0x21, 0x01);
  pic.write(0x21, 0x00);
  pic.level = 0x08;
  pic.setLine(3, true);
  check('il filo alto chiede', pic.request() === 3);
  pic.acknowledge(3);
  pic.write(0x20, 0x20);
  check('dopo l\'EOI, ancora alto, chiede di nuovo', pic.request() === 3);
  pic.acknowledge(3);
  pic.setLine(3, false);
  pic.write(0x20, 0x20);
  check('abbassato, smette', pic.request() === -1);
  pic.setLine(3, true);
  pic.setLine(3, false);
  check('e un filo che sale e scende prima di essere visto non lascia niente', pic.request() === -1);
  pic.level = 0;
  pic.setLine(3, true);
  pic.setLine(3, false);
  check('sul fronte invece sì', pic.request() === 3);
}

// ------------------------------------------------------------- il router

/** Una macchina finta dall'altra parte del cavo, con quel poco di IP che serve. */
class Guest {
  constructor() {
    this.inbox = [];
    this.nat = new NAT({ send: (frame) => this.inbox.push(frame) });
  }

  frame(dst, type, payload) {
    const frame = new Uint8Array(14 + payload.length);
    frame.set(dst);
    frame.set(MAC, 6);
    frame[12] = type >> 8;
    frame[13] = type & 0xff;
    frame.set(payload, 14);
    this.nat.receive(frame);
  }

  ip(src, dst, proto, payload) {
    const packet = new Uint8Array(20 + payload.length);
    const view = new DataView(packet.buffer);
    packet[0] = 0x45;
    view.setUint16(2, packet.length);
    packet[8] = 64;
    packet[9] = proto;
    view.setUint32(12, src);
    view.setUint32(16, dst);
    packet.set(payload, 20);
    this.frame(GATEWAY_MAC, 0x0800, packet);
  }

  udp(src, srcPort, dst, dstPort, data) {
    const packet = new Uint8Array(8 + data.length);
    const view = new DataView(packet.buffer);
    view.setUint16(0, srcPort);
    view.setUint16(2, dstPort);
    view.setUint16(4, packet.length);
    packet.set(data, 8);
    this.ip(src, dst, 17, packet);
  }

  tcp(port, dst, dstPort, seq, ack, flags, data = new Uint8Array(0), window = 65535) {
    const packet = new Uint8Array(20 + data.length);
    const view = new DataView(packet.buffer);
    view.setUint16(0, port);
    view.setUint16(2, dstPort);
    view.setUint32(4, seq >>> 0);
    view.setUint32(8, ack >>> 0);
    packet[12] = 0x50;
    packet[13] = flags;
    view.setUint16(14, window);
    packet.set(data, 20);
    this.ip(GUEST, dst, 6, packet);
  }

  /** I pacchetti IP arrivati, smontati e con le somme di controllo verificate. */
  take() {
    const out = [];
    for (const frame of this.inbox.splice(0)) {
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const type = view.getUint16(12);
      if (type === 0x0806) {
        out.push({ arp: true, frame });
        continue;
      }
      const proto = frame[23];
      const src = view.getUint32(26);
      const dst = view.getUint32(30);
      const payload = frame.subarray(34);
      const ipOK = sum(frame, 14, 34) === 0xffff;
      const pseudo = (src >>> 16) + (src & 0xffff) + (dst >>> 16) + (dst & 0xffff) + proto + payload.length;
      const bodyOK = proto === 1 ? sum(payload, 0, payload.length) === 0xffff : sum(payload, 0, payload.length, pseudo) === 0xffff;
      const packet = { proto, src, dst, payload, ok: ipOK && bodyOK, frame };
      if (proto === 6) {
        const tcp = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        Object.assign(packet, {
          srcPort: tcp.getUint16(0),
          dstPort: tcp.getUint16(2),
          seq: tcp.getUint32(4),
          ack: tcp.getUint32(8),
          flags: payload[13],
          data: payload.subarray((payload[12] >> 4) * 4),
        });
      }
      if (proto === 17) {
        const udp = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        Object.assign(packet, { srcPort: udp.getUint16(0), dstPort: udp.getUint16(2), data: payload.subarray(8) });
      }
      out.push(packet);
    }
    return out;
  }
}

function sum(bytes, start, end, initial = 0) {
  let total = initial;
  for (let i = start; i + 1 < end; i += 2) total += (bytes[i] << 8) | bytes[i + 1];
  if ((end - start) & 1) total += bytes[end - 1] << 8;
  while (total > 0xffff) total = (total & 0xffff) + (total >>> 16);
  return total;
}

const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
};

console.log('\nIl router');
const guest = new Guest();

// ARP: chi è 10.0.2.2?
{
  const arp = new Uint8Array(28);
  arp.set([0, 1, 8, 0, 6, 4, 0, 1]);
  arp.set(MAC, 8);
  arp.set([10, 0, 2, 15], 14);
  arp.set([10, 0, 2, 2], 24);
  guest.frame(BROADCAST, 0x0806, arp);
  const [reply] = guest.take();
  check('ARP: il router risponde col suo indirizzo', reply?.arp && GATEWAY_MAC.every((b, i) => reply.frame[22 + i] === b));
}

// DHCP: DISCOVER, e poi REQUEST.
for (const [type, expected, name] of [
  [1, 2, 'DISCOVER → OFFER'],
  [3, 5, 'REQUEST → ACK'],
]) {
  const bootp = new Uint8Array(300);
  bootp.set([1, 1, 6, 0, 0xde, 0xad, 0xbe, 0xef]);
  bootp.set(MAC, 28);
  bootp.set([0x63, 0x82, 0x53, 0x63, 53, 1, type, 255], 236);
  guest.udp(0, 68, 0xffffffff, 67, bootp);
  const [reply] = guest.take();
  const data = reply?.data ?? new Uint8Array(0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const options = {};
  for (let at = 240; at < data.length && data[at] !== 255; at += 2 + data[at + 1]) {
    options[data[at]] = data.subarray(at + 2, at + 2 + data[at + 1]);
  }
  const addr = (bytes) => bytes && ipString(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0));
  check(
    `DHCP ${name}`,
    reply?.ok && options[53]?.[0] === expected && view.getUint32(4) === 0xdeadbeef && view.getUint32(16) === GUEST,
    `${ipString(view.getUint32(16) || 0)}, router ${addr(options[3])}, DNS ${addr(options[6])}`,
  );
}

// Il ping al router.
{
  const echo = new Uint8Array([8, 0, 0, 0, 0, 1, 0, 7, 1, 2, 3, 4]);
  const s = ~sum(echo, 0, echo.length) & 0xffff;
  echo[2] = s >> 8;
  echo[3] = s & 0xff;
  guest.ip(GUEST, GATEWAY, 1, echo);
  const [reply] = guest.take();
  check('il ping al router torna', reply?.ok && reply.proto === 1 && reply.payload[0] === 0 && reply.payload[11] === 4);
}

// UDP verso un server su questo computer, che risponde al contrario.
{
  const server = dgram.createSocket('udp4');
  server.on('message', (message, from) => server.send(Buffer.from(message).reverse(), from.port, from.address));
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const port = server.address().port;
  guest.udp(GUEST, 5000, GATEWAY, port, new TextEncoder().encode('ciao'));
  let replies = [];
  await until(() => (replies = replies.concat(guest.take())).length > 0);
  const reply = replies[0];
  check(
    'UDP: la risposta torna da 10.0.2.2, alla porta giusta',
    reply?.ok && reply.src === GATEWAY && reply.srcPort === port && reply.dstPort === 5000 && new TextDecoder().decode(reply.data) === 'oaic',
  );
  server.close();
}

// TCP: una connessione verso un server che manda duecento KB e poi chiude.
{
  const blob = Buffer.alloc(200 * 1024);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 7 + (i >> 8)) & 0xff;
  let heard = '';
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      heard += chunk;
      if (heard.includes('\n')) socket.end(blob);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const iss = 1000;
  guest.tcp(40000, GATEWAY, port, iss, 0, 0x02);
  let synack;
  await until(() => (synack = guest.take().find((p) => p.proto === 6)));
  check('TCP: SYN → SYN-ACK', synack?.ok && synack.flags === 0x12 && synack.ack === iss + 1);
  let ack = (synack.seq + 1) >>> 0;
  let seq = iss + 1;
  guest.tcp(40000, GATEWAY, port, seq, ack, 0x10);
  const hello = new TextEncoder().encode('dammi il file\n');
  guest.tcp(40000, GATEWAY, port, seq, ack, 0x18, hello);
  seq += hello.length;

  // Si riceve come riceve una macchina: in ordine, confermando quello che c'è,
  // con una finestra piccola — e il terzo pezzo lo si perde, apposta.
  const received = [];
  let dropped = false;
  let finished = false;
  let bad = 0;
  let segments = 0;
  const deadline = Date.now() + 15000;
  while (!finished && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    let advanced = false;
    let arrived = false;
    for (const p of guest.take()) {
      if (p.proto !== 6) continue;
      arrived = true;
      if (!p.ok) bad++;
      segments++;
      if (!dropped && segments === 3 && p.data.length) {
        dropped = true;
        continue;
      }
      if (p.seq === ack && p.data.length) {
        received.push(Buffer.from(p.data));
        ack = (ack + p.data.length) >>> 0;
        advanced = true;
      }
      if (p.flags & 0x01 && ((p.seq + p.data.length) >>> 0) === ack) {
        ack = (ack + 1) >>> 0;
        finished = true;
        advanced = true;
      }
    }
    if (advanced || arrived) guest.tcp(40000, GATEWAY, port, seq, ack, 0x10, undefined, 8192);
  }
  const got = Buffer.concat(received);
  check('il server ha sentito la domanda', heard === 'dammi il file\n');
  check('arrivano tutti i duecento KB, nell\'ordine', got.equals(blob), `${got.length} byte`);
  check('anche il pezzo perso, rimandato', dropped);
  check('le somme di controllo sono giuste', bad === 0, `${bad} sbagliate`);
  check('e alla fine il FIN', finished);
  guest.tcp(40000, GATEWAY, port, seq, ack, 0x11);
  seq++;
  await until(() => guest.nat.tcp.size === 0);
  check('chiusa da tutte e due le parti, la connessione se ne va', guest.nat.tcp.size === 0);

  // Una porta dove non ascolta nessuno: il router risponde con un RST.
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const nobody = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  guest.tcp(40001, GATEWAY, nobody, 5000, 0, 0x02);
  let rst;
  await until(() => (rst = guest.take().find((p) => p.proto === 6 && p.dstPort === 40001)));
  check('una porta chiusa risponde RST', rst?.ok && (rst.flags & 0x04) !== 0 && rst.ack === 5001);
  server.close();
}
guest.nat.close();
check('il DNS del router è 10.0.2.3', ipString(NAMESERVER) === '10.0.2.3');

// ------------------------------------------------- la scheda nella macchina

const ROMS = join(fileURLToPath(import.meta.url), '..', '..', 'roms', 'pentium');
if (existsSync(join(ROMS, 'seabios.bin'))) {
  console.log('\nLa scheda sul Pentium');
  const { bootPentium, Session } = await import('./pentiumsession.mjs');
  const pc = bootPentium({ disk: null });
  const session = new Session(pc);
  session.run(200);
  let mp = false;
  for (let at = 0xf0000; at < 0x100000; at += 16) {
    if (pc.read8(at) === 0x5f && pc.read8(at + 1) === 0x4d && pc.read8(at + 2) === 0x50 && pc.read8(at + 3) === 0x5f) mp = true;
  }
  check('finito il POST, la tabella MP con l\'IO-APIC che non c\'è è sparita', !mp);
  const base = pc.nicPCI.bar(0);
  const irq = pc.nicPCI.config[0x3c];
  check('SeaBIOS le dà una finestra di porte e la accende', base !== 0 && pc.nicPCI.ioEnabled, `porte a ${base.toString(16)}h`);
  check('e una riga d\'interruzione, messa sul livello', irq > 0 && irq < 16 && (pc.elcr[irq >> 3] & (1 << (irq & 7))) !== 0, `IRQ ${irq}`);
  check('dalla finestra risponde la scheda: «PC»', pc.inb(base + 0x0a) === 0x50 && pc.inb(base + 0x0b) === 0x43);
  pc.inb(base + 0x1f);
  pc.outb(base, 0x21);
  pc.outb(base + 0x0e, 0x49); // a parole
  pc.outb(base + 0x0f, 0x01);
  pc.outb(base + 0x01, 0x46);
  pc.outb(base + 0x02, 0x80);
  pc.outb(base + 0x03, 0x46);
  pc.outb(base + 0x0c, 0x04);
  pc.outb(base, 0x61);
  pc.outb(base + 0x07, 0x47);
  pc.outb(base, 0x22);
  const frame = new Uint8Array(64).fill(0xff);
  pc.nic.receive(frame);
  const slave = pc.pics.slave;
  check('un pacchetto alza la sua riga sull\'8259', (slave.irr & (1 << (irq - 8))) !== 0);
  pc.outb(base + 0x07, 0xff);
  check('e servito il bit, la riga scende', (slave.irr & (1 << (irq - 8))) === 0);
  pc.outw(base + 0x0a, 4);
  pc.outw(base + 0x08, 0x4700);
  pc.outb(base, 0x0a);
  const word = pc.ind(base + 0x10);
  check('una lettura a trentadue bit dalla porta dei dati sono quattro byte della fila', (word & 0xff) === 0x21 && ((word >>> 16) & 0xffff) === 64 + 4, word.toString(16));
} else {
  console.log('\n(senza SeaBIOS in roms/pentium/ la prova sul Pentium si salta)');
}

console.log(failures === 0 ? '\nRete OK.' : `\n${failures} problemi con la rete.`);
process.exit(failures === 0 ? 0 : 1);
