import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../design-mockups/', import.meta.url));
const files = ['01-studio.html','02-discord.html','03-record-shop.html','04-broadcast.html','05-swiss.html','06-library.html','07-winamp.html','08-terminal.html','09-cassette.html','10-sleeve.html'];
const port = Number(process.env.MOCKUP_PORT || 3001);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'POST' && url.pathname === '/selection') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://localhost:${port}` && origin !== `http://127.0.0.1:${port}`) {
        res.writeHead(403).end('Invalid origin'); return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) { res.writeHead(413).end('Too large'); return; }
      }
      let choice;
      try { choice = JSON.parse(body); } catch { res.writeHead(400).end('Invalid selection'); return; }
      const filename = files.find(file => file.startsWith(`${choice.id}-`));
      if (!filename) { res.writeHead(400).end('Unknown design'); return; }
      await writeFile(path.join(directory, 'choice.json'), JSON.stringify({ id: choice.id, file: filename, chosenAt: new Date().toISOString() }, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', ...files].includes(filename)) { res.writeHead(404).end('Not found'); return; }
    const body = await readFile(path.join(directory, filename));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error('Preview request failed:', error.message);
    if (!res.headersSent) res.writeHead(500);
    res.end('Could not open the preview.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Ten Turntable mockups: http://localhost:${port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
