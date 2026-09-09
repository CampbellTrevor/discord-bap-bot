import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { generateDependencyReport } from '@discordjs/voice';
import { loadConfig } from '../src/config.mjs';
const config = loadConfig();
console.log(generateDependencyReport());
try {
  const { DAVESession } = await import('@snazzah/davey');
  const encryption = new DAVESession(1, '123456789012345678', '123456789012345679');
  if (!encryption.getSerializedKeyPackage().length) throw new Error('No DAVE key package');
  console.log('Discord DAVE encryption: ready');
} catch {
  console.log('Discord DAVE encryption: MISSING or could not initialize');
  process.exitCode = 1;
}
for (const [command, args] of [[config.ytDlpPath, ['--version']], ['ffmpeg', ['-version']]]) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const ok = result.status === 0 && !result.error;
  console.log(`${command}: ${ok ? result.stdout.split(/\r?\n/)[0] : 'MISSING or could not start'}`);
  if (!ok) process.exitCode = 1;
}
for (const [name, value] of Object.entries({ DISCORD_TOKEN: config.discordToken, DISCORD_CLIENT_ID: config.discordClientId, DISCORD_CLIENT_SECRET: config.discordClientSecret, SPOTIFY_CLIENT_ID: config.spotifyClientId, SPOTIFY_CLIENT_SECRET: config.spotifyClientSecret, SPOTIFY_REFRESH_TOKEN: config.spotifyRefreshToken })) {
  console.log(`${name}: ${value ? 'set' : 'not set'}`);
}
console.log(`OAuth redirect: ${config.publicUrl}/auth/discord/callback`);
