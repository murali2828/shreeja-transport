-- Viewer role sees only the Execution section and creates nothing (owner,
-- 2026-10-07). The seed from migration 035 also switched on billing and
-- reports for viewer; this resets the role to execution only. Read-only
-- enforcement for viewer-only users lives in middleware/auth.js.
UPDATE roles
   SET permissions = '{"masters":false,"planning":false,"execution":true,"billing":false,"reports":false,"quality":false}'::jsonb,
       updated_at = NOW()
 WHERE name = 'viewer';
