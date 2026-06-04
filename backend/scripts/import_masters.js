'use strict';

const XLSX = require('xlsx');
const { Pool } = require('pg');

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
  if (!sheet) { console.log('Sheet "Route Name" not found — skipping'); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const route_no    = toStr(row['Route No']);
    const route_name  = toStr(row['Route Name']);
    const distance_km = toNum(row['KM']);
    if (!route_name) { skipped++; continue; }

    const existing = await client.query('SELECT id FROM route_masters WHERE route_name=$1', [route_name]);
    if (existing.rows.length) {
      await client.query(
        'UPDATE route_masters SET route_no=$1, distance_km=$2 WHERE id=$3',
        [route_no, distance_km, existing.rows[0].id]
      );
      updated++;
    } else {
      await client.query(
        'INSERT INTO route_masters (route_name, route_no, distance_km) VALUES ($1,$2,$3)',
        [route_name, route_no, distance_km]
      );
      inserted++;
    }
  }
  console.log(`Routes  — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`);
}

async function importBmcus(wb, client) {
  const sheet = wb.Sheets['BMCU'];
  if (!sheet) { console.log('Sheet "BMCU" not found — skipping'); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const bmcu_code = toStr(row['Plant Code']);
    const bmcu_name = toStr(row['Plant Name']);
    const latitude  = toNum(row['Lattitude'] ?? row['Latitude']);
    const longitude = toNum(row['Longitude']);
    if (!bmcu_code || !bmcu_name) { skipped++; continue; }

    const existing = await client.query('SELECT id FROM bmcus WHERE bmcu_code=$1', [bmcu_code]);
    if (existing.rows.length) {
      await client.query(
        'UPDATE bmcus SET bmcu_name=$1, latitude=$2, longitude=$3 WHERE id=$4',
        [bmcu_name, latitude, longitude, existing.rows[0].id]
      );
      updated++;
    } else {
      await client.query(
        'INSERT INTO bmcus (bmcu_code, bmcu_name, latitude, longitude) VALUES ($1,$2,$3,$4)',
        [bmcu_code, bmcu_name, latitude, longitude]
      );
      inserted++;
    }
  }
  console.log(`BMCUs   — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`);
}

async function importTankers(wb, client) {
  const sheet = wb.Sheets['Vehicle details'];
  if (!sheet) { console.log('Sheet "Vehicle details" not found — skipping'); return; }
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  let inserted = 0, updated = 0, skipped = 0;
  for (const row of rows) {
    const tanker_number    = toStr(row['Tanker No']);
    const vendor_code      = toStr(row['Vendor code']);
    const vendor_name      = toStr(row['Vendor Name']);
    const capacity_litres  = toNum(row['Capacity']);
    const compartments     = toStr(row['Compartment']);
    const rate_per_km_bmcu = toNum(row['Rate/KM-BMCU']);
    const rate_per_km_p2p  = toNum(row['Rate/KM point to point']);
    if (!tanker_number || capacity_litres === null) { skipped++; continue; }

    const reg = tanker_number.trim().toUpperCase();
    const existing = await client.query('SELECT id FROM tankers WHERE tanker_number=$1', [reg]);
    if (existing.rows.length) {
      await client.query(
        `UPDATE tankers SET vendor_code=$1, vendor_name=$2, capacity_litres=$3,
         compartments=$4, rate_per_km_bmcu=$5, rate_per_km_p2p=$6 WHERE id=$7`,
        [vendor_code, vendor_name, capacity_litres, compartments, rate_per_km_bmcu, rate_per_km_p2p, existing.rows[0].id]
      );
      updated++;
    } else {
      await client.query(
        `INSERT INTO tankers (tanker_number, vendor_code, vendor_name, capacity_litres,
         compartments, rate_per_km_bmcu, rate_per_km_p2p)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [reg, vendor_code, vendor_name, capacity_litres, compartments, rate_per_km_bmcu, rate_per_km_p2p]
      );
      inserted++;
    }
  }
  console.log(`Tankers — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`);
}

async function main() {
  console.log(`Reading Excel: ${EXCEL_PATH}`);
  let wb;
  try { wb = XLSX.readFile(EXCEL_PATH); }
  catch (err) { console.error(`Failed to read file: ${err.message}`); process.exit(1); }
  console.log(`Sheets: ${wb.SheetNames.join(', ')}`);

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
