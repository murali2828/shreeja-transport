-- Executor role gets the execution module flag (owner role audit, 2026-10-07).
-- Migration 035 seeded it with every flag off because the sidebar then used a
-- hardcoded executor branch; the menu now follows module flags, so without
-- this the executor saw no Execution section although the API admitted it.
UPDATE roles
   SET permissions = jsonb_set(permissions, '{execution}', 'true'::jsonb, true), updated_at = NOW()
 WHERE name = 'executor';
