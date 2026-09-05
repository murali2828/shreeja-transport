# Identity / Code Mapping Notes

## BMCU code
TMS: `bmcus.bmcu_code`, `VARCHAR(10) UNIQUE NOT NULL` (`backend/migrations/001_base_schema.sql:34`).
Real examples seen in code (upload-template sample data,
`backend/src/routes/plans.js:669-674`): `'3001'`, `'3002'`, `'3003'`, `'3004'`,
`'3005'` — 4-digit numeric strings. No fixed-length constraint is enforced beyond the
10-character column limit, so do not assume every code is exactly 4 digits without
checking live data.
**SAP/Assure's own BMCU code format cannot be confirmed from this codebase** —
inferred/unknown; this repo has no reference to SAP codes at all.

## Customer / delivery plant
TMS: `delivery_points.name` (free text) + `.receiver_name` (also free text — e.g. seed
data pairs `'Balaji Dairy Plant'` → `'MDFVPL'`, `'Milma Plant'` → `'Milma'`,
`'KMF Plant'` → `'KMF'`). **There is no code column on `delivery_points` at all** —
identification is purely by name string matching (see `plans.js` upload logic:
`WHERE name ILIKE $1`).
There is also no schema-level distinction between a Shreeja-owned dairy plant and a
genuine third-party customer — see README §3.
**SAP's sold-to code for these plants cannot be confirmed from this codebase** —
inferred/unknown.

## Vehicle (tanker)
TMS: `tankers.tanker_number`, `VARCHAR(20) UNIQUE NOT NULL`, stored uppercased on
insert (`tanker_number.trim().toUpperCase()` — `backend/src/routes/masters.js`).
Real examples from code (`plans.js:669-674`): `'AP03TF4985'`, `'AP03TF2538'` — an
Indian vehicle-registration-style string (state code + RTO code + series + digits),
free-form beyond the 20-char limit and the uppercase normalization; no regex/format
CHECK constraint in the migrations.
**A customer weighbridge slip's own vehicle-number format is unknown from this
codebase** — no customer-facing document format exists in TMS to compare against.

## Users
TMS `users` table (`backend/migrations/001_base_schema.sql:8-17`, altered by migration
006 and by runtime DDL in `backend/src/routes/auth.js:17-26`):
`id, username (widened to TEXT), email, password_hash, full_name, role, is_active,
created_at, must_change_password, user_id (TEXT, login identifier)`.

- `user_id` is a **login handle** — backfilled from `username` for existing rows,
  enforced case-insensitively unique (`CREATE UNIQUE INDEX ... ON users
  (LOWER(user_id))`, `auth.js:22`), and validated only against
  `/^[A-Za-z0-9._@+-]+$/` (email-or-alphanumeric-handle, no spaces) at signup
  (`auth.js:29`). It is chosen at account creation, not assigned by HR.
- `email` is a separate, also-unique column — genuinely an email address.
- **There is no employee-code column anywhere on `users`.**
- **TMS logins do NOT currently map to Shreeja employee codes at all** — confirmed by
  reading the full column list added across migration 001 and every later ALTER
  touching `users` (006, 025's role CHECK change, 035's role CHECK removal, and
  auth.js's runtime `user_id` addition); none introduce an employee-code concept.
- If Assure needs to resolve a TMS user to a Shreeja employee code, this would require
  either: (a) a new `employee_code` column added to `users` (small effort, but
  requires someone to backfill real employee codes against existing accounts — a data
  entry task, not a code task), or (b) an external mapping table maintained outside
  TMS (e.g. by Assure or HR) keyed on `users.email` or `users.user_id`, since neither
  currently carries an employee code.
