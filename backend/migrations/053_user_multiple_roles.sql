-- Multiple roles per user (owner, 2026-10-07). users.role stays the primary
-- role ('admin' whenever admin is among them) so every existing role check
-- keeps working; users.roles holds the full set and a user's module
-- permissions are the union over all of them (middleware/auth.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';
UPDATE users SET roles = ARRAY[role] WHERE (roles IS NULL OR roles = '{}') AND role IS NOT NULL;
