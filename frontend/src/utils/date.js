// Shared date DISPLAY helper — converts an ISO (YYYY-MM-DD) string, a
// timestamp string, or a Date into DD-MM-YYYY for human-facing text (table
// cells, headings, toast messages). Never use this for values fed into
// <input type="date"> value props, comparisons, sorting, query params, or
// React Query cache keys — those must stay raw ISO strings.
export function fmtDate(d) {
  if (!d) return '';
  const iso = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const [, y, mo, da] = m;
  return `${da}-${mo}-${y}`;
}
