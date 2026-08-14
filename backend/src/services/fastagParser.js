// backend/src/services/fastagParser.js
// Parses FASTag statement PDFs into per-vehicle toll totals.
// pdf-parse concatenates table columns WITHOUT spaces, so both formats are
// parsed with structure-aware heuristics validated against real samples:
//   1. ICICI "FASTag E-Statement" — Vehicle Summary rows like
//      "25309558AP02TC1483Default18988.004500.00- 4550.00938.00"
//      (tag)(plate)Default(trips)(opening)(credit)- (debit)(closing);
//      the four trailing 2-dp amounts anchor the split; debit is what we need.
//   2. Generic "FASTAG ACCOUNT SUMMARY" — rows spread over lines:
//      "Debit2601,568" … "TN28BZ3247178548877520567". Amount and closing are
//      concatenated; resolved via the closing-balance chain
//      (closing[i] + amount[i] = closing[i+1] for debits, minus for credits).
const pdfParse = require('pdf-parse');

const num = s => { const n = parseFloat(String(s).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const normPlate = p => String(p || '').replace(/\s+/g, '').toUpperCase();
const PLATE = '[A-Z]{2}\\d{1,2}[A-Z]{1,3}\\d{3,4}';

function parseIcici(text) {
  const out = new Map();
  // Vehicle Summary: split the row from the RIGHT — the last four 2-dp
  // amounts are opening/credit/debit/closing (debit may carry "- ").
  const rowRe = new RegExp(
    `^(\\d{7,10})(${PLATE})Default(\\d+?)([\\d,]*\\d\\.\\d{2})([\\d,]*\\d\\.\\d{2})(?:-\\s*)?([\\d,]*\\d\\.\\d{2})([\\d,]*\\d\\.\\d{2})$`);
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(rowRe);
    if (!m) continue;
    const debit = num(m[6]);
    if (debit > 0) out.set(normPlate(m[2]), { toll: debit, trips: 0 });
  }
  // Trip counts (and a full fallback if the summary block was absent):
  // sections headed "AP02TC1483 - 25309558", trip rows end "…<CR><DR>".
  const counts = new Map(); const sums = new Map();
  let plate = null;
  const headRe = new RegExp(`^(${PLATE})\\s*-\\s*\\d{6,}$`);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const head = line.match(headRe);
    if (head) { plate = normPlate(head[1]); continue; }
    if (!plate) continue;
    // Amount pair at end of a wrapped trip row: "…0.00255.00" (CR then DR)
    const amts = line.match(/([\d,]*\d\.\d{2})([\d,]*\d\.\d{2})$/);
    if (!amts) continue;
    const dr = num(amts[2]);
    if (dr <= 0) continue;                       // payments/credits
    counts.set(plate, (counts.get(plate) || 0) + 1);
    sums.set(plate, (sums.get(plate) || 0) + dr);
  }
  if (!out.size) for (const [p, s] of sums) out.set(p, { toll: s, trips: counts.get(p) || 0 });
  else for (const [p, v] of out) v.trips = counts.get(p) || 0;
  return out;
}

function parseGeneric(text) {
  // Collect rows in statement order: nature + concatenated amountClosing,
  // then the plate (plate+txn-id concatenated on a later line).
  const lines = text.split('\n').map(l => l.trim());
  const rows = [];
  const debitRe = /^(Debit|Credit)([\d,]+)$/;
  const plateRe = new RegExp(`^(${PLATE})\\d{8,}$`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(debitRe);
    if (!m) continue;
    let plate = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (debitRe.test(lines[j])) break;
      const pm = lines[j].match(plateRe);
      if (pm) { plate = normPlate(pm[1]); break; }
    }
    rows.push({ nature: m[1], digits: m[2], plate });
  }

  // Resolve each row's amount|closing split. Unambiguous when the closing has
  // thousand-separators; otherwise use the chain closing[i]±amount[i]=closing[i+1].
  const validNum = s => /^\d{1,3}(,\d{3})*$/.test(s) || /^\d+$/.test(s);
  const splits = digits => {
    // Prefer the GREEDY comma split — latest cut point where the tail is a
    // well-formed comma-grouped number ("2601,568" → 260 | 1,568).
    for (let cut = digits.length - 1; cut >= 1; cut--) {
      const a = digits.slice(0, cut), c = digits.slice(cut);
      if (/^\d{1,3}(,\d{3})+$/.test(c) && validNum(a))
        return [{ amount: num(a), closing: num(c) }];
    }
    // No comma anywhere → every cut is a candidate; the chain pass resolves it.
    const res = [];
    const clean = digits.replace(/,/g, '');
    for (let cut = 1; cut < clean.length; cut++)
      res.push({ amount: parseInt(clean.slice(0, cut), 10), closing: parseInt(clean.slice(cut), 10) });
    return res;
  };
  // Statement runs latest→earliest, so closing[i+1] = closing[i] + amount[i]
  // for a Debit row i (and − for a Credit).
  const expectedNext = r => r.nature === 'Debit' ? r.closing + r.amount : r.closing - r.amount;
  for (let i = 0; i < rows.length; i++) {
    const cands = splits(rows[i].digits);
    if (cands.length === 1) { Object.assign(rows[i], cands[0]); continue; }
    const next = rows[i + 1];
    if (next) {
      const nextClosings = new Set(splits(next.digits).map(c => c.closing));
      const hit = cands.find(c => nextClosings.has(expectedNext({ ...rows[i], ...c })));
      if (hit) { Object.assign(rows[i], hit); continue; }
    }
    Object.assign(rows[i], cands[0]); // resolved (or corrected) by the second pass
  }
  // Second pass: rows still ambiguous get fixed from the row above them
  // (chronologically later): closing[i] = closing[i-1] + amount[i-1] (debit).
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    if (prev.closing == null || prev.amount == null) continue;
    const expected = prev.nature === 'Debit' ? prev.closing + prev.amount : prev.closing - prev.amount;
    const clean = rows[i].digits.replace(/,/g, '');
    const exp = String(expected);
    if (clean.endsWith(exp) && clean.length > exp.length) {
      rows[i].closing = expected;
      rows[i].amount = parseInt(clean.slice(0, clean.length - exp.length), 10);
    }
  }

  const out = new Map();
  for (const r of rows) {
    if (r.nature !== 'Debit' || !r.plate || !r.amount) continue; // fee debits carry no plate
    const cur = out.get(r.plate) || { toll: 0, trips: 0 };
    cur.toll += r.amount; cur.trips += 1;
    out.set(r.plate, cur);
  }
  return out;
}

// → { vehicles: [{ plate, toll_amount, trips }], format }
async function parseFastagPdf(buffer) {
  const { text } = await pdfParse(buffer);
  let map, format;
  if (/FASTag\s*E-Statement/i.test(text) || /Vehicle Summary/i.test(text)) {
    format = 'icici'; map = parseIcici(text);
  } else {
    format = 'generic'; map = parseGeneric(text);
  }
  const vehicles = [...map.entries()]
    .map(([plate, v]) => ({ plate, toll_amount: Math.round(v.toll * 100) / 100, trips: v.trips }))
    .sort((a, b) => a.plate.localeCompare(b.plate));
  return { vehicles, format };
}

module.exports = { parseFastagPdf, normPlate };
