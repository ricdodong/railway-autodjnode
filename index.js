// index.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ICECAST_HOST = process.env.ICECAST_HOST || 'interchange.proxy.rlwy.net';
const ICECAST_PORT = process.env.ICECAST_PORT || '41091';
const ICECAST_MOUNT = process.env.ICECAST_MOUNT || '/live';
const ICECAST_USER = process.env.ICECAST_USER || 'source';
const ICECAST_PASS = process.env.ICECAST_PASS || 'ricalgen127';
const BITRATE = process.env.BITRATE || '128k';

const SOURCES_FILE = process.env.SOURCES_FILE || 'sources.txt';
const YOUTUBE_PLAYLIST = process.env.YOUTUBE_PLAYLIST || null;

let queue = [];
let current = 0;
let isStopping = false;

function loadQueue() {
  const arr = [];
  if (YOUTUBE_PLAYLIST) {
    arr.push(YOUTUBE_PLAYLIST);
  }
  if (fs.existsSync(SOURCES_FILE)) {
    const lines = fs.readFileSync(SOURCES_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.startsWith('#'));
    arr.push(...lines);
  }
  if (arr.length === 0) {
    console.error('No sources found. Put YouTube links in sources.txt or set YOUTUBE_PLAYLIST.');
    process.exit(1);
  }
  queue = arr;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function nextIndex() {
  current = (current + 1) % queue.length;
  return current;
}

async function playLoop() {
  while (!isStopping) {
    try {
      loadQueue();
      shuffle(queue);
      for (let i = 0; i < queue.length; i++) {
        const url = queue[i];
        console.log(`Now playing (${i+1}/${queue.length}): ${url}`);
        await playUrl(url);
        if (isStopping) break;
      }
      // looped playlist; shuffle again on loop
    } catch (err) {
      console.error('Error in playLoop:', err);
      await wait(5000);
    }
  }
}

function wait(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function playUrl(url) {
  return new Promise((resolve) => {
    // yt-dlp: write raw bestaudio to stdout (-o -) in m4a or webm
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio',
      '--no-playlist', // avoid yt-dlp auto expanding playlists when we want single items; playlist mode handled by queue or YOUTUBE_PLAYLIST only
      '-o', '-',       // output to stdout
      url
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    ytdlp.on('error', (e) => {
      console.error('yt-dlp error:', e);
    });

    // ffmpeg reads from stdin (pipe:0), encodes to mp3, and streams to icecast
    // icecast url: icecast://user:pass@host:port/mount
    const icecastUrl = `icecast://${encodeURIComponent(ICECAST_USER)}:${encodeURIComponent(ICECAST_PASS)}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
    const ffmpegArgs = [
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libmp3lame',
      '-b:a', BITRATE,
      '-content_type', 'audio/mpeg',
      '-f', 'mp3',
      icecastUrl
    ];
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

    // Pipe yt-dlp stdout into ffmpeg stdin
    ytdlp.stdout.pipe(ffmpeg.stdin);

    const finish = (reason) => {
      // kill children if still alive
      if (!ytdlp.killed) ytdlp.kill('SIGKILL');
      if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
      resolve();
    };

    // If yt-dlp exits (download ended or error), give ffmpeg a little time then finish
    ytdlp.on('exit', (code, sig) => {
      console.log(`yt-dlp exited: ${code} ${sig}`);
      // let ffmpeg finish stream for up to 6s
      setTimeout(() => finish('ytdlp-exit'), 6000);
    });

    ffmpeg.on('exit', (code, sig) => {
      console.log(`ffmpeg exited: ${code} ${sig}`);
      finish('ffmpeg-exit');
    });

    // safety: if either errors, resolve and continue next track
    ytdlp.on('error', (err) => {
      console.error('yt-dlp spawn error', err);
      finish('ytdlp-error');
    });
    ffmpeg.on('error', (err) => {
      console.error('ffmpeg spawn error', err);
      finish('ffmpeg-error');
    });

    // If ffmpeg fails to connect to Icecast, retry after small delay (handled by outer loop)
  });
}

process.on('SIGINT', () => { console.log('SIGINT received — stopping'); isStopping = true; });
process.on('SIGTERM', () => { console.log('SIGTERM received — stopping'); isStopping = true; });

playLoop().catch(e => {
  console.error('Fatal error in playLoop:', e);
  process.exit(1);
});
