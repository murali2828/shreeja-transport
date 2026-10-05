// History load: create closed, acknowledged trips from the FY 2026-27 history
// workbook (docs/templates/TMS_History_Load_Template_FY2026-27.xlsx layout)
// so reports, analytics and billing cover months before the portal went live.
//
//   docker exec -i shreeja-backend node scripts/import_history.js /tmp/history.xlsx            # dry run
//   docker exec -i shreeja-backend node scripts/import_history.js /tmp/history.xlsx --apply    # write
//   options: --from YYYY-MM-DD --to YYYY-MM-DD   (lifting-date window, default whole file)
//            --user history-load                  (login that owns the loaded rows; created if missing)
//            --report /tmp/history_result.csv     (per-trip outcome; default next to the workbook)
//
// Copy the workbook into the container first:
//   docker cp history.xlsx shreeja-backend:/tmp/history.xlsx
// To avoid Google Routes calls for pairs missing in Distance Master (cost), run with
//   docker exec -i -e GOOGLE_MAPS_API_KEY= shreeja-backend node scripts/import_history.js ...
// Legs then fall back to Haversine × ROAD_DISTANCE_FACTOR and are flagged estimated,
// exactly like a live execution without a key; Recalc Distances on the billing run
// refreshes them later.
//
// Rules (also on the workbook's README sheet):
//  - one TRIPS row = one plan + one execution; TRIP_BMCUS rows by Trip Ref give the
//    pickup chain; ACKNOWLEDGEMENTS rows by Trip Ref give chamber receipts;
//  - names resolve against the masters ignoring case / spaces / dots, with the
//    NAME_MAP sheet applied first (column F "Team decision" wins over column D);
//  - a tanker that already has a live execution on that lifting date is SKIPPED;
//  - sum of BMCU litres must be within 1 % of the trip litres, unless the first
//    BMCU row's Remarks say TRIP-TOTAL (whole quantity goes on that BMCU);
//  - no acknowledgement rows → ack = dispatch, description 'backfill, no plant data';
//  - every write goes through services/executionData.applyExecutionData (capacity
//    guard, totals, distance cascade) — never raw inserts into execution tables;
//  - dry run validates everything and writes the report; --apply loads trip by
//    trip, each in its own transaction, so a bad row never blocks the rest.
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const ExcelJS  = require('exceljs');
const bcrypt   = require('bcrypt');
const { pool } = require('../src/config/db');
const { applyExecutionData } = require('../src/services/executionData');
const isSaleTankerNumber = n => /^sale/i.test(String(n || '').trim()); // mirrors utils/saleTanker.js (tanker_number ILIKE 'SALE%')

const args = process.argv.slice(2);
const FILE  = args.find(a => !a.startsWith('--'));
const APPLY = args.includes('--apply');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const FROM  = opt('--from', null), TO = opt('--to', null);
const LOGIN = opt('--user', 'history-load');
const REPORT = opt('--report', FILE ? FILE.replace(/\.xlsx$/i, '') + '_result.csv' : null);
if (!FILE) { console.error('usage: node scripts/import_history.js <workbook.xlsx> [--apply] [--from d] [--to d] [--user login]'); process.exit(2); }

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const str  = v => (v == null ? '' : (typeof v === 'object' && v.richText ? v.richText.map(t => t.text).join('') : typeof v === 'object' && v.result !== undefined ? String(v.result) : String(v))).trim();
const num  = v => { const s = str(v).replace(/,/g, ''); if (s === '') return null; const n = parseFloat(s); return Number.isFinite(n) ? n : NaN; };
function isoDate(v) {                       // DD-MM-YYYY (text) or Excel date → YYYY-MM-DD
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = str(v); if (!s) return null;
  let m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return 'BAD';
}
function isoStamp(v, dateIso) {             // DD-MM-YYYY HH:MM → ISO with +05:30; blank → null
  if (v instanceof Date) return v.toISOString();
  const s = str(v); if (!s) return null;
  const m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})[ T](\d{1,2}):(\d{2})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${m[4].padStart(2, '0')}:${m[5]}:00+05:30`;
  const t = s.match(/^(\d{1,2}):(\d{2})$/);  // time only → on the lifting date
  if (t && dateIso) return `${dateIso}T${t[1].padStart(2, '0')}:${t[2]}:00+05:30`;
  return 'BAD';
}

async function readSheet(wb, name, headers) {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`sheet ${name} missing`);
  const head = ws.getRow(1).values.map(v => norm(str(v)));
  const col = {};
  for (const [key, label] of Object.entries(headers)) {
    const i = head.findIndex(h => h && h.startsWith(norm(label)));
    if (i < 0) throw new Error(`sheet ${name}: column "${label}" missing`);
    col[key] = i;
  }
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const o = { _row: n };
    for (const k of Object.keys(col)) o[k] = row.getCell(col[k]).value;
    if (Object.keys(col).some(k => str(o[k]) !== '')) rows.push(o);
  });
  return rows;
}

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const trips = await readSheet(wb, 'TRIPS', { ref: 'Trip Ref', lift: 'Milk Lifting Date', tanker: 'Tanker No', sale: 'Sale Tanker', route: 'Route Name',
    start: 'Starting Point', deliv: 'Delivery Point', testing: 'Testing Point', km: 'Km (team)', ltrs: 'Qty Ltrs (trip)', kgs: 'Qty Kgs (trip)',
    fat: 'Fat %', snf: 'SNF %', out: 'Gate Pass OUT', inn: 'Plant IN', driver: 'Driver Name', helper: 'Helper Name', dc: 'DC Number', remarks: 'Remarks' });
  const bmcuRows = await readSheet(wb, 'TRIP_BMCUS', { ref: 'Trip Ref', seq: 'Seq', bmcu: 'BMCU Name', date: 'Milk Date', shift: 'Shift', ltrs: 'Dispatch Ltrs',
    fat: 'Fat %', snf: 'SNF %', rmrd: 'RMRD Ltrs', balance: 'Balance Milk Ltrs', tps: 'Third Party Sale Ltrs', tpc: 'Third Party Customer', remarks: 'Remarks' });
  const ackRows = await readSheet(wb, 'ACKNOWLEDGEMENTS', { ref: 'Trip Ref', date: 'Ack Date', chamber: 'Chamber', ltrs: 'Qty Ltrs', kgs: 'Qty Kgs', fat: 'Fat %', snf: 'SNF %', temp: 'Temperature', remarks: 'Remarks' });
  let nameMap = [];
  try { nameMap = await readSheet(wb, 'NAME_MAP', { type: 'Type', name: 'Name as used', proposed: 'Portal master name', decision: 'Team decision' }); } catch (e) { console.warn('[history] ' + e.message + ' — matching masters directly'); }

  // ── masters ──────────────────────────────────────────────────────────────
  const q = (sql, p) => pool.query(sql, p);
  const tankers = (await q('SELECT id, tanker_number, capacity_litres FROM tankers')).rows;
  const bmcus   = (await q('SELECT id, bmcu_name, bmcu_code FROM bmcus')).rows;
  const starts  = (await q('SELECT id, name FROM starting_points')).rows;
  const delivs  = (await q('SELECT id, name FROM delivery_points')).rows;
  const tests   = (await q('SELECT id, name FROM testing_points')).rows;
  const routes  = (await q('SELECT id, route_name FROM route_masters')).rows;
  const idx = (rows, key) => { const m = new Map(); for (const r of rows) m.set(norm(r[key]), r); return m; };
  const T = idx(tankers, 'tanker_number'), B = idx(bmcus, 'bmcu_name'), S = idx(starts, 'name'), D = idx(delivs, 'name'), X = idx(tests, 'name'), R = idx(routes, 'route_name');
  for (const b of bmcus) B.set(norm(b.bmcu_name).replace(/bmcu$/, ''), b); // "Kuppam BMCU" ≙ "Kuppam"
  const alias = {};                                                          // (type|name) → portal name
  for (const r of nameMap) {
    const target = str(r.decision) || str(r.proposed);
    if (!target || /^(new|\?|drop)/i.test(target)) continue;
    alias[`${norm(r.type)}|${norm(r.name)}`] = target;
  }
  const resolve = (type, map, name) => {
    if (!str(name)) return null;
    const a = alias[`${norm(type)}|${norm(name)}`];
    return map.get(norm(a || name)) || map.get(norm(name)) || null;
  };

  // ── existing live executions per tanker × lifting date ───────────────────
  const existing = new Set((await q(`
    SELECT t.tanker_number, p.plan_for_date::text AS d
    FROM trip_executions e JOIN trip_plans p ON p.id = e.trip_plan_id JOIN tankers t ON t.id = p.tanker_id
    WHERE e.status <> 'cancelled'`)).rows.map(r => `${norm(r.tanker_number)}|${r.d}`));

  // ── group detail rows ────────────────────────────────────────────────────
  const byRef = (rows) => { const m = new Map(); for (const r of rows) { const k = str(r.ref); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const bmcuByRef = byRef(bmcuRows), ackByRef = byRef(ackRows);

  // ── validate ─────────────────────────────────────────────────────────────
  const seen = new Set(); const plan = []; const report = [];
  const reject = (t, why) => report.push({ ref: str(t.ref), row: t._row, status: 'REJECTED', detail: why });
  for (const t of trips) {
    const ref = str(t.ref); const lift = isoDate(t.lift);
    if (!ref) { reject(t, 'Trip Ref blank'); continue; }
    if (!lift || lift === 'BAD') { reject(t, 'Milk Lifting Date invalid'); continue; }
    if ((FROM && lift < FROM) || (TO && lift > TO)) { report.push({ ref, row: t._row, status: 'OUT OF WINDOW', detail: lift }); continue; }
    const tanker = resolve('tanker', T, t.tanker);
    if (!tanker) { reject(t, `tanker not in master: ${str(t.tanker)}`); continue; }
    const key = `${norm(tanker.tanker_number)}|${lift}`;
    if (existing.has(key)) { report.push({ ref, row: t._row, status: 'SKIPPED (exists)', detail: `${tanker.tanker_number} ${lift} already has a live execution` }); continue; }
    const dupKey = key + '|' + norm(t.route);
    if (seen.has(dupKey)) { reject(t, 'duplicate of an earlier row (same tanker, lifting date, route)'); continue; }
    seen.add(dupKey);
    const start = resolve('startingpoint', S, t.start), deliv = resolve('deliverypoint', D, t.deliv);
    if (!start) { reject(t, `starting point not in master: ${str(t.start)}`); continue; }
    if (!deliv) { reject(t, `delivery point not in master: ${str(t.deliv)}`); continue; }
    const testing = str(t.testing) ? resolve('testingpoint', X, t.testing) : null;
    if (str(t.testing) && !testing) { reject(t, `testing point not in master: ${str(t.testing)}`); continue; }
    const route = resolve('route', R, t.route);
    const ltrs = num(t.ltrs);
    if (ltrs == null || Number.isNaN(ltrs) || ltrs <= 0) { reject(t, 'Qty Ltrs (trip) missing'); continue; }
    const fat = num(t.fat), snf = num(t.snf);
    const kgs = num(t.kgs);
    const outAt = isoStamp(t.out, lift), inAt = isoStamp(t.inn, lift);
    if (outAt === 'BAD' || inAt === 'BAD') { reject(t, 'OUT / IN time not DD-MM-YYYY HH:MM'); continue; }

    const bl = bmcuByRef.get(ref) || [];
    if (!bl.length) { reject(t, 'no TRIP_BMCUS rows'); continue; }
    const pickups = []; let bad = null; let sum = 0; let anyLtrs = false; let testingFromBmcus = null;
    const tripTotal = /trip-?total/i.test(str(bl[0].remarks));
    for (const b of bl.sort((a, c) => (num(a.seq) || 0) - (num(c.seq) || 0))) {
      const bm = resolve('bmcu', B, b.bmcu);
      if (!bm) {
        // Route text often carries the plant or a testing point as a token; the
        // NAME_MAP maps those to a point, not a BMCU — drop them from the chain.
        const tp = resolve('bmcu', X, b.bmcu);
        if (tp) { if (!testingFromBmcus) testingFromBmcus = tp; continue; }
        if (resolve('bmcu', S, b.bmcu) || resolve('bmcu', D, b.bmcu)) continue;
        bad = `BMCU not in master: ${str(b.bmcu)} (row ${b._row})`; break;
      }
      const l = num(b.ltrs); if (Number.isNaN(l)) { bad = `BMCU litres not a number (row ${b._row})`; break; }
      if (l != null) { anyLtrs = true; sum += l; }
      const shift = str(b.shift).toUpperCase();
      pickups.push({ row: b._row, bmcu: bm, seq: pickups.length + 1, date: isoDate(b.date) && isoDate(b.date) !== 'BAD' ? isoDate(b.date) : lift,
        shift: shift === 'AM' || shift === 'PM' ? shift : null, ltrs: l, fat: num(b.fat) ?? fat, snf: num(b.snf) ?? snf,
        rmrd: num(b.rmrd), balance: num(b.balance), tps: num(b.tps), tpc: str(b.tpc), remarks: str(b.remarks) });
    }
    if (bad) { reject(t, bad); continue; }
    if (!pickups.length) { reject(t, 'no BMCU left after dropping plant / testing-point tokens'); continue; }
    const testingPt = testing || testingFromBmcus;
    let splitNote = null;
    if (tripTotal || !anyLtrs) {
      pickups.forEach(p => { p.ltrs = 0; }); pickups[0].ltrs = ltrs; splitNote = 'BMCU split not available';
    } else if (Math.abs(sum - ltrs) > Math.max(ltrs * 0.01, 1)) {
      reject(t, `BMCU litres ${sum.toFixed(0)} differ from trip litres ${ltrs.toFixed(0)} by more than 1 %`); continue;
    }
    const al = (ackByRef.get(ref) || []).filter(a => num(a.ltrs) != null);
    const acks = []; let ackBad = null;
    for (const a of al) {
      const ch = str(a.chamber).toUpperCase();
      if (!['FC', 'MC', 'BC'].includes(ch)) { ackBad = `chamber must be FC/MC/BC (row ${a._row})`; break; }
      const d = isoDate(a.date);
      acks.push({ chamber: ch, ack_date: d && d !== 'BAD' ? d : null, qty_litres: num(a.ltrs), qty_kgs: num(a.kgs), fat_pct: num(a.fat) ?? fat, snf_pct: num(a.snf) ?? snf, temperature: str(a.temp) || null, description: str(a.remarks) || null });
    }
    if (ackBad) { reject(t, ackBad); continue; }
    let ackNote = null;
    if (!acks.length) { acks.push({ chamber: 'FC', ack_date: null, qty_litres: ltrs, qty_kgs: kgs, fat_pct: fat, snf_pct: snf, description: 'backfill, no plant data' }); ackNote = 'ack = dispatch (no plant data)'; }
    const isSale = /^y/i.test(str(t.sale)) || isSaleTankerNumber(tanker.tanker_number);
    plan.push({ t, ref, lift, tanker, start, deliv, testing: testingPt, route, ltrs, fat, snf, kgs, outAt, inAt, pickups, acks, isSale,
      notes: [splitNote, ackNote, !outAt || !inAt ? 'OUT/IN times defaulted' : null].filter(Boolean) });
  }
  const counts = s => report.filter(r => r.status.startsWith(s)).length;
  console.log(`[history] ${trips.length} trip rows: ${plan.length} loadable, ${counts('SKIPPED')} already in portal, ${counts('REJECTED')} rejected, ${counts('OUT')} outside window`);

  // ── apply ────────────────────────────────────────────────────────────────
  if (APPLY && plan.length) {
    const userId = await ensureUser();
    let n = 0;
    for (const p of plan) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const remarks = ['History load ' + p.ref, str(p.t.remarks), ...p.notes].filter(Boolean).join(' | ');
        const pr = await client.query(`
          INSERT INTO trip_plans (plan_date, plan_for_date, route_id, tanker_id, start_point_id, testing_point_id, delivery_point_id,
                                  expected_km, expected_total_qty, driver_name, loader_name, remarks, status, created_by, is_sale_tanker)
          VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'published',$12,$13) RETURNING id`,
          [p.lift, p.route?.id || null, p.tanker.id, p.start.id, p.testing?.id || null, p.deliv.id, num(p.t.km) || null, p.ltrs,
           str(p.t.driver) || null, str(p.t.helper) || null, remarks, userId, p.isSale]);
        const planId = pr.rows[0].id;
        for (const b of p.pickups)
          await client.query('INSERT INTO trip_plan_bmcus (trip_plan_id, seq_no, bmcu_id, shift_code, expected_qty, description) VALUES ($1,$2,$3,$4,$5,$6)',
            [planId, b.seq, b.bmcu.id, b.shift, b.ltrs || 0, 'RMRD']);
        const er = await client.query(`INSERT INTO trip_executions (trip_plan_id, execution_date, dc_number, executed_by, status) VALUES ($1,$2,$3,$4,'in_progress') RETURNING id`,
          [planId, p.lift, str(p.t.dc) || null, userId]);
        const execId = er.rows[0].id;
        const bmcus = p.pickups.map(b => ({ seq_no: b.seq, bmcu_id: b.bmcu.id, milk_date: b.date, shift: b.shift, qty_litres: b.ltrs || null, fat_pct: b.fat, snf_pct: b.snf, description: 'RMRD' }));
        const shift_rows = p.pickups.map(b => ({ bmcu_seq_no: b.seq, milk_date: b.date, shift: b.shift, rmrd_qty: b.rmrd ?? b.ltrs ?? null, rmrd_fat_pct: b.fat, rmrd_snf_pct: b.snf }));
        const entries = p.pickups.filter(b => b.balance).map(b => ({ bmcu_seq_no: b.seq, kind: 'balance_milk', category: 'Lifted milk', qty_litres: b.balance, fat_pct: b.fat, snf_pct: b.snf, remarks: 'history load' }));
        const third_party_sales = p.pickups.filter(b => b.tps).map(b => ({ bmcu_seq_no: b.seq, qty_litres: b.tps, fat_pct: b.fat, snf_pct: b.snf, customer_name: b.tpc || null, remarks: 'history load' }));
        const { dist } = await applyExecutionData(client, execId, {
          start_point_id: p.start.id, delivery_point_id: p.deliv.id, bmcus, shift_rows, entries, third_party_sales,
          ack_date: p.acks[0].ack_date, acknowledgements: p.acks }, userId);
        await client.query(`UPDATE trip_executions SET actual_km=$1, status='closed', points_confirmed=TRUE, updated_at=NOW() WHERE id=$2`, [dist.total_km, execId]);
        const outAt = p.outAt || `${p.lift}T06:00:00+05:30`, inAt = p.inAt || `${p.lift}T18:00:00+05:30`;
        await client.query(`INSERT INTO trip_document_prints (trip_plan_id, doc_type, print_no, printed_by, printed_by_name, printed_at) VALUES ($1,'gate_pass',1,$2,'history-load',$3::timestamptz), ($1,'coa',1,$2,'history-load',$4::timestamptz)`,
          [planId, userId, outAt, inAt]);
        await client.query('COMMIT');
        report.push({ ref: p.ref, row: p.t._row, status: 'LOADED', detail: `plan ${planId} execution ${execId} km ${dist.total_km}${dist.estimated_leg_count ? ' (' + dist.estimated_leg_count + ' est. legs)' : ''}${p.notes.length ? ' | ' + p.notes.join(', ') : ''}` });
        if (++n % 100 === 0) console.log(`[history] loaded ${n}/${plan.length}`);
      } catch (err) {
        await client.query('ROLLBACK');
        report.push({ ref: p.ref, row: p.t._row, status: 'FAILED', detail: err.message });
      } finally { client.release(); }
    }
    console.log(`[history] loaded ${report.filter(r => r.status === 'LOADED').length}, failed ${report.filter(r => r.status === 'FAILED').length}`);
  } else if (plan.length) {
    for (const p of plan) report.push({ ref: p.ref, row: p.t._row, status: 'WOULD LOAD', detail: `${p.tanker.tanker_number} ${p.lift} ${p.start.name} → ${p.deliv.name}, ${p.pickups.length} BMCU${p.notes.length ? ' | ' + p.notes.join(', ') : ''}` });
    console.log('[history] dry run — nothing written. Re-run with --apply to load.');
  }

  report.sort((a, b) => a.row - b.row);
  const csv = ['trip_ref,row,status,detail', ...report.map(r => [r.ref, r.row, r.status, '"' + String(r.detail || '').replace(/"/g, '""') + '"'].join(','))].join('\n');
  fs.writeFileSync(REPORT, csv);
  console.log(`[history] report: ${REPORT}`);
  const bad = report.filter(r => /REJECTED|FAILED/.test(r.status));
  for (const r of bad.slice(0, 30)) console.log(`  ${r.status} ${r.ref} (row ${r.row}): ${r.detail}`);
  if (bad.length > 30) console.log(`  … ${bad.length - 30} more in the report`);
}

// Rows are owned by a dedicated, inactive login so audit and "entered by" show
// where they came from. Created on first --apply with a random password.
async function ensureUser() {
  const r = await pool.query('SELECT id FROM users WHERE LOWER(user_id)=LOWER($1) OR LOWER(username)=LOWER($1)', [LOGIN]);
  if (r.rows.length) return r.rows[0].id;
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString('base64'), 10);
  const ins = await pool.query(
    `INSERT INTO users (user_id, username, password_hash, full_name, role, email, is_active, must_change_password)
     VALUES ($1,$1,$2,'History Load','planner',$3,FALSE,TRUE) RETURNING id`, [LOGIN, hash, `${LOGIN}@localhost`]);
  console.log(`[history] created inactive user ${LOGIN} (id ${ins.rows[0].id})`);
  return ins.rows[0].id;
}

main().then(() => pool.end()).catch(err => { console.error('[history] ' + (err.stack || err.message)); pool.end(); process.exit(1); });
