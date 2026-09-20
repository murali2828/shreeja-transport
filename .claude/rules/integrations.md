---
paths:
  - "**/services/**"
  - "**/integrations/**"
  - "**/jobs/**"
  - "backend/src/routes/integrations.js"
  - "backend/src/routes/tracking.js"
  - "backend/src/config/mailer.js"
---
# Integration rules

- Every external call (Google Routes, WheelsEye, SMTP) has a timeout (`AbortController`)
  and returns `null` / `{ ok:false, error }` on failure; callers degrade (Haversine
  estimate, poller skip, logged mail failure) and never crash a request.
- Credentials come from `process.env` only and are never logged, returned in JSON or
  embedded in error text. Use `[module]` log prefixes: `[roadDistance]`, `[wheelseye]`,
  `[assure]`, `[mailer]`, `[docAlerts]`.
- Google Routes: go through `services/roadDistance.js` + `distanceLookup.js` so results are
  cached into `distance_master` with Google attribution and `google_km`; pass a preloaded
  master cache in batch jobs.
- WheelsEye: pages read `tanker_gps_latest/history` only; the poller in `jobs/wheelseyePoll.js`
  is the single caller (overlap guard, min 60 s interval, hourly prune). Match vehicles with
  `normalizeVehicle()`.
- Assure feed (`routes/integrations.js`): column aliases, error codes (`FEATURE_DISABLED`,
  `RATE_LIMITED`, …), `+05:30` timestamps and `assure-v1` contract are frozen by
  `docs/assure-handover/API_SPEC_v1.md`; additive changes only, and update the spec together.
- Mail: use `config/mailer.js` `createTransport(redirect?)`; billing mail passes
  `BILLING_EMAIL_REDIRECT` so QA never mails vendors; honour the `app_settings`
  vendor-email toggle. Recipients/approvers are env-overridable, not new hardcodes.
- Jobs export `startScheduler()` plus `runOnce()`/`getStatus()` for admin endpoints; they
  must be safe to skip when their env var is missing (log one line, no ticks).
- New env vars get a default in code and a commented placeholder in both `.env.example`
  and `.env.qa.example`; document the failure mode in `docs/RUNBOOK.md`.
