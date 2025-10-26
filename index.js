/**
 * index.js — AutoDJ with status endpoint
 *
 * Features:
 *  - sources.txt playlist (one URL per line, '#' for comments)
 *  - cache mp3 files to CACHE_DIR (human-readable sanitized filenames)
 *  - convert once (yt-dlp -> tmp -> ffmpeg -> mp3 cache)
 *  - stream cached mp3 to Icecast via ffmpeg (copy mode, -re)
 *  - update Icecast metadata via admin endpoint (best-effort)
 *  - /status endpoint on PORT (default 3000) returning now_playing, bitrate, listeners
 *
 * ENV:
 *   ICECAST_HOST, ICECAST_PORT, ICECAST_MOUNT, ICECAST_USER, ICECAST_PASS (or ICECAST_PASSWORD)
 *   ICECAST_ADMIN_USER, ICECAST_ADMIN_PASS
 *   BITRATE (e.g. "128k")
 *   SOURCES_FILE (default "sources.txt")
 *   COOKIES_PATH (default "/app/secrets/cookies.txt")
 *   CACHE_DIR (default "/app/cache")
 *   PORT (HTTP status port, default 3000)
 *   STATION_NAME (default "AutoDJ Live")
 *
 * Requirements:
 *   - ffmpeg and yt-dlp available in PATH
 */

const { spawn } = require('child_process');
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

if (!ICECAST_HOST) {
  console.error('ERROR: ICECAST_HOST is not set. Set it in env (Railway variables).');
  process.exit(1);
}

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---- Globals ----
let nowPlaying = null;          // "Artist - Title" string
let nowPlayingUpdated = null;   // timestamp ms
let lastKnownListeners = null;  // integer or null

// ---- Utilities ----
function sanitizeFilename(name) {
  return name
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 200);
}

function cleanTitle(raw) {
  if (!raw) return raw || '';
  let s = raw;
  s = s.replace(/\[[^\]]*]/g, '');
  s = s.replace(/\([^)]*\)/g, '');
  s = s.replace(/\{[^}]*\}/g, '');
  const noise = [
    'official video', 'official music video', 'music video', 'lyrics', 'lyric video',
    'hd', 'hq', 'audio', 'video', 'official', 'remastered', 'visualizer', 'clip'
  ];
  const patt = new RegExp('\\b(' + noise.join('|') + ')\\b', 'ig');
  s = s.replace(patt, '');
  s = s.replace(/\s*[-–—]\s*/g, ' - ');
  s = s.replace(/\s{2,}/g, ' ');
  s = s.trim();
  return s.length ? s : raw.trim();
}

function runCmdCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
    let out = '';
    let err = '';
    if (p.stdout) p.stdout.on('data', d => out += d.toString());
    if (p.stderr) p.stderr.on('data', d => err += d.toString());
    p.on('error', (e) => reject(e));
    p.on('exit', (code, sig) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code} ${sig || ''}\n${err}`));
    });
  });
}

function runCmdDetached(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'inherit', 'inherit'] }, opts));
    p.on('error', (e) => reject(e));
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
  // show progress to logs (inherit) so Railway logs show download activity
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

// ---- Icecast helpers ----
function icecastUrl() {
  return `icecast://${encodeURIComponent(ICECAST_USER)}:${encodeURIComponent(ICECAST_PASS)}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
}

function updateIcecastMetadata(nowPlayingTitle) {
  return new Promise((resolve) => {
    try {
      const song = encodeURIComponent(nowPlayingTitle || '');
      const pathStr = `/admin/metadata?mount=${encodeURIComponent(ICECAST_MOUNT)}&mode=updinfo&song=${song}`;
      const opts = {
        hostname: ICECAST_HOST,
        port: parseInt(ICECAST_PORT || '80', 10),
        path: pathStr,
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64')
        },
        timeout: 4000
      };
      const useHttps = (ICECAST_PORT == '443' || ICECAST_PORT == 443);
      const req = (useHttps ? https : http).request(opts, (res) => {
        // drain
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      });
      req.on('error', (e) => { console.warn('Icecast metadata update failed:', e.message); resolve(false); });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (e) {
      console.warn('Icecast metadata update error:', e.message);
      resolve(false);
    }
  });
}

// Fetch listener count from /admin/stats (XML) and parse
function fetchIcecastListeners() {
  return new Promise((resolve) => {
    try {
      const pathStr = `/admin/stats`;
      const opts = {
        hostname: ICECAST_HOST,
        port: parseInt(ICECAST_PORT || '80', 10),
        path: pathStr,
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64')
        },
        timeout: 4000
      };
      const useHttps = (ICECAST_PORT == '443' || ICECAST_PORT == 443);
      const req = (useHttps ? https : http).request(opts, (res) => {
        let data = '';
        res.on('data', d => data += d.toString());
        res.on('end', () => {
          try {
            // find <source mount="/mount"> ... <listeners>NUM</listeners>
            const mountAttr = ICECAST_MOUNT;
            const regex = new RegExp(`<source[^>]*mount="${escapeRegExp(mountAttr)}"[^>]*>([\\s\\S]*?)<\\/source>`, 'i');
            const match = data.match(regex);
            if (!match) {
              // fallback: find first <listeners> in data
              const alt = data.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
              if (alt) {
                const n = parseInt(alt[1], 10);
                resolve(n);
              } else {
                resolve(null);
              }
              return;
            }
            const sourceBlock = match[1];
            const lis = sourceBlock.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
            if (lis) {
              resolve(parseInt(lis[1], 10));
            } else {
              resolve(null);
            }
          } catch (err) {
            resolve(null);
          }
        });
      });
      req.on('error', (e) => { resolve(null); });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Playback logic ----
async function ensureCachedMp3ForUrl(url) {
  // fetch metadata
  const meta = await fetchYtMeta(url).catch(err => { throw err; });
  const rawTitle = meta.title || meta.fulltitle || 'unknown';
  const clean = cleanTitle(rawTitle);
  let human = clean;
  if (meta.uploader && !/ - /.test(clean)) human = `${meta.uploader} - ${clean}`;
  const safeName = sanitizeFilename(human) + '.mp3';
  const cachePath = path.join(CACHE_DIR, safeName);

  if (fs.existsSync(cachePath)) {
    return { cached: true, path: cachePath, title: human };
  }

  // not cached -> download & convert
  const id = meta.id || ('yt-' + Date.now());
  const tmpFile = await downloadToTmp(url, id);
  // convert to mp3
  await convertToMp3(tmpFile, cachePath);
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return { cached: false, path: cachePath, title: human };
}

async function streamCachedMp3ToIcecast(mp3Path, title) {
  // update globals
  nowPlaying = title;
  nowPlayingUpdated = Date.now();

  // try to update icecast metadata via admin
  updateIcecastMetadata(title).then(ok => {
    if (ok) console.log('Icecast metadata updated (admin).');
    else console.log('Icecast metadata admin update not allowed or failed.');
  });

  return new Promise((resolve) => {
    const ffargs = [
        '-re',
        '-hide_banner',
        '-loglevel', 'warning',
        '-i', mp3Path, // quote if needed
        '-vn',
        '-metadata', `title=${title.replace(/"/g, '\\"')}`,
        '-metadata', `artist=${STATION_NAME.replace(/"/g, '\\"')}`,
        '-c:a', 'copy',
        '-content_type', 'audio/mpeg',
        '-f', 'mp3',
        icecastUrl()
      ];
      
    console.log('Launching ffmpeg with args:', ffargs.join(' '));
    const ff = spawn('ffmpeg', ffargs, { stdio: ['ignore', 'inherit', 'inherit'] });

    ff.on('error', (e) => {
      console.error('ffmpeg error:', e && e.message ? e.message : e);
      resolve();
    });
    ff.on('exit', (code, sig) => {
      console.log(`ffmpeg exited ${code || ''} ${sig || ''}`);
      resolve();
    });
  });
}

// Main per-track play function: ensure cache, then stream
async function playUrl(url) {
  try {
    console.log('Preparing:', url);
    const info = await ensureCachedMp3ForUrl(url);
    console.log('Now playing:', info.title);
    await streamCachedMp3ToIcecast(info.path, info.title);
  } catch (err) {
    console.error('playUrl error:', err && err.message ? err.message : err);
    // small backoff
    await new Promise(r => setTimeout(r, 4000));
  }
}

// ---- Queue loader & main loop ----
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

let stopping = false;
process.on('SIGINT', () => { console.log('SIGINT'); stopping = true; });
process.on('SIGTERM', () => { console.log('SIGTERM'); stopping = true; });

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

// ---- Status server ----
async function updateListenersPeriodically() {
  while (!stopping) {
    try {
      const n = await fetchIcecastListeners();
      if (n !== null && typeof n === 'number') {
        lastKnownListeners = n;
      } else {
        lastKnownListeners = null;
      }
    } catch (e) {
      lastKnownListeners = null;
    }
    // every 10s
    await new Promise(r => setTimeout(r, 10000));
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/status' || req.url === '/status/') {
    const bitrateNum = parseInt(BITRATE.replace(/\D/g, ''), 10) || 128;
    const payload = {
      station: STATION_NAME,
      now_playing: nowPlaying || null,
      bitrate: bitrateNum,
      listeners: lastKnownListeners,
      updated: nowPlayingUpdated || Date.now()
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
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
mainLoop().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
