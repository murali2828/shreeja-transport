// frontend/src/utils/printDocs.js
// Printable Gate Pass & COA documents (replicating the physical templates).
// Minimal pre-fill: trip no, date, tanker, route — all other blanks stay blank.
// Reprints (print_no > 1) get a red DUPLICATE banner; the first-print timestamp
// (stored server-side) is the operational trip start / arrival time.

const fmtTs = ts => {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtD = s => s ? s.split('-').reverse().join('/') : '';
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

const BASE_CSS = `
  * { box-sizing: border-box; font-family: 'Times New Roman', serif; }
  body { margin: 24px; color: #000; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
  .noborder td, .noborder th { border: none; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .dup { color: #c0392b; border: 2px solid #c0392b; padding: 6px 10px;
         text-align: center; font-weight: bold; margin-bottom: 10px; font-size: 12px; }
  .small { font-size: 11px; }
  @media print { body { margin: 10mm; } .dup { -webkit-print-color-adjust: exact; } }
`;

function openPrintWindow(title, bodyHtml) {
  const w = window.open('', '_blank', 'width=900,height=1000');
  if (!w) return;
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title>
    <style>${BASE_CSS}</style></head><body>${bodyHtml}
    <script>window.onload = function(){ window.print(); };</scr` + `ipt></body></html>`);
  w.document.close();
}

const dupBanner = r => r.is_duplicate
  ? `<div class="dup">DUPLICATE — original printed on ${fmtTs(r.first_printed_at)}</div>` : '';

// ─── GATE PASS ────────────────────────────────────────────────────────────────
export function printGatePass(r) {
  const d = r.data;
  const rows = Array.from({ length: 4 }, () =>
    `<tr><td style="height:26px;width:10%"></td><td style="width:40%"></td><td style="width:25%"></td><td style="width:25%"></td></tr>`).join('');
  openPrintWindow(`Gate Pass — Trip #${d.trip_no}`, `
    ${dupBanner(r)}
    <div class="center bold" style="font-size:16px;">SHREEJA MAHILA MILK PRODUCER COMPANY LIMITED.</div>
    <div class="center bold" style="font-size:15px; margin:14px 0; text-decoration:underline;">GATE PASS</div>
    <table class="noborder" style="margin-bottom:14px;">
      <tr>
        <td><span class="bold">Sl.No:</span> ${esc(d.trip_no)}</td>
        <td style="text-align:right;"><span class="bold">Date:</span> ${fmtD(d.plan_for_date)}</td>
      </tr>
    </table>
    <p style="line-height:2;">The following goods taken by Sri……………………………………………………… May be<br/>
    Allowed pass out of premises by hand / Vehicle No: <span class="bold">${esc(d.tanker_number || '')}</span>
    &nbsp;&nbsp;&nbsp;(Route: ${esc(d.route_name || '')})</p>
    <table style="margin:12px 0;">
      <tr class="bold"><td>SL.No.</td><td>Material</td><td>Quantity/No/weight</td><td>Remarks</td></tr>
      ${rows}
    </table>
    <table class="noborder" style="margin-top:56px;">
      <tr class="bold">
        <td>Sign. of Receiver</td>
        <td class="center">Check Security Sign</td>
        <td style="text-align:right;">Issuing authority/Designation</td>
      </tr>
    </table>
    <div class="small" style="margin-top:26px; color:#444;">
      Trip #${esc(d.trip_no)} · ${esc(d.starting_point || '')} → ${esc(d.delivery_point || '')} ·
      Printed ${fmtTs(r.printed_at)} (print #${r.print_no})
    </div>`);
}

// ─── COA / MILK DISPATCH VOUCHER ─────────────────────────────────────────────
const COA_TESTS = [
  ['Seal of Integrity', 'OK/Not', 'Ok'],
  ['Appearance', 'If MM – White to cream color, odour typical of fresh milk. If CM – Cream to slight yellowish color, odour typical of fresh cow milk', ''],
  ['Cleanliness of Tanker (checked by despatcher)', 'Satisfactory', 'Ok'],
  ['Temperature', '&lt;= 4 °C', ''],
  ['Foreign Matter', 'Absent', 'Absent'],
  ['Fat', 'If CM – 3.20 to 5.50', ''],
  ['SNF', 'Min 8.00', ''],
  ['Taste &amp; Flavor (Organoleptic Evaluation)', 'Clean Flavor', 'Normal'],
  ['Titratable Acidity (as Lactic Acid)', '0.100 - 0.153 %', ''],
  ['Methylene Blue Reduction Time (MBRT)', '&gt; 30 Minutes', ''],
  ['Clot-On-Boiling (COB) Test', 'Negative', 'Negative'],
  ['Alcohol (60 %)', 'Negative', 'Negative'],
  ['Neutralizer (Carbonate, Bicarbonate, Per carbonate, Hydroxides)', 'Negative', 'Negative'],
  ['Urea', 'Negative', 'Negative'],
  ['Ammonium Compounds', 'Negative', 'Negative'],
  ['Starch and Cereal Flours', 'Negative', 'Negative'],
  ['Salts (NaCl, KCL)', 'Negative', 'Negative'],
  ['Sucrose (Cane Sugar)', 'Negative', 'Negative'],
  ['Glucose', 'Negative', 'Negative'],
  ['Formalin', 'Negative', 'Negative'],
  ['Hydrogen Peroxide', 'Negative', 'Negative'],
  ['Anionic Detergent / Detergents', 'Negative', 'Negative'],
  ['Maltodextrin (By Enzymatic Method)', 'Negative', 'Negative'],
  ['Quaternary Ammonium Compound', 'Negative', 'Negative'],
  ['Butyro-Refractrometer (BR) Reading of extracted Fat at 40°C-Top Layer (for Vegetable Oil/Fat)', '40-43', ''],
  ['Nitrates', 'Negative', 'Negative'],
  ['Boric Acid', 'Negative', 'Negative'],
];

export function printCoa(r) {
  const d = r.data;
  const blank = (label, value = '') =>
    `<tr><td class="bold" style="width:34%">${label}</td><td>${value}</td></tr>`;
  openPrintWindow(`COA — Trip #${d.trip_no}`, `
    ${dupBanner(r)}
    <table style="margin-bottom:8px;">
      <tr><td class="center">
        <div class="bold" style="font-size:15px;">SHREEJA MAHILA MILK PRODUCER COMPANY LIMITED</div>
        <div class="small">Address: 3rd &amp; 4th Floors, Plot No 29 &amp; 30, Bachala Towers, SGS Arts College Road, Tirupati<br/>
        Tel: 0877-2242173, E-Mail: info@shreejamilk.com, Website: shreejamilk.com</div>
      </td></tr>
    </table>
    <table style="margin-bottom:10px;" class="small bold">
      <tr><td>FSSAI Lic No.: 10014044000870</td><td>GST No. AAUCS7586A1ZQ</td><td>STATE CODE: 37</td></tr>
    </table>

    <p><span class="bold">Milk Dispatch Voucher</span>
       &nbsp;&nbsp;&nbsp;&nbsp; Name of the Route: <span class="bold">${esc(d.route_name || '')}</span><br/>
       Tanker Number: <span class="bold">${esc(d.tanker_number || '')}</span></p>
    <table style="margin-bottom:10px;">
      <tr class="bold"><td>Description</td><td>Front cell</td><td>Middle cell</td><td>Back cell</td></tr>
      <tr><td>Milk Type</td><td style="height:22px"></td><td></td><td></td></tr>
      <tr><td>Milk Quantity In Ltrs</td><td style="height:22px"></td><td></td><td></td></tr>
      <tr><td>Seal Number</td><td style="height:22px"></td><td></td><td></td></tr>
    </table>

    <table style="margin-bottom:10px;" class="small">
      <tr>
        <td style="width:33%">
          <table class="noborder small">
            ${blank('Delivery Challan Date:', fmtD(d.plan_for_date))}
            ${blank('Delivery Challan No.:')}
            ${blank('Name of Route:', esc(d.route_name || ''))}
            ${blank('Dispatch Center Code:')}
            ${blank('Address:')}
            ${blank('Name of Transporter:')}
            ${blank('Name of Driver:')}
            ${blank('Vehicle No.:', esc(d.tanker_number || ''))}
            ${blank('LR No./LR Date:')}
          </table>
        </td>
        <td style="width:33%">
          <div class="bold center">Details of (Bill to Party)</div>
          <table class="noborder small">
            ${blank('Name of Bill to Party:', 'NDDB Dairy Services')}
            ${blank('Customer Code:')}
            ${blank('Address:', 'NDDB House, Safdarjung Enclave, South West Delhi, New Delhi 110029')}
            ${blank('GSTIN/Unique ID:', '07AADCN1059J1ZG')}
            ${blank('State:', 'Delhi')}
            ${blank('State Code:', '07')}
            ${blank('Date of PO:')}
          </table>
        </td>
        <td style="width:34%">
          <div class="bold center">Details of (Ship to Party)</div>
          <table class="noborder small">
            ${blank('SAP Vendor Code (MD):', '4024119')}
            ${blank('Name of Ship to Party:', 'Mother Dairy Fruit and Vegetable Private Limited (c/o Balaji Dairy)')}
            ${blank('Customer Code:')}
            ${blank('Address of Delivery:')}
            ${blank('Place of Supply:', 'TIRUPATI')}
            ${blank('GSTIN/Unique ID:', '37AACCM3174A1ZU')}
            ${blank('State:', 'ANDHRA PRADESH')}
            ${blank('State Code:', '37')}
          </table>
        </td>
      </tr>
    </table>

    <table class="small" style="margin-bottom:6px;">
      <tr class="bold center">
        <td rowspan="2">Sr. No.</td><td rowspan="2">HSN/SAC Code</td><td rowspan="2">Batch</td>
        <td rowspan="2">Quantity</td><td rowspan="2">Value</td>
        <td colspan="2">Central Tax</td><td colspan="2">State Tax/UT Tax</td><td colspan="2">Integrated Tax</td>
        <td rowspan="2">Total</td>
      </tr>
      <tr class="bold center"><td>Rate</td><td>Amt.</td><td>Rate</td><td>Amt.</td><td>Rate</td><td>Amt.</td></tr>
      <tr><td class="bold">RAW COW MILK</td><td></td><td></td><td></td><td></td>
        <td class="center">-</td><td></td><td></td><td class="center">-</td><td class="center">-</td><td class="center">-</td><td></td></tr>
    </table>
    <p style="text-align:right;" class="bold">Signature:<br/>Shreeja Representative</p>

    <div style="page-break-before:always;"></div>
    ${dupBanner(r)}
    <div class="center bold" style="font-size:14px; margin-bottom:10px;">
      Certificate of Analysis (Annexure to Tanker Challan)</div>
    <table class="small" style="margin-bottom:10px;">
      ${blank('Milk Tanker being sent from:', esc(d.starting_point || ''))}
      ${blank('Type of Milk:')}
      ${blank('Milk Tanker Regn Number:', esc(d.tanker_number || ''))}
      ${blank('Milk Tanker Challan Number:')}
      ${blank('Date of despatch:', fmtD(d.plan_for_date))}
    </table>
    <table class="small">
      <tr class="bold center"><td style="width:7%">Sr. No.</td><td style="width:33%">Parameter</td>
        <td style="width:35%">Acceptance Limit</td><td style="width:25%">Actual Observation/ Value</td></tr>
      ${COA_TESTS.map((t, i) =>
        `<tr><td class="center">${i + 1}</td><td>${t[0]}</td><td>${t[1]}</td><td>${t[2]}</td></tr>`).join('')}
    </table>
    <div class="small" style="margin-top:8px;">
      <span class="bold">Note:</span><br/>
      1. Rest Values of Tests (like Fat &amp; SNF) are mentioned in the main Tanker Challan<br/>
      2. This milk is being sent for further processing and is not for direct sales<br/>
      3. This document is to be prepared in duplicate; one to be sent as annexure to main copy of challan,
      and second to be preserved by the dispatch location.
    </div>
    <p style="text-align:right; margin-top:36px;" class="bold">Signature of Despatcher<br/>(In-charge MCC/ QA)</p>
    <div class="small" style="color:#444;">Trip #${esc(d.trip_no)} · Printed ${fmtTs(r.printed_at)} (print #${r.print_no})</div>`);
}
