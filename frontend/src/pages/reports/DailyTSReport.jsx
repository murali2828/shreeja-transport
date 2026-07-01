// frontend/src/pages/reports/DailyTSReport.jsx
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Download, Mail, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { getDailyTSReport, downloadTSExcel, sendDailyReport } from '../../api/index';

function VarCell({ value }) {
  const v = parseFloat(value);
  if (isNaN(v)) return <td className="table-td text-right">—</td>;
  return (
    <td className={`table-td text-right font-medium ${v > 0 ? 'text-green-600' : v < 0 ? 'text-red-600' : 'text-gray-400'}`}>
      {v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2)}
    </td>
  );
}

function ShiftDetailRow({ shiftRows }) {
  if (!shiftRows || shiftRows.length === 0) {
    return (
      <tr>
        <td colSpan={25} style={{ padding: 0, background: '#f8fafc' }}>
          <div style={{ padding: '4px 36px 6px', fontSize: 11, color: '#aaa' }}>No RMRD shift data</div>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={25} style={{ padding: 0, background: '#f0f9ff' }}>
        <div style={{ padding: '4px 36px 8px' }}>
          <table style={{ width: 'auto', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ color: '#0369a1', borderBottom: '1px solid #bae6fd' }}>
                <th style={{ padding: '2px 12px 2px 0', fontWeight: 600, textAlign: 'left' }}>BMCU</th>
                <th style={{ padding: '2px 12px 2px 0', fontWeight: 600, textAlign: 'left' }}>Milk Date</th>
                <th style={{ padding: '2px 12px 2px 0', fontWeight: 600, textAlign: 'left' }}>Shift</th>
                <th style={{ padding: '2px 12px 2px 0', fontWeight: 600, textAlign: 'right' }}>RMRD Qty (L)</th>
                <th style={{ padding: '2px 12px 2px 0', fontWeight: 600, textAlign: 'right' }}>RMRD Fat%</th>
                <th style={{ padding: '2px 0 2px 0',   fontWeight: 600, textAlign: 'right' }}>RMRD SNF%</th>
              </tr>
            </thead>
            <tbody>
              {shiftRows.map((sr, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #e0f2fe' }}>
                  <td style={{ padding: '2px 12px 2px 0', color: '#0c4a6e', fontWeight: 500 }}>
                    {sr.bmcu_code} — {sr.bmcu_name}
                  </td>
                  <td style={{ padding: '2px 12px 2px 0' }}>
                    {sr.milk_date ? String(sr.milk_date).slice(0, 10) : '—'}
                  </td>
                  <td style={{ padding: '2px 12px 2px 0' }}>
                    <span style={{
                      display: 'inline-block', padding: '0 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                      background: sr.shift === 'AM' ? '#fef3c7' : '#ede9fe',
                      color: sr.shift === 'AM' ? '#92400e' : '#5b21b6'
                    }}>{sr.shift || '—'}</span>
                  </td>
                  <td style={{ padding: '2px 12px 2px 0', textAlign: 'right', fontWeight: 500 }}>
                    {sr.rmrd_qty != null ? parseFloat(sr.rmrd_qty).toFixed(0) : '—'}
                  </td>
                  <td style={{ padding: '2px 12px 2px 0', textAlign: 'right' }}>
                    {sr.rmrd_fat_pct != null ? parseFloat(sr.rmrd_fat_pct).toFixed(3) : '—'}
                  </td>
                  <td style={{ padding: '2px 0 2px 0', textAlign: 'right' }}>
                    {sr.rmrd_snf_pct != null ? parseFloat(sr.rmrd_snf_pct).toFixed(3) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  );
}

export default function DailyTSReport() {
  const today = new Date().toISOString().slice(0,10);
  const [from, setFrom] = useState(today);
  const [to,   setTo]   = useState(today);
  const [expanded, setExpanded] = useState({});

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['daily-ts', from, to],
    queryFn:  () => getDailyTSReport({ from_date: from, to_date: to }).then(r => r.data),
    enabled:  false,
  });

  const emailMut = useMutation({
    mutationFn: () => sendDailyReport(from),
    onSuccess: (r) => toast.success(`Email sent to ${r.data.recipients} recipient(s)`),
    onError: (e)   => toast.error(e.response?.data?.error || 'Email failed'),
  });

  const tot = (field) => rows.reduce((s,r) => s + parseFloat(r[field]||0), 0);
  const toggleRow = (i) => setExpanded(prev => ({ ...prev, [i]: !prev[i] }));

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="page-title">Daily TS Variation Report</h2>
        <div className="flex flex-wrap gap-2 items-center">
          <input type="date" className="input py-1.5 text-sm" value={from}
            onChange={e => setFrom(e.target.value)}/>
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" className="input py-1.5 text-sm" value={to}
            onChange={e => setTo(e.target.value)}/>
          <button onClick={() => refetch()} className="btn-primary flex items-center gap-1.5">
            {isLoading ? <RefreshCw size={14} className="animate-spin"/> : null}
            Load Report
          </button>
          <button onClick={() => downloadTSExcel(from)} className="btn-secondary flex items-center gap-1.5">
            <Download size={14}/> Excel
          </button>
          <button onClick={() => emailMut.mutate()} disabled={emailMut.isPending}
            className="btn-secondary flex items-center gap-1.5">
            {emailMut.isPending ? <RefreshCw size={14} className="animate-spin"/> : <Mail size={14}/>}
            Email
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          {[
            { label:'Total Trips',  value: rows.length },
            { label:'DPS Litres',   value: tot('dps_litres').toFixed(0) },
            { label:'Milk Litres',  value: tot('ts_litres').toFixed(0) },
            { label:'Ack Litres',   value: tot('ack_litres').toFixed(0) },
          ].map(s => (
            <div key={s.label} className="card p-3">
              <div className="text-xs text-gray-500">{s.label}</div>
              <div className="text-xl font-bold mt-0.5">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs" style={{ color: 'rgba(255,255,255,0.65)' }}>
        Click any trip row to expand RMRD shift detail
      </p>

      <div className="card overflow-hidden">
        <div className="overflow-x-scroll" style={{ scrollbarColor: '#93c5fd #e5e7eb' }}>
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b sticky top-0">
              <tr>
                <th className="table-th w-6"></th>
                <th className="table-th">Date</th>
                <th className="table-th">Trip</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Route</th>
                <th className="table-th">DC No</th>
                <th className="table-th">Temp</th>
                {/* DPS */}
                <th className="table-th text-right bg-blue-50">DPS L</th>
                <th className="table-th text-right bg-blue-50">DPS Kg</th>
                {/* TS */}
                <th className="table-th text-right bg-amber-50">Milk L</th>
                <th className="table-th text-right bg-amber-50">Milk KG</th>
                <th className="table-th text-right bg-amber-50">Fat%</th>
                <th className="table-th text-right bg-amber-50">SNF%</th>
                <th className="table-th text-right bg-amber-50">Kg Fat</th>
                <th className="table-th text-right bg-amber-50">Kg SNF</th>
                <th className="table-th text-right bg-amber-50">Total TS</th>
                {/* Ack */}
                <th className="table-th text-right bg-green-50">Ack L</th>
                <th className="table-th text-right bg-green-50">Ack Kg</th>
                <th className="table-th text-right bg-green-50">Ack KgF</th>
                <th className="table-th text-right bg-green-50">Ack KgS</th>
                <th className="table-th text-right bg-green-50">Total ACK TS</th>
                {/* Var */}
                <th className="table-th text-right bg-red-50">Var L</th>
                <th className="table-th text-right bg-red-50">Var Kg</th>
                <th className="table-th text-right bg-red-50">Var KgF</th>
                <th className="table-th text-right bg-red-50">Var KgS</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={25} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={25} className="table-td text-center py-10 text-gray-400">
                  No closed trips in this range. Click Load Report after selecting dates.
                </td></tr>
              )}
              {rows.map((r, i) => (
                <>
                  <tr key={i} className="hover:bg-gray-50 border-b border-gray-50 cursor-pointer"
                    onClick={() => toggleRow(i)}>
                    <td className="table-td text-center text-gray-400">
                      {expanded[i] ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                    </td>
                    <td className="table-td">{r.execution_date?.slice(0,10)}</td>
                    <td className="table-td font-bold text-[#0078d4]">#{r.trip_no}</td>
                    <td className="table-td font-mono">{r.tanker_number}</td>
                    <td className="table-td">{r.route_name || '—'}</td>
                    <td className="table-td">{r.dc_number || '—'}</td>
                    <td className="table-td">{r.temperature || '—'}</td>
                    {/* DPS */}
                    <td className="table-td text-right bg-blue-50">{parseFloat(r.dps_litres||0).toFixed(0)}</td>
                    <td className="table-td text-right bg-blue-50">{parseFloat(r.dps_kgs||0).toFixed(2)}</td>
                    {/* TS */}
                    <td className="table-td text-right bg-amber-50">{parseFloat(r.ts_litres||0).toFixed(0)}</td>
                    <td className="table-td text-right bg-amber-50">{parseFloat(r.ts_kgs||0).toFixed(2)}</td>
                    <td className="table-td text-right bg-amber-50">{parseFloat(r.ts_fat||0).toFixed(3)}</td>
                    <td className="table-td text-right bg-amber-50">{parseFloat(r.ts_snf||0).toFixed(3)}</td>
                    <td className="table-td text-right bg-amber-50">{parseFloat(r.ts_kg_fat||0).toFixed(2)}</td>
                    <td className="table-td text-right bg-amber-50">{parseFloat(r.ts_kg_snf||0).toFixed(2)}</td>
                    <td className="table-td text-right bg-amber-50 font-medium">{(parseFloat(r.ts_kg_fat||0) + parseFloat(r.ts_kg_snf||0)).toFixed(2)}</td>
                    {/* Ack */}
                    <td className="table-td text-right bg-green-50">{parseFloat(r.ack_litres||0).toFixed(0)}</td>
                    <td className="table-td text-right bg-green-50">{parseFloat(r.ack_kgs||0).toFixed(2)}</td>
                    <td className="table-td text-right bg-green-50">{parseFloat(r.ack_kg_fat||0).toFixed(2)}</td>
                    <td className="table-td text-right bg-green-50">{parseFloat(r.ack_kg_snf||0).toFixed(2)}</td>
                    <td className="table-td text-right bg-green-50 font-medium">{(parseFloat(r.ack_kg_fat||0) + parseFloat(r.ack_kg_snf||0)).toFixed(2)}</td>
                    {/* Var */}
                    <VarCell value={r.var_litres}/>
                    <VarCell value={r.var_kgs}/>
                    <VarCell value={r.var_kg_fat}/>
                    <VarCell value={r.var_kg_snf}/>
                  </tr>
                  {expanded[i] && <ShiftDetailRow key={`shift-${i}`} shiftRows={r.shift_rows}/>}
                </>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
