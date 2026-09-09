import 'dotenv/config';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { createMedia } from './media.mjs';
import { createBot } from './discord.mjs';
import { createDemoBot } from './demo.mjs';

const config = loadConfig(process.env, { demo: process.argv.includes('--demo') });
const configured = !config.setupMode && Boolean(config.discordToken && config.discordClientId && config.discordClientSecret);
const bot = config.demo ? createDemoBot() : configured ? createBot({ config, media: createMedia(config) }) : { isReady: () => false, shutdown: async () => {} };
const { app, close } = createApp({ config, bot });
const server = app.listen(config.port, config.host, () => {
  console.log(`Turntable portal: http://localhost:${config.port}`);
  if (config.demo) console.log('Local demo mode: no Discord connection or audio playback.');
  else if (!configured) console.log('Setup mode: fill in .env to connect the Discord bot.');
});
server.on('error', error => { console.error('Portal could not start:', error.message); void shutdown(1); });
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  server.close();
  server.closeIdleConnections();
  try { await bot.shutdown(); } catch { console.error('Could not finish saving the queue.'); code = 1; }
  close();
  clearTimeout(deadline);
  process.exit(code);
}
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
if (config.demo || configured) {
  bot.start().catch(error => {
    console.error('Bot startup failed:', error.message);
    void shutdown(1);
  });
}
