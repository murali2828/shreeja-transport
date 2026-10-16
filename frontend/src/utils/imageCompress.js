// frontend/src/utils/imageCompress.js
// Shrinks phone photos before upload (trip scans, ADR-025): long side ≤ 1800 px,
// JPEG quality 0.72 (a 4–8 MB photo → ~200–400 KB, handwriting still legible),
// plus a 320 px thumbnail for the viewer strip. PDFs pass through untouched
// with no thumbnail. EXIF orientation is honoured via createImageBitmap's
// imageOrientation: 'from-image' where available (browsers that lack it
// apply EXIF orientation to <img> by default).
const MAX_SIDE = 1800, QUALITY = 0.72, THUMB_SIDE = 320, THUMB_QUALITY = 0.7;

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Cannot read this image — save it as JPEG and try again')); img.src = url; });
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
}

function draw(src, maxSide, quality) {
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // PNG transparency → white
  ctx.drawImage(src, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Image compression failed'))), 'image/jpeg', quality));
}

const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');

// Returns { file: File|Blob, thumb: Blob|null, name }
export async function compressForUpload(file) {
  if (isPdf(file)) return { file, thumb: null, name: file.name || 'document.pdf' };
  if (/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) {
    // Browsers that can decode HEIC (Safari) convert it here; others get the server's message.
    try {
      const bmp = await decode(file);
      const [main, thumb] = [await draw(bmp, MAX_SIDE, QUALITY), await draw(bmp, THUMB_SIDE, THUMB_QUALITY)];
      if (bmp.close) bmp.close();
      return { file: main, thumb, name: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg' };
    } catch (_) { return { file, thumb: null, name: file.name }; }
  }
  const bmp = await decode(file);
  const main = await draw(bmp, MAX_SIDE, QUALITY);
  const thumb = await draw(bmp, THUMB_SIDE, THUMB_QUALITY);
  if (bmp.close) bmp.close();
  // Keep the original if it is already smaller (e.g. a small scanned PNG).
  const out = main.size < file.size ? main : file;
  const name = out === main ? (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg' : file.name;
  return { file: out, thumb, name };
}
