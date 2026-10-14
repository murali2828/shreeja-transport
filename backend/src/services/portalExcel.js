// backend/src/services/portalExcel.js
// ExcelJS styling shared by the billing workbooks and the Tanker Utilisation
// cumulative sheets: portal palette (blue title band, light-blue header,
// zebra rows, yellow TOTAL) and column auto-width.
// Fit every column of a sheet to its longest value (header words wrap, so a
// header counts by its longest word); bounded so long BMCU chains don't
// stretch the sheet.
function autoWidth(ws, { min = 8, max = 60, skipRows = 0 } = {}) {
  const widths = [];
  ws.eachRow((row, r) => {
    if (r <= skipRows) return;
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      let v = cell.value;
      if (v && typeof v === 'object') v = v.result ?? v.text ?? (v.richText ? v.richText.map(t => t.text).join('') : '');
      if (v == null) return;
      let s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
      if (cell.font && cell.font.bold && cell.alignment && cell.alignment.wrapText) s = s.split(/\s+/).sort((a, b) => b.length - a.length)[0] || '';
      widths[c] = Math.max(widths[c] || 0, s.length);
    });
  });
  // +3 and a bold allowance so TOTAL rows never show ########.
  widths.forEach((w, c) => { if (w) ws.getColumn(c).width = Math.min(max, Math.max(min, Math.ceil(w * 1.1) + 3)); });
}

function stylePortalWorkbook(wb, titlePrefix, skip = []) {
  const FILL = c => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: c } });
  const thin = { style: 'thin', color: { argb: 'FFBFC7D1' } };
  const BOX = { top: thin, bottom: thin, left: thin, right: thin };
  wb.eachSheet(ws => {
    if (skip.includes(ws.name)) return;
    const titleRow = String(ws.getRow(1).getCell(1).value || '').startsWith(titlePrefix) ? 1 : 0;
    const headerRow = titleRow ? 3 : 1;
    const cols = ws.getRow(headerRow).cellCount;
    if (titleRow) {
      ws.mergeCells(1, 1, 1, Math.max(cols, 2));
      const t = ws.getCell(1, 1);
      t.fill = FILL('FF005BA3'); t.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
      t.alignment = { vertical: 'middle' }; ws.getRow(1).height = 22;
    }
    const h = ws.getRow(headerRow);
    h.height = 30;
    for (let c = 1; c <= cols; c++) {
      const cell = h.getCell(c);
      cell.fill = FILL('FFDCE9F7'); cell.font = { bold: true, size: 10, color: { argb: 'FF1F2937' } };
      cell.border = BOX; cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
    for (let r = headerRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const first = String(row.getCell(1).value || '').toUpperCase();
      const isTotal = first === 'TOTAL' || first.startsWith('GRAND TOTAL') || first.startsWith('TOLL CHALLANS');
      for (let c = 1; c <= cols; c++) {
        const cell = row.getCell(c);
        cell.border = BOX;
        if (isTotal) { cell.fill = FILL('FFFFF9C4'); cell.font = { bold: true }; }
        else if ((r - headerRow) % 2 === 0) cell.fill = FILL('FFF5F8FC');
      }
    }
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    autoWidth(ws, { skipRows: titleRow ? 2 : 0 });
  });
}

module.exports = { autoWidth, stylePortalWorkbook };
