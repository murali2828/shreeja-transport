-- Ack Fat%/SNF% columns for the Tanker Billing report (Report Excel — Trip
-- Wise sheet), shown beside Ack Kgs. Weighted-average % (kg fat/snf ÷ kg
-- total), computed at execute time the same way ack_kgs already is.
ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS ack_fat_pct NUMERIC(6,3);
ALTER TABLE billing_run_trips ADD COLUMN IF NOT EXISTS ack_snf_pct NUMERIC(6,3);
