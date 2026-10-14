// frontend/src/components/TransportCumulative.jsx
// Month Cumulative and Year Cumulative tables (Reports → Tanker Utilisation;
// moved from the Payment Report, owner 2026-10-14). Data: GET /api/reports/cumulative.
import { useState, useRef, useEffect } from 'react';
import toast from 'react-hot-toast';
import { Download, Upload } from 'lucide-react';
import api from '../api';

const nf = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

// ── Month Cumulative (financial year of the From date) ───────────────────────
const MC_COLS = [
  ['Tankers capacity (L)', 'capacity_litres', 0], ['Milk received (L)', 'milk_litres', 0], ['Milk received (kg)', 'milk_kgs', 0],
  ['Fat %', 'fat_pct', 3], ['SNF %', 'snf_pct', 3], ['TS %', 'ts_pct', 3], ['Fat kgs', 'kg_fat', 0], ['SNF kgs', 'kg_snf', 0],
  ['Total KM', 'total_km', 0], ['Rate/KM', 'rate_per_km', 2], ['Amount (₹)', 'amount', 0], ['Toll (₹)', 'toll_amount', 0], ['Fixed cost 9000 km (₹)', 'fixed_cost', 0], ['Total cost (₹)', 'total_cost', 0],
  ['Cost/Ltr (trips)', 'cost_per_litre', 4], ['Cost/Ltr (all-in)', 'cost_per_litre_all_in', 4], ['Util %', 'utilisation_pct', 2], ['Trips', 'trips', 0], ['Avg KM', 'avg_km', 2], ['Diesel Price', 'diesel_sum', 2], ['Diesel Rate', 'diesel_price', 2],
];
export function CumulativeMonths({ months, total }) {
  const cell = (m, k, d) => m[k] == null ? '—' : nf(m[k], d);
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-blue-50 text-left text-gray-600">
            <tr><th className="px-2 py-2">Month</th>{MC_COLS.map(c => <th key={c[1]} className="px-2 py-2 text-right whitespace-nowrap">{c[0]}</th>)}<th className="px-2 py-2">Source</th></tr>
          </thead>
          <tbody>
            {(months || []).map(m => (
              <tr key={m.month} className={`border-t border-gray-100 ${!m.trips && !m.source ? 'text-gray-400' : ''}`}>
                <td className="px-2 py-1.5 whitespace-nowrap font-semibold">{m.month_name.slice(0, 3)} {m.year}</td>
                {MC_COLS.map(c => <td key={c[1]} className="px-2 py-1.5 text-right">{cell(m, c[1], c[2])}</td>)}
                <td className="px-2 py-1.5 text-gray-500">{m.source || ''}</td>
              </tr>
            ))}
            {total && (
              <tr className="bg-blue-100 font-bold"><td className="px-2 py-2">TOTAL / YTD</td>
                {MC_COLS.map(c => <td key={c[1]} className="px-2 py-2 text-right">{cell(total, c[1], c[2])}</td>)}<td/></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-500">Milk received = plant acknowledgements of the billed trips; amount and km from the billing lines; diesel = average of the Diesel Rates master over the month. Months before the portal come from the keyed monthly history (Year Cumulative tab).</div>
    </div>
  );
}

// ── Year Cumulative (month × FY matrix with YTD) + history upload (admin) ────
const YC_ROWS = [
  ['Tanker capacities (L)', 'capacity_litres', 0], ['Milk received (L)', 'milk_litres', 0], ['Milk received (kg)', 'milk_kgs', 0],
  ['Fat %', 'fat_pct', 3], ['SNF %', 'snf_pct', 3], ['TS %', 'ts_pct', 3], ['Kg fat', 'kg_fat', 0], ['Kg SNF', 'kg_snf', 0],
  ['Milk per day (L)', 'milk_per_day', 0], ['Total KM', 'total_km', 0], ['Rate/KM', 'rate_per_km', 2], ['Amount (₹)', 'amount', 0],
  ['Toll (₹)', 'toll_amount', 0], ['Fixed cost 9000 km (₹)', 'fixed_cost', 0], ['Total cost (₹)', 'total_cost', 0],
  ['Cost/Ltr (trips)', 'cost_per_litre', 4], ['Cost/Ltr (all-in)', 'cost_per_litre_all_in', 4], ['Util %', 'utilisation_pct', 2], ['Diesel ₹/L', 'diesel_price', 2], ['Trips', 'trips', 0], ['Avg KM', 'avg_km', 2],
];
export function CumulativeYears({ years, isAdmin, onHistoryChanged }) {
  const fileRef = useRef(null);
  const [metric, setMetric] = useState('cost_per_litre');
  const [showAll, setShowAll] = useState(false);
  const months = years?.[0]?.months || [];
  const onUpload = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    api.post('/reports/cumulative/history-upload', fd).then(r => {
      toast.success(`${r.data.saved} month(s) saved`);
      if (r.data.errors?.length) toast.error(r.data.errors.slice(0, 5).join('\n'), { duration: 9000 });
      onHistoryChanged?.();
    }).catch(err => toast.error(err.response?.data?.error || err.message)).finally(() => { e.target.value = ''; });
  };
  const template = () => api.get('/reports/cumulative/history-template', { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data); const a = document.createElement('a');
    a.href = url; a.download = 'transport_monthly_history_template.xlsx'; a.click(); URL.revokeObjectURL(url);
  });
  const rowsToShow = showAll ? YC_ROWS : YC_ROWS.filter(r => r[1] === metric);
  const val = (m, k, d) => (m.trips || m.source) && m[k] != null ? nf(m[k], d) : '—';
  return (
    <div className="space-y-2">
      <div className="card p-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">Metric</span>
        <select className="input text-xs" value={metric} onChange={e => setMetric(e.target.value)} disabled={showAll}>
          {YC_ROWS.map(r => <option key={r[1]} value={r[1]}>{r[0]}</option>)}
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}/> all metrics</label>
        <div className="flex-1"/>
        {isAdmin && (
          <>
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={template}><Download size={12}/> History template</button>
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => fileRef.current?.click()}><Upload size={12}/> Upload earlier years</button>
            <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={onUpload}/>
          </>
        )}
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-blue-50 text-left text-gray-600">
              <tr><th className="px-2 py-2">Metric</th><th className="px-2 py-2">FY</th>
                {months.map(m => <th key={m.month} className="px-2 py-2 text-right">{m.month_name.slice(0, 3)}</th>)}<th className="px-2 py-2 text-right">YTD</th></tr>
            </thead>
            <tbody>
              {rowsToShow.map(([label, k, d]) => (years || []).map((y, yi) => (
                <tr key={k + y.fy_start_year} className={`border-t border-gray-100 ${yi === 0 ? 'border-t-2 border-gray-300' : ''}`}>
                  <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{yi === 0 ? label : ''}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{y.fy_label}</td>
                  {y.months.map(m => <td key={m.month} className="px-2 py-1.5 text-right" title={m.source || ''}>{val(m, k, d)}</td>)}
                  <td className="px-2 py-1.5 text-right font-semibold">{val(y.ytd, k, d)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-[11px] text-gray-500">Months in the portal come from billing runs (approved or all, per the filter above); earlier years from the keyed monthly history. A month present in the portal always wins.</div>
      </div>
    </div>
  );
}

// ── Fixed cost (minimum 9,000 km per tanker per month, approval 04-06-2026) ──
// Finance's approved monthly workbook is uploaded (preview → confirm); a month
// re-uploaded replaces the earlier one. Counted in Total cost and Cost/Ltr (all-in).
export function FixedCostPanel({ canUpload }) {
  const fileRef = useRef(null);
  const [data, setData] = useState(null);
  const [month, setMonth] = useState(null);
  const [preview, setPreview] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get('/reports/fixed-costs').then(r => { setData(r.data); if (!month && r.data.months.length) setMonth(r.data.months[r.data.months.length - 1].month_start); })
    .catch(e => toast.error(e.response?.data?.error || e.message));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const monthLabel = ms => new Date(ms + 'T00:00:00').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  const pick = e => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const fd = new FormData(); fd.append('file', f); setBusy(true);
    api.post('/reports/fixed-costs/preview', fd).then(r => { setPreview(r.data); setFile(f); })
      .catch(err => toast.error(err.response?.data?.error || err.message)).finally(() => setBusy(false));
  };
  const confirm = () => {
    const fd = new FormData(); fd.append('file', file); setBusy(true);
    api.post('/reports/fixed-costs/upload', fd).then(r => {
      toast.success(`${monthLabel(r.data.month_start)}: ${r.data.saved} tankers saved`);
      setPreview(null); setFile(null); setMonth(r.data.month_start); load();
    }).catch(err => toast.error(err.response?.data?.error || err.message)).finally(() => setBusy(false));
  };
  const excel = () => api.get('/reports/fixed-costs/excel', { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data); const a = document.createElement('a');
    a.href = url; a.download = 'tanker_fixed_cost.xlsx'; a.click(); URL.revokeObjectURL(url);
  }).catch(e => toast.error(e.response?.data?.error || e.message));
  const rows = (data?.rows || []).filter(r => r.month_start === month);
  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-gray-600">Minimum 9,000 km per tanker per month (May–Oct 2026, approval 04-06-2026): shortfall km × fixed ₹/km by capacity.</span>
        <div className="flex-1"/>
        <button onClick={excel} className="btn-secondary flex items-center gap-1.5 text-sm"><Download size={14}/> Excel</button>
        {canUpload && (
          <>
            <button disabled={busy} onClick={() => fileRef.current?.click()} className="btn-primary flex items-center gap-1.5 text-sm"><Upload size={14}/> Upload approved sheet</button>
            <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={pick}/>
          </>
        )}
      </div>

      {preview && (
        <div className="card p-3 space-y-2 text-sm border-2 border-amber-300">
          <div className="font-semibold">Preview — {monthLabel(preview.month_start)} (sheet "{preview.sheet}")</div>
          <div>{preview.rows.length} tankers · ₹ {nf(preview.total)}{preview.sheet_total != null ? ` (sheet total ₹ ${nf(preview.sheet_total)})` : ''}
            {preview.existing ? <span className="text-amber-700"> · replaces the {preview.existing} rows already loaded for this month</span> : null}</div>
          {preview.warnings?.length > 0 && <div className="text-red-700 text-xs">{preview.warnings.join(' · ')}</div>}
          {preview.unmatched_tankers?.length > 0 && <div className="text-xs text-gray-600">Not in Tanker Master (loaded anyway): {preview.unmatched_tankers.join(', ')}</div>}
          <div className="flex gap-2">
            <button disabled={busy} onClick={confirm} className="btn-primary text-sm">Confirm and save</button>
            <button onClick={() => { setPreview(null); setFile(null); }} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-blue-50 text-left text-gray-600"><tr><th className="px-2 py-2">Month</th><th className="px-2 py-2 text-right">Tankers</th><th className="px-2 py-2 text-right">Balance KM</th><th className="px-2 py-2 text-right">Fixed cost (₹)</th></tr></thead>
          <tbody>
            {(data?.months || []).map(m => (
              <tr key={m.month_start} onClick={() => setMonth(m.month_start)} className={`border-t border-gray-100 cursor-pointer ${m.month_start === month ? 'bg-indigo-50 font-semibold' : 'hover:bg-gray-50'}`}>
                <td className="px-2 py-1.5">{monthLabel(m.month_start)}</td><td className="px-2 py-1.5 text-right">{m.tankers}</td>
                <td className="px-2 py-1.5 text-right">{nf(m.balance_km, 0)}</td><td className="px-2 py-1.5 text-right">{nf(m.amount)}</td>
              </tr>
            ))}
            {data && !data.months.length && <tr><td colSpan={4} className="px-2 py-4 text-center text-gray-500">No fixed cost loaded yet{canUpload ? ' — upload the approved monthly sheet' : ''}.</td></tr>}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 text-sm font-semibold">{monthLabel(month)} — per tanker</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-blue-50 text-left text-gray-600"><tr>
                {['Transporter', 'Vendor code', 'Tanker', 'Capacity (L)', 'Run KM', 'Maint. days', 'Maint. KM', 'Total KM', 'Balance KM', '₹/KM', 'Fixed cost (₹)'].map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.tanker_number} className="border-t border-gray-100">
                    <td className="px-2 py-1">{r.vendor_name}</td><td className="px-2 py-1">{r.vendor_code}</td><td className="px-2 py-1 whitespace-nowrap">{r.tanker_number}</td>
                    <td className="px-2 py-1 text-right">{nf(r.capacity_litres, 0)}</td><td className="px-2 py-1 text-right">{nf(r.run_km, 0)}</td>
                    <td className="px-2 py-1 text-right">{nf(r.maintenance_days, 0)}</td><td className="px-2 py-1 text-right">{nf(r.maintenance_km, 0)}</td>
                    <td className="px-2 py-1 text-right">{nf(r.total_km, 0)}</td><td className="px-2 py-1 text-right">{nf(r.balance_km, 0)}</td>
                    <td className="px-2 py-1 text-right">{nf(r.rate_per_km)}</td><td className="px-2 py-1 text-right font-semibold">{nf(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
