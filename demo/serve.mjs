// Static server for the demo pages.
//   /vendor/*.js            → GSAP builds from node_modules/gsap/dist
//   /img/photo.svg?w&h&delay → generated placeholder image, optionally slow
// Run: node demo/serve.mjs [port]

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const gsapDist = path.join(root, '..', 'node_modules', 'gsap', 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

export function createDemoServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/img/photo.svg') {
        const w = +url.searchParams.get('w') || 1200;
        const h = +url.searchParams.get('h') || 800;
        await new Promise((r) => setTimeout(r, +url.searchParams.get('delay') || 0));
        res.writeHead(200, { 'content-type': TYPES['.svg'], 'cache-control': 'no-store' });
        return res.end(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
            `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff7a59"/><stop offset="1" stop-color="#6a5cff"/></linearGradient></defs>` +
            `<rect width="100%" height="100%" fill="url(#g)"/></svg>`,
        );
      }
      const file = url.pathname.startsWith('/vendor/')
        ? path.join(gsapDist, path.basename(url.pathname))
        : path.join(root, 'public', path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(gsapDist) && !file.startsWith(path.join(root, 'public'))) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2]) || 4173;
  createDemoServer().listen(port, () => {
    console.log(`Demo running:\n  http://localhost:${port}/broken.html  (deliberately broken)\n  http://localhost:${port}/clean.html   (should pass)`);
  });
}
