// backend/src/jobs/docAlerts.js
// Statutory-document expiry alerting for tankers.
// Sends a digest email to configured recipients at fixed lead-time thresholds
// before a document expires, plus a notice once it has expired. A dedupe log
// ensures each (document, threshold) alert is sent only once.
const nodemailer = require('nodemailer');
const { query }  = require('../config/db');

// Days-before-expiry milestones at which to alert. -1 represents "expired".
const THRESHOLDS = [30, 15, 7, 1, -1];

const { createTransport } = require('../config/mailer');

// Pick the milestone that a given daysLeft value has just crossed.
// e.g. daysLeft=20 → 30 (already within 30-day window); daysLeft=15 → 15; daysLeft<0 → -1.
function thresholdFor(daysLeft) {
  if (daysLeft < 0) return -1;
  for (const t of [1, 7, 15, 30]) {
    if (daysLeft <= t) return t;
  }
  return null; // more than 30 days away — no alert yet
}

function thresholdLabel(t) {
  if (t === -1) return 'EXPIRED';
  if (t === 1)  return '1 day left';
  return `${t} days left`;
}

// Core check. Returns { triggered: [...], emailed: bool }.
async function runAlertCheck({ force = false } = {}) {
  // All active documents with an expiry date on active tankers.
  const docs = await query(`
    SELECT d.id, d.doc_type, d.doc_name, d.doc_number, d.expiry_date,
           t.tanker_number, v.vendor_name,
           (d.expiry_date - CURRENT_DATE) AS days_left
    FROM tanker_documents d
    JOIN tankers t ON t.id = d.tanker_id
    LEFT JOIN vendors v ON v.id = t.vendor_id
    WHERE d.is_active = TRUE AND t.is_active = TRUE AND d.expiry_date IS NOT NULL
    ORDER BY d.expiry_date
  `);

  const toAlert = [];
  for (const d of docs.rows) {
    const daysLeft = parseInt(d.days_left, 10);
    const t = thresholdFor(daysLeft);
    if (t === null) continue;
    // Dedupe: skip if this (document, threshold) already alerted (unless forced).
    if (!force) {
      const seen = await query(
        'SELECT 1 FROM document_alert_log WHERE document_id=$1 AND threshold_days=$2',
        [d.id, t]
      );
      if (seen.rows.length) continue;
    }
    toAlert.push({ ...d, days_left: daysLeft, threshold: t });
  }

  if (!toAlert.length) return { triggered: [], emailed: false };

  // Record the alerts (idempotent) before emailing so a mail failure doesn't spam.
  for (const a of toAlert) {
    await query(
      `INSERT INTO document_alert_log (document_id, threshold_days)
       VALUES ($1,$2) ON CONFLICT (document_id, threshold_days) DO NOTHING`,
      [a.id, a.threshold]
    );
  }

  const recips = await query(
    'SELECT email FROM document_alert_recipients WHERE is_active=TRUE'
  );
  const emails = recips.rows.map(r => r.email).filter(Boolean);
  if (!emails.length) {
    console.warn('[docAlerts] documents due for alert but no recipients configured');
    return { triggered: toAlert, emailed: false };
  }

  const rows = toAlert.map(a => `
    <tr>
      <td style="padding:6px 10px;border:1px solid #e5e7eb;">${a.tanker_number}</td>
      <td style="padding:6px 10px;border:1px solid #e5e7eb;">${a.vendor_name || '—'}</td>
      <td style="padding:6px 10px;border:1px solid #e5e7eb;">${a.doc_type}${a.doc_name ? ' — ' + a.doc_name : ''}</td>
      <td style="padding:6px 10px;border:1px solid #e5e7eb;">${a.doc_number || '—'}</td>
      <td style="padding:6px 10px;border:1px solid #e5e7eb;">${a.expiry_date instanceof Date ? a.expiry_date.toISOString().slice(0,10) : String(a.expiry_date).slice(0,10)}</td>
      <td style="padding:6px 10px;border:1px solid #e5e7eb;font-weight:600;color:${a.threshold === -1 ? '#b91c1c' : '#b45309'};">${thresholdLabel(a.threshold)}</td>
    </tr>`).join('');

  const html = `
    <p>The following tanker statutory documents require attention:</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left;">Tanker</th>
          <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left;">Vendor</th>
          <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left;">Document</th>
          <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left;">Number</th>
          <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left;">Expiry</th>
          <th style="padding:6px 10px;border:1px solid #e5e7eb;text-align:left;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
    <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">Automated alert from Shreeja TMS · Developed &amp; maintained by <strong style="color:#6b7280;">Shreeja IT Team</strong>.</p>`;

  try {
    const transporter = createTransport();
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      emails.join(','),
      subject: `Shreeja TMS — Tanker Document Expiry Alerts (${toAlert.length})`,
      html,
    });
    return { triggered: toAlert, emailed: true, recipients: emails.length };
  } catch (err) {
    console.error('[docAlerts] email send failed:', err.message);
    return { triggered: toAlert, emailed: false, error: err.message };
  }
}

// Start the periodic scheduler: first run shortly after boot, then every 6 hours.
function startScheduler() {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    runAlertCheck().then(r => {
      if (r.triggered.length) console.log(`[docAlerts] startup check: ${r.triggered.length} alert(s), emailed=${r.emailed}`);
    }).catch(e => console.error('[docAlerts] startup check error:', e.message));
  }, 30_000);

  setInterval(() => {
    runAlertCheck().then(r => {
      if (r.triggered.length) console.log(`[docAlerts] periodic check: ${r.triggered.length} alert(s), emailed=${r.emailed}`);
    }).catch(e => console.error('[docAlerts] periodic check error:', e.message));
  }, SIX_HOURS);

  console.log('[docAlerts] scheduler started (every 6h)');
}

module.exports = { runAlertCheck, startScheduler, THRESHOLDS };
