// Shared date DISPLAY helper — converts an ISO (YYYY-MM-DD) string or Date
// object into DD-MM-YYYY for human-facing text (Excel cells, report JSON
// fields, email bodies). Never use this for values that are stored, sent as
// API request payloads, compared, sorted, or used as query/cache keys.
function fmtDateDisplay(d) {
  if (!d) return '';
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, da] = m;
  return `${da}-${mo}-${y}`;
}

module.exports = { fmtDateDisplay };
