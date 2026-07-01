// backend/src/app.js
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');

const app = express();

// ─── Security + parsing ───────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
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

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/masters',    require('./routes/masters'));
app.use('/api/plans',      require('./routes/plans'));
app.use('/api/executions', require('./routes/executions'));
app.use('/api/reports',    require('./routes/reports'));
app.use('/api/distances',  require('./routes/distances'));
app.use('/api/optimize',   require('./routes/optimize'));
app.use('/api/vendors',    require('./routes/vendors'));
app.use('/api/documents',  require('./routes/documents'));

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[App Error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── 404 for unmatched API routes ─────────────────────────────────────────────
app.use('/api/*', (_req, res) => res.status(404).json({ error: 'API route not found' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[server] Shreeja Backend running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  // Start the tanker-document expiry alert scheduler.
  try { require('./jobs/docAlerts').startScheduler(); }
  catch (e) { console.error('[docAlerts] failed to start scheduler:', e.message); }
});

module.exports = app;
