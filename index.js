/**
 * index.js — AutoDJ full merged
 *
 * - Smart cache (local-first + yt-dlp fallback)
 * - Station ID injection before each track (alternate)
 * - Persistent ffmpeg reads named FIFO and streams to Icecast (re-encode)
 * - Writes small silence before each file to avoid EOF issues
 * - Metadata update using /admin/metadata.xsl every 1s
 * - /status endpoint with yt-dlp debug and cookies preview
 *
 * ENV variables used (defaults below; set in Railway):
 *  ICECAST_HOST, ICECAST_PORT, ICECAST_MOUNT, ICECAST_USER, ICECAST_PASS
 *  ICECAST_ADMIN_USER, ICECAST_ADMIN_PASS
 *  BITRATE (e.g. "128k")
 *  SOURCES_FILE (default "sources.txt")
 *  COOKIES_PATH (default "/app/secrets/cookies.txt")
 *  CACHE_DIR (default "./cache")
 *  TMP_DIR (default "./tmp")
 *  PORT (status server default 3000)
 *  STATION_NAME (default "RicalgenFM")
 *
 * Requirements in container:
 *  - ffmpeg
 *  - yt-dlp (available via pip or included)
 *  - mkfifo (coreutils)
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ---- Config / env ----
const ICECAST_HOST = process.env.ICECAST_HOST || 'interchange.proxy.rlwy.net';
const ICECAST_PORT = process.env.ICECAST_PORT || '41091';
let ICECAST_MOUNT = process.env.ICECAST_MOUNT || '/live';
if (!ICECAST_MOUNT.startsWith('/')) ICECAST_MOUNT = '/' + ICECAST_MOUNT;

const ICECAST_USER = process.env.ICECAST_USER || 'source';
const ICECAST_PASS = process.env.ICECAST_PASS || process.env.ICECAST_PASSWORD || 'ricalgen127';

const ICECAST_ADMIN_USER = process.env.ICECAST_ADMIN_USER || ICECAST_USER;
const ICECAST_ADMIN_PASS = process.env.ICECAST_ADMIN_PASS || ICECAST_PASS;

const BITRATE = process.env.BITRATE || '128k';
const SOURCES_FILE = process.env.SOURCES_FILE || 'sources.txt';
const COOKIES_PATH = process.env.COOKIES_PATH || '/app/secrets/cookies.txt';
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const TMP_DIR = process.env.TMP_DIR || path.join(process.cwd(), 'tmp');
const PIPE_DIR = path.join(process.cwd(), 'pipe');
const FIFO_PATH = path.join(PIPE_DIR, 'musicfifo'); // named pipe
const PORT = parseInt(process.env.PORT || '3000', 10);
const STATION_NAME = process.env.STATION_NAME || 'RicalgenFM';

// Station ID files (you confirmed names in CACHE_DIR)
const STATION_ID_FILES = [
  path.join(CACHE_DIR, 'station-id.mp3'),
  path.join(CACHE_DIR, 'station-id2.mp3')
];

// ensure fs dirs
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(PIPE_DIR)) fs.mkdirSync(PIPE_DIR, { recursive: true });

// ---- Globals ----
let nowPlaying = null;
let nowPlayingUpdated = null;
let lastKnownListeners = null;
let ffmpegProc = null;
let fifoWriteStream = null;
let metadataInterval = null;
let stationIdIdx = 0;
let ytDebug = {
  last_url: null,
  command: null,
  stdout: null,
  stderr: null,
  error: null,
  auth_state: 'Unknown',
  raw_html: null
};

// ---- Helpers ----
function icecastUrl() {
  return `icecast://${encodeURIComponent(ICECAST_USER)}:${encodeURIComponent(ICECAST_PASS)}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
}
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function sanitizeForMeta(s) { if (!s) return ''; return String(s).replace(/[\/\\|&<>:"*@'?]+/g, ' - ').replace(/\s{2,}/g, ' ').trim(); }
function sanitizeFilename(s) { if (!s) return 'unknown'; return String(s).replace(/[\/\\|&<>:"*@'?]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200); }
function cleanTitle(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/\[[^\]]*]/g, '');
  s = s.replace(/\([^)]*\)/g, '');
  s = s.replace(/\{[^}]*\}/g, '');
  s = s.replace(/\s*[-–—]\s*/g, ' - ');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

// ---- child process wrappers ----
function runCmdCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let out = '', err = '';
    if (p.stdout) p.stdout.on('data', d => out += d.toString());
    if (p.stderr) p.stderr.on('data', d => err += d.toString());
    p.on('error', e => reject(e));
    p.on('exit', code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${err}`));
    });
  });
}
function runCmdDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', e => reject(e));
    p.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

// ---- yt-dlp helpers (metadata & playlist) ----
async function fetchYtMeta(url) {
  ytDebug.last_url = url;
  const args = ['-j', '--no-warnings', url];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  ytDebug.command = `yt-dlp ${args.join(' ')}`;
  try {
    const res = await runCmdCapture('yt-dlp', args);
    ytDebug.stdout = res.out;
    ytDebug.stderr = res.err;
    ytDebug.error = null;
    ytDebug.auth_state = fs.existsSync(COOKIES_PATH) ? 'Has cookies' : 'No cookies';
    return JSON.parse(res.out);
  } catch (e) {
    ytDebug.stdout = null;
    ytDebug.stderr = null;
    ytDebug.error = e.message || String(e);
    ytDebug.auth_state = fs.existsSync(COOKIES_PATH) ? 'Has cookies' : 'No cookies';
    try { ytDebug.raw_html = await fetchRawHtml(url); } catch (_) { ytDebug.raw_html = null; }
    throw new Error('yt-dlp metadata fetch failed: ' + ytDebug.error);
  }
}

async function fetchPlaylistUrls(playlistUrl) {
  const args = ['--flat-playlist', '-j', '--no-warnings', playlistUrl];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  try {
    const res = await runCmdCapture('yt-dlp', args);
    const lines = res.out.split(/\r?\n/).filter(Boolean);
    const urls = lines.map(l => {
      try {
        const o = JSON.parse(l);
        return o.url ? `https://www.youtube.com/watch?v=${o.url}` : null;
      } catch (e) { return null; }
    }).filter(Boolean);
    return urls;
  } catch (e) {
    return [];
  }
}

async function fetchRawHtml(url) {
  return new Promise(resolve => {
    try {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let data = '';
        res.on('data', c => data += c.toString());
        res.on('end', () => resolve(data));
      }).on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

// ---- download & convert flow ----
async function downloadToTmp(url, id) {
  const outTmpl = path.join(TMP_DIR, `${id}.%(ext)s`);
  const args = ['-f', 'bestaudio', '-o', outTmpl, url];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  // detached so output is logged
  await runCmdDetached('yt-dlp', args);
  const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.'));
  if (!files.length) throw new Error('downloaded file not found in tmp');
  return path.join(TMP_DIR, files[0]);
}

async function convertToMp3(inputFile, outFile) {
  // produce 44.1k stereo mp3 matching broadcast
  await runCmdDetached('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'warning', '-i', inputFile, '-vn', '-c:a', 'libmp3lame', '-b:a', BITRATE, '-ar', '44100', '-ac', '2', outFile]);
}

// ---- cache management (smart cache C3) ----
async function ensureCachedMp3ForUrl(url) {
  // fetch metadata to derive filename
  const meta = await fetchYtMeta(url);
  const rawTitle = meta.title || meta.fulltitle || 'unknown';
  const cleaned = cleanTitle(rawTitle);
  let human = cleaned;
  if (meta.uploader && !/ - /.test(cleaned)) human = `${meta.uploader} - ${cleaned}`;
  const sname = sanitizeFilename(human) + '.mp3';
  const cachePath = path.join(CACHE_DIR, sname);

  if (fs.existsSync(cachePath)) {
    return { cached: true, path: cachePath, title: human, meta };
  }

  // not cached: download then convert and keep
  const id = meta.id || ('yt-' + Date.now());
  const tmpFile = await downloadToTmp(url, id);
  await convertToMp3(tmpFile, cachePath);
  try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }
  return { cached: false, path: cachePath, title: human, meta };
}

// ---- silence creation for safe write ----
const SILENCE_MP3 = path.join(CACHE_DIR, '._silence_200ms.mp3');
function ensureSilenceMp3(durationMs = 200) {
  if (fs.existsSync(SILENCE_MP3)) return;
  const sec = Math.max(50, durationMs) / 1000;
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`, '-t', String(sec), '-c:a', 'libmp3lame', '-b:a', BITRATE, SILENCE_MP3], { stdio: ['ignore', 'inherit', 'inherit'] });
}

// ---- FIFO (named pipe) + persistent ffmpeg process ----
function ensureFifoExistsSync() {
  try {
    if (fs.existsSync(FIFO_PATH)) return true;
    // try mkfifo (works on Linux)
    spawnSync('mkfifo', [FIFO_PATH]);
    return fs.existsSync(FIFO_PATH);
  } catch (e) {
    return false;
  }
}

function startPersistentFfmpeg() {
  if (ffmpegProc) return;
  if (!ensureFifoExistsSync()) {
    console.warn('FIFO not available; persistent ffmpeg cannot start. Ensure mkfifo available and FIFO path created:', FIFO_PATH);
    return;
  }

  const args = [
    '-re',
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'mp3',
    '-i', FIFO_PATH,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', BITRATE,
    '-ar', '44100',
    '-ac', '2',
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    icecastUrl()
  ];

  console.log('Starting persistent ffmpeg ->', icecastUrl());
  ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });

  ffmpegProc.on('exit', (code, sig) => {
    console.warn('Persistent ffmpeg exited', code, sig);
    ffmpegProc = null;
    try { if (fifoWriteStream) { fifoWriteStream.destroy(); fifoWriteStream = null; } } catch (e) {}
    // small backoff then restart
    setTimeout(() => startPersistentFfmpeg(), 2000);
  });
}

// ---- resilient FIFO writer which writes a short silence then file content into FIFO ----
async function writeMp3ToFifo(filePath, maxRetries = 3) {
  ensureSilenceMp3(200);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (!ffmpegProc) startPersistentFfmpeg();
      if (!fs.existsSync(FIFO_PATH)) throw new Error('FIFO missing');
      if (!fifoWriteStream) {
        fifoWriteStream = fs.createWriteStream(FIFO_PATH, { flags: 'a' });
        fifoWriteStream.on('error', (err) => {
          console.error('fifoWriteStream error', err && err.message ? err.message : err);
          try { fifoWriteStream.destroy(); } catch (e) {}
          fifoWriteStream = null;
        });
      }

      // helper to pipe file into FIFO without ending it
      const pipeFile = (p) => new Promise((resolve, reject) => {
        const rs = fs.createReadStream(p);
        rs.on('error', reject);
        rs.on('end', () => setTimeout(resolve, 80)); // tiny delay to let ffmpeg absorb
        rs.pipe(fifoWriteStream, { end: false });
      });

      if (fs.existsSync(SILENCE_MP3)) await pipeFile(SILENCE_MP3);
      await pipeFile(filePath);
      return;
    } catch (e) {
      console.warn('write attempt failed:', e && e.message ? e.message : e);
      // cleanup, restart ffmpeg and retry
      try { if (fifoWriteStream) { fifoWriteStream.destroy(); fifoWriteStream = null; } } catch (_) {}
      try { if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; } } catch (_) {}
      await new Promise(r => setTimeout(r, 800));
      startPersistentFfmpeg();
    }
  }
  throw new Error('Failed to write file to FIFO after retries');
}

// ---- metadata updater (every 1s) ----
function updateIcecastMetadata(title) {
  try {
    const safe = sanitizeForMeta(title || STATION_NAME);
    const song = encodeURIComponent(safe);
    // note: using metadata.xsl as you tested
    const pathStr = `/admin/metadata.xsl?mount=${encodeURIComponent(ICECAST_MOUNT)}&mode=updinfo&song=${song}&charset=UTF-8`;
    const opts = {
      hostname: ICECAST_HOST,
      port: parseInt(ICECAST_PORT || '80', 10),
      path: pathStr,
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64')
      },
      timeout: 3000
    };
    const lib = (ICECAST_PORT == '443') ? https : http;
    const req = lib.request(opts, (res) => {
      res.on('data', () => { });
      res.on('end', () => { });
    });
    req.on('error', () => { });
    req.on('timeout', () => { req.destroy(); });
    req.end();
  } catch (e) { /* ignore */ }
}

function startMetadataUpdater(intervalMs = 1000) {
  if (metadataInterval) return;
  metadataInterval = setInterval(() => {
    try {
      updateIcecastMetadata(nowPlaying || STATION_NAME);
    } catch (e) { /* ignore */ }
  }, intervalMs);
}
function stopMetadataUpdater() {
  if (metadataInterval) { clearInterval(metadataInterval); metadataInterval = null; }
}

// ---- listeners fetch ----
async function fetchIcecastListeners() {
  try {
    const opts = {
      hostname: ICECAST_HOST,
      port: parseInt(ICECAST_PORT || '80', 10),
      path: '/admin/stats',
      method: 'GET',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64')
      },
      timeout: 3000
    };
    const lib = (ICECAST_PORT == '443') ? https : http;
    return await new Promise((resolve) => {
      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', d => data += d.toString());
        res.on('end', () => {
          try {
            const regex = new RegExp(`<source[^>]*mount="${escapeRegExp(ICECAST_MOUNT)}"[^>]*>([\\s\\S]*?)<\\/source>`, 'i');
            const match = data.match(regex);
            if (!match) {
              const alt = data.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
              if (alt) resolve(parseInt(alt[1], 10));
              else resolve(null);
              return;
            }
            const block = match[1];
            const lis = block.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
            resolve(lis ? parseInt(lis[1], 10) : null);
          } catch (err) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    });
  } catch (e) { return null; }
}

async function updateListenersPeriodically() {
  while (true) {
    lastKnownListeners = await fetchIcecastListeners().catch(() => null);
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ---- queue loader & playlist expansion ----
async function loadQueueExpanded() {
  const arr = [];
  if (process.env.YOUTUBE_PLAYLIST) arr.push(process.env.YOUTUBE_PLAYLIST);
  if (fs.existsSync(SOURCES_FILE)) {
    const lines = fs.readFileSync(SOURCES_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => !l.startsWith('#'));
    arr.push(...lines);
  }
  if (arr.length === 0) {
    console.error('No sources found in', SOURCES_FILE, 'and no YOUTUBE_PLAYLIST set. Exiting.');
    process.exit(1);
  }

  const expanded = [];
  for (const item of arr) {
    if (/playlist\?list=/.test(item) || /list=PL/.test(item)) {
      const urls = await fetchPlaylistUrls(item);
      if (urls.length) expanded.push(...urls);
      else expanded.push(item);
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}

// ---- station-id helper (ALT1 strict alternation) ----
function nextStationId() {
  const f = STATION_ID_FILES[stationIdIdx % STATION_ID_FILES.length];
  stationIdIdx++;
  return f;
}

// ---- Play flow (Station ID BEFORE every song) ----
async function playUrlSmart(url) {
  // If url is a direct youtube watch link or any link
  try {
    console.log('Preparing:', url);
    const info = await ensureCachedMp3ForUrl(url); // will download if missing
    const displayTitle = info.title || STATION_NAME;
    // Station ID BEFORE song (SID1)
    const idFile = nextStationId();
    if (fs.existsSync(idFile)) {
      try { await writeMp3ToFifo(idFile); } catch (e) { console.warn('station-id write failed', e && e.message ? e.message : e); }
    } else {
      // fallback: ensure a short silence if ID not present
      ensureSilenceMp3(200);
      if (fs.existsSync(SILENCE_MP3)) await writeMp3ToFifo(SILENCE_MP3);
    }

    // update now playing (song will play next)
    nowPlaying = sanitizeForMeta(displayTitle);
    nowPlayingUpdated = Date.now();
    startMetadataUpdater(1000);
    startPersistentFfmpeg();

    console.log('Now playing (writing to FIFO):', nowPlaying, '->', info.path);
    await writeMp3ToFifo(info.path);
    // after track, we do nothing (IDs are only before songs per SID1)
  } catch (e) {
    console.error('playUrlSmart error:', e && e.message ? e.message : e);
    // small backoff
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ---- Main loop (C3: local-first + yt-dlp fallback) ----
async function mainLoop() {
  ensureSilenceMp3(200);
  // start background listeners poll
  updateListenersPeriodically().catch(() => {});
  // Ensure persistent ffmpeg running
  startPersistentFfmpeg();
  // Start metadata updater as well
  startMetadataUpdater(1000);

  while (true) {
    try {
      const queue = await loadQueueExpanded();
      // shuffle to avoid same order every run
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [queue[i], queue[j]] = [queue[j], queue[i]];
      }

      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        // If local file path (exists in cache directory directly), prefer it:
        if (fs.existsSync(item) && item.toLowerCase().endsWith('.mp3')) {
          // Station ID before local file
          const idFile = nextStationId();
          if (fs.existsSync(idFile)) {
            try { await writeMp3ToFifo(idFile); } catch (e) { console.warn('station-id write failed', e && e.message ? e.message : e); }
          } else if (fs.existsSync(SILENCE_MP3)) {
            await writeMp3ToFifo(SILENCE_MP3);
          }
          const title = path.basename(item, path.extname(item));
          nowPlaying = sanitizeForMeta(title);
          nowPlayingUpdated = Date.now();
          console.log('Now playing local file:', item);
          await writeMp3ToFifo(item);
          continue;
        }

        // Otherwise assume URL (YT or http)
        await playUrlSmart(item);
      }

      // after finishing queue, small wait before repeating
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error('Main loop error:', e && e.message ? e.message : e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ---- Status server ----
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/status')) {
    const showHtml = req.url.includes('html=1');
    const cookiesInfo = (() => {
      try {
        if (!fs.existsSync(COOKIES_PATH)) return { exists: false, path: COOKIES_PATH };
        const content = fs.readFileSync(COOKIES_PATH, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        return { exists: true, path: COOKIES_PATH, size_bytes: Buffer.byteLength(content, 'utf8'), preview_lines: lines.slice(0, 40), full_lines_count: lines.length };
      } catch (e) { return { exists: false, path: COOKIES_PATH }; }
    })();

    const payload = {
      station: STATION_NAME,
      now_playing: nowPlaying || null,
      bitrate: parseInt(BITRATE.replace(/\D/g, ''), 10) || 128,
      listeners: lastKnownListeners,
      updated: nowPlayingUpdated || Date.now(),
      yt: ytDebug,
      cookies: cookiesInfo,
      fifo: { path: FIFO_PATH, exists: fs.existsSync(FIFO_PATH) }
    };

    if (showHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${STATION_NAME} status</title></head><body><h1>${STATION_NAME} status</h1><pre>${JSON.stringify(payload, null, 2)}</pre></body></html>`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }
    return;
  }

  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Status server listening on port ${PORT} (GET /status)`);
});

// ---- Kick off ----
ensureSilenceMp3(200);
startPersistentFfmpeg();
mainLoop().catch(err => {
  console.error('Fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
