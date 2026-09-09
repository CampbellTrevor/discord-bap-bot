import 'dotenv/config';
import { createServer } from 'node:http';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createMedia } from './media.mjs';
import { createBot } from './discord.mjs';
import { createDemoBot } from './demo.mjs';
import { createWorkerBridge, connectWorker } from './worker-bridge.mjs';

const config = loadConfig(process.env, { demo: process.argv.includes('--demo') });
const remotePortal = config.botRole === 'portal';
const workerOnly = config.botRole === 'worker';
const configured = !config.setupMode && Boolean(config.discordClientId &&
  (remotePortal ? config.discordClientSecret : config.discordToken && (workerOnly || config.discordClientSecret)));
const bridge = remotePortal ? createWorkerBridge({ secret: config.workerSecret, trustProxy: config.production }) : null;
const bot = bridge?.bot || (config.demo ? createDemoBot() : configured ? createBot({ config, media: createMedia(config) }) : { isReady: () => false, shutdown: async () => {} });
let server;
let appResources;
let connection;
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30000).unref();
  connection?.close();
  bridge?.close();
  server?.close();
  server?.closeIdleConnections();
  try { if (!remotePortal) await bot.shutdown(); } catch { console.error('Could not finish saving the queue.'); code = 1; }
  appResources?.close();
  clearTimeout(deadline);
  process.exit(code);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
if (!workerOnly) {
  appResources = createApp({ config, bot });
  server = createServer(appResources.app);
  bridge?.attach(server);
  server.on('error', error => { console.error('Portal could not start:', error.message); void shutdown(1); });
  server.listen(config.port, config.host, () => {
    console.log(`Turntable portal listening on port ${config.port}.`);
    if (config.demo) console.log('Local demo mode: no Discord connection or audio playback.');
    else if (!configured) console.log('Setup mode: fill in .env to connect the Discord bot.');
    else if (remotePortal) console.log('Portal ready for the audio worker.');
  });
}
if (!remotePortal && (config.demo || configured)) {
  bot.start().then(() => {
    if (workerOnly && !stopping) {
      connection = connectWorker({ url: config.workerUrl, secret: config.workerSecret, bot,
        spotifyEnabled: Boolean(config.spotifyClientId && config.spotifyClientSecret) });
      console.log('Audio worker running; connecting to the portal.');
    }
  }).catch(error => {
    console.error('Bot startup failed:', error.message);
    void shutdown(1);
  });
}
