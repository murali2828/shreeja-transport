// backend/src/services/scanStore.js
// Storage for trip scans (BMCU dispatch challans, plant acknowledgement slips;
// migration 071, ADR-025). Files live on the uploads volume under
// UPLOAD_DIR/trip-scans/YYYY/MM/<sha256>.<ext>, content-addressed so the same
// file uploaded twice is stored once. multer writes to a temp dir on the same
// volume; we sniff magic bytes, hash by streaming, then rename into place.
// Nothing here buffers a whole file in memory. No req/res.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const BASE_DIR = () => process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads/documents');
const ROOT     = () => path.join(BASE_DIR(), 'trip-scans');
const TMP_DIR  = () => path.join(ROOT(), 'tmp');

function ensureDirs() {
  fs.mkdirSync(TMP_DIR(), { recursive: true });
}

// Accepted types by magic bytes; extension follows the content, never the name.
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { mime: 'image/jpeg', ext: '.jpg' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return { mime: 'image/png', ext: '.png' };
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  return null;
}
function isHeic(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.slice(4, 8).toString('latin1') !== 'ftyp') return false;
  return /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(buf.slice(8, 12).toString('latin1'));
}

function readHead(file, n = 16) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.slice(0, got); }
  finally { fs.closeSync(fd); }
}

// Throws an Error with .status = 400 and a user-facing message on a bad type.
function checkType(file) {
  const head = readHead(file);
  const t = sniff(head);
  if (t) return t;
  const e = new Error(isHeic(head)
    ? 'HEIC photos are not accepted — save the photo as JPEG (or set the camera to "Most compatible") and upload again'
    : 'File type not allowed — JPEG, PNG or PDF only');
  e.status = 400;
  throw e;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// Moves a temp upload into place. Returns { rel, mime, bytes, sha256, deduped }
// where rel is the path relative to the trip-scans root (stored in the DB).
async function storeTemp(tmpFile, when = new Date()) {
  try {
    const t = checkType(tmpFile);
    const sha = await sha256File(tmpFile);
    const bytes = fs.statSync(tmpFile).size;
    const yyyy = String(when.getFullYear());
    const mm = String(when.getMonth() + 1).padStart(2, '0');
    const relDir = path.join(yyyy, mm);
    fs.mkdirSync(path.join(ROOT(), relDir), { recursive: true });
    const rel = path.join(relDir, sha + t.ext);
    const full = path.join(ROOT(), rel);
    let deduped = false;
    if (fs.existsSync(full)) { fs.unlinkSync(tmpFile); deduped = true; }
    else fs.renameSync(tmpFile, full);
    return { rel, mime: t.mime, bytes, sha256: sha, deduped };
  } catch (e) {
    removeQuiet(tmpFile);
    throw e;
  }
}

function removeQuiet(f) { try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* ignore */ } }

// Absolute path of a stored rel path; only YYYY/MM/<basename> is honoured so a
// tampered DB value cannot escape the trip-scans root (ADR-009).
function resolve(rel) {
  if (!rel) return null;
  const parts = String(rel).split(/[\\/]/).filter(Boolean);
  if (parts.length < 3) return null;
  const [yyyy, mm] = parts.slice(-3, -1);
  if (!/^\d{4}$/.test(yyyy) || !/^\d{2}$/.test(mm)) return null;
  return path.join(ROOT(), yyyy, mm, path.basename(parts[parts.length - 1]));
}

module.exports = { ensureDirs, TMP_DIR, ROOT, sniff, isHeic, checkType, sha256File, storeTemp, removeQuiet, resolve };
