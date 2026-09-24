#!/usr/bin/env node
// Minimal zero-dependency static server for alloldos.
// The whole project is plain ES modules, so no build step is needed.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket } from './websocket.mjs';
import { NAT } from './nat.mjs';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
  '.rom': 'application/octet-stream',
  '.prg': 'application/octet-stream',
  '.bas': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    const full = normalize(join(ROOT, path));
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');

    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // Dev server: never let a stale module survive a reload.
      'Cache-Control': 'no-store, must-revalidate',
    });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

// The network cable of the emulated PCs: a WebSocket on /net, one Ethernet frame
// per message, into a small user-mode router (see nat.mjs). Whoever holds that
// cable can open connections from this computer, so it is offered only to pages
// served by this same server, and only to browsers on this same computer.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  let sameOrigin = false;
  try {
    sameOrigin = new URL(req.headers.origin).host === req.headers.host;
  } catch {
    sameOrigin = false;
  }
  if (
    !url.pathname.endsWith('/net') ||
    req.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !req.headers['sec-websocket-key'] ||
    !LOOPBACK.has(socket.remoteAddress) ||
    !sameOrigin
  ) {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const link = acceptWebSocket(req, socket, head);
  const nat = new NAT({ send: (frame) => link.send(frame), log: (message) => console.log(`rete: ${message}`) });
  link.onmessage = (frame) => nat.receive(frame);
  link.onclose = () => nat.close();
  console.log('rete: una macchina ha attaccato il cavo');
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`La porta ${PORT} è già occupata: c'è un altro alloldos in ascolto?`);
    console.error(`Chiudilo, oppure usa un'altra porta:  PORT=${PORT + 1} npm start`);
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, () => {
  console.log(`alloldos → http://localhost:${PORT}/`);
});
