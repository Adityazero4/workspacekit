import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT ?? 4320);
const ROOT = resolve(import.meta.dirname, '..', 'out');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function fileFor(urlPath) {
  try {
    const candidate = resolve(join(ROOT, normalize(decodeURIComponent(urlPath))));
    if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats?.isDirectory()) return join(candidate, 'index.html');
    return stats?.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  const file = fileFor(pathname);
  if (!file || !statSync(file, { throwIfNoEntry: false })) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(PORT, '127.0.0.1');
