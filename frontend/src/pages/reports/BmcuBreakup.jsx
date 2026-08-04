// frontend/src/pages/reports/BmcuBreakup.jsx
// BMCU Break Up Report — per-BMCU dispatch vs RMRD reconciliation
// (per sample BMCU_Break_Up.xlsx). One block per BMCU per trip:
// dispatch entry vs RMRD shift rows + adjustments (leftover −, lifted +,
// New MPP +, milk shifting +receiver/−source), Gross Total with
// difference = RMRD − Dispatch; Grand Total per trip.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { getBmcuBreakup, downloadBmcuBreakupExcel } from '../../api/index';

const today = () => new Date().toISOString().slice(0, 10);
const n2 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const M6 = m => [m?.litres, m?.kgs, m?.fat, m?.snf, m?.kg_fat, m?.kg_snf];
const D4 = d => [d?.kgs, d?.litres, d?.kg_fat, d?.kg_snf, d?.pct];

const NumCells = ({ m, cls = '' }) => M6(m).map((v, i) => (
  <td key={i} className={`table-td text-right whitespace-nowrap ${i === 0 ? 'border-l border-gray-200' : ''} ${cls}`}>{n2(v)}</td>
));

const DiffCells = ({ d, blank = false }) => D4(d).map((v, i) => (
  <td key={i} className={`table-td text-right font-semibold whitespace-nowrap bg-amber-50 ${i === 0 ? 'border-l border-gray-200' : ''}
    ${blank || v == null ? 'text-gray-300' : parseFloat(v) < 0 ? 'text-red-600' : 'text-green-700'}`}>
    {blank ? '' : n2(v)}
  </td>
));

export default function BmcuBreakup() {
  const [reportDate, setReportDate] = useState(today());

  const { data, isFetching } = useQuery({
    queryKey: ['bmcu-breakup', reportDate],
    queryFn:  () => getBmcuBreakup({ report_date: reportDate }).then(r => r.data),
    enabled:  !!reportDate,
  });
  const trips = data?.trips || [];
  const notes = data?.notes || [];
  const totalBmcus = trips.reduce((s, t) => s + t.bmcus.length, 0);

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title">BMCU Break Up Report</div>
          <div className="page-sub">Per-BMCU Dispatch vs RMRD (Truck sheet) reconciliation — by planning date</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" className="input py-1.5 text-sm" value={reportDate}
            onChange={e => setReportDate(e.target.value)}/>
          <button onClick={() => downloadBmcuBreakupExcel(reportDate)} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download size={14}/> Export Excel
          </button>
        </div>
      </div>

      <div className="flex gap-3 text-xs">
        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{trips.length} trips with execution data</span>
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{totalBmcus} BMCUs</span>
        {isFetching && <RefreshCw size={13} className="animate-spin text-gray-400 mt-1"/>}
      </div>

      {notes.map((n, i) => (
        <div key={i} className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Note: {n}</div>
      ))}

      {trips.length === 0 && (
        <div className="card"><div className="empty-state">No execution data for trips planned on this date.</div></div>
      )}

      {trips.map(trip => (
        <div key={trip.trip_no} className="card overflow-hidden">
          <div className="px-4 py-2.5 bg-gray-50 border-b flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-bold text-[#0078d4]">Trip #{trip.trip_no}</span>
            <span className="font-mono text-xs font-semibold text-[#005ba3]">{trip.tanker_number || '—'}</span>
            <span className="text-gray-600">{trip.route_name || '—'}</span>
            <span className="text-gray-500 text-xs">Lifting: {trip.lifting_date || '—'}</span>
            {trip.entered_by && <span className="text-gray-500 text-xs">Entered by: <span className="font-mono text-gray-700">{trip.entered_by}</span></span>}
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs" style={{ minWidth: 1700 }}>
              <thead className="bg-gray-50">
                <tr className="border-b">
                  <th className="table-th" rowSpan={2}>BMCU Code</th>
                  <th className="table-th" rowSpan={2}>BMCUs Name</th>
                  <th className="table-th" rowSpan={2}>Compartment</th>
                  <th className="table-th text-center border-l bg-emerald-50" colSpan={6}>As per the Tanker Dispatch Quantity</th>
                  <th className="table-th text-center border-l" rowSpan={2}>Shift</th>
                  <th className="table-th text-center border-l bg-sky-50" colSpan={6}>As Per RMRD</th>
                  <th className="table-th text-center border-l bg-amber-50" colSpan={5}>Difference Dispatch Vs RMRD</th>
                </tr>
                <tr className="border-b">
                  {['Qty Lts','Qty Kgs','Fat','SNF','KG Fat','KG SNF'].map((h, i) => (
                    <th key={'d'+h} className={`table-th text-right bg-emerald-50 ${i===0?'border-l':''}`}>{h}</th>))}
                  {['Qty Lts','Qty Kgs','Fat','SNF','KG Fat','KG SNF'].map((h, i) => (
                    <th key={'r'+h} className={`table-th text-right bg-sky-50 ${i===0?'border-l':''}`}>{h}</th>))}
                  {['Qty Kgs','Qty Lts','KG Fat','KG SNF','Gain/Loss %'].map((h, i) => (
                    <th key={'x'+h} className={`table-th text-right bg-amber-50 ${i===0?'border-l':''}`}>{h}</th>))}
                </tr>
              </thead>
              <tbody>
                {trip.bmcus.map((b, bi) => {
                  const blockRows = b.rows.length ? b.rows : [{ type: 'shift', shift: '' }];
                  return [
                    ...blockRows.map((r, i) => (
                      <tr key={`${bi}-${i}`} className="border-b border-gray-50 hover:bg-gray-50">
                        <td className="table-td font-mono font-semibold text-[#005ba3]">{b.bmcu_code}</td>
                        <td className={`table-td whitespace-nowrap ${r.type === 'adjustment' ? 'text-amber-700 font-medium' : ''}`}>
                          {r.type === 'adjustment' ? r.label : b.bmcu_name}
                        </td>
                        <td className="table-td">{i === 0 ? (b.compartment || '—') : ''}</td>
                        {i === 0
                          ? <NumCells m={b.dispatch} cls="bg-emerald-50/40"/>
                          : M6({}).map((_, k) => <td key={k} className={`table-td bg-emerald-50/40 ${k===0?'border-l border-gray-200':''}`}></td>)}
                        <td className="table-td text-center border-l border-gray-200 font-medium">{r.shift || ''}</td>
                        <NumCells m={r} cls="bg-sky-50/40"/>
                        <DiffCells blank/>
                      </tr>
                    )),
                    <tr key={`${bi}-gross`} className="border-b bg-gray-50 font-semibold">
                      <td className="table-td font-mono text-[#005ba3]">{b.bmcu_code}</td>
                      <td className="table-td">Gross Total</td>
                      <td className="table-td"></td>
                      <NumCells m={b.dispatch}/>
                      <td className="table-td border-l border-gray-200"></td>
                      <NumCells m={b.rmrd}/>
                      <DiffCells d={b.diff}/>
                    </tr>,
                  ];
                })}
              </tbody>
              <tfoot className="bg-blue-50 border-t font-bold">
                <tr>
                  <td className="table-td text-[#003a6b]" colSpan={3}>Grand Total</td>
                  <NumCells m={trip.grand.dispatch} cls="text-[#003a6b]"/>
                  <td className="table-td text-center border-l border-gray-200 text-[#003a6b]">E & M</td>
                  <NumCells m={trip.grand.rmrd} cls="text-[#003a6b]"/>
                  <DiffCells d={trip.grand.diff}/>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
