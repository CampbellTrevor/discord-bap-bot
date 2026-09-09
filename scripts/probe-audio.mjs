import 'dotenv/config';
import { createMedia, MediaError } from '../src/media.mjs';

// A small public-audio probe for evaluating a host before moving the bot.
// It does not log into Discord, save media, print signed URLs, or use cookies.
const query = process.argv[2];
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(new Error('Audio probe timed out.')), 90000);
let opened;
try {
  if (!query) throw new Error('Usage: npm run probe:audio -- <public YouTube video URL>');
  const url = new URL(query);
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1)
    : ['youtube.com', 'www.youtube.com'].includes(url.hostname) && url.pathname === '/watch' ? url.searchParams.get('v') : '';
  if (url.protocol !== 'https:' || url.username || url.password || !/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw new Error('The audio probe requires one public YouTube video URL.');
  const started = Date.now();
  const media = createMedia({ ytDlpPath: process.env.YT_DLP_PATH || 'yt-dlp' });
  const [track] = await media.resolve(`https://www.youtube.com/watch?v=${id}`, { signal: controller.signal });
  opened = await media.open(track, { signal: controller.signal });
  let bytes = 0;
  for await (const chunk of opened.stream) {
    bytes += chunk.length;
    if (bytes >= 65536) break;
  }
  if (bytes < 65536) throw new Error('The audio stream ended before the probe completed.');
  console.log(`Public YouTube audio received: ${bytes} bytes in ${((Date.now() - started) / 1000).toFixed(1)}s. No media saved.`);
  console.log('This verifies audio access now. A real Discord voice test and continued operation are still required.');
} catch (error) {
  // MediaError contains the same sanitized diagnostics shown by the bot.
  console.error(error instanceof MediaError ? `Audio probe failed [${error.code}]: ${error.message}`
    : query ? 'Audio probe failed. Check the video URL, extractor installation, and host connectivity.' : error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  opened?.cleanup();
  controller.abort();
}
