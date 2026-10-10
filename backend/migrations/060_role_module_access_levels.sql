-- Per-module access level on roles (owner, 2026-10-10): each module is None,
-- View or Edit, so a role can e.g. edit Execution but only view Reports and
-- Billing. `roles.access` holds {"module": "none"|"view"|"edit"}; the old
-- boolean `permissions` stays in sync (true = view or edit) for menus and
-- older code paths, and `read_only` becomes derived (no module at Edit).
-- Backfill: a ticked module becomes Edit, or View when the role was read-only
-- (the built-in viewer and any read-only finance role).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS access JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE roles r
   SET access = (
     SELECT COALESCE(jsonb_object_agg(k,
              CASE WHEN v = 'true'::jsonb THEN to_jsonb(CASE WHEN r.read_only THEN 'view' ELSE 'edit' END)
                   ELSE to_jsonb('none'::text) END), '{}'::jsonb)
       FROM jsonb_each(COALESCE(r.permissions, '{}'::jsonb)) AS e(k, v))
 WHERE r.access = '{}'::jsonb;
