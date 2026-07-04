// frontend/src/pages/reports/DailyTSReport.jsx
// Daily TS Report — reconciliation format (per Report_TMS.xlsx):
// one row per trip planned for the selected date, with RMRD / Dispatch /
// Acknowledgement totals and Ack−RMRD, Ack−Dispatch differences.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Mail, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getDailyTSReport, downloadTSExcel, sendDailyReport } from '../../api/index';

const today = () => new Date().toISOString().slice(0, 10);
const fmtD  = d => d ? String(d).slice(0, 10) : '—';
const n2 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const n4 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 4 });

const MEASURES = ['litres', 'kgs', 'kg_fat', 'kg_snf'];
const GROUPS = [
  { title: 'As per RMRD',                prefix: 'rmrd',      cls: 'bg-sky-50' },
  { title: 'As per Dispatch',            prefix: 'disp',      cls: 'bg-emerald-50' },
  { title: 'As per Acknowledgement',     prefix: 'ack',       cls: 'bg-violet-50' },
  { title: 'Difference RMRD Vs Ack',     prefix: 'diff_rmrd', cls: 'bg-amber-50', diff: true },
  { title: 'Difference Dispatch Vs Ack', prefix: 'diff_disp', cls: 'bg-rose-50',  diff: true },
];

function DiffCell({ value, fmt }) {
  if (value == null) return <td className="table-td text-right text-gray-300">—</td>;
  const v = parseFloat(value);
  return (
    <td className={`table-td text-right font-medium ${v < 0 ? 'text-red-600' : 'text-green-700'}`}>
      {fmt(v)}
    </td>
  );
}

export default function DailyTSReport() {
  const [reportDate, setReportDate] = useState(today());
  const [emailing, setEmailing] = useState(false);

  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['daily-ts', reportDate],
    queryFn:  () => getDailyTSReport({ report_date: reportDate }).then(r => r.data),
    enabled:  !!reportDate,
  });

  const sum = key => rows.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0);
  const acked = rows.filter(r => r.has_ack).length;

  const doEmail = async () => {
    setEmailing(true);
    try {
      const r = await sendDailyReport(reportDate);
      toast.success(`Report emailed to ${r.data.recipients} recipient(s)`);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Email failed');
    } finally { setEmailing(false); }
  };

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title">Daily TS Report</div>
          <div className="page-sub">RMRD vs Dispatch vs Acknowledgement reconciliation — by planning date</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" className="input py-1.5 text-sm" value={reportDate}
            onChange={e => setReportDate(e.target.value)}/>
          <button onClick={() => downloadTSExcel(reportDate)} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download size={14}/> Export Excel
          </button>
          <button onClick={doEmail} disabled={emailing} className="btn-primary flex items-center gap-1.5 text-sm">
            {emailing ? <RefreshCw size={14} className="animate-spin"/> : <Mail size={14}/>} Send Email
          </button>
        </div>
      </div>

      <div className="flex gap-3 text-xs">
        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{rows.length} trips planned</span>
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{acked} acknowledged</span>
        <span className="px-3 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">{rows.length - acked} pending</span>
        {isFetching && <RefreshCw size={13} className="animate-spin text-gray-400 mt-1"/>}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[68vh]">
          <table className="text-xs" style={{ minWidth: 1700 }}>
            <thead className="sticky top-0 bg-gray-50 z-10">
              <tr className="border-b">
                <th className="table-th" rowSpan={2}>Tanker Number</th>
                <th className="table-th" rowSpan={2}>Milk Lifting Date</th>
                <th className="table-th" rowSpan={2}>Ack. Date</th>
                <th className="table-th" rowSpan={2}>Route Name</th>
                <th className="table-th" rowSpan={2}>Unloading Point</th>
                {GROUPS.map(g => (
                  <th key={g.prefix} colSpan={4}
                    className={`table-th text-center border-l ${g.cls}`}>{g.title}</th>
                ))}
              </tr>
              <tr className="border-b">
                {GROUPS.map(g => (
                  ['Qty Ltrs', 'Qty Kgs', 'Kg.Fat', 'Kg.SNF'].map((h, i) => (
                    <th key={g.prefix + h} className={`table-th text-right ${g.cls} ${i === 0 ? 'border-l' : ''}`}>{h}</th>
                  ))
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={25}><div className="empty-state">No trips planned for this date.</div></td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td font-mono font-semibold text-[#005ba3] whitespace-nowrap">{r.tanker_number || '—'}</td>
                  <td className="table-td whitespace-nowrap">{fmtD(r.lifting_date)}</td>
                  <td className="table-td whitespace-nowrap">{fmtD(r.ack_date)}</td>
                  <td className="table-td whitespace-nowrap">{r.route_name || '—'}</td>
                  <td className="table-td whitespace-nowrap">{r.unloading_point || '—'}</td>
                  {GROUPS.map(g => MEASURES.map((m, mi) => {
                    const key = `${g.prefix}_${m}`;
                    const fmt = m === 'litres' ? n2 : n4;
                    return g.diff
                      ? <DiffCell key={key} value={r[key]} fmt={fmt}/>
                      : <td key={key} className={`table-td text-right ${mi === 0 ? 'border-l border-gray-100' : ''}`}>{fmt(r[key])}</td>;
                  }))}
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-blue-50 border-t font-semibold sticky bottom-0">
                <tr>
                  <td className="table-td" colSpan={5}>TOTAL — {rows.length} trips</td>
                  {GROUPS.map(g => MEASURES.map((m, mi) => {
                    const total = sum(`${g.prefix}_${m}`);
                    const fmt = m === 'litres' ? n2 : n4;
                    return (
                      <td key={g.prefix + m}
                        className={`table-td text-right ${g.diff ? (total < 0 ? 'text-red-600' : 'text-green-700') : 'text-[#003a6b]'} ${mi === 0 ? 'border-l' : ''}`}>
                        {fmt(total)}
                      </td>
                    );
                  }))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
