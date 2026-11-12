// Local server: serves CyberSafe NG to this computer and to other devices on the
// same school network (Wi-Fi or computer lab). No internet connection is needed.
// Usage: node server.js [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PRIVATE = ['server.js', 'package.json', 'README.md', 'tests', 'node_modules', '.git'];

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    const rel = file.slice(ROOT.length);
    if (!file.startsWith(ROOT) || PRIVATE.some(p => rel === p || rel.startsWith(p + sep)) || rel.split(sep).some(p => p.startsWith('.'))) throw { code: 'ENOENT' };
    if (!(await stat(file)).isFile()) throw { code: 'ENOENT' };
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch (e) {
    res.writeHead(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 404 : 500, { 'Content-Type': 'text/plain' });
    res.end(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'Not found' : 'Server error');
  }
}).listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('CyberSafe NG is running.\n');
  console.log(`  On this computer:      http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  On the school network: http://${ip}:${PORT}`);
  console.log('\nPress Ctrl+C to stop.');
});
