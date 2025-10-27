/**
 * index.js — AutoDJ with continuous FIFO ffmpeg streamer + status endpoint
 *
 * - single persistent ffmpeg process reads from FIFO (/app/pipe/musicfifo)
 * - Node downloads/converts mp3s to cache and pipes them into FIFO (no ffmpeg restarts between tracks)
 * - metadata updated via Icecast admin endpoint every second
 * - sanitized filenames & metadata to avoid problematic characters
 *
 * ENV:
 *  ICECAST_HOST, ICECAST_PORT, ICECAST_MOUNT, ICECAST_USER, ICECAST_PASS (or ICECAST_PASSWORD)
 *  ICECAST_ADMIN_USER, ICECAST_ADMIN_PASS
 *  BITRATE (e.g. "128k")
 *  SOURCES_FILE (default "sources.txt")
 *  COOKIES_PATH (default "/app/secrets/cookies.txt")
 *  CACHE_DIR (default "/app/cache")
 *  PORT (status server, default 3000)
 *  STATION_NAME (default "AutoDJ Live")
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ---- Config / env ----
const ICECAST_HOST = process.env.ICECAST_HOST || '';
const ICECAST_PORT = process.env.ICECAST_PORT || '8000';
let ICECAST_MOUNT = process.env.ICECAST_MOUNT || '/stream';
if (!ICECAST_MOUNT.startsWith('/')) ICECAST_MOUNT = '/' + ICECAST_MOUNT;

const ICECAST_USER = process.env.ICECAST_USER || 'source';
const ICECAST_PASS = process.env.ICECAST_PASS || process.env.ICECAST_PASSWORD || '';
const ICECAST_ADMIN_USER = process.env.ICECAST_ADMIN_USER || ICECAST_USER;
const ICECAST_ADMIN_PASS = process.env.ICECAST_ADMIN_PASS || ICECAST_PASS;

const BITRATE = process.env.BITRATE || '128k';
const SOURCES_FILE = process.env.SOURCES_FILE || 'sources.txt';
const COOKIES_PATH = process.env.COOKIES_PATH || '/app/secrets/cookies.txt';
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const TMP_DIR = path.join(process.cwd(), 'tmp');
const PORT = parseInt(process.env.PORT || '3000', 10);
const STATION_NAME = process.env.STATION_NAME || 'AutoDJ Live';

// FIFO config
const FIFO_DIR = path.join(process.cwd(), 'pipe');        // /app/pipe
const FIFO_PATH = path.join(FIFO_DIR, 'musicfifo');      // /app/pipe/musicfifo

if (!ICECAST_HOST) {
  console.error('ERROR: ICECAST_HOST is not set. Set it in env (Railway variables).');
  process.exit(1);
}

// Prepare folders
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---- Globals ----
let nowPlaying = null;          // sanitized title string
let nowPlayingUpdated = null;   // timestamp ms
let lastKnownListeners = null;  // integer or null

// -- Metadata updater interval
let metadataInterval = null;

// ---- Utilities: sanitizers ----
function sanitizeForFfmpeg(str) {
  if (!str) return 'unknown';
  // replace forbidden chars with dash
  let s = String(str).replace(/[\/\\|&<>:"*@'?]+/g, '-');
  // collapse multiple dashes
  s = s.replace(/-+/g, '-');
  // collapse spaces
  s = s.replace(/\s+/g, ' ');
  // trim dashes/spaces at edges
  s = s.replace(/^-+/, '').replace(/-+$/, '').trim();
  return s || 'unknown';
}

function sanitizeFilename(name) {
  if (!name) return 'unknown';
  let s = String(name).replace(/[\/\\|&<>:"*@'?]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^-+/, '').replace(/-+$/, '').trim();
  return (s.slice(0, 200) || 'unknown');
}

function cleanTitle(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/\[[^\]]*]/g, '')
       .replace(/\([^)]*\)/g, '')
       .replace(/\{[^}]*\}/g, '');
  const noise = [
    'official video', 'official music video', 'music video', 'lyrics', 'lyric video',
    'hd', 'hq', 'audio', 'video', 'official', 'remastered', 'visualizer', 'clip'
  ];
  const patt = new RegExp('\\b(' + noise.join('|') + ')\\b', 'ig');
  s = s.replace(patt, '').replace(/\s*[-–—]\s*/g, ' - ').replace(/\s{2,}/g, ' ').trim();
  return s.length ? s : raw.trim();
}

// ---- Child process helpers ----
function runCmdCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let out = '', err = '';
    if (p.stdout) p.stdout.on('data', d => out += d.toString());
    if (p.stderr) p.stderr.on('data', d => err += d.toString());
    p.on('error', e => reject(e));
    p.on('exit', (code, sig) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code} ${sig || ''}\n${err}`));
    });
  });
}

function runCmdDetached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'inherit', 'inherit'] }, opts));
    p.on('error', e => reject(e));
    p.on('exit', (code, sig) => {
      if (code === 0) resolve({ code, sig });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code} ${sig || ''}`));
    });
  });
}

// ---- yt-dlp & ffmpeg helpers ----
async function fetchYtMeta(url) {
  try {
    const args = ['-j', '--no-warnings', url];
    if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
    const res = await runCmdCapture('yt-dlp', args);
    return JSON.parse(res.out);
  } catch (e) {
    throw new Error('yt-dlp metadata fetch failed: ' + (e.message || e));
  }
}

async function downloadToTmp(url, id) {
  const outTmpl = path.join(TMP_DIR, `${id}.%(ext)s`);
  const args = ['-f', 'bestaudio', '-o', outTmpl, url];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  await runCmdDetached('yt-dlp', args);
  const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.'));
  if (!files.length) throw new Error('downloaded file not found in tmp');
  return path.join(TMP_DIR, files[0]);
}

async function convertToMp3(inputFile, outFile) {
  await runCmdDetached('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-i', inputFile,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', BITRATE,
    outFile
  ]);
}

// ---- Cache and playback ----
async function ensureCachedMp3ForUrl(url) {
  const meta = await fetchYtMeta(url);
  const rawTitle = meta.title || meta.fulltitle || 'unknown';
  let clean = cleanTitle(rawTitle);
  if (meta.uploader && !/ - /.test(clean)) clean = `${meta.uploader} - ${clean}`;

  const safeName = sanitizeFilename(clean) + '.mp3';
  const cachePath = path.join(CACHE_DIR, safeName);

  if (fs.existsSync(cachePath)) return { cached: true, path: cachePath, title: clean };

  const id = meta.id || ('yt-' + Date.now());
  const tmpFile = await downloadToTmp(url, id);
  await convertToMp3(tmpFile, cachePath);
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return { cached: false, path: cachePath, title: clean };
}

// ---- Icecast helpers ----
function icecastUrl() {
  return `icecast://${encodeURIComponent(ICECAST_USER)}:${encodeURIComponent(ICECAST_PASS)}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
}

async function updateIcecastMetadata(nowPlayingTitle) {
  return new Promise(resolve => {
    try {
      const safeTitle = sanitizeForFfmpeg(nowPlayingTitle || 'unknown');
      const song = encodeURIComponent(safeTitle);
      // use .xsl and charset to match many icecast setups
      const pathStr = `/admin/metadata.xsl?mount=${encodeURIComponent(ICECAST_MOUNT)}&mode=updinfo&song=${song}&charset=UTF-8`;
      const opts = {
        hostname: ICECAST_HOST,
        port: parseInt(ICECAST_PORT || '80', 10),
        path: pathStr,
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64') },
        timeout: 4000
      };
      const req = (ICECAST_PORT == '443' ? https : http).request(opts, res => {
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      });
      req.on('error', e => { console.warn('Icecast metadata update failed:', e.message); resolve(false); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (e) { console.warn('Icecast metadata update error:', e.message); resolve(false); }
  });
}

function fetchIcecastListeners() {
  return new Promise(resolve => {
    try {
      const opts = {
        hostname: ICECAST_HOST,
        port: parseInt(ICECAST_PORT || '80', 10),
        path: '/admin/stats',
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64') },
        timeout: 4000
      };
      const req = (ICECAST_PORT == '443' ? https : http).request(opts, res => {
        let data = '';
        res.on('data', d => data += d.toString());
        res.on('end', () => {
          try {
            const regex = new RegExp(`<source[^>]*mount="${escapeRegExp(ICECAST_MOUNT)}"[^>]*>([\\s\\S]*?)<\\/source>`, 'i');
            const match = data.match(regex);
            if (match) {
              const lis = match[1].match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
              resolve(lis ? parseInt(lis[1], 10) : null);
            } else {
              const alt = data.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
              resolve(alt ? parseInt(alt[1], 10) : null);
            }
          } catch (e) {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}

function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- FIFO and persistent ffmpeg manager ----
let ffmpegProc = null;
let fifoWriteStream = null;
let ffmpegRestartTimer = null;
const FFMPEG_RESTART_DELAY = 3000; // ms

function ensureFifoExistsSync() {
  try {
    if (!fs.existsSync(FIFO_DIR)) fs.mkdirSync(FIFO_DIR, { recursive: true, mode: 0o755 });
    if (!fs.existsSync(FIFO_PATH)) {
      const res = spawnSync('mkfifo', [FIFO_PATH]);
      if (res.status !== 0) {
        console.warn('mkfifo failed:', res.stderr ? res.stderr.toString() : '(no stderr)');
        throw new Error('mkfifo failed');
      }
      try { fs.chmodSync(FIFO_PATH, 0o666); } catch (e) {}
    }
    return true;
  } catch (e) {
    console.error('Failed to create FIFO:', e.message || e);
    return false;
  }
}

function startPersistentFfmpeg() {
  if (ffmpegProc) return;
  if (!ensureFifoExistsSync()) return;

  // Build ffmpeg args (read from FIFO path)
  const ffargs = [
    '-re',
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', FIFO_PATH,
    '-vn',
    '-c:a', 'copy',               // copy MP3 frames (low CPU)
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    icecastUrl()
  ];

  console.log('Starting persistent ffmpeg with args:', ffargs.join(' '));
  ffmpegProc = spawn('ffmpeg', ffargs, { stdio: ['ignore', 'inherit', 'inherit'] });

  ffmpegProc.on('error', (err) => {
    console.error('Persistent ffmpeg error:', err && err.message ? err.message : err);
  });

  ffmpegProc.on('exit', (code, sig) => {
    console.warn(`Persistent ffmpeg exited ${code || ''} ${sig || ''}`);
    ffmpegProc = null;
    try { if (fifoWriteStream) { fifoWriteStream.destroy(); fifoWriteStream = null; } } catch (e) {}
    if (ffmpegRestartTimer) clearTimeout(ffmpegRestartTimer);
    ffmpegRestartTimer = setTimeout(() => {
      startPersistentFfmpeg();
      ffmpegRestartTimer = null;
    }, FFMPEG_RESTART_DELAY);
  });
}

// write an mp3 file into FIFO (appends, does not close FIFO writer)
async function writeMp3ToFifo(mp3Path) {
  return new Promise((resolve, reject) => {
    if (!ffmpegProc) startPersistentFfmpeg();
    if (!fs.existsSync(FIFO_PATH)) return reject(new Error('FIFO path not found: ' + FIFO_PATH));

    if (!fifoWriteStream) {
      try {
        // 'a' append flag prevents accidentally closing the reader when write ends
        fifoWriteStream = fs.createWriteStream(FIFO_PATH, { flags: 'a' });
        fifoWriteStream.on('error', (err) => {
          console.error('FIFO write stream error:', err && err.message ? err.message : err);
        });
      } catch (e) {
        return reject(e);
      }
    }

    const rs = fs.createReadStream(mp3Path);
    rs.on('error', (err) => {
      console.error('Error reading mp3 for FIFO:', err && err.message ? err.message : err);
      return reject(err);
    });

    rs.on('end', () => {
      // a tiny gap guard
      setTimeout(() => resolve(), 200);
    });

    // pipe without ending the write stream
    rs.pipe(fifoWriteStream, { end: false });
  });
}

function shutdownFifoAndFfmpeg() {
  try { if (fifoWriteStream) { fifoWriteStream.end(); fifoWriteStream = null; } } catch (e) {}
  try { if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; } } catch (e) {}
  if (ffmpegRestartTimer) clearTimeout(ffmpegRestartTimer);
}

// ---- Streaming using FIFO (replaces per-file ffmpeg spawning) ----
async function streamCachedMp3ToIcecast(mp3Path, title) {
  try {
    const safeTitle = sanitizeForFfmpeg(title);
    nowPlaying = safeTitle;
    nowPlayingUpdated = Date.now();

    // ensure ffmpeg is running and start metadata updater
    startMetadataUpdater();

    // initial single metadata update (updater will continue)
    updateIcecastMetadata(safeTitle).then(ok => {
      console.log(ok ? 'Icecast metadata updated (initial).' : 'Icecast metadata update failed (initial).');
    });

    console.log('Writing MP3 to FIFO:', mp3Path);
    await writeMp3ToFifo(mp3Path);
    console.log('Finished writing MP3 to FIFO:', mp3Path);
  } catch (err) {
    console.error('streamCachedMp3ToIcecast (FIFO) error:', err && err.message ? err.message : err);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// ---- Playback loop ----
let stopping = false;
process.on('SIGINT', () => { console.log('SIGINT'); stopping = true; stopMetadataUpdater(); shutdownFifoAndFfmpeg(); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM'); stopping = true; stopMetadataUpdater(); shutdownFifoAndFfmpeg(); process.exit(0); });

async function playUrl(url) {
  try {
    console.log('Preparing:', url);
    const info = await ensureCachedMp3ForUrl(url);
    console.log('Now playing (title):', info.title);
    await streamCachedMp3ToIcecast(info.path, info.title);
  } catch (err) {
    console.error('playUrl error:', err && err.message ? err.message : err);
    await new Promise(r => setTimeout(r, 4000));
  }
}

function loadQueue() {
  const arr = [];
  const pl = process.env.YOUTUBE_PLAYLIST;
  if (pl) arr.push(pl);

  if (fs.existsSync(SOURCES_FILE)) {
    const lines = fs.readFileSync(SOURCES_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.startsWith('#'));
    arr.push(...lines);
  }

  if (arr.length === 0) {
    console.error('No sources found in', SOURCES_FILE, 'and no YOUTUBE_PLAYLIST set. Exiting.');
    process.exit(1);
  }
  return arr;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

async function mainLoop() {
  while (!stopping) {
    try {
      const q = loadQueue();
      shuffle(q);
      for (let i = 0; i < q.length && !stopping; i++) {
        console.log(`Queue item ${i+1}/${q.length}: ${q[i]}`);
        await playUrl(q[i]);
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error('Main loop error:', e && e.message ? e.message : e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log('Stopped main loop.');
}

// ---- Metadata updater (every 1s, configurable) ----
function startMetadataUpdater(intervalMs = 1000) {
  if (metadataInterval) return;
  metadataInterval = setInterval(async () => {
    if (nowPlaying) {
      try {
        await updateIcecastMetadata(nowPlaying);
      } catch (e) {
        // ignore
      }
    }
  }, intervalMs);
}

function stopMetadataUpdater() {
  if (metadataInterval) {
    clearInterval(metadataInterval);
    metadataInterval = null;
  }
}

// ---- Status server ----
async function updateListenersPeriodically() {
  while (!stopping) {
    try {
      lastKnownListeners = await fetchIcecastListeners();
    } catch (e) {
      lastKnownListeners = null;
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/status' || req.url === '/status/') {
    const bitrateNum = parseInt(BITRATE.replace(/\D/g, ''), 10) || 128;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      station: STATION_NAME,
      now_playing: nowPlaying || null,
      bitrate: bitrateNum,
      listeners: lastKnownListeners,
      updated: nowPlayingUpdated || Date.now()
    }));
  } else if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Status server listening on port ${PORT} (GET /status)`);
});

// Kick off
updateListenersPeriodically().catch(() => {});
mainLoop().catch(err => { console.error('Fatal:', err); process.exit(1); });
