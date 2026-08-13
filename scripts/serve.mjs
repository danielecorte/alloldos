#!/usr/bin/env node
// Minimal zero-dependency static server for alloldos.
// The whole project is plain ES modules, so no build step is needed.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
