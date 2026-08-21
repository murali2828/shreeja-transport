-- Sale tankers replace the earlier "Milma" rule in Tanker Payment billing.
--
-- Milk that is SOLD runs on a sale tanker (tanker master named "Sale Tanker…",
-- or the trip flagged as a sale trip in planning). Those trips are never
-- payable to a transport vendor: billing loads them for visibility only
-- (Sale Tankers tab / sheet) and always excludes them from the payment total.
-- TS and Analytics reports read trip data directly and continue to count this
-- milk exactly as before.
--
-- Backfill EXISTING runs so already-executed runs (e.g. run #17, whose trips
-- were classified under the old Milma rule) show up correctly in the new tab.
UPDATE billing_run_trips
   SET is_sale_tanker = TRUE,
       excluded       = TRUE
 WHERE REGEXP_REPLACE(UPPER(COALESCE(tanker_number, '')), '[^A-Z]', '', 'g') LIKE 'SALETANKER%'
   AND (is_sale_tanker = FALSE OR excluded = FALSE);

-- Column billing_run_trips.is_milma is intentionally LEFT IN PLACE (unused
-- from now on) so that rolling the application back to the previous release
-- cannot fail on a missing NOT NULL column. Drop it only after the sale-tanker
-- release is confirmed in production.
