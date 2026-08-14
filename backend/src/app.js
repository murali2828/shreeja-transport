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
// Billing is gated: enabled only where BILLING_ENABLED=true (QA during UAT).
// Production runs with the flag unset until the module gets business sign-off.
if (process.env.BILLING_ENABLED === 'true') {
  app.use('/api/billing', require('./routes/billing'));
} else {
  app.use('/api/billing', (_req, res) =>
    res.status(503).json({ error: 'Billing module is not enabled in this environment' }));
}
app.use('/api/distances',  require('./routes/distances'));
app.use('/api/optimize',   require('./routes/optimize'));
app.use('/api/vendors',    require('./routes/vendors'));
app.use('/api/documents',  require('./routes/documents'));
app.use('/api/audit',      require('./routes/audit'));
app.use('/api/change-requests', require('./routes/changeRequests'));
app.use('/api/trip-docs', require('./routes/tripDocs'));

// ─── 404 for unmatched API routes ─────────────────────────────────────────────
app.use('/api/*', (_req, res) => res.status(404).json({ error: 'API route not found' }));

// ─── Global error handler (must be registered LAST) ──────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[App Error]', err);
  // Never leak internals (SQL/table/constraint names) to clients in production.
  const msg = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error');
  res.status(500).json({ error: msg });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[server] Shreeja Backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  // Start the tanker-document expiry alert scheduler.
  try { require('./jobs/docAlerts').startScheduler(); }
  catch (e) { console.error('[docAlerts] failed to start scheduler:', e.message); }
});

module.exports = app;
