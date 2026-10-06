-- Material trips: the supplier's and customer's documents state quantity in
-- kgs with kg fat and kg SNF (total solids), not litres and percentages
-- (owner, 2026-10-06). Store the kg fat / kg SNF as keyed on the purchase
-- side; litres and percentages are derived (KG_FACTOR 1.0285). The customer
-- side already has kg_fat / kg_snf on trip_acknowledgements.
ALTER TABLE trip_material_data ADD COLUMN IF NOT EXISTS purchase_kg_fat NUMERIC(14,4);
ALTER TABLE trip_material_data ADD COLUMN IF NOT EXISTS purchase_kg_snf NUMERIC(14,4);
