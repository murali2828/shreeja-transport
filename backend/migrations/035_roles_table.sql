-- Database-backed, admin-manageable roles with per-module (not per-action)
-- visibility toggles. The 5 existing hardcoded roles are seeded as system
-- roles whose permissions exactly replicate current Sidebar.jsx behavior, so
-- this migration changes nothing about who can see what — it just moves the
-- source of truth into the DB and lets admins add more roles later.

CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(40) UNIQUE NOT NULL,   -- stored in users.role
  label       VARCHAR(60) NOT NULL,          -- display name shown in UI
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,-- true for the 5 built-in roles
  permissions JSONB NOT NULL DEFAULT '{}',   -- {masters,planning,execution,billing,reports}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO roles (name, label, is_system, permissions) VALUES
  ('admin',    'Admin',    TRUE, '{"masters":true,"planning":true,"execution":true,"billing":true,"reports":true}'),
  ('planner',  'Planner',  TRUE, '{"masters":false,"planning":true,"execution":true,"billing":false,"reports":true}'),
  ('executor', 'Executor', TRUE, '{"masters":false,"planning":false,"execution":false,"billing":false,"reports":false}'),
  ('viewer',   'Viewer',   TRUE, '{"masters":false,"planning":false,"execution":true,"billing":true,"reports":true}'),
  ('biller',   'Biller',   TRUE, '{"masters":false,"planning":false,"execution":true,"billing":true,"reports":true}')
ON CONFLICT (name) DO NOTHING;

-- Drop the CHECK constraint that restricted users.role to the 5 literal
-- values so admin-created custom role names can be assigned to users.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
