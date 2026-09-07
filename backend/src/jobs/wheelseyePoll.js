// backend/src/jobs/wheelseyePoll.js
// Periodic WheelsEye GPS poller. Every WHEELSEYE_POLL_SECONDS (default 120,
// minimum 60) it pulls the current position of every vehicle and syncs it into
// tanker_gps_latest / tanker_gps_history via services/wheelseye.js. Once an
// hour the history trail is pruned to WHEELSEYE_HISTORY_DAYS (default 90).
// Disabled (one log line, no ticks) when WHEELSEYE_ACCESS_TOKEN is unset.
const { pool } = require('../config/db');
const { fetchAllCurrentLoc, syncPositions, pruneHistory } = require('../services/wheelseye');

const status = {
  enabled: false,
  intervalSeconds: null,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastCounts: null,
  lastPruneAt: null,
  running: false,
};

function pollSeconds() {
  const n = parseInt(process.env.WHEELSEYE_POLL_SECONDS || '120', 10);
  return Math.max(60, isNaN(n) ? 120 : n);
}

function getStatus() {
  return { ...status };
}

// One fetch + sync cycle. Returns the sync counts (or { ok:false, error }).
// Overlap guard: a tick that starts while the previous one is still running
// is skipped rather than queued.
async function runOnce() {
  if (status.running) return { ok: false, error: 'poll already in progress', skipped: true };
  status.running = true;
  status.lastRunAt = new Date().toISOString();
  try {
    const fetched = await fetchAllCurrentLoc({ withAddress: process.env.WHEELSEYE_FETCH_ADDRESS === 'true' });
    if (!fetched.ok) {
      status.lastError = fetched.error;
      console.warn('[wheelseye] fetch failed:', fetched.error);
      return { ok: false, error: fetched.error };
    }
    const counts = await syncPositions(pool, fetched.list);
    status.lastSuccessAt = new Date().toISOString();
    status.lastError = null;
    status.lastCounts = {
      received: counts.received, upserted: counts.upserted, historyAdded: counts.historyAdded,
      matched: counts.matched, unmatched: counts.unmatched.length, totalCount: fetched.totalCount,
    };
    return { ok: true, ...counts };
  } catch (err) {
    status.lastError = err.message;
    console.error('[wheelseye] sync error:', err.message);
    return { ok: false, error: err.message };
  } finally {
    status.running = false;
  }
}

async function runPrune() {
  try {
    const deleted = await pruneHistory(process.env.WHEELSEYE_HISTORY_DAYS || 90);
    status.lastPruneAt = new Date().toISOString();
    if (deleted) console.log(`[wheelseye] pruned ${deleted} history point(s)`);
  } catch (err) {
    console.error('[wheelseye] prune error:', err.message);
  }
}

// Start the periodic scheduler: first run shortly after boot, then every
// WHEELSEYE_POLL_SECONDS; history pruning once an hour.
function startScheduler() {
  if (!process.env.WHEELSEYE_ACCESS_TOKEN) {
    console.log('[wheelseye] no WHEELSEYE_ACCESS_TOKEN — tracking poller disabled');
    return;
  }
  const secs = pollSeconds();
  status.enabled = true;
  status.intervalSeconds = secs;

  setTimeout(() => {
    runOnce().then(r => {
      if (r.ok) console.log(`[wheelseye] startup poll: ${r.received} vehicle(s), ${r.matched} matched, ${r.unmatched.length} unmatched`);
    }).catch(e => console.error('[wheelseye] startup poll error:', e.message));
    runPrune();
  }, 15_000);

  setInterval(() => {
    runOnce().catch(e => console.error('[wheelseye] periodic poll error:', e.message));
  }, secs * 1000);

  setInterval(runPrune, 60 * 60 * 1000);

  console.log(`[wheelseye] scheduler started (every ${secs}s)`);
}

module.exports = { runOnce, startScheduler, getStatus };
