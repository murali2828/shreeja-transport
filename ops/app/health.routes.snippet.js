/**
 * ops-kit — the three health endpoints the scripts rely on (Express + a
 * Knex/pg `db` handle). Mount under OPS_HEALTH_PATH's parent, e.g.
 * app.use('/api/v1/health', router).
 *
 *   GET /health         → 200 { success, data: { status, git_sha } }  — deploy.sh
 *                          compares data.git_sha with the commit it just deployed
 *                          (build arg GIT_SHA → process.env.GIT_SHA).
 *   GET /health/ready   → 200 when the app can reach its database, else 503 — watchdog api_ready
 *   GET /health/backup  → 200 when continuous WAL archiving is working RIGHT NOW,
 *                          else 503 — watchdog `backup` check (reads pg_stat_archiver,
 *                          visible to any role; base-backup age is covered by backup.sh check)
 */
const express = require('express');

module.exports = function healthRoutes(db, logger = console) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ success: true, data: { status: 'ok', git_sha: process.env.GIT_SHA || null, ts: new Date().toISOString() } });
  });

  router.get('/ready', async (req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ success: true, data: { status: 'ready', checks: { db: 'ok' } } });
    } catch (err) {
      res.status(503).json({ success: false, data: { status: 'degraded', checks: { db: 'down' } }, error: 'Not ready: database unreachable' });
    }
  });

  router.get('/backup', async (req, res) => {
    try {
      const { rows } = await db.raw(`
        SELECT current_setting('archive_mode') AS archive_mode, archived_count, last_archived_wal, last_archived_time,
               failed_count, last_failed_wal, last_failed_time,
               COALESCE(extract(epoch FROM now() - last_archived_time) / 60, -1)::int AS archive_lag_min
          FROM pg_stat_archiver`);
      const a = rows[0];
      const lastFailedAfterSuccess = a.last_failed_time && (!a.last_archived_time || new Date(a.last_failed_time) > new Date(a.last_archived_time));
      const problems = [];
      if (a.archive_mode !== 'on') problems.push('archive_mode is off');
      else if (a.archive_lag_min < 0) problems.push('no WAL segment archived yet');
      if (lastFailedAfterSuccess) problems.push(`last archive attempt failed (${a.last_failed_wal})`);
      res.status(problems.length ? 503 : 200).json({
        success: true,
        data: {
          ok: problems.length === 0, problems,
          archive_mode: a.archive_mode, archived_count: Number(a.archived_count), failed_count: Number(a.failed_count),
          last_archived_wal: a.last_archived_wal, last_archived_at: a.last_archived_time, archive_lag_min: a.archive_lag_min,
          last_failed_wal: a.last_failed_wal, last_failed_at: a.last_failed_time,
        },
      });
    } catch (err) {
      logger.error('[health/backup] check failed:', err.message);
      res.status(503).json({ success: false, error: 'Backup status unavailable' });
    }
  });

  return router;
};
