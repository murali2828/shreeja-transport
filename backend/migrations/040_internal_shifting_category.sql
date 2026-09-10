-- Internal Shifting entries are now split into 'Raw Milk' and 'Chilled Milk'
-- (trip_execution_bmcu_entries.category, kind stays 'internal_shifting').
-- Legacy rows saved before the split had category NULL and were always treated
-- as chilled stock moved out of the source plant — backfill them so reports
-- and the execution form see an explicit type. Code still COALESCEs NULL to
-- 'Chilled Milk' defensively.
UPDATE trip_execution_bmcu_entries
   SET category = 'Chilled Milk'
 WHERE kind = 'internal_shifting' AND category IS NULL;
