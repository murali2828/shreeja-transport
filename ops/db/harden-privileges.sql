-- ===========================================================================
-- ops-kit — database privilege lockdown, TWO roles per tier.
--
--   OWNER role (POSTGRES_USER): owns every table; used ONLY by migrations,
--     seeds, backups and operators (DATABASE_ADMIN_URL).
--   APP role  (:app_role): what the application connects as at runtime
--     (DATABASE_URL). It can SELECT / INSERT / UPDATE everything and DELETE
--     ONLY from the allow-list below. Every other table is DELETE- and
--     TRUNCATE-proof for the app, and an audit table (if any) is APPEND-ONLY.
--
-- Why: the application, a mis-typed script run with the app credentials, or an
-- injection bug can at worst insert/update rows — never wipe a table — and a
-- NEW table added by a migration is DELETE-proof by default until it is
-- consciously added to the allow-list here.
--
-- Idempotent — deploy.sh re-runs it after EVERY migrate. Run as the OWNER:
--   docker compose -f docker-compose.<tier>.yml exec -T postgres sh -c \
--     'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" "$POSTGRES_DB" \
--        -v app_role=<slug>_<tier>_app -v app_pass="$<TIER>_DB_APP_PASS"' < ops/db/harden-privileges.sql
-- ===========================================================================
\set ON_ERROR_STOP on

-- 1. The app role (create once, keep the password in sync afterwards).
SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'app_role', :'app_pass')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'app_role', :'app_pass') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', current_database(), :'app_role') \gexec

-- 2. Baseline: read + insert + update everywhere, NEVER delete/truncate, no DDL.
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO :"app_role";
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM :"app_role";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO :"app_role";

-- 3. DELETE allow-list — EVERY table the application legitimately hard-deletes
--    from (grep `.del()` / `.delete()` / `DELETE FROM` in the code). Adding a
--    delete elsewhere REQUIRES adding the table here; until then the app gets
--    a permission error — the intended fail-closed behaviour. Project-specific:
--    replace the examples.
CREATE TEMP TABLE app_delete_allowlist (tablename text PRIMARY KEY);
INSERT INTO app_delete_allowlist VALUES
  ('refresh_tokens'),        -- auth: rotation + logout
  ('password_resets'),       -- auth: consumed reset tokens
  ('login_lockouts');        -- auth: lockout window cleared on success
SELECT format('GRANT DELETE ON %I TO %I', t.tablename, :'app_role')
  FROM pg_tables t JOIN app_delete_allowlist a USING (tablename)
 WHERE t.schemaname = 'public' \gexec

-- 4. Append-only tables (audit trails): no UPDATE/DELETE/TRUNCATE for the app.
--    Add every audit-style table of the project to the list.
SELECT format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM %I', t, :'app_role')
  FROM unnest(ARRAY['audit_log']) AS t
 WHERE to_regclass('public.' || t) IS NOT NULL \gexec

-- 5. Report.
SELECT string_agg(c.relname, ', ' ORDER BY c.relname) AS app_can_delete_from
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND has_table_privilege(:'app_role', c.oid, 'DELETE');
SELECT count(*) AS tables_delete_proof
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT has_table_privilege(:'app_role', c.oid, 'DELETE');
