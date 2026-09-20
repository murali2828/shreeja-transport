# Shreeja TMS — Conventions

Written from the code as it is on `qa` (2026-09-20). Follow the surrounding file when
in doubt; these are the patterns that repeat.

## Code style

- Backend: CommonJS (`require`/`module.exports`), `async/await`, 2-space indent, single
  quotes, semicolons, aligned `const` blocks at the top of a file, a header comment
  explaining what the file owns and why.
- Frontend: ESM + JSX function components, hooks only, Tailwind utility classes plus the
  shared classes in `src/index.css`, `lucide-react` icons, `react-hot-toast` for feedback.
- No linter or formatter is configured (no ESLint/Prettier config in the repo). Keep the
  existing formatting of any file you edit; do not reformat whole files.
- Comments explain business intent ("billing team bills on delivery date"), not syntax.
  Reference the migration or audit that introduced a rule when you know it.

## Folder rules

- `backend/src/routes/<module>.js` — one Express router per module, mounted in `app.js`.
  Routers own their auth: every handler lists `authenticate` then the role/module gate.
- `backend/src/services/` — shared logic with no `req`/`res`; anything used by two
  routes (or a route and a job/script) lives here.
- `backend/src/jobs/` — schedulers started from `app.js` `listen()`; each exports
  `startScheduler()` and a status/`runOnce()` for admin "run now" endpoints.
- `backend/src/utils/` — pure helpers (`saleTanker.js`, `geo.js`, `date.js`).
- `backend/migrations/NNN_snake_case.sql` — schema only; data fixes go in a migration
  with an explanatory header comment. `backend/scripts/` is for one-off operator tools.
- `frontend/src/api/index.js` — every HTTP call is an exported helper here; pages never
  import axios directly.
- `frontend/src/pages/<module>/PascalCase.jsx`; shared pieces in `components/`.
- Docs for people go in `docs/`; the root `*.md` files are legacy guides kept for links.

## Naming

- SQL: snake_case tables and columns, plural table names (`trip_executions`),
  `is_*` booleans, `*_id` FKs, `created_at`/`updated_at`. Unique/partial indexes are
  named `uq_<table>_<what>`. JSON payloads reuse the SQL column names unchanged.
- JS: camelCase functions/variables, PascalCase React components, UPPER_SNAKE for
  constants (`KG_FACTOR`, `ACTIVE_TTL_MS`). API helpers are `verbNoun` (`getVendors`).
- Env vars: UPPER_SNAKE, grouped by prefix (`SMTP_*`, `WHEELSEYE_*`, `BILLING_*`,
  `ASSURE_*`, `TRACKING_*`). New tunables get a default in code and a commented line in
  both `.env.example` and `.env.qa.example`.
- Routes: kebab-case paths (`/api/change-requests/decide`, `/api/tanker-rates`).

## Error handling

- Handlers wrap work in `try/catch`; respond `res.status(4xx|5xx).json({ error: '...' })`.
  Use 400 for validation, 401 unauthenticated, 403 forbidden, 404 missing, 409 for
  `err.code === '23505'` (unique violation), 503 for a disabled feature.
- The global handler in `app.js` hides `err.message` in production; never send SQL,
  table or constraint names to the client on purpose.
- Transactions: `const client = await pool.connect(); BEGIN … COMMIT` with `ROLLBACK`
  in `catch` and `client.release()` in `finally`. Never hold a transaction across an
  external HTTP call (Google, WheelsEye, SMTP).
- Background work (audit writes, mail, pollers) is fire-and-forget and must never fail
  the request: catch, log, continue.
- Frontend: mutations show `toast.error(e.response?.data?.error || e.message)`;
  queries invalidate by key after success.

## Logging

- `console.log/warn/error` with a `[module]` prefix (`[migrate]`, `[wheelseye]`,
  `[assure]`, `[mailer]`, `[DB SLOW]`). Docker captures stdout (json-file, 10 MB x 5).
- Never log secrets: JWTs, API keys, `WHEELSEYE_ACCESS_TOKEN`, SMTP passwords, query
  params of DB calls. `auditLog.js` strips `SECRET_KEYS` before storing bodies.
- Dev-only request logging is gated on `NODE_ENV !== 'production'`.

## Validation

- Validate at the top of the handler and return 400 early with a specific message
  naming the field (`'vendor_code and vendor_name required'`).
- Dates travel as `YYYY-MM-DD` strings end to end; the pg type parser keeps `DATE`
  columns as strings. Only `fmtDate`/`fmtDateDisplay` convert to DD-MM-YYYY for humans.
  Never feed display dates into inputs, comparisons, sorts or query keys.
- Money/quantities are computed server-side (`calcKgs`, billing amounts); the UI shows
  what the API returns.
- Uploads: `multer` memory storage, size limits, file names via `path.basename`; serve
  files only from `UPLOAD_DIR`.

## API contract style

- REST-ish JSON under `/api/<module>`; list endpoints accept filters as query params
  and return arrays; writes return the created/updated row.
- Excel downloads stream an ExcelJS workbook with `Content-Disposition: attachment`.
- Token-authenticated email links (`billing/decide`, `change-requests/decide`) use
  single-use tokens; decisions are POST (GET may only show `decision-info`).
- The Assure feed (`/api/integrations/assure/*`) is versioned (`assure-v1`): column
  aliases, error codes and timestamp format are frozen by
  `docs/assure-handover/API_SPEC_v1.md`.
- Every mutating call is audited centrally; do not add per-route audit inserts.

## Testing approach

- There is no automated test suite (no `test` script in either `package.json`).
- Minimum before every push: `node -c` on each changed backend file (CI walks all of
  `backend/src`), `cd frontend && npx vite build --logLevel error` for frontend changes.
- Functional verification happens on QA (qatms.shreejamilk.com) by the user during UAT.
- Migrations are tested by deploying to QA (the backend container runs them on start).

## Never do

- Edit or renumber an applied migration; rewrite history on `qa` or `main`.
- Hardcode credentials, recipients or hostnames that belong in env (`APP_BASE_URL`,
  `BILLING_APPROVER_*`, `CHANGE_APPROVER_*` have defaults, but override via env).
- Bypass `applyExecutionData` when writing execution rows, or bypass `saleTankerSql`
  when deciding whether a trip is a sale tanker.
- Change `KG_FACTOR`, fortnight boundaries, the ack cutoff or carry-forward rules
  without a business decision recorded in `docs/DECISIONS.md`.
- Run docker, psql or deploy commands from the dev sandbox; hand them to the operator.
- Introduce a build step, ORM, TypeScript or a new framework without an ADR.
