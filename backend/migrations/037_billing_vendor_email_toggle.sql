-- Admin-toggleable switch to divert (or restore) vendor-facing billing
-- emails, without needing an env-var change + redeploy. Seeded OFF with a
-- redirect address so a trial run against real data doesn't reach real
-- vendors until an admin flips it on from the Billing screen.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INTEGER
);

INSERT INTO app_settings (key, value) VALUES
  ('billing_vendor_emails_enabled', 'false'),
  ('billing_vendor_email_redirect_to', 'murali.m@shreejamilk.com')
ON CONFLICT (key) DO NOTHING;
