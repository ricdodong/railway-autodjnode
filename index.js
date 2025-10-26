/**
 * index.js — AutoDJ with status endpoint + yt-dlp debug + cookies diagnostics
 *
 * Full features:
 *  - sources.txt playlist (one URL per line, '#' for comments)
 *  - cache mp3 files to CACHE_DIR (human-readable sanitized filenames)
 *  - convert once (yt-dlp -> tmp -> ffmpeg -> mp3 cache)
 *  - stream cached mp3 to Icecast via ffmpeg (copy mode, -re)
 *  - update Icecast metadata via admin endpoint (best-effort)
 *  - /status endpoint on PORT (default 3000) returning now_playing, bitrate, listeners
 *  - /status?html=1 returns an HTML debug page
 *  - cookies diagnostics: reads /app/secrets/cookies.txt, shows preview + full (capped)
 *
 * WARNING: /status will show cookie contents if present. You acknowledged risk.
 *
 * ENV:
 *   ICECAST_HOST, ICECAST_PORT, ICECAST_MOUNT, ICECAST_USER, ICECAST_PASS (or ICECAST_PASSWORD)
 *   ICECAST_ADMIN_USER, ICECAST_ADMIN_PASS
 *   BITRATE (e.g. "128k")
 *   SOURCES_FILE (default "sources.txt")
 *   CACHE_DIR (default "/app/cache")
 *   PORT (HTTP status port, default 3000)
 *   STATION_NAME (default "AutoDJ Live")
 *
 * Requirements:
 *   - ffmpeg and yt-dlp available in PATH
 */

const { spawn, execSync } = require('child_process');
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

// FIXED cookies path (entrypoint.sh writes here)
const COOKIES_PATH = '/app/secrets/cookies.txt';

const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const TMP_DIR = path.join(process.cwd(), 'tmp');
const PORT = parseInt(process.env.PORT || '3000', 10);
const STATION_NAME = process.env.STATION_NAME || 'AutoDJ Live';

// Safety cap for full cookie content lines
const COOKIES_FULL_MAX_LINES = 2000;

// basic env check
if (!ICECAST_HOST) {
  console.error('ERROR: ICECAST_HOST is not set. Set it in env (Railway variables).');
  process.exit(1);
}

// ensure directories exist
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ---- Globals ----
let nowPlaying = null;
let nowPlayingUpdated = null;
let lastKnownListeners = null;

// ---- yt-dlp debug ----
let ytStatus = {
  last_url: null,
  command_args: null,   // array of args for pretty rendering
  command_pretty: null, // multi-line pretty string
  stdout: null,
  stderr: null,
  error: null,
  auth_state: 'Unknown',
  raw_html: null
};

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

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Cookies & secrets diagnostics helpers ----
function readCookiesDiagnostics() {
  const res = {
    path: COOKIES_PATH,
    exists: false,
    size_bytes: 0,
    preview_lines: [],   // first 3 non-empty lines
    full_lines_count: 0,
    full_lines: null,    // array limited to COOKIES_FULL_MAX_LINES (if requested)
    included_in_command: false
  };

  try {
    const secretsDir = path.dirname(COOKIES_PATH);
    // secrets_dir listing (names only)
    if (fs.existsSync(secretsDir)) {
      try {
        res.secrets_dir = fs.readdirSync(secretsDir).filter(Boolean);
      } catch (e) {
        res.secrets_dir = [];
      }
    } else {
      res.secrets_dir = [];
    }

    if (fs.existsSync(COOKIES_PATH)) {
      res.exists = true;
      const stat = fs.statSync(COOKIES_PATH);
      res.size_bytes = stat.size;

      const raw = fs.readFileSync(COOKIES_PATH, 'utf8');
      const lines = raw.split(/\r?\n/).map(l => l.trim());
      // first 3 non-empty lines
      const nonEmpty = lines.filter(l => l.length > 0);
      res.preview_lines = nonEmpty.slice(0, 3);
      // full lines limited
      res.full_lines_count = nonEmpty.length;
      const take = Math.min(nonEmpty.length, COOKIES_FULL_MAX_LINES);
      res.full_lines = nonEmpty.slice(0, take);
    } else {
      res.exists = false;
      res.size_bytes = 0;
      res.preview_lines = [];
      res.full_lines_count = 0;
      res.full_lines = null;
    }
  } catch (err) {
    res.error = String(err);
  }

  // whether yt-dlp command currently includes cookies param (dyanmic)
  try {
    if (Array.isArray(ytStatus.command_args) && ytStatus.command_args.includes('--cookies')) {
      res.included_in_command = true;
    } else {
      res.included_in_command = false;
    }
  } catch (e) {
    res.included_in_command = false;
  }

  return res;
}

// ---- yt-dlp & ffmpeg helpers (updated to use cookies param) ----
async function fetchYtMeta(url) {
  ytStatus.last_url = url;

  // build cookiesParam if file exists
  const cookiesParam = fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
  ytStatus.auth_state = fs.existsSync(COOKIES_PATH) ? 'Cookies loaded' : 'No cookies';

  // build args array
  const args = ['-j', '--no-warnings', ...cookiesParam, url];
  ytStatus.command_args = args.slice();
  // pretty multi-line display of command
  ytStatus.command_pretty = buildPrettyCommand('yt-dlp', args);
  ytStatus.stdout = null;
  ytStatus.stderr = null;
  ytStatus.error = null;

  try {
    const res = await runCmdCapture('yt-dlp', args);
    ytStatus.stdout = res.out || null;
    ytStatus.stderr = res.err || null;
    ytStatus.error = null;
    return JSON.parse(res.out);
  } catch (e) {
    ytStatus.stdout = null;
    ytStatus.stderr = e.message || (e && e.err) || null;
    ytStatus.error = e.message || String(e);
    throw new Error('yt-dlp metadata fetch failed: ' + ytStatus.error);
  }
}

async function downloadToTmp(url, id) {
  const outTmpl = path.join(TMP_DIR, `${id}.%(ext)s`);
  const cookiesParam = fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
  const args = ['-f', 'bestaudio', '-o', outTmpl, ...cookiesParam, url];
  // show progress in logs by inheriting stdio
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
            const mountAttr = ICECAST_MOUNT;
            const regex = new RegExp(`<source[^>]*mount="${escapeRegExp(mountAttr)}"[^>]*>([\\s\\S]*?)<\\/source>`, 'i');
            const match = data.match(regex);
            if (!match) {
              const alt = data.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
              if (alt) resolve(parseInt(alt[1], 10));
              else resolve(null);
              return;
            }
            const sourceBlock = match[1];
            const lis = sourceBlock.match(/<listeners>\s*(\d+)\s*<\/listeners>/i);
            if (lis) resolve(parseInt(lis[1], 10));
            else resolve(null);
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

// ---- Playback logic ----
async function ensureCachedMp3ForUrl(url) {
  const meta = await fetchYtMeta(url).catch(async err => {
    // capture raw HTML for debugging if possible
    if (ytStatus.last_url) {
      try { ytStatus.raw_html = await fetchRawHtml(ytStatus.last_url); } catch (e) { ytStatus.raw_html = null; }
    }
    throw err;
  });
  const rawTitle = meta.title || meta.fulltitle || 'unknown';
  const clean = cleanTitle(rawTitle);
  let human = clean;
  if (meta.uploader && !/ - /.test(clean)) human = `${meta.uploader} - ${clean}`;
  const safeName = sanitizeFilename(human) + '.mp3';
  const cachePath = path.join(CACHE_DIR, safeName);

  if (fs.existsSync(cachePath)) {
    return { cached: true, path: cachePath, title: human };
  }

  const id = meta.id || ('yt-' + Date.now());
  const tmpFile = await downloadToTmp(url, id);
  await convertToMp3(tmpFile, cachePath);
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return { cached: false, path: cachePath, title: human };
}

async function streamCachedMp3ToIcecast(mp3Path, title) {
  nowPlaying = title;
  nowPlayingUpdated = Date.now();

  updateIcecastMetadata(title).then(ok => {
    if (ok) console.log('Icecast metadata updated (admin).');
    else console.log('Icecast metadata admin update not allowed or failed.');
  });

  return new Promise((resolve) => {
    const ffargs = [
      '-re',
      '-hide_banner',
      '-loglevel', 'warning',
      '-i', mp3Path,
      '-vn',
      '-metadata', `title=${title}`,
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

// Main per-track play function
async function playUrl(url) {
  try {
    console.log('Preparing:', url);
    const info = await ensureCachedMp3ForUrl(url);
    console.log('Now playing:', info.title);
    await streamCachedMp3ToIcecast(info.path, info.title);
  } catch (err) {
    console.error('playUrl error:', err && err.message ? err.message : err);
    // capture raw html for debugging
    if (ytStatus.last_url) {
      try { ytStatus.raw_html = await fetchRawHtml(ytStatus.last_url); } catch (e) { ytStatus.raw_html = null; }
    }
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

// ---- Status server helpers ----
function buildPrettyCommand(bin, args) {
  // multi-line pretty formatting
  // return an array of lines for safer JSON embedding
  const lines = [bin];
  args.forEach(a => {
    // if a contains spaces or special chars, quote it for clarity
    if (/\s/.test(a)) lines.push(`  "${a}"`);
    else lines.push(`  ${a}`);
  });
  return lines;
}

async function fetchRawHtml(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk.toString());
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { try { req.destroy(); } catch(e){}; resolve(null); });
    } catch (e) {
      resolve(null);
    }
  });
}

// ---- Status server ----
const server = http.createServer(async (req, res) => {
  try {
    const bitrateNum = parseInt(BITRATE.replace(/\D/g, ''), 10) || 128;

    // collect cookies diagnostics
    const cookiesDiag = readCookiesDiagnostics();

    // render pretty command as multi-line string for status
    let commandPrettyStr = null;
    if (Array.isArray(ytStatus.command_pretty)) {
      commandPrettyStr = ytStatus.command_pretty.join('\n');
    } else if (ytStatus.command_pretty) {
      commandPrettyStr = Array.isArray(ytStatus.command_args) ? buildPrettyCommand('yt-dlp', ytStatus.command_args).join('\n') : String(ytStatus.command_pretty);
    }

    const payload = {
      station: STATION_NAME,
      now_playing: nowPlaying || null,
      bitrate: bitrateNum,
      listeners: lastKnownListeners,
      updated: nowPlayingUpdated || Date.now(),
      yt: {
        last_url: ytStatus.last_url,
        command: commandPrettyStr,
        stdout: ytStatus.stdout,
        stderr: ytStatus.stderr,
        error: ytStatus.error,
        auth_state: ytStatus.auth_state,
        raw_html: ytStatus.raw_html ? ytStatus.raw_html.substring(0, 20000) : null // short raw_html snippet
      },
      // top-level cookies object (as requested)
      cookies: {
        exists: cookiesDiag.exists,
        path: cookiesDiag.path,
        size_bytes: cookiesDiag.size_bytes,
        preview_lines: cookiesDiag.preview_lines,
        full_lines_count: cookiesDiag.full_lines_count,
        full_lines: cookiesDiag.full_lines, // may be null if not present
        included_in_command: cookiesDiag.included_in_command
      },
      // simple secrets_dir listing (filenames only)
      secrets_dir: cookiesDiag.secrets_dir || []
    };

    if (req.url.startsWith('/status') && req.url.includes('html=1')) {
      // HTML view
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const safeJson = JSON.stringify(payload, null, 2)
        .replace(/</g, '&lt;'); // basic escape for HTML safety
      let html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${STATION_NAME} Status</title>
<style>body{font-family:system-ui,Segoe UI,Arial;padding:16px;background:#fff;color:#111} pre{background:#f5f6f7;padding:12px;border-radius:6px;overflow:auto;max-height:60vh}</style>
</head><body>
  <h1>${STATION_NAME} — Status</h1>
  <h2>Now playing</h2>
  <pre>${payload.now_playing || '(none)'}</pre>

  <h2>YT-dlp info</h2>
  <pre>${payload.yt.command ? payload.yt.command.replace(/&lt;/g,'<') : '(no command yet)'}</pre>
  <h3>stdout</h3>
  <pre>${(payload.yt.stdout || '(none)').replace(/</g,'&lt;')}</pre>
  <h3>stderr / error</h3>
  <pre>${(payload.yt.stderr || payload.yt.error || '(none)').replace(/</g,'&lt;')}</pre>

  <h2>Cookies (diagnostics)</h2>
  <pre>exists: ${payload.cookies.exists}
path: ${payload.cookies.path}
size_bytes: ${payload.cookies.size_bytes}
preview (first 3 non-empty lines):
${payload.cookies.preview_lines && payload.cookies.preview_lines.length ? payload.cookies.preview_lines.map(l => l.replace(/</g,'&lt;')).join('\n') : '(none)'}
full_lines_count: ${payload.cookies.full_lines_count}
</pre>`;

      if (payload.cookies.full_lines && payload.cookies.full_lines.length) {
        html += `<h3>Full cookie lines (capped at ${COOKIES_FULL_MAX_LINES})</h3><pre>${payload.cookies.full_lines.map(l => l.replace(/</g,'&lt;')).join('\n')}</pre>`;
      }

      html += `<h2>Secrets dir listing</h2><pre>${(payload.secrets_dir && payload.secrets_dir.length) ? payload.secrets_dir.join('\n') : '(empty)'}</pre>`;

      if (payload.yt.raw_html) {
        html += `<h2>Raw YouTube HTML snippet</h2><pre>${payload.yt.raw_html.replace(/</g,'&lt;')}</pre>`;
      }

      html += `</body></html>`;
      res.end(html);
      return;
    }

    if (req.url === '/status' || req.url === '/status/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload, null, 2));
      return;
    } else if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

  } catch (err) {
    try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(err) })); }
    catch(e){ console.error('Failed to respond to /status request', e); }
  }
});

server.listen(PORT, () => {
  console.log(`Status server listening on port ${PORT} (GET /status)`);
});

// ---- Kick off background tasks ----
async function updateListenersPeriodically() {
  while (!stopping) {
    try {
      const n = await fetchIcecastListeners();
      if (n !== null && typeof n === 'number') lastKnownListeners = n;
      else lastKnownListeners = null;
    } catch {
      lastKnownListeners = null;
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

updateListenersPeriodically().catch(() => {});
mainLoop().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
