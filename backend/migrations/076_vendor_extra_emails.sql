-- 076_vendor_extra_emails.sql
-- Vendor master: second / third … email ids (owner, 2026-10-17). Push to
-- Vendors mails the primary email plus every address here in the To line.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS extra_emails TEXT[] NOT NULL DEFAULT '{}';
