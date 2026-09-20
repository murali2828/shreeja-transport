---
paths:
  - "**/auth/**"
  - "**/api/**"
  - "**/*.env*"
  - "backend/src/middleware/**"
  - "backend/src/routes/auth.js"
  - "backend/src/routes/integrations.js"
---
# Security rules

- Every route handler lists `authenticate` first, then `authorize(...)` / `authorizeModule` /
  `authorizeOrModule`; the only JWT-free endpoints are login, forgot/reset password, the
  token-based `decide` links and the Assure feed (`X-Assure-Key`).
- Keep the hardcoded admin bypass in `authorizeModule` / `authorizeOrModule`; never make
  admin access depend solely on a `roles` row.
- `JWT_SECRET` must be ≥ 32 chars (boot check); `FRONTEND_URL` is mandatory in production.
- Never log or return secrets: JWTs, `WHEELSEYE_ACCESS_TOKEN`, `ASSURE_API_KEY*`, SMTP
  passwords, reset/approval tokens. Compare API keys with `crypto.timingSafeEqual`.
- All SQL uses `$n` parameters; never interpolate user input into query text.
- GET never mutates state (approvals, decisions are POST); single-use tokens are nulled once used.
- Uploads: multer memory storage with size limit and file-type filter; serve only from
  `UPLOAD_DIR` via `path.basename`.
- Production error responses are generic (`Internal server error`); do not leak SQL,
  table or constraint names.
- New public or credential endpoints get an `express-rate-limit` entry in `app.js`.
- `.env`, `.env.qa`, `backend/.env`, `deploy/backup.env` are never committed; `.env.example`
  and `.env.qa.example` contain placeholders only, and every new env var is added to both.
- Audit: mutating calls are logged centrally by `auditLog.js`; add new secret field names
  to its `SECRET_KEYS` when introducing them.
