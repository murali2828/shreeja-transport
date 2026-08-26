-- Milma: milk sold directly at the BMCU (delivery point 'Milma%'), never
-- acknowledged at a plant. Shown in billing runs for identification,
-- auto-excluded from vendor billing by default (biller can re-include).
ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS is_milma BOOLEAN NOT NULL DEFAULT FALSE;
