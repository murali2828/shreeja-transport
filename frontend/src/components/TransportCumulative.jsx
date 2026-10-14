// frontend/src/components/TransportCumulative.jsx
// Month Cumulative and Year Cumulative tables (Reports → Tanker Utilisation;
// moved from the Payment Report, owner 2026-10-14). Data: GET /api/reports/cumulative.
import { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import { Download, Upload } from 'lucide-react';
import api from '../api';

const nf = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

// ── Month Cumulative (financial year of the From date) ───────────────────────
const MC_COLS = [
  ['Tankers capacity (L)', 'capacity_litres', 0], ['Milk received (L)', 'milk_litres', 0], ['Milk received (kg)', 'milk_kgs', 0],
  ['Fat %', 'fat_pct', 3], ['SNF %', 'snf_pct', 3], ['TS %', 'ts_pct', 3], ['Fat kgs', 'kg_fat', 0], ['SNF kgs', 'kg_snf', 0],
  ['Total KM', 'total_km', 0], ['Rate/KM', 'rate_per_km', 2], ['Amount (₹)', 'amount', 0], ['Toll (₹)', 'toll_amount', 0], ['Total cost (₹)', 'total_cost', 0],
  ['Cost/Ltr', 'cost_per_litre', 4], ['Util %', 'utilisation_pct', 2], ['Trips', 'trips', 0], ['Avg KM', 'avg_km', 2], ['Diesel Price', 'diesel_sum', 2], ['Diesel Rate', 'diesel_price', 2],
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
  ['Toll (₹)', 'toll_amount', 0], ['Total cost (₹)', 'total_cost', 0],
  ['Cost/Ltr', 'cost_per_litre', 4], ['Util %', 'utilisation_pct', 2], ['Diesel ₹/L', 'diesel_price', 2], ['Trips', 'trips', 0], ['Avg KM', 'avg_km', 2],
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
