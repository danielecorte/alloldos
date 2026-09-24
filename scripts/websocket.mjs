// Il WebSocket, quanto basta per far passare pacchetti ethernet.
//
// È il cavo fra la scheda di rete nel browser e il router in `nat.mjs`: un
// messaggio binario per ogni pacchetto, in tutte e due le direzioni. Il
// protocollo è quello del 2011 (RFC 6455) e ne serve una parte piccola: la
// stretta di mano, i messaggi binari, il ping e la chiusura. Niente
// compressione, niente testo.

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP_CONTINUATION = 0x0;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Più di così un messaggio non è un pacchetto ethernet. */
const MAX_MESSAGE = 64 * 1024;

/**
 * Risponde alla richiesta di passare a WebSocket.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head quello che il client ha già mandato dopo la richiesta
 * @returns {{send(data:Uint8Array):void, close():void, onmessage:?(data:Uint8Array)=>void, onclose:?()=>void}}
 */
export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const link = {
    onmessage: null,
    onclose: null,
    send(data) {
      if (!socket.destroyed) socket.write(frame(OP_BINARY, data));
    },
    close() {
      if (!socket.destroyed) socket.end(frame(OP_CLOSE, new Uint8Array(0)));
    },
  };

  let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let pieces = [];
  const parse = () => {
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        at = 10;
      }
      if (length > MAX_MESSAGE) {
        socket.destroy();
        return;
      }
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buffer.length < at + length) return;
      const payload = Buffer.from(buffer.subarray(at, at + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buffer = buffer.subarray(at + length);

      if (opcode === OP_CLOSE) {
        link.close();
        return;
      }
      if (opcode === OP_PING) {
        socket.write(frame(OP_PONG, payload));
        continue;
      }
      if (opcode !== OP_BINARY && opcode !== OP_CONTINUATION) continue;
      pieces.push(payload);
      if (fin) {
        const message = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
        pieces = [];
        link.onmessage?.(new Uint8Array(message.buffer, message.byteOffset, message.length));
      }
    }
  };
  socket.on('data', (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    parse();
  });
  socket.on('close', () => link.onclose?.());
  socket.on('error', () => socket.destroy());
  queueMicrotask(parse);
  return link;
}

/** Un messaggio dal server, che non si maschera. */
function frame(opcode, data) {
  const length = data.length;
  const header = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const out = Buffer.alloc(header + length);
  out[0] = 0x80 | opcode;
  if (length < 126) out[1] = length;
  else if (length < 65536) {
    out[1] = 126;
    out.writeUInt16BE(length, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(length), 2);
  }
  out.set(data, header);
  return out;
}
