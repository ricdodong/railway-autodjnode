/**
 * index.js — AutoDJ with continuous FIFO ffmpeg streamer + status endpoint
 *
 * Full features implemented for your choices:
 *  - Source: YouTube playlist URL(s) expanded (env YOUTUBE_PLAYLIST or sources.txt lines)
 *  - Continuous FIFO (/app/pipe/musicfifo) + single persistent ffmpeg process (re-encode)
 *  - Cache mp3s in CACHE_DIR and reuse
 *  - Generate short silence file and insert between tracks for smoother transitions (gapless style)
 *  - Resilient FIFO writer with retries and auto-restart of ffmpeg
 *  - Icecast metadata updated via admin endpoint every 1s
 *  - /status endpoint returns now_playing, bitrate, listeners and debug info for yt-dlp
 *
 * ENV used:
 *   ICECAST_HOST, ICECAST_PORT, ICECAST_MOUNT, ICECAST_USER, ICECAST_PASS (or ICECAST_PASSWORD)
 *   ICECAST_ADMIN_USER, ICECAST_ADMIN_PASS
 *   BITRATE (e.g. "128k")
 *   SOURCES_FILE (default "sources.txt")
 *   COOKIES_PATH (default "/app/secrets/cookies.txt")
 *   CACHE_DIR (default "/app/cache")
 *   PORT (default 3000)
 *   STATION_NAME (default "AutoDJ Live")
 *   YOUTUBE_PLAYLIST (optional playlist URL)
 *
 * Requirements:
 *   - ffmpeg, yt-dlp, mkfifo present in PATH (Linux environment)
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
const FIFO_DIR = path.join(process.cwd(), 'pipe');
const FIFO_PATH = path.join(FIFO_DIR, 'musicfifo');

if (!ICECAST_HOST) {
  console.error('ERROR: ICECAST_HOST is not set. Set it in env.');
  process.exit(1);
}

// Prepare folders
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---- Globals ----
let nowPlaying = null;          // sanitized "Artist - Title" string
let nowPlayingUpdated = null;   // timestamp ms
let lastKnownListeners = null;  // integer or null

let metadataInterval = null;    // updater interval id

// Debug info for yt-dlp calls
let ytDebug = { last_url: null, command: null, stdout: null, stderr: null, error: null, auth_state: 'Unknown', raw_html: null };

// ---- Utilities: sanitizers ----
function sanitizeForFfmpeg(str) {
  if (!str) return 'unknown';
  let s = String(str).replace(/[\/\\|&<>:\"*@'?]+/g, '-');
  s = s.replace(/-+/g, '-');
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/^-+/, '').replace(/-+$/, '').trim();
  return s || 'unknown';
}

function sanitizeFilename(name) {
  if (!name) return 'unknown';
  let s = String(name).replace(/[\/\\|&<>:\"*@'?]+/g, '-');
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

// ---- yt-dlp helpers: metadata and playlist expansion ----
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
    return JSON.parse(res.out);
  } catch (e) {
    ytDebug.stdout = null;
    ytDebug.stderr = null;
    ytDebug.error = e.message || String(e);
    // attempt to capture raw HTML if possible (for debugging)
    try { ytDebug.raw_html = await fetchRawHtml(url); } catch (_) {}
    // auth state
    ytDebug.auth_state = fs.existsSync(COOKIES_PATH) ? 'Has cookies' : 'No cookies';
    throw new Error('yt-dlp metadata fetch failed: ' + ytDebug.error);
  }
}

async function fetchPlaylistUrls(playlistUrl) {
  // use --flat-playlist to get list of entries
  const args = ['--flat-playlist', '-j', '--no-warnings', playlistUrl];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  try {
    const res = await runCmdCapture('yt-dlp', args);
    // yt-dlp returns newline-delimited JSON objects for flat-playlist; parse lines
    const lines = res.out.split(/\r?\n/).filter(Boolean);
    const urls = lines.map(l => {
      try { const o = JSON.parse(l); return o.url ? `https://www.youtube.com/watch?v=${o.url}` : null; } catch (e) { return null; }
    }).filter(Boolean);
    return urls;
  } catch (e) {
    console.warn('fetchPlaylistUrls failed:', e.message || e);
    return [];
  }
}

async function fetchRawHtml(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk.toString());
        res.on('end', () => resolve(data));
      }).on('error', () => resolve(null));
    } catch (e) { resolve(null); }
  });
}

// ---- download / convert helpers ----
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
  // normalize sample rate / channels during convert to help concatenation
  await runCmdDetached('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-i', inputFile,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', BITRATE,
    '-ar', '44100',
    '-ac', '2',
    outFile
  ]);
}

// ---- Cache and ensure mp3 ----
async function ensureCachedMp3ForUrl(url) {
  // If url is a youtube playlist, throw — caller expands playlist. Here expect single video URL.
  const meta = await fetchYtMeta(url);
  const rawTitle = meta.title || meta.fulltitle || 'unknown';
  let clean = cleanTitle(rawTitle);
  if (meta.uploader && !/ - /.test(clean)) clean = `${meta.uploader} - ${clean}`;

  // ensure Artist - Title ordering as requested
  const titleParts = clean.split(' - ');
  let artistTitle = clean;
  if (titleParts.length >= 2) {
    artistTitle = clean; // keep
  }

  const safeName = sanitizeFilename(artistTitle) + '.mp3';
  const cachePath = path.join(CACHE_DIR, safeName);

  if (fs.existsSync(cachePath)) return { cached: true, path: cachePath, title: artistTitle };

  const id = meta.id || ('yt-' + Date.now());
  const tmpFile = await downloadToTmp(url, id);
  await convertToMp3(tmpFile, cachePath);
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return { cached: false, path: cachePath, title: artistTitle };
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
          } catch (e) { resolve(null); }
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

// ---- FIFO + persistent ffmpeg manager (re-encode mode) ----
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

  const ffargs = [
    '-re',
    '-hide_banner',
    '-loglevel', 'warning',
    '-f', 'mp3',
    '-i', FIFO_PATH,
    '-vn',
    '-c:a', 'libmp3lame', // re-encode to normalize frames
    '-b:a', BITRATE,
    '-ar', '44100',
    '-ac', '2',
    '-content_type', 'audio/mpeg',
    '-f', 'mp3',
    icecastUrl()
  ];

  console.log('Starting persistent ffmpeg (re-encode) with args:', ffargs.join(' '));
  ffmpegProc = spawn('ffmpeg', ffargs, { stdio: ['ignore', 'inherit', 'inherit'] });

  ffmpegProc.on('error', (err) => {
    console.error('Persistent ffmpeg error:', err && err.message ? err.message : err);
  });

  ffmpegProc.on('exit', (code, sig) => {
    console.warn(`Persistent ffmpeg exited ${code || ''} ${sig || ''}`);
    ffmpegProc = null;
    try { if (fifoWriteStream) { fifoWriteStream.destroy(); fifoWriteStream = null; } } catch (e) {}
    if (ffmpegRestartTimer) clearTimeout(ffmpegRestartTimer);
    ffmpegRestartTimer = setTimeout(() => { startPersistentFfmpeg(); ffmpegRestartTimer = null; }, FFMPEG_RESTART_DELAY);
  });
}

// Silence file generation
const SILENCE_MP3 = path.join(CACHE_DIR, '._silence_250ms.mp3');
async function ensureSilenceMp3(durationMs = 250) {
  try {
    if (fs.existsSync(SILENCE_MP3)) return;
    const sec = Math.max(50, durationMs) / 1000;
    const args = [
      '-y',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`,
      '-t', String(sec),
      '-c:a', 'libmp3lame',
      '-b:a', BITRATE,
      SILENCE_MP3
    ];
    console.log('Creating silence mp3:', args.join(' '));
    const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) console.warn('ffmpeg silence creation failed');
    else console.log('Silence MP3 created at', SILENCE_MP3);
  } catch (e) { console.warn('ensureSilenceMp3 error', e && e.message ? e.message : e); }
}

// Resilient writer: pipes silence then track, retries on EPIPE
async function writeMp3ToFifo(mp3Path, opts = {}) {
  const maxRetries = opts.maxRetries || 3;
  const silenceBeforeMs = opts.silenceBeforeMs || 200;
  await ensureSilenceMp3(silenceBeforeMs);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      if (!ffmpegProc) startPersistentFfmpeg();
      if (!fs.existsSync(FIFO_PATH)) throw new Error('FIFO path not found: ' + FIFO_PATH);

      if (!fifoWriteStream) {
        fifoWriteStream = fs.createWriteStream(FIFO_PATH, { flags: 'a' });
        fifoWriteStream.on('error', (err) => {
          console.error('FIFO write stream error (caught):', err && err.message ? err.message : err);
          try { fifoWriteStream.destroy(); } catch (e) {}
          fifoWriteStream = null;
        });
      }

      const pipeFile = (filePath) => new Promise((resolve, reject) => {
        const rs = fs.createReadStream(filePath);
        rs.on('error', err => reject(err));
        rs.on('end', () => setTimeout(resolve, 120));
        rs.pipe(fifoWriteStream, { end: false });
      });

      // pipe silence then actual mp3
      if (fs.existsSync(SILENCE_MP3)) await pipeFile(SILENCE_MP3);
      await pipeFile(mp3Path);
      return; // success
    } catch (err) {
      console.error(`writeMp3ToFifo attempt ${attempt+1} failed:`, err && err.message ? err.message : err);
      const msg = (err && err.message) ? err.message : '';
      try { if (fifoWriteStream) { fifoWriteStream.destroy(); fifoWriteStream = null; } } catch (e) {}

      if (msg.includes('EPIPE') || msg.includes('broken pipe') || !ffmpegProc) {
        // restart ffmpeg and retry
        await new Promise(r => setTimeout(r, 500 + attempt * 500));
        startPersistentFfmpeg();
        await new Promise(r => setTimeout(r, 800));
        continue; // retry
      } else {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }
  throw new Error('writeMp3ToFifo failed after retries for ' + mp3Path);
}

function shutdownFifoAndFfmpeg() {
  try { if (fifoWriteStream) { fifoWriteStream.end(); fifoWriteStream = null; } } catch (e) {}
  try { if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; } } catch (e) {}
  if (ffmpegRestartTimer) clearTimeout(ffmpegRestartTimer);
}

// ---- Streaming function using FIFO ----
async function streamCachedMp3ToIcecast(mp3Path, title) {
  try {
    // Artist - Title format: ensure ordering as requested
    // We will keep `title` as returned by ensureCachedMp3ForUrl which was already Artist - Title where possible
    const safeTitle = sanitizeForFfmpeg(title);
    nowPlaying = safeTitle;
    nowPlayingUpdated = Date.now();

    // start metadata updater and ffmpeg
    startMetadataUpdater();
    startPersistentFfmpeg();

    // initial metadata update
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

// ---- Playback loop and queue loader (expands YouTube playlists) ----
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

async function loadQueueExpanded() {
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

  // expand playlist entries into individual video URLs
  const expanded = [];
  for (const item of arr) {
    if (/playlist\?list=/.test(item) || /list=PL/.test(item)) {
      const urls = await fetchPlaylistUrls(item);
      if (urls.length) expanded.push(...urls);
      else expanded.push(item); // fallback
    } else {
      expanded.push(item);
    }
  }

  if (expanded.length === 0) {
    console.error('No sources found in', SOURCES_FILE, 'and no YOUTUBE_PLAYLIST set. Exiting.');
    process.exit(1);
  }
  return expanded;
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
      const q = await loadQueueExpanded();
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

// ---- Metadata updater (every 1s) ----
function startMetadataUpdater(intervalMs = 1000) {
  if (metadataInterval) return;
  metadataInterval = setInterval(async () => {
    if (nowPlaying) {
      try { await updateIcecastMetadata(nowPlaying); } catch (e) {}
    }
  }, intervalMs);
}

function stopMetadataUpdater() {
  if (metadataInterval) { clearInterval(metadataInterval); metadataInterval = null; }
}

// ---- Status server ----
async function updateListenersPeriodically() {
  while (!stopping) {
    try { lastKnownListeners = await fetchIcecastListeners(); } catch (e) { lastKnownListeners = null; }
    await new Promise(r => setTimeout(r, 10000));
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/status')) {
    const showHtml = req.url.includes('html=1');
    const bitrateNum = parseInt(BITRATE.replace(/\D/g, ''), 10) || 128;
    const payload = {
      station: STATION_NAME,
      now_playing: nowPlaying || null,
      bitrate: bitrateNum,
      listeners: lastKnownListeners,
      updated: nowPlayingUpdated || Date.now(),
      yt: ytDebug,
      cookies: (() => {
        try {
          if (!fs.existsSync(COOKIES_PATH)) return { exists: false, path: COOKIES_PATH };
          const content = fs.readFileSync(COOKIES_PATH, 'utf8');
          const lines = content.split(/\r?\n/).filter(Boolean);
          return { exists: true, path: COOKIES_PATH, size_bytes: Buffer.byteLength(content, 'utf8'), preview_lines: lines.slice(0,50), full_lines_count: lines.length };
        } catch (e) { return { exists: false, path: COOKIES_PATH }; }
      })(),
      fifo: { path: FIFO_PATH, exists: fs.existsSync(FIFO_PATH) }
    };

    if (showHtml) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${STATION_NAME} status</title></head><body><h1>${STATION_NAME} status</h1><pre>${JSON.stringify(payload, null, 2)}</pre></body></html>`);
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    }

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

// ---- Start everything ----
(async () => {
  // ensure silence file exists before first write
  await ensureSilenceMp3(250);
  // start listener updater and main loop
  updateListenersPeriodically().catch(() => {});
  mainLoop().catch(err => { console.error('Fatal:', err); process.exit(1); });
})();

