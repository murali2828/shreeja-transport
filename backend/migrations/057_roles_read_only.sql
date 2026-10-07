-- Read-only switch on roles (owner, 2026-10-07). A user whose roles are ALL
-- read-only may only read (every non-GET is refused by the auth gates),
-- whatever module flags those roles carry — so finance / MIS can get a role
-- with billing + reports that looks but never changes. The built-in viewer
-- role is read-only by definition; the hardcoded check in middleware/auth.js
-- is replaced by this column.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE roles SET read_only = TRUE, updated_at = NOW() WHERE name = 'viewer';
