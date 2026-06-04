// backend/scripts/import_masters.js
// Bulk import Routes, BMCUs, and Tankers from Excel file into the DB.
// Run inside the backend container:
//   docker cp /path/to/TMS_Master.xlsx shreeja-backend:/tmp/TMS_Master.xlsx
//   docker exec shreeja-backend node /app/scripts/import_masters.js

'use strict';

const XLSX = require('xlsx');
const { Pool } = require('pg');
const path = require('path');

const EXCEL_PATH = process.env.EXCEL_PATH || '/tmp/TMS_Master.xlsx';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'db',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'shreeja_transport',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function toStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

async function importRoutes(wb, client) {
  const sheet = wb.Sheets['Route Name'];
  if (!sheet) { console.log('Sheet "Route Name" not found — skipping routes'); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const route_no   = toStr(row['Route No']);
    const route_name = toStr(row['Route Name']);
    const distance_km = toNum(row['KM']);

    if (!route_name) { skipped++; continue; }

    const res = await client.query(
      `INSERT INTO route_masters (route_name, route_no, distance_km)
       VALUES ($1, $2, $3)
       ON CONFLICT (route_name) DO UPDATE
         SET route_no = EXCLUDED.route_no,
             distance_km = EXCLUDED.distance_km,
             updated_at = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [route_name, route_no, distance_km]
    );
    if (res.rows[0].is_insert) inserted++; else updated++;
  }
  console.log(`Routes    — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`);
}

async function importBmcus(wb, client) {
  const sheet = wb.Sheets['BMCU'];
  if (!sheet) { console.log('Sheet "BMCU" not found — skipping BMCUs'); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const code      = toStr(row['Plant Code']);
    const name      = toStr(row['Plant Name']);
    const latitude  = toNum(row['Latitude']);
    const longitude = toNum(row['Longitude']);

    if (!code || !name) { skipped++; continue; }

    const res = await client.query(
      `INSERT INTO bmcus (bmcu_code, bmcu_name, latitude, longitude)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bmcu_code) DO UPDATE
         SET bmcu_name  = EXCLUDED.bmcu_name,
             latitude   = EXCLUDED.latitude,
             longitude  = EXCLUDED.longitude,
             updated_at = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [code, name, latitude, longitude]
    );
    if (res.rows[0].is_insert) inserted++; else updated++;
  }
  console.log(`BMCUs     — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`);
}

async function importTankers(wb, client) {
  const sheet = wb.Sheets['Vehicle details'];
  if (!sheet) { console.log('Sheet "Vehicle details" not found — skipping tankers'); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const vendor_code       = toStr(row['Vendor code']);
    const vendor_name       = toStr(row['Vendor Name']);
    const registration_no   = toStr(row['Tanker No']);
    const capacity_litres   = toNum(row['Capacity']);
    const compartments      = toStr(row['Compartment']);
    const rate_per_km_bmcu  = toNum(row['Rate/KM-BMCU']);
    const rate_per_km_p2p   = toNum(row['Rate/KM point to point']);

    if (!registration_no) { skipped++; continue; }

    const res = await client.query(
      `INSERT INTO tankers
         (tanker_number, vendor_code, vendor_name, capacity_litres, compartments, rate_per_km_bmcu, rate_per_km_p2p)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tanker_number) DO UPDATE
         SET vendor_code      = EXCLUDED.vendor_code,
             vendor_name      = EXCLUDED.vendor_name,
             capacity_litres  = COALESCE(EXCLUDED.capacity_litres, tankers.capacity_litres),
             compartments     = EXCLUDED.compartments,
             rate_per_km_bmcu = EXCLUDED.rate_per_km_bmcu,
             rate_per_km_p2p  = EXCLUDED.rate_per_km_p2p,
             updated_at       = NOW()
       RETURNING (xmax = 0) AS is_insert`,
      [registration_no, vendor_code, vendor_name, capacity_litres, compartments, rate_per_km_bmcu, rate_per_km_p2p]
    );
    if (res.rows[0].is_insert) inserted++; else updated++;
  }
  console.log(`Tankers   — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`);
}

async function main() {
  console.log(`Reading Excel: ${EXCEL_PATH}`);
  let wb;
  try {
    wb = XLSX.readFile(EXCEL_PATH);
  } catch (err) {
    console.error(`Failed to read Excel file: ${err.message}`);
    process.exit(1);
  }
  console.log(`Sheets found: ${wb.SheetNames.join(', ')}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await importRoutes(wb, client);
    await importBmcus(wb, client);
    await importTankers(wb, client);
    await client.query('COMMIT');
    console.log('Import complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Import failed, rolled back:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
