/**
 * AutoDJ (YouTube -> cache MP3 -> stream to Icecast)
 * - Metadata mode B (clean titles)
 * - Cache mode 2 (human-readable filenames)
 * - Streaming mode B (convert to MP3 once, then stream MP3 directly)
 *
 * ENV vars:
 * ICECAST_HOST, ICECAST_PORT, ICECAST_MOUNT, ICECAST_USER, ICECAST_PASS
 * ICECAST_ADMIN_USER, ICECAST_ADMIN_PASS (optional; defaults to ICECAST_USER/PASS)
 * BITRATE (e.g. "128k")
 * SOURCES_FILE (default "sources.txt")
 * YOUTUBE_PLAYLIST (optional single playlist)
 * CACHE_DIR (default "/app/cache")
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const ICECAST_HOST = process.env.ICECAST_HOST || 'interchange.proxy.rlwy.net';
const ICECAST_PORT = process.env.ICECAST_PORT || '41091';
let ICECAST_MOUNT = process.env.ICECAST_MOUNT || '/live';
if (!ICECAST_MOUNT.startsWith('/')) ICECAST_MOUNT = '/' + ICECAST_MOUNT;
const ICECAST_USER = process.env.ICECAST_USER || 'source';
const ICECAST_PASS = process.env.ICECAST_PASS || 'ricalgen127';
const ICECAST_ADMIN_USER = process.env.ICECAST_ADMIN_USER || ICECAST_USER;
const ICECAST_ADMIN_PASS = process.env.ICECAST_ADMIN_PASS || ICECAST_PASS;
const BITRATE = process.env.BITRATE || '128k';
const SOURCES_FILE = process.env.SOURCES_FILE || 'sources.txt';
const YOUTUBE_PLAYLIST = process.env.YOUTUBE_PLAYLIST || null;
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), 'cache');
const TMP_DIR = path.join(process.cwd(), 'tmp');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/** Utility: sanitize filenames to be safe on Linux/filesystems */
function sanitizeFilename(name) {
  // replace slashes, control chars, multi spaces, trim
  return name
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') // avoid leading dots
    .slice(0, 220); // limit length
}

/** Metadata cleaning (Mode B): remove common noise like (Official Video), [HD], (Lyrics) etc. */
function cleanTitle(raw) {
  if (!raw) return raw;
  let s = raw;

  // remove bracketed sections like [HD], (Official Video), {whatever}
  s = s.replace(/\[[^\]]*]/g, ''); // remove [...]
  s = s.replace(/\([^)]*\)/g, ''); // remove (...)
  s = s.replace(/\{[^}]*\}/g, ''); // remove {...}

  // common noise phrases to remove
  const noise = [
    'official video', 'official music video', 'music video', 'lyrics', 'lyric video',
    'hd', 'hq', 'audio', 'video', 'official', 'remastered', 'visualizer', 'feat.', 'ft.', '(remix)', 'remix'
  ];
  const patt = new RegExp('\\b(' + noise.join('|') + ')\\b', 'ig');
  s = s.replace(patt, '');

  // common separators cleanup
  s = s.replace(/\s*[-–—]\s*/g, ' - ');
  s = s.replace(/\s{2,}/g, ' ');
  s = s.trim();

  // If result becomes empty, fall back to raw trimmed
  return s.length ? s : raw.trim();
}

/** Helper: run a child process and promise completion */
function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, opts);
    p.on('error', (e) => reject(e));
    p.on('exit', (code, sig) => {
      if (code === 0) resolve({ code, sig });
      else reject(new Error(`${cmd} exited ${code} ${sig || ''}`));
    });
  });
}

/** Get metadata JSON for a youtube link via yt-dlp -j */
function fetchYtMetadata(url) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', ['-j', '--no-warnings', url], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    ytdlp.stdout.on('data', (b) => out += b.toString());
    ytdlp.on('error', (e) => reject(e));
    ytdlp.on('exit', (code) => {
      if (code !== 0) return reject(new Error('yt-dlp metadata fetch failed'));
      try {
        const j = JSON.parse(out);
        resolve(j);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/** Download bestaudio to tmp (yt-dlp output file contains id.ext) */
async function downloadAudioToTmp(url, id) {
  // output template: tmp/{id}.%(ext)s
  const outTmpl = path.join(TMP_DIR, `${id}.%(ext)s`);
  await runCmd('yt-dlp', ['-f', 'bestaudio', '-o', outTmpl, url]);
  // find file by id
  const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.'));
  if (files.length === 0) throw new Error('Downloaded file not found in tmp');
  return path.join(TMP_DIR, files[0]);
}

/** Convert tmp audio (m4a/webm/opus) to mp3 (one-time) */
function convertToMp3(inputFile, outFile) {
  return runCmd('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', inputFile,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', BITRATE,
    outFile
  ]);
}

/** Try update Icecast metadata via admin endpoint (best-effort).
 *  Many Icecast installs accept GET to /admin/metadata?mount=/mount&mode=updinfo&song=... with basic auth.
 */
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
      const useHttps = (ICECAST_PORT == 443);
      const req = (useHttps ? https : http).request(opts, (res) => {
        // ignore status except log
        // read and discard
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      });
      req.on('error', (e) => {
        console.warn('Icecast metadata update failed:', e.message);
        resolve(false);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (e) {
      console.warn('Icecast metadata update error:', e.message);
      resolve(false);
    }
  });
}

/** Build icecast URL used by ffmpeg output */
function icecastUrl() {
  return `icecast://${encodeURIComponent(ICECAST_USER)}:${encodeURIComponent(ICECAST_PASS)}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
}

/** Main playback for a single URL:
 * - fetch metadata (title/id)
 * - if cached mp3 exists -> use it
 * - else download -> convert -> move to cache
 * - stream cached mp3 to icecast (ffmpeg -re -i file -c copy -f mp3 icecastUrl)
 * - update icecast metadata via admin endpoint (best-effort)
 */
async function playUrl(url) {
  try {
    console.log('Fetching metadata for:', url);
    const meta = await fetchYtMetadata(url);
    const rawTitle = meta.title || (meta.fulltitle || 'unknown');
    const clean = cleanTitle(rawTitle);
    // Construct human-readable filename
    // Try to find "artist - title" pattern from yt-dlp metadata (uploader/artist fields)
    let humanName = clean;
    // if uploader exists and title doesn't already contain dash, prefer "uploader - title"
    if (meta.uploader && !/ - /.test(clean)) {
      humanName = `${meta.uploader} - ${clean}`;
    }
    const safeName = sanitizeFilename(humanName) + '.mp3';
    const cachedPath = path.join(CACHE_DIR, safeName);

    if (fs.existsSync(cachedPath)) {
      console.log('Using cached file:', cachedPath);
    } else {
      console.log('No cache found. Downloading & converting:', safeName);
      const id = meta.id || ('yt-' + Date.now());
      // download to tmp
      const tmpDownloaded = await downloadAudioToTmp(url, id);
      // convert tmp -> mp3
      await convertToMp3(tmpDownloaded, cachedPath);
      // cleanup tmp
      try { fs.unlinkSync(tmpDownloaded); } catch (e) {}
      console.log('Cached:', cachedPath);
    }

    // Attempt to update metadata before streaming (some players may pick it up)
    const nowPlaying = clean;
    updateIcecastMetadata(nowPlaying).then(ok => {
      if (ok) console.log('Icecast metadata updated via admin endpoint (best-effort).');
      else console.log('Icecast metadata update: not available or failed (continuing).');
    });

    // Stream cached mp3 to Icecast with minimal CPU (copy)
    console.log('Streaming to Icecast:', icecastUrl());
    return new Promise((resolve) => {
      // ffmpeg: -re (read in real-time), -i cached.mp3, copy audio codec, set content_type
      // set -metadata for redundancy (some servers/clients pick this up)
      const ffmpegArgs = [
        '-re',
        '-hide_banner',
        '-loglevel', 'warning',
        '-i', cachedPath,
        '-vn',
        '-metadata', `title=${nowPlaying}`,
        '-c:a', 'copy',
        '-content_type', 'audio/mpeg',
        '-f', 'mp3',
        icecastUrl()
      ];
      const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'inherit', 'inherit'] });

      ffmpeg.on('error', (err) => {
        console.error('ffmpeg spawn error:', err.message);
        resolve();
      });
      ffmpeg.on('exit', (code, sig) => {
        console.log(`ffmpeg exited (${code || ''} ${sig || ''}) — moving to next track`);
        resolve();
      });

      // Safety: if ffmpeg keeps running more than X (we rely on it to exit when file ends),
      // we do nothing; when the file ends ffmpeg will exit and we resolve to continue loop.
    });

  } catch (err) {
    console.error('playUrl error:', err && err.message ? err.message : err);
    // wait a little so we don't spin too fast on broken links
    await new Promise(r => setTimeout(r, 3000));
  }
}

/** Load queue from sources.txt and optional single playlist var */
function loadQueue() {
  const arr = [];
  if (YOUTUBE_PLAYLIST) arr.push(YOUTUBE_PLAYLIST);
  if (fs.existsSync(SOURCES_FILE)) {
    const lines = fs.readFileSync(SOURCES_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .filter(l => !l.startsWith('#'));
    arr.push(...lines);
  }
  if (arr.length === 0) {
    console.error('No sources defined. Add links in sources.txt or set YOUTUBE_PLAYLIST.');
    process.exit(1);
  }
  return arr;
}

/** Shuffle array in-place */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Main loop */
let stopping = false;
async function mainLoop() {
  while (!stopping) {
    try {
      const queue = loadQueue();
      shuffle(queue);
      for (let i = 0; i < queue.length && !stopping; i++) {
        console.log(`Now playing ${i+1}/${queue.length}: ${queue[i]}`);
        await playUrl(queue[i]);
      }
      // small delay before reshuffle/loop
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error('Main loop error:', e.message || e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

process.on('SIGINT', () => { console.log('SIGINT received — stopping'); stopping = true; });
process.on('SIGTERM', () => { console.log('SIGTERM received — stopping'); stopping = true; });

mainLoop().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
