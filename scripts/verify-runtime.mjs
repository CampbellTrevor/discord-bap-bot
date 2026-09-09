import { execFileSync } from 'node:child_process';
import { DAVESession } from '@snazzah/davey';
import OpusScript from 'opusscript';

// Run inside the Docker build without account credentials or network playback.
const encryption = new DAVESession(1, '123456789012345678', '123456789012345679');
if (!encryption.getSerializedKeyPackage().length) throw new Error('Discord voice encryption could not initialize.');
const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
try {
  if (!encoder.encode(Buffer.alloc(960 * 2 * 2), 960).length) throw new Error('Opus encoder could not encode a frame.');
} finally { encoder.delete(); }
const extractorVersion = execFileSync('yt-dlp', ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true }).trim();
execFileSync('ffmpeg', ['-version'], { stdio: 'pipe', timeout: 15000, windowsHide: true });
console.log(`Voice encryption, Opus, FFmpeg, and yt-dlp ${extractorVersion} verified.`);
