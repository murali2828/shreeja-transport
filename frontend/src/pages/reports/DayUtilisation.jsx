// frontend/src/pages/reports/DayUtilisation.jsx
// Reports → Tanker Utilisation (renamed from Day Utilisation, owner 2026-10-14):
// tabs Day wise · Month Cumulative · Year Cumulative (the cumulative views
// moved here from the Payment Report; components/TransportCumulative.jsx).
// Day wise Tanker Utilisation (per sample Day_wise_Utilisation.xlsx):
// one row per acknowledged trip by ack date — ack totals, tanker capacity,
// Utilization % = Ack Qty Ltrs / capacity × 100, remark ABOVE/BELOW threshold.
import { useState } from 'react';
import { CumulativeMonths, CumulativeYears } from '../../components/TransportCumulative';
import { getCumulative, downloadCumulativeExcel } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';
import { hasRole } from '../../utils/roles';
import toast from 'react-hot-toast';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { getDayUtilisation, downloadDayUtilisationExcel } from '../../api/index';
import { fmtDate } from '../../utils/date';

const today = () => new Date().toISOString().slice(0, 10);
const n2 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

function DayWise() {
  const [from, setFrom] = useState(today());
  const [to, setTo]     = useState(today());
  const [threshold, setThreshold] = useState(95);

  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['day-utilisation', from, to, threshold],
    queryFn:  () => getDayUtilisation({ from_date: from, to_date: to, threshold }).then(r => r.data),
    enabled:  !!from && !!to,
  });

  const above = rows.filter(r => r.utilization != null && r.utilization >= threshold).length;
  const below = rows.filter(r => r.utilization != null && r.utilization < threshold).length;
  const totLitres = rows.reduce((s, r) => s + (parseFloat(r.ack_litres) || 0), 0);
  // Fleet utilisation excludes sale tankers (milk sold, not a fleet fill).
  const fleetRows = rows.filter(r => !r.is_sale_tanker);
  const saleCount = rows.length - fleetRows.length;
  const fleetLitres = fleetRows.reduce((s, r) => s + (parseFloat(r.ack_litres) || 0), 0);
  const totCap    = fleetRows.reduce((s, r) => s + (parseFloat(r.capacity) || 0), 0);
  const avgUtil   = totCap ? (fleetLitres / totCap * 100) : null;

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title text-base">Day wise</div>
          <div className="page-sub">Acknowledged quantity vs tanker capacity — by acknowledgement date</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" className="input py-1.5 text-sm" value={from} onChange={e => setFrom(e.target.value)}/>
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" className="input py-1.5 text-sm" value={to} onChange={e => setTo(e.target.value)}/>
          <label className="text-xs text-gray-500 flex items-center gap-1">
            Threshold %
            <input type="number" min="1" max="100" className="input py-1.5 text-sm w-16"
              value={threshold} onChange={e => setThreshold(parseFloat(e.target.value) || 95)}/>
          </label>
          <button onClick={() => downloadDayUtilisationExcel(from, to, threshold)} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download size={14}/> Export Excel
          </button>
          {isFetching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
        </div>
      </div>

      <div className="flex gap-3 text-xs flex-wrap">
        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{rows.length} acknowledged trips</span>
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{above} above {threshold}%</span>
        <span className="px-3 py-1 rounded-full bg-red-100 text-red-600 font-medium">{below} below {threshold}%</span>
        {avgUtil != null && (
          <span className={`px-3 py-1 rounded-full font-medium ${avgUtil >= threshold ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
            fleet utilisation {n2(avgUtil)}%
          </span>
        )}
        {saleCount > 0 && (
          <span className="px-3 py-1 rounded-full bg-violet-100 text-violet-700 font-medium" title="Sale tankers are excluded from fleet utilisation">
            {saleCount} sale tanker{saleCount > 1 ? 's' : ''} (excluded)
          </span>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[68vh]">
          <table className="w-full text-xs" style={{ minWidth: 1300 }}>
            <thead className="sticky top-0 bg-gray-50 z-10 border-b">
              <tr>
                {['S.NO','Started Point','Delivery Point','Ack date','Tanker Number','Route Name',
                  'Ack Qty Ltrs','Ack Qty Kgs','Fat','SNF','KG Fat','Kg SNF','Tanker Capacity','Utilization %','Remarks']
                  .map((h, i) => (
                    <th key={h} className={`table-th ${i >= 6 && i <= 13 ? 'text-right' : ''} ${i === 14 ? 'text-center' : ''}`}>{h}</th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={15}><div className="empty-state">No acknowledged trips in this date range.</div></td></tr>
              )}
              {rows.map(r => (
                <tr key={r.s_no} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td">{r.s_no}</td>
                  <td className="table-td whitespace-nowrap">{r.starting_point || '—'}</td>
                  <td className="table-td whitespace-nowrap">{r.delivery_point || '—'}</td>
                  <td className="table-td whitespace-nowrap">{fmtDate(r.ack_date)}</td>
                  <td className="table-td font-mono font-semibold text-[#005ba3] whitespace-nowrap">
                    {r.tanker_number || '—'}
                    {r.is_sale_tanker && <span className="ml-1 px-1 rounded bg-violet-600 text-white text-[10px] font-sans" title="Sale Tanker — milk sold, not delivered to a plant">SALE</span>}
                  </td>
                  <td className="table-td whitespace-nowrap">{r.route_name || '—'}</td>
                  <td className="table-td text-right">{n2(r.ack_litres)}</td>
                  <td className="table-td text-right">{n2(r.ack_kgs)}</td>
                  <td className="table-td text-right">{n2(r.fat)}</td>
                  <td className="table-td text-right">{n2(r.snf)}</td>
                  <td className="table-td text-right">{n2(r.kg_fat)}</td>
                  <td className="table-td text-right">{n2(r.kg_snf)}</td>
                  <td className="table-td text-right">{n0(r.capacity)}</td>
                  <td className={`table-td text-right font-bold ${r.utilization == null ? 'text-gray-300' : r.utilization >= threshold ? 'text-green-700' : 'text-red-600'}`}>
                    {n2(r.utilization)}
                  </td>
                  <td className="table-td text-center">
                    {r.remarks && (
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${r.remarks.startsWith('ABOVE') ? 'bg-green-100 text-green-700' : r.is_sale_tanker ? 'bg-violet-100 text-violet-700' : 'bg-red-100 text-red-600'}`}>
                        {r.remarks}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-blue-50 border-t font-semibold sticky bottom-0">
                <tr>
                  <td className="table-td text-[#003a6b]" colSpan={6}>TOTAL — {rows.length} trips{saleCount > 0 ? ` (utilisation on ${fleetRows.length} non-sale)` : ''}</td>
                  <td className="table-td text-right text-[#003a6b]">{n2(totLitres)}</td>
                  <td className="table-td text-right text-[#003a6b]">{n2(rows.reduce((s, r) => s + (parseFloat(r.ack_kgs) || 0), 0))}</td>
                  <td className="table-td" colSpan={2}></td>
                  <td className="table-td text-right text-[#003a6b]">{n2(rows.reduce((s, r) => s + (parseFloat(r.kg_fat) || 0), 0))}</td>
                  <td className="table-td text-right text-[#003a6b]">{n2(rows.reduce((s, r) => s + (parseFloat(r.kg_snf) || 0), 0))}</td>
                  <td className="table-td text-right text-[#003a6b]">{n0(totCap)}</td>
                  <td className={`table-td text-right font-bold ${avgUtil != null && avgUtil >= threshold ? 'text-green-700' : 'text-red-600'}`}>{n2(avgUtil)}</td>
                  <td className="table-td"></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

// Financial year (April → March) containing a date: start year.
const fyStartOf = iso => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y : y - 1; };

function Cumulative({ view }) {
  const { user } = useAuth();
  const isAdmin = hasRole(user, 'admin');
  const [fy, setFy] = useState(fyStartOf(today()));
  const [status, setStatus] = useState('approved');
  const from = `${fy}-04-01`;
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['cumulative', fy, status],
    queryFn: () => getCumulative({ from, status }).then(r => r.data),
  });
  const years = [];
  for (let y = fyStartOf(today()); y >= 2023; y--) years.push(y);
  const excel = () => downloadCumulativeExcel({ from, status }).catch(e => toast.error(e.response?.data?.error || e.message));
  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="text-xs text-gray-600 flex items-center gap-1">Financial year
          <select className="input py-1.5 text-sm" value={fy} onChange={e => setFy(+e.target.value)}>
            {years.map(y => <option key={y} value={y}>{y}-{String(y + 1).slice(2)}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600 flex items-center gap-1">Runs
          <select className="input py-1.5 text-sm" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="approved">Approved only (payable)</option>
            <option value="all">All runs</option>
          </select>
        </label>
        <button onClick={excel} className="btn-secondary flex items-center gap-1.5 text-sm"><Download size={14}/> Excel</button>
        {isFetching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
      </div>
      {isError && <div className="card p-3 text-red-700 text-sm">Could not load: {error.response?.data?.error || error.message}</div>}
      {data && view === 'months' && <CumulativeMonths months={data.months} total={data.months_total}/>}
      {data && view === 'years' && <CumulativeYears years={data.years} isAdmin={isAdmin} onHistoryChanged={refetch}/>}
    </div>
  );
}

export default function TankerUtilisation() {
  const [tab, setTab] = useState('day');
  const TABS = [['day', 'Day wise'], ['months', 'Month Cumulative'], ['years', 'Year Cumulative']];
  return (
    <div className="space-y-4 w-full">
      <div>
        <div className="page-title">Tanker Utilisation</div>
        <div className="page-sub">Day-wise acknowledged quantity vs capacity, and month / year cumulative of milk, km and transport cost</div>
      </div>
      <div className="flex gap-2">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="text-xs px-3 py-1.5 rounded-lg font-semibold"
            style={tab === k ? { background: '#4a3aa7', color: '#fff' } : { background: '#fff', color: '#57534e' }}>{l}</button>
        ))}
      </div>
      {tab === 'day' ? <DayWise/> : <Cumulative view={tab}/>}
    </div>
  );
}
