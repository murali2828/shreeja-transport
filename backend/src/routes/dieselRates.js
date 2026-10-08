// backend/src/routes/dieselRates.js
// Diesel price master per state per fortnight (migration 058, owner 2026-10-08).
// Purchase's fortnightly annexure derives every ₹/km rate from the state's
// diesel price: rate = previous rate + (diesel − previous diesel) ÷ mileage.
// Here the price is kept once per state × fortnight, filled from the Tanker
// Rates screen (template diesel row, rate form, diesel strip) and read by the
// cost-driver analysis and the Payment Report cumulatives. Reads are open to
// the roles that use rates; writes are masters / admin.
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { authenticate, authorizeOrModule } = require('../middleware/auth');
const { STATES, dieselPriceFor, fortnightError } = require('../services/rates');
const { fmtDateDisplay } = require('../utils/date');

const READERS = ['admin', 'planner', 'biller', 'viewer'];
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

function validate(b) {
  const state = STATES.find(s => s.toLowerCase() === String(b.state || '').trim().toLowerCase());
  if (!state) return { error: `state must be one of: ${STATES.join(', ')}` };
  if (!isDate(b.effective_from) || !isDate(b.effective_to)) return { error: 'effective_from and effective_to are required (YYYY-MM-DD)' };
  const fe = fortnightError(b.effective_from, b.effective_to);
  if (fe) return { error: fe };
  const price = num(b.price_per_litre);
  if (price == null || price <= 0) return { error: 'price_per_litre must be a positive number' };
  return { row: { state, effective_from: b.effective_from, effective_to: b.effective_to, price, source: (b.source || '').trim() || null } };
}

const SELECT = `SELECT id, state, effective_from::text AS effective_from, effective_to::text AS effective_to,
  price_per_litre, source, created_by_name, created_at, updated_at FROM diesel_rates`;

// ── GET /api/diesel-rates?from&to&state ──────────────────────────────────────
router.get('/', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.state) { params.push(req.query.state); cond.push(`state = $${params.length}`); }
    if (isDate(req.query.from)) { params.push(req.query.from); cond.push(`effective_to >= $${params.length}::date`); }
    if (isDate(req.query.to))   { params.push(req.query.to);   cond.push(`effective_from <= $${params.length}::date`); }
    const r = await query(`${SELECT} ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
      ORDER BY effective_from DESC, state`, params);
    res.json(r.rows);
  } catch (err) {
    console.error('[diesel-rates] list error:', err);
    res.status(500).json({ error: 'Failed to load diesel rates' });
  }
});

// ── GET /api/diesel-rates/matrix?periods=12 — fortnights × states grid ───────
router.get('/matrix', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  try {
    const n = Math.min(Math.max(parseInt(req.query.periods) || 12, 1), 60);
    const r = await query(`${SELECT} WHERE effective_from IN (
        SELECT DISTINCT effective_from FROM diesel_rates ORDER BY effective_from DESC LIMIT $1)
      ORDER BY effective_from DESC, state`, [n]);
    const periods = [];
    const byKey = new Map();
    for (const x of r.rows) {
      const k = x.effective_from;
      if (!byKey.has(k)) { byKey.set(k, { effective_from: k, effective_to: x.effective_to, prices: {} }); periods.push(byKey.get(k)); }
      byKey.get(k).prices[x.state] = { id: x.id, price: parseFloat(x.price_per_litre), source: x.source };
    }
    res.json({ states: STATES, periods });
  } catch (err) {
    console.error('[diesel-rates] matrix error:', err);
    res.status(500).json({ error: 'Failed to load diesel rate matrix' });
  }
});

// ── GET /api/diesel-rates/period?date= — price per state valid on a date ─────
router.get('/period', authenticate, authorizeOrModule('masters', ...READERS), async (req, res) => {
  if (!isDate(req.query.date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
  try {
    const out = {};
    for (const s of STATES) out[s] = await dieselPriceFor(s, req.query.date);
    res.json(out);
  } catch (err) {
    console.error('[diesel-rates] period error:', err);
    res.status(500).json({ error: 'Failed to load diesel prices' });
  }
});

// ── POST /api/diesel-rates ───────────────────────────────────────────────────
router.post('/', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const v = validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await query(`
      INSERT INTO diesel_rates (state, effective_from, effective_to, price_per_litre, source, created_by, created_by_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [v.row.state, v.row.effective_from, v.row.effective_to, v.row.price, v.row.source,
       req.user.id, req.user.user_id || req.user.full_name || null]);
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A diesel price for ${v.row.state} from ${fmtDateDisplay(v.row.effective_from)} already exists — edit it instead` });
    console.error('[diesel-rates] create error:', err);
    res.status(500).json({ error: 'Failed to save diesel rate' });
  }
});

// ── PUT /api/diesel-rates/:id ────────────────────────────────────────────────
router.put('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  const v = validate(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await query(`
      UPDATE diesel_rates SET state=$1, effective_from=$2, effective_to=$3, price_per_litre=$4, source=$5, updated_at=NOW()
      WHERE id=$6 RETURNING id`,
      [v.row.state, v.row.effective_from, v.row.effective_to, v.row.price, v.row.source, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Diesel rate not found' });
    res.json({ id: r.rows[0].id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `A diesel price for ${v.row.state} from ${fmtDateDisplay(v.row.effective_from)} already exists` });
    console.error('[diesel-rates] update error:', err);
    res.status(500).json({ error: 'Failed to update diesel rate' });
  }
});

// ── DELETE /api/diesel-rates/:id ─────────────────────────────────────────────
router.delete('/:id', authenticate, authorizeOrModule('masters', 'admin'), async (req, res) => {
  try {
    const r = await query('DELETE FROM diesel_rates WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Diesel rate not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[diesel-rates] delete error:', err);
    res.status(500).json({ error: 'Failed to delete diesel rate' });
  }
});

module.exports = router;
