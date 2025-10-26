// convert_cookies.js
// Usage: node convert_cookies.js cookies.json cookies.txt [expiryDays]
// Example: node convert_cookies.js cookies.json /app/secrets/cookies.txt 365

const fs = require('fs');
const path = require('path');

const inp = process.argv[2] || 'cookies.json';
const out = process.argv[3] || 'cookies.txt';
const days = parseInt(process.argv[4] || '365', 10);

// Read JSON
const raw = fs.readFileSync(inp, 'utf8');
const arr = JSON.parse(raw);

// expiry default -> now + days
const defaultExpiry = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;

function normDomain() {
  // normalize to .youtube.com (we'll duplicate to .music.youtube.com)
  return '.youtube.com';
}

function toLine(domain, cookie) {
  const flag = 'TRUE';
  const pathStr = cookie.path || '/';
  const secure = cookie.secure ? 'TRUE' : 'FALSE';
  const expiry = cookie.expires ? Math.floor(cookie.expires) : defaultExpiry;
  const name = cookie.name || '';
  const value = cookie.value || '';
  return [domain, flag, pathStr, secure, expiry.toString(), name, value].join('\t');
}

const lines = [];
for (const c of arr) {
  // normalize all domains to .youtube.com and duplicate for music.youtube.com
  const d1 = '.youtube.com';
  const d2 = '.music.youtube.com';
  lines.push(toLine(d1, c));
  lines.push(toLine(d2, c));
}

// Ensure target dir exists
const outdir = path.dirname(out);
try { fs.mkdirSync(outdir, { recursive: true }); } catch(e){}

fs.writeFileSync(out, lines.join('\n') + '\n', { mode: 0o600 });
console.log(`✅ Written ${out} with ${lines.length} entries (including duplicates).`);
console.log('Make sure to keep this file secret (do NOT commit to git).');
