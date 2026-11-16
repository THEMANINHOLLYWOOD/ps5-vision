// The bridge's own eyes: one picture out of the video the console is
// sending, as a JPEG. The page can do this for itself with its <video>; the
// bridge needs it to look at the screen when nobody's browser is asked to.
//
// Decoding is left to ffmpeg, which most Macs with Homebrew have. Without it
// everything else still works; only what needs to look does not.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Where ffmpeg lives, or null. PS5VISION_FFMPEG overrides.
export function findFfmpeg(env = process.env) {
  const candidates = [
    env.PS5VISION_FFMPEG,
    ...(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'ffmpeg')),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // not there; try the next
    }
  }
  return null;
}

// keyframe: one whole picture with its parameter sets in front (Annex B).
// Resolves with a JPEG no wider than `width`.
export function toJpeg({ ffmpegPath, keyframe, hevc = false, width = 1280, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-loglevel', 'error',
      '-f', hevc ? 'hevc' : 'h264', '-i', 'pipe:0',
      '-frames:v', '1',
      '-vf', `scale='min(${width},iw)':-2`,
      '-q:v', '5',
      '-f', 'mjpeg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.setEncoding('utf8').on('data', (text) => { err = (err + text).slice(-500); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`could not run ffmpeg: ${error.message}`));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      const isJpeg = jpeg.length > 3 && jpeg[0] === 0xff && jpeg[1] === 0xd8;
      if (isJpeg) resolve(jpeg);
      else reject(new Error(`The picture could not be read${err.trim() ? `: ${err.trim().split('\n')[0]}` : '.'}`));
    });
    child.stdin.on('error', () => {}); // exited early; 'exit' reports it
    child.stdin.end(keyframe);
  });
}
