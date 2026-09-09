import 'dotenv/config';
import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env first.');
  process.exit(1);
}
const port = 8888;
const redirect = `http://127.0.0.1:${port}/spotify/callback`;
const state = randomBytes(32).toString('hex');
const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const parameters = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect,
  scope: 'playlist-read-private playlist-read-collaborative', state, code_challenge_method: 'S256', code_challenge: challenge });
let used = false;
let finished = false;
const cancellation = new AbortController();
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  let url;
  try { url = new URL(req.url, redirect); } catch { res.writeHead(400).end('Invalid request'); return; }
  if (req.method !== 'GET' || url.pathname !== '/spotify/callback') { res.writeHead(404).end('Not found'); return; }
  const received = Buffer.from(url.searchParams.get('state') || '');
  const expected = Buffer.from(state);
  if (finished || used || received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.writeHead(400).end('Invalid or expired authorization. Run npm run spotify:authorize again.'); return;
  }
  used = true;
  if (url.searchParams.has('error') || !url.searchParams.get('code')) {
    res.writeHead(400).end('Spotify authorization was declined. No credentials were changed.');
    console.log('Spotify authorization was declined.'); finish(1); return;
  }
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(20000)]),
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: url.searchParams.get('code'), redirect_uri: redirect, code_verifier: verifier }),
    });
    if (!response.ok) throw new Error('Spotify rejected authorization. Check the registered redirect URL and app credentials.');
    const tokens = await response.json();
    if (finished) throw new Error('Spotify authorization expired. Run the helper again.');
    if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || /[\r\n]/.test(tokens.refresh_token)) throw new Error('Spotify did not issue a refresh token.');
    const file = path.resolve('.env');
    let contents;
    try { contents = await readFile(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; contents = ''; }
    const line = `SPOTIFY_REFRESH_TOKEN=${JSON.stringify(tokens.refresh_token)}`;
    contents = contents.split(/\r?\n/).filter(value => !/^\s*(?:export\s+)?SPOTIFY_REFRESH_TOKEN\s*=/.test(value)).join('\n').trimEnd() + `\n${line}\n`;
    if (finished) throw new Error('Spotify authorization expired. Run the helper again.');
    const temporary = `${file}.spotify.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    if (finished) throw new Error('Spotify authorization expired. Run the helper again.');
    await rename(temporary, file);
    res.end('Spotify connected. The refresh token was saved to your local .env. You can close this tab.');
    console.log('Spotify authorized. SPOTIFY_REFRESH_TOKEN saved to .env (not printed). Copy it securely into the Render service environment when deploying.');
    finish(0);
  } catch (error) {
    res.writeHead(500).end('Authorization could not be completed. Return to the terminal for instructions.');
    console.error(error.message.includes('Spotify') ? error.message : 'Could not save authorization. Check the local .env file permissions and try again.');
    finish(1);
  }
});
const deadline = setTimeout(() => { console.error('Spotify authorization timed out. Run the command again to retry.'); finish(1); }, 10 * 60000);
function finish(code) {
  if (finished) return;
  finished = true;
  cancellation.abort();
  clearTimeout(deadline);
  process.exitCode = code;
  server.close();
  server.closeIdleConnections();
}
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port 8888 is already in use. Close the other authorization helper and retry.' : 'Could not start the local authorization helper.'); finish(1); });
server.listen(port, '127.0.0.1', () => {
  console.log(`Register this exact redirect in your Spotify app: ${redirect}`);
  console.log('Open this authorization link and approve access for the account whose playlists the bot will use:');
  console.log(`https://accounts.spotify.com/authorize?${parameters}`);
});
