// backend/src/app.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const rateLimit = require('express-rate-limit');

// ─── Boot-time config validation (fail fast, not at first request) ───────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET is missing or shorter than 32 characters — refusing to start.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  console.error('[FATAL] FRONTEND_URL is not set — CORS would fall back to localhost.');
  process.exit(1);
}

const app = express();

// Behind the nginx container (and the host reverse proxy): honour
// X-Forwarded-For so req.ip is the real client, not the docker bridge —
// required for rate limiting to key on actual clients.
app.set('trust proxy', 1);

// ─── Security + parsing ───────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));

// ─── Rate limiting (audit 2026-08) ───────────────────────────────────────────
const limiter = (windowMs, max, message) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false,
              message: { error: message } });
// Global backstop
app.use('/api', limiter(15 * 60 * 1000, 1000, 'Too many requests — slow down.'));
// Credential endpoints: brute-force / enumeration / mail-amplification guards
app.use('/api/auth/login', limiter(15 * 60 * 1000, 20, 'Too many login attempts — try again in 15 minutes.'));
app.use('/api/auth/forgot-password', limiter(60 * 60 * 1000, 5, 'Too many password reset requests — try again later.'));
app.use('/api/auth/reset-password', limiter(60 * 60 * 1000, 10, 'Too many attempts — try again later.'));
// Public token-based decision endpoints (billing + change requests)
app.use('/api/billing/decide', limiter(15 * 60 * 1000, 30, 'Too many attempts.'));
app.use('/api/billing/decision-info', limiter(15 * 60 * 1000, 60, 'Too many attempts.'));
app.use('/api/change-requests/decide', limiter(15 * 60 * 1000, 30, 'Too many attempts.'));
app.use('/api/billing/toll-changes/decide', limiter(15 * 60 * 1000, 30, 'Too many attempts.'));
app.use('/api/billing/toll-changes/decision-info', limiter(15 * 60 * 1000, 60, 'Too many attempts.'));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Request logger (dev) ─────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Audit trail — records every mutating API call (who/what/when) ───────────
app.use('/api', require('./middleware/auditLog'));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/masters',    require('./routes/masters'));
app.use('/api/plans',      require('./routes/plans'));
app.use('/api/executions', require('./routes/executions'));
app.use('/api/reports',    require('./routes/reports'));
app.use('/api/analytics',  require('./routes/analytics'));
app.use('/api/tanker-rates', require('./routes/tankerRates'));
app.use('/api/diesel-rates', require('./routes/dieselRates')); // diesel price per state × fortnight (migration 058)
// Billing is gated: enabled only where BILLING_ENABLED=true (QA during UAT).
// Production runs with the flag unset until the module gets business sign-off.
if (process.env.BILLING_ENABLED === 'true') {
  app.use('/api/billing/toll-changes', require('./routes/billingTollChanges')); // before the main router (migration 051)
  app.use('/api/billing', require('./routes/billing'));
} else {
  app.use('/api/billing', (_req, res) =>
    res.status(503).json({ error: 'Billing module is not enabled in this environment' }));
}
app.use('/api/distances',  require('./routes/distances'));
app.use('/api/optimize',   require('./routes/optimize'));
app.use('/api/vendors',    require('./routes/vendors'));
app.use('/api/materials',  require('./routes/materials'));
app.use('/api/quality',    require('./routes/quality'));      // QA dispatch entries (migration 052)
app.use('/api/material-trips', require('./routes/materialTrips'));
app.use('/api/documents',  require('./routes/documents'));
app.use('/api/audit',      require('./routes/audit'));
app.use('/api/change-requests', require('./routes/changeRequests'));
app.use('/api/trip-docs', require('./routes/tripDocs'));
app.use('/api/roles',      require('./routes/roles'));
app.use('/api/tracking',   require('./routes/tracking'));
// Shreeja Assure read-only integration API (X-Assure-Key auth, own per-IP
// limiter inside the router) — docs/assure-handover/API_SPEC_v1.md
app.use('/api/integrations/assure', require('./routes/integrations'));

// ─── 404 for unmatched API routes ─────────────────────────────────────────────
app.use('/api/*', (_req, res) => res.status(404).json({ error: 'API route not found' }));

// ─── Global error handler (must be registered LAST) ──────────────────────────
// Every failure reaches the browser as JSON { error, code?, ref? } with a
// message a user can act on. Known client-side causes get their real reason;
// unexpected failures get a reference id that is also in the server log, so
// support can find the stack trace without the user seeing internals.
app.use((err, req, res, _next) => {
  const mb = n => `${Math.round(n / 1024 / 1024)} MB`;
  // multer (file uploads)
  if (err && err.name === 'MulterError') {
    const map = {
      LIMIT_FILE_SIZE: `File is too large${err.limit ? ` (limit ${mb(err.limit)})` : ''} — compress it and try again`,
      LIMIT_FILE_COUNT: 'Too many files in one upload',
      LIMIT_UNEXPECTED_FILE: `Unexpected file field "${err.field || ''}"`,
    };
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: map[err.code] || `Upload rejected: ${err.message}`, code: err.code });
  }
  // body-parser: payload size / bad JSON
  if (err && err.type === 'entity.too.large')
    return res.status(413).json({ error: `Request is too large${err.limit ? ` (limit ${mb(err.limit)})` : ''} — reduce the data or file size`, code: 'PAYLOAD_TOO_LARGE' });
  if (err && err.type === 'entity.parse.failed')
    return res.status(400).json({ error: 'Request body is not valid JSON', code: 'BAD_JSON' });
  // errors thrown with an explicit HTTP code by route/service code
  const status = Number.isInteger(err?.code) && err.code >= 400 && err.code < 600 ? err.code
               : Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status < 500)
    return res.status(status).json({ error: err.message || 'Request rejected' });
  // unexpected: log with a reference id; tell the user what failed and how to report it
  const ref = Date.now().toString(36).toUpperCase().slice(-6) + Math.random().toString(36).slice(2, 5).toUpperCase();
  console.error(`[App Error] ref=${ref} ${req.method} ${req.originalUrl}`, err);
  const detail = process.env.NODE_ENV === 'production' ? '' : ` — ${err.message || ''}`;
  res.status(500).json({ error: `Something went wrong on the server while processing ${req.method} ${req.originalUrl.replace(/^\/api/, '')}. Reference ${ref}${detail}`, code: 'INTERNAL', ref });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[server] Shreeja Backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  // Start the tanker-document expiry alert scheduler.
  try { require('./jobs/docAlerts').startScheduler(); }
  catch (e) { console.error('[docAlerts] failed to start scheduler:', e.message); }
  // Start the WheelsEye GPS tracking poller (no-op without WHEELSEYE_ACCESS_TOKEN).
  try { require('./jobs/wheelseyePoll').startScheduler(); }
  catch (e) { console.error('[wheelseye] failed to start scheduler:', e.message); }
});

module.exports = app;
