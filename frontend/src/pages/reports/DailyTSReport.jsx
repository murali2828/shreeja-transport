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
const n4 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const M6 = [['litres','Qty Ltrs'], ['kgs','Qty Kgs'], ['fat','Fat%'], ['snf','SNF%'], ['kg_fat','Kg.Fat'], ['kg_snf','Kg.SNF'], ['ts','TS']];
const D5 = [['litres','Qty Ltrs'], ['kgs','Qty Kgs'], ['kg_fat','Kg.Fat'], ['kg_snf','Kg.SNF'], ['ts','TS'], ['pct','TS Gain/TS Loss %']];
const D7 = [['litres','Qty Ltrs'], ['kgs','Qty Kgs'], ['fat','Fat%'], ['snf','SNF%'], ['kg_fat','Kg.Fat'], ['kg_snf','Kg.SNF'], ['ts','TS'], ['pct','TS Gain/TS Loss %']];
const GROUPS = [
  { title: 'As per Dispatch',             prefix: 'disp', cls: 'bg-emerald-50', measures: M6 },
  { title: 'As per RMRD',                 prefix: 'rmrd', cls: 'bg-sky-50',     measures: M6 },
  { title: 'As per Acknowledgement',      prefix: 'ack',  cls: 'bg-violet-50',  measures: M6 },
  { title: 'Difference Dispatch Vs RMRD', prefix: 'dd',   cls: 'bg-amber-50',   measures: D5, diff: true },
  { title: 'Difference Ack Vs Dispatch',  prefix: 'da',   cls: 'bg-rose-50',    measures: D7, diff: true },
  { title: 'Difference Ackn Vs RMRD',     prefix: 'dr',   cls: 'bg-yellow-50',  measures: D7, diff: true },
];
// Weighted totals (mirrors the backend): pct columns are never plain sums.
function tsTotal(key, sum) {
  const w = (part, kgs) => sum(kgs) > 0 ? sum(part) / sum(kgs) * 100 : null;
  const dw = (p1, k1, p2, k2) => {
    const a = w(p1, k1), b = w(p2, k2);
    return a != null && b != null ? a - b : null;
  };
  // Gain/Loss % — confirmed formula (sample workbook cell AV4):
  // (Σdiff Kg.Fat + Σdiff Kg.SNF) / (Σbase Kg.Fat + Σbase Kg.SNF) × 100
  const g = (diffKgFat, diffKgSnf, baseKgFat, baseKgSnf) => {
    const base = sum(baseKgFat) + sum(baseKgSnf);
    return base > 0 ? (sum(diffKgFat) + sum(diffKgSnf)) / base * 100 : null;
  };
  switch (key) {
    case 'rmrd_fat': return w('rmrd_kg_fat', 'rmrd_kgs');
    case 'rmrd_snf': return w('rmrd_kg_snf', 'rmrd_kgs');
    case 'disp_fat': return w('disp_kg_fat', 'disp_kgs');
    case 'disp_snf': return w('disp_kg_snf', 'disp_kgs');
    case 'ack_fat':  return w('ack_kg_fat', 'ack_kgs');
    case 'ack_snf':  return w('ack_kg_snf', 'ack_kgs');
    case 'da_fat':   return dw('ack_kg_fat', 'ack_kgs', 'disp_kg_fat', 'disp_kgs');
    case 'da_snf':   return dw('ack_kg_snf', 'ack_kgs', 'disp_kg_snf', 'disp_kgs');
    case 'dr_fat':   return dw('ack_kg_fat', 'ack_kgs', 'rmrd_kg_fat', 'rmrd_kgs');
    case 'dr_snf':   return dw('ack_kg_snf', 'ack_kgs', 'rmrd_kg_snf', 'rmrd_kgs');
    case 'dd_pct':   return g('dd_kg_fat', 'dd_kg_snf', 'rmrd_kg_fat', 'rmrd_kg_snf');
    case 'da_pct':   return g('da_kg_fat', 'da_kg_snf', 'disp_kg_fat', 'disp_kg_snf');
    case 'dr_pct':   return g('dr_kg_fat', 'dr_kg_snf', 'rmrd_kg_fat', 'rmrd_kg_snf');
    default:         return sum(key);
  }
}

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
  const [basis, setBasis] = useState('plan'); // 'plan' | 'ack_entry'
  const [emailing, setEmailing] = useState(false);

  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['daily-ts', reportDate, basis],
    queryFn:  () => getDailyTSReport({ report_date: reportDate, date_basis: basis }).then(r => r.data),
    enabled:  !!reportDate,
  });

  const sum = key => rows.reduce((s, r) => s + (parseFloat(r[key]) || 0), 0);
  const acked = rows.filter(r => r.has_ack).length;

  const doEmail = async () => {
    setEmailing(true);
    try {
      const r = await sendDailyReport(reportDate, basis);
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
          <div className="page-sub">
            RMRD vs Dispatch vs Acknowledgement reconciliation — by {basis === 'ack_entry' ? 'acknowledgement entry date' : basis === 'ack_date' ? 'acknowledgement date' : 'planning date'}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Date basis toggle: planning date (all planned trips) vs ack entry date (only acknowledged trips — no zero rows) */}
          <div className="flex rounded-lg overflow-hidden border border-white/40 text-xs font-medium">
            {[['plan', 'Planning Date'], ['ack_date', 'Ack Date'], ['ack_entry', 'Ack Entry Date']].map(([k, label]) => (
              <button key={k} onClick={() => setBasis(k)}
                className={`px-3 py-1.5 ${basis === k ? 'bg-white text-[#005ba3]' : 'bg-white/10 text-white hover:bg-white/20'}`}>
                {label}
              </button>
            ))}
          </div>
          <input type="date" className="input py-1.5 text-sm" value={reportDate}
            onChange={e => setReportDate(e.target.value)}/>
          <button onClick={() => downloadTSExcel(reportDate, basis)} className="btn-secondary flex items-center gap-1.5 text-sm">
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
          <table className="text-xs" style={{ minWidth: 2900 }}>
            <thead className="sticky top-0 bg-gray-50 z-10">
              <tr className="border-b">
                <th className="table-th" rowSpan={2}>Milk Lifting Date</th>
                <th className="table-th" rowSpan={2}>Milk Ack Date</th>
                <th className="table-th" rowSpan={2}>Posting Date</th>
                <th className="table-th" rowSpan={2}>Tanker Number</th>
                <th className="table-th" rowSpan={2}>Route Name</th>
                <th className="table-th" rowSpan={2}>Starting Point</th>
                <th className="table-th" rowSpan={2}>Unloading Point</th>
                <th className="table-th" rowSpan={2}>Entered By</th>
                {GROUPS.map(g => (
                  <th key={g.prefix} colSpan={g.measures.length}
                    className={`table-th text-center border-l ${g.cls}`}>{g.title}</th>
                ))}
                <th className="table-th bg-sky-50 border-l" rowSpan={2}
                    title="Balance-milk movements explaining why RMRD differs from Dispatch">
                  RMRD Adjustments
                </th>
              </tr>
              <tr className="border-b">
                {GROUPS.map(g => (
                  g.measures.map(([, h], i) => (
                    <th key={g.prefix + h} className={`table-th text-right ${g.cls} ${i === 0 ? 'border-l' : ''}`}>{h}</th>
                  ))
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={45}><div className="empty-state">
                  {basis === 'ack_entry' ? 'No acknowledgements were entered on this date.' : 'No trips planned for this date.'}
                </div></td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td whitespace-nowrap">{fmtD(r.lifting_date)}</td>
                  <td className="table-td whitespace-nowrap">{fmtD(r.ack_date)}</td>
                  <td className="table-td whitespace-nowrap">{fmtD(r.posting_date)}</td>
                  <td className="table-td font-mono font-semibold text-[#005ba3] whitespace-nowrap">{r.tanker_number || '—'}</td>
                  <td className="table-td whitespace-nowrap">{r.route_name || '—'}</td>
                  <td className="table-td whitespace-nowrap">{r.starting_point || '—'}</td>
                  <td className="table-td whitespace-nowrap">{r.unloading_point || '—'}</td>
                  <td className="table-td whitespace-nowrap font-mono text-[11px] text-gray-600">{r.entered_by || '—'}</td>
                  {GROUPS.map(g => g.measures.map(([m], mi) => {
                    const key = `${g.prefix}_${m}`;
                    const fmt = m === 'litres' ? n2 : n4;
                    return g.diff
                      ? <DiffCell key={key} value={r[key]} fmt={fmt}/>
                      : <td key={key} className={`table-td text-right ${mi === 0 ? 'border-l border-gray-100' : ''}`}>{fmt(r[key])}</td>;
                  }))}
                  <td className="table-td border-l text-[11px] text-gray-600" style={{ minWidth: 220, maxWidth: 340, whiteSpace: 'normal' }}>
                    {r.rmrd_adjust_note || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-blue-50 border-t font-semibold sticky bottom-0">
                <tr>
                  <td className="table-td" colSpan={8}>TOTAL — {rows.length} trips</td>
                  {GROUPS.map(g => g.measures.map(([m], mi) => {
                    const total = tsTotal(`${g.prefix}_${m}`, sum);
                    const fmt = m === 'litres' ? n2 : n4;
                    return (
                      <td key={g.prefix + m}
                        className={`table-td text-right ${g.diff ? (total < 0 ? 'text-red-600' : 'text-green-700') : 'text-[#003a6b]'} ${mi === 0 ? 'border-l' : ''}`}>
                        {total == null ? '—' : fmt(total)}
                      </td>
                    );
                  }))}
                  <td className="table-td border-l"/>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
