// merged index.js — FIFO continuous streamer with station-ID injection
// - persistent ffmpeg reads from FIFO and streams to Icecast (re-encoding)
// - app writes mp3 files into FIFO (with station-id bumpers between tracks)
// - yt-dlp fetch & cache mp3s, ffmpeg converts when needed
// - metadata updated every 1s via Icecast admin endpoint (metadata.xsl)
// - /status endpoint shows now playing, yt-dlp debug, and cookies preview

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ---- Config (env) ----
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
const FIFO_PATH = path.join(PIPE_DIR, 'musicfifo');
const PORT = parseInt(process.env.PORT || '3000', 10);
const STATION_NAME = process.env.STATION_NAME || 'RicalgenFM'; // user chose C2

// filenames for station-id bumpers (existence confirmed)
const STATION_ID_1 = path.join(CACHE_DIR, 'station-id.mp3');
const STATION_ID_2 = path.join(CACHE_DIR, 'station-id2.mp3');

// ensure directories
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
let stationIdToggle = false; // alternate between id1/id2
let ytDebug = { last_url: null, command: null, stdout: null, stderr: null, error: null, auth_state: 'Unknown', raw_html: null };

// ---- small helpers ----
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&'); }
function sanitizeForFfmpeg(s) { if (!s) return ''; return String(s).replace(/[\\/:\\\\|&<>:\"*@'?]+/g, '-').replace(/-+/g, '-').trim(); }
function sanitizeFilename(s) { if (!s) return 'unknown'; return String(s).replace(/[\\/:\\\\|&<>:\"*@'?]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 200); }
function cleanTitle(raw) { if (!raw) return ''; let t = String(raw); t = t.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\{[^}]*\}/g, ''); t = t.replace(/\s*[-–—]\s*/g, ' - ').replace(/\s{2,}/g, ' ').trim(); return t; }

function icecastUrl() {
  return `icecast://${encodeURIComponent(ICECAST_USER)}:${encodeURIComponent(ICECAST_PASS)}@${ICECAST_HOST}:${ICECAST_PORT}${ICECAST_MOUNT}`;
}

// ---- child process helpers ----
function runCmdCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, Object.assign({ stdio: ['ignore','pipe','pipe'] }, opts));
    let out = '', err = '';
    if (p.stdout) p.stdout.on('data', d => out += d.toString());
    if (p.stderr) p.stderr.on('data', d => err += d.toString());
    p.on('error', e => reject(e));
    p.on('exit', code => { if (code === 0) resolve({ out, err }); else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${err}`)); });
  });
}
function runCmdDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore','inherit','inherit'] });
    p.on('error', e => reject(e));
    p.on('exit', code => { if (code === 0) resolve(); else reject(new Error(`${cmd} exited ${code}`)); });
  });
}

// ---- yt-dlp helpers ----
async function fetchYtMeta(url) {
  ytDebug.last_url = url;
  const args = ['-j','--no-warnings',url];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  ytDebug.command = `yt-dlp ${args.join(' ')}`;
  try {
    const res = await runCmdCapture('yt-dlp', args);
    ytDebug.stdout = res.out; ytDebug.stderr = res.err; ytDebug.error = null;
    return JSON.parse(res.out);
  } catch (e) {
    ytDebug.stdout = null; ytDebug.stderr = null; ytDebug.error = e.message || String(e);
    ytDebug.auth_state = fs.existsSync(COOKIES_PATH) ? 'Has cookies' : 'No cookies';
    try { ytDebug.raw_html = await fetchRawHtml(url); } catch(_) { ytDebug.raw_html = null; }
    throw new Error('yt-dlp metadata fetch failed: ' + ytDebug.error);
  }
}
async function fetchPlaylistUrls(playlistUrl) {
  const args = ['--flat-playlist','-j','--no-warnings',playlistUrl];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  try {
    const res = await runCmdCapture('yt-dlp', args);
    const lines = res.out.split(/\r?\n/).filter(Boolean);
    return lines.map(l=>{ try{const o=JSON.parse(l); return o.url?`https://www.youtube.com/watch?v=${o.url}`:null;}catch(e){return null;} }).filter(Boolean);
  } catch (e) { return []; }
}
async function fetchRawHtml(url) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      lib.get(url,{headers:{'User-Agent':'Mozilla/5.0'}}, res => { let d=''; res.on('data',c=>d+=c.toString()); res.on('end',()=>resolve(d)); }).on('error',()=>resolve(null));
    } catch(e){ resolve(null); }
  });
}

// ---- download & convert ----
async function downloadToTmp(url, id) {
  const outTmpl = path.join(TMP_DIR, `${id}.%(ext)s`);
  const args = ['-f','bestaudio','-o',outTmpl,url];
  if (fs.existsSync(COOKIES_PATH)) args.unshift('--cookies', COOKIES_PATH);
  await runCmdDetached('yt-dlp', args);
  const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(id + '.'));
  if (!files.length) throw new Error('download not found');
  return path.join(TMP_DIR, files[0]);
}
async function convertToMp3(inputFile, outFile) {
  await runCmdDetached('ffmpeg', ['-y','-hide_banner','-loglevel','warning','-i',inputFile,'-vn','-c:a','libmp3lame','-b:a',BITRATE,'-ar','44100','-ac','2',outFile]);
}

// ---- caching ----
async function ensureCachedMp3ForUrl(url) {
  const meta = await fetchYtMeta(url);
  const rawTitle = meta.title || meta.fulltitle || 'unknown';
  let clean = cleanTitle(rawTitle);
  if (meta.uploader && !/ - /.test(clean)) clean = `${meta.uploader} - ${clean}`;
  const safe = sanitizeFilename(clean) + '.mp3';
  const cachePath = path.join(CACHE_DIR, safe);
  if (fs.existsSync(cachePath)) return { cached:true, path:cachePath, title:clean };
  const id = meta.id || ('yt-' + Date.now());
  const tmp = await downloadToTmp(url, id);
  await convertToMp3(tmp, cachePath);
  try{ fs.unlinkSync(tmp); }catch(e){}
  return { cached:false, path:cachePath, title:clean };
}

// ---- silence & station-id ----
const SILENCE_MP3 = path.join(CACHE_DIR, '._silence_200ms.mp3');
function ensureSilenceMp3(durationMs=200){ if (fs.existsSync(SILENCE_MP3)) return; const sec=Math.max(50,durationMs)/1000; spawnSync('ffmpeg',['-y','-f','lavfi','-i',`anullsrc=channel_layout=stereo:sample_rate=44100`,'-t',String(sec),'-c:a','libmp3lame','-b:a',BITRATE,SILENCE_MP3],{stdio:['ignore','inherit','inherit']}); }

function stationIdPath() { stationIdToggle = !stationIdToggle; return (stationIdToggle?STATION_ID_1:STATION_ID_2); }

// ---- FIFO + persistent ffmpeg (re-encode) ----
function ensureFifoExistsSync() { try { if (fs.existsSync(FIFO_PATH)) return true; spawnSync('mkfifo',[FIFO_PATH]); return fs.existsSync(FIFO_PATH); } catch(e){ return false; } }
function startPersistentFfmpeg(){ if (ffmpegProc) return; if (!ensureFifoExistsSync()) return; const ffargs=['-re','-hide_banner','-loglevel','warning','-f','mp3','-i',FIFO_PATH,'-vn','-c:a','libmp3lame','-b:a',BITRATE,'-ar','44100','-ac','2','-content_type','audio/mpeg','-f','mp3',icecastUrl()]; console.log('Starting persistent ffmpeg ->',icecastUrl()); ffmpegProc = spawn('ffmpeg', ffargs, { stdio: ['ignore','inherit','inherit'] }); ffmpegProc.on('exit',(code,sig)=>{ console.warn('Persistent ffmpeg exited',code,sig); ffmpegProc=null; try{ if (fifoWriteStream){ fifoWriteStream.destroy(); fifoWriteStream=null; } }catch(e){} setTimeout(()=>startPersistentFfmpeg(),2000); }); }

async function writeMp3ToFifo(mp3Path,maxRetries=3){ ensureSilenceMp3(200); for (let attempt=0; attempt<maxRetries; attempt++){ try{ if (!ffmpegProc) startPersistentFfmpeg(); if (!fs.existsSync(FIFO_PATH)) throw new Error('FIFO missing'); if (!fifoWriteStream){ fifoWriteStream = fs.createWriteStream(FIFO_PATH,{flags:'a'}); fifoWriteStream.on('error',err=>{ console.error('fifo write error',err && err.message ? err.message : err); try{ fifoWriteStream.destroy(); }catch(e){} fifoWriteStream=null; }); } const pipe=(file)=>new Promise((res,rej)=>{ const rs=fs.createReadStream(file); rs.on('error',rej); rs.on('end',()=>setTimeout(res,120)); rs.pipe(fifoWriteStream,{end:false}); }); if (fs.existsSync(SILENCE_MP3)) await pipe(SILENCE_MP3); await pipe(mp3Path); return; } catch(e){ console.error('write attempt failed:',e && e.message?e.message:e); try{ if (fifoWriteStream){ fifoWriteStream.destroy(); fifoWriteStream=null; } }catch(e){} try{ if (ffmpegProc){ ffmpegProc.kill('SIGTERM'); ffmpegProc=null; } }catch(e){} await new Promise(r=>setTimeout(r,800)); startPersistentFfmpeg(); } } throw new Error('Failed to write to FIFO after retries'); }

// ---- metadata update every 1s ----
async function updateIcecastMetadataNow(title){ try{ const safe=sanitizeForFfmpeg(title||STATION_NAME); const song=encodeURIComponent(safe); const pathStr=`/admin/metadata.xsl?mount=${encodeURIComponent(ICECAST_MOUNT)}&mode=updinfo&song=${song}&charset=UTF-8`; const opts={ hostname:ICECAST_HOST, port:parseInt(ICECAST_PORT||'80',10), path:pathStr, method:'GET', headers:{ 'Authorization':'Basic '+Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64') }, timeout:3000 }; const lib=(ICECAST_PORT=='443')?https:http; const req=lib.request(opts,res=>{ res.on('data',()=>{}); res.on('end',()=>{}); }); req.on('error',()=>{}); req.on('timeout',()=>{ req.destroy(); }); req.end(); }catch(e){} }
function startMetadataUpdater(intervalMs=1000){ if (metadataInterval) return; metadataInterval=setInterval(()=>{ try{ updateIcecastMetadataNow(nowPlaying||STATION_NAME); }catch(e){} }, intervalMs); }
function stopMetadataUpdater(){ if (metadataInterval){ clearInterval(metadataInterval); metadataInterval=null; } }

// ---- listeners ----
async function fetchIcecastListeners(){ try{ const opts={ hostname:ICECAST_HOST, port:parseInt(ICECAST_PORT||'80',10), path:'/admin/stats', method:'GET', headers:{ 'Authorization':'Basic '+Buffer.from(`${ICECAST_ADMIN_USER}:${ICECAST_ADMIN_PASS}`).toString('base64') }, timeout:3000 }; const lib=(ICECAST_PORT=='443')?https:http; return await new Promise((resolve)=>{ const req=lib.request(opts,res=>{ let d=''; res.on('data',c=>d+=c.toString()); res.on('end',()=>{ try{ const regex=new RegExp(`<source[^>]*mount="${escapeRegExp(ICECAST_MOUNT)}"[^>]*>([\\s\\S]*?)<\\/source>`, 'i'); const m=d.match(regex); if (m){ const lis = m[1].match(/<listeners>\s*(\d+)\s*<\/listeners>/i); resolve(lis?parseInt(lis[1],10):null); } else { const alt = d.match(/<listeners>\s*(\d+)\s*<\/listeners>/i); resolve(alt?parseInt(alt[1],10):null); } }catch(e){ resolve(null); } }); }); req.on('error',()=>resolve(null)); req.on('timeout',()=>{ req.destroy(); resolve(null); }); req.end(); }); }catch(e){ return null; } }
async function updateListenersPeriodically(){ while(true){ lastKnownListeners = await fetchIcecastListeners().catch(()=>null); await new Promise(r=>setTimeout(r,10000)); } }

// ---- queue loader ----
async function loadQueueExpanded(){ const arr=[]; if (process.env.YOUTUBE_PLAYLIST) arr.push(process.env.YOUTUBE_PLAYLIST); if (fs.existsSync(SOURCES_FILE)){ const lines=fs.readFileSync(SOURCES_FILE,'utf8').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).filter(l=>!l.startsWith('#')); arr.push(...lines); } const expanded=[]; for (const item of arr){ if (/playlist\?list=/.test(item) || /list=PL/.test(item)){ const urls = await fetchPlaylistUrls(item); if (urls.length) expanded.push(...urls); else expanded.push(item); } else expanded.push(item); } if (!expanded.length){ console.error('No sources found'); process.exit(1); } return expanded; }
function shuffle(a){ for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } }

// ---- playback with station-id injection (alternate) ----
async function playUrl(url){ try{ console.log('Preparing',url); const info = await ensureCachedMp3ForUrl(url); const safeTitle = sanitizeForFfmpeg(info.title || STATION_NAME); nowPlaying = safeTitle; nowPlayingUpdated = Date.now(); startMetadataUpdater(); startPersistentFfmpeg(); console.log('Now playing:', safeTitle); // write track
 await writeMp3ToFifo(info.path); // after track, write station-id (alternate)
 const idPath = stationIdPath(); if (fs.existsSync(idPath)){
   try{ await writeMp3ToFifo(idPath); }catch(e){ console.warn('failed to write station-id',e && e.message?e.message:e); }
 } else {
   // fallback: short silence to keep ffmpeg alive
   if (fs.existsSync(SILENCE_MP3)){
     try{ await writeMp3ToFifo(SILENCE_MP3); }catch(e){}
   }
 }
 }catch(e){ console.error('playUrl error:', e && e.message? e.message : e); await new Promise(r=>setTimeout(r,3000)); } }

async function mainLoop(){ ensureSilenceMp3(200); updateListenersPeriodically().catch(()=>{}); while(true){ try{ const q = await loadQueueExpanded(); shuffle(q); for (let i=0;i<q.length;i++){ await playUrl(q[i]); } }catch(e){ console.error('Main loop error:', e && e.message? e.message : e); await new Promise(r=>setTimeout(r,5000)); } } }

// ---- status server ----
const server = http.createServer((req,res)=>{ if (req.url.startsWith('/status')){ const showHtml = req.url.includes('html=1'); const cookiesInfo = (()=>{ try{ if (!fs.existsSync(COOKIES_PATH)) return { exists:false, path:COOKIES_PATH }; const content = fs.readFileSync(COOKIES_PATH,'utf8'); const lines = content.split(/\r?\n/).filter(Boolean); return { exists:true, path:COOKIES_PATH, size_bytes: Buffer.byteLength(content,'utf8'), preview_lines: lines.slice(0,40), full_lines_count: lines.length }; }catch(e){ return { exists:false, path:COOKIES_PATH }; } })(); const payload = { station: STATION_NAME, now_playing: nowPlaying || STATION_NAME, bitrate: parseInt(BITRATE.replace(/\D/g,''),10)||128, listeners: lastKnownListeners, updated: nowPlayingUpdated||Date.now(), yt: ytDebug, cookies: cookiesInfo, fifo: { path: FIFO_PATH, exists: fs.existsSync(FIFO_PATH) } }; if (showHtml){ res.writeHead(200,{'Content-Type':'text/html'}); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${STATION_NAME} status</title></head><body><h1>${STATION_NAME} status</h1><pre>${JSON.stringify(payload,null,2)}</pre></body></html>`); } else { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(payload)); } } else if (req.url === '/' || req.url === '/health'){ res.writeHead(200,{'Content-Type':'text/plain'}); res.end('ok'); } else { res.writeHead(404,{'Content-Type':'text/plain'}); res.end('Not found'); } });

server.listen(PORT,()=>{ console.log('Status server listening on port',PORT); });

// kick off
ensureSilenceMp3(200);
startPersistentFfmpeg();
mainLoop().catch(err=>{ console.error('Fatal:',err); process.exit(1); });
