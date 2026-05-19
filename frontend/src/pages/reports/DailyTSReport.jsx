import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getDailyTSReport, sendDailyReport, downloadTSExcel } from '../../api';
import toast from 'react-hot-toast';
import { format, subDays } from 'date-fns';
import { Download, Send, BarChart3 } from 'lucide-react';

function n(v, d = 2) { return v != null ? parseFloat(v).toFixed(d) : '—'; }

export default function DailyTSReport() {
  const [from, setFrom] = useState(format(subDays(new Date(), 1), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [reportDate, setReportDate] = useState(format(subDays(new Date(), 1), 'yyyy-MM-dd'));

  const { data: rows = [], isLoading, refetch } = useQuery({
    queryKey: ['ts-report', from, to],
    queryFn: () => getDailyTSReport({ from_date: from, to_date: to }).then(r => r.data),
    enabled: false
  });

  const sendMut = useMutation({
    mutationFn: () => sendDailyReport(reportDate),
    onSuccess: (r) => toast.success(`Report sent to ${r.data.sent_to} recipients`),
    onError: (e) => toast.error(e.response?.data?.error || 'Send failed')
  });

  const handleDownload = async () => {
    try {
      const r = await downloadTSExcel(reportDate);
      const url = window.URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a'); a.href = url; a.download = `TS_Report_${reportDate}.xlsx`; a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) { toast.error('Download failed'); }
  };

  const totals = rows.reduce((s, r) => ({
    truck_qty: s.truck_qty + parseFloat(r.truck_qty_litres || 0),
    ack_qty: s.ack_qty + parseFloat(r.ack_qty_ltrs || 0),
    truck_kg_fat: s.truck_kg_fat + parseFloat(r.truck_kg_fat || 0),
    ack_kg_fat: s.ack_kg_fat + parseFloat(r.ack_kg_fat || 0),
    truck_kg_snf: s.truck_kg_snf + parseFloat(r.truck_kg_snf || 0),
    ack_kg_snf: s.ack_kg_snf + parseFloat(r.ack_kg_snf || 0),
  }), { truck_qty: 0, ack_qty: 0, truck_kg_fat: 0, ack_kg_fat: 0, truck_kg_snf: 0, ack_kg_snf: 0 });

  return (
    <div className="space-y-4 max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Daily TS Report</h2>
          <p className="text-xs text-gray-500">Daily Milk Procurement Total Solid Variation Report</p>
        </div>
      </div>

      <div className="card p-4 space-y-4">
        <div className="grid grid-cols-4 gap-4 items-end">
          <div>
            <label className="label">From Date</label>
            <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="label">To Date</label>
            <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
          <div>
            <button onClick={() => refetch()} className="btn-primary w-full">
              <BarChart3 size={14} /> Generate Report
            </button>
          </div>
          <div className="text-xs text-gray-500 pb-1">{rows.length > 0 ? `${rows.length} trips found` : ''}</div>
        </div>

        <div className="border-t pt-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Send Daily Report by Email</h3>
          <div className="flex gap-3 items-end">
            <div>
              <label className="label">Report Date</label>
              <input className="input" type="date" value={reportDate} onChange={e => setReportDate(e.target.value)} />
            </div>
            <button onClick={handleDownload} className="btn-secondary">
              <Download size={14} /> Download Excel
            </button>
            <button onClick={() => { if (confirm(`Send TS Report for ${reportDate} to all configured recipients?`)) sendMut.mutate(); }}
              className="btn-primary" disabled={sendMut.isPending}>
              <Send size={14} /> {sendMut.isPending ? 'Sending…' : 'Send by Email'}
            </button>
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <>
          {/* Summary Cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="card p-3">
              <div className="text-xs text-gray-500">Total Trips</div>
              <div className="text-2xl font-bold text-brand-700">{rows.length}</div>
            </div>
            <div className="card p-3">
              <div className="text-xs text-gray-500">Total Truck Qty (L)</div>
              <div className="text-2xl font-bold text-brand-700">{totals.truck_qty.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
            <div className="card p-3">
              <div className="text-xs text-gray-500">Total Ack Qty (L)</div>
              <div className="text-2xl font-bold text-green-700">{totals.ack_qty.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
          </div>

          {/* Main Table */}
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="table-th">S.No</th>
                    <th className="table-th">Started From</th>
                    <th className="table-th">Receiver</th>
                    <th className="table-th">Milk Lifting Date</th>
                    <th className="table-th">Ack Date</th>
                    <th className="table-th">Tanker No.</th>
                    <th className="table-th">Route</th>
                    <th className="table-th">Temp.</th>
                    {/* Scale / DPS */}
                    <th className="table-th bg-blue-50">DPS Ltrs</th>
                    <th className="table-th bg-blue-50">DPS Kgs</th>
                    {/* Truck sheet */}
                    <th className="table-th bg-amber-50">Truck Ltrs</th>
                    <th className="table-th bg-amber-50">Truck Kgs</th>
                    <th className="table-th bg-amber-50">Fat%</th>
                    <th className="table-th bg-amber-50">SNF%</th>
                    <th className="table-th bg-amber-50">Kg Fat</th>
                    <th className="table-th bg-amber-50">Kg SNF</th>
                    {/* Dairy Ack */}
                    <th className="table-th bg-green-50">Ack Ltrs</th>
                    <th className="table-th bg-green-50">Ack Kgs</th>
                    <th className="table-th bg-green-50">Ack Fat%</th>
                    <th className="table-th bg-green-50">Ack SNF%</th>
                    <th className="table-th bg-green-50">Ack Kg Fat</th>
                    <th className="table-th bg-green-50">Ack Kg SNF</th>
                    {/* Variation */}
                    <th className="table-th bg-red-50">Qty Var</th>
                    <th className="table-th bg-red-50">KgFat±</th>
                    <th className="table-th bg-red-50">KgSNF±</th>
                    <th className="table-th bg-red-50">TS±</th>
                    {/* Tanker */}
                    <th className="table-th">Tanker Qty</th>
                    <th className="table-th">Util%</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const qtyVar = parseFloat(r.ack_qty_ltrs || 0) - parseFloat(r.truck_qty_litres || 0);
                    const kgFatVar = parseFloat(r.ack_kg_fat || 0) - parseFloat(r.truck_kg_fat || 0);
                    const kgSnfVar = parseFloat(r.ack_kg_snf || 0) - parseFloat(r.truck_kg_snf || 0);
                    return (
                      <tr key={r.execution_id} className="hover:bg-gray-50">
                        <td className="table-td">{i + 1}</td>
                        <td className="table-td">{r.started_from || '—'}</td>
                        <td className="table-td">{r.receiver || '—'}</td>
                        <td className="table-td">{r.milk_lifting_date?.slice(0,10)}</td>
                        <td className="table-td">{r.execution_date?.slice(0,10)}</td>
                        <td className="table-td font-mono">{r.tanker_number}</td>
                        <td className="table-td font-medium">{r.route_name}</td>
                        <td className="table-td">{r.temperature || '—'}</td>
                        <td className="table-td bg-blue-50">{n(r.dps_qty_litres, 2)}</td>
                        <td className="table-td bg-blue-50">{n(r.dps_qty_kgs, 4)}</td>
                        <td className="table-td bg-amber-50">{n(r.truck_qty_litres, 2)}</td>
                        <td className="table-td bg-amber-50">{n(r.truck_qty_kgs, 4)}</td>
                        <td className="table-td bg-amber-50">{n(r.truck_fat, 4)}</td>
                        <td className="table-td bg-amber-50">{n(r.truck_snf, 4)}</td>
                        <td className="table-td bg-amber-50">{n(r.truck_kg_fat, 4)}</td>
                        <td className="table-td bg-amber-50">{n(r.truck_kg_snf, 4)}</td>
                        <td className="table-td bg-green-50">{n(r.ack_qty_ltrs, 2)}</td>
                        <td className="table-td bg-green-50">{n(r.ack_qty_kgs, 4)}</td>
                        <td className="table-td bg-green-50">{n(r.ack_fat, 4)}</td>
                        <td className="table-td bg-green-50">{n(r.ack_snf, 4)}</td>
                        <td className="table-td bg-green-50">{n(r.ack_kg_fat, 4)}</td>
                        <td className="table-td bg-green-50">{n(r.ack_kg_snf, 4)}</td>
                        <td className={`table-td ${qtyVar < 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{qtyVar > 0 ? '+' : ''}{n(qtyVar, 2)}</td>
                        <td className={`table-td ${kgFatVar < 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{kgFatVar > 0 ? '+' : ''}{n(kgFatVar, 4)}</td>
                        <td className={`table-td ${kgSnfVar < 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>{kgSnfVar > 0 ? '+' : ''}{n(kgSnfVar, 4)}</td>
                        <td className="table-td">{n(kgFatVar + kgSnfVar, 4)}</td>
                        <td className="table-td">{r.tanker_qty?.toLocaleString()}</td>
                        <td className="table-td">{n(r.utilization_pct, 2)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-100 font-bold text-xs">
                    <td colSpan={10} className="table-td text-right">TOTALS</td>
                    <td className="table-td">{totals.truck_qty.toFixed(0)}</td>
                    <td colSpan={3}></td>
                    <td className="table-td">{totals.truck_kg_fat.toFixed(4)}</td>
                    <td className="table-td">{totals.truck_kg_snf.toFixed(4)}</td>
                    <td className="table-td">{totals.ack_qty.toFixed(0)}</td>
                    <td colSpan={3}></td>
                    <td className="table-td">{totals.ack_kg_fat.toFixed(4)}</td>
                    <td className="table-td">{totals.ack_kg_snf.toFixed(4)}</td>
                    <td className="table-td">{(totals.ack_qty - totals.truck_qty).toFixed(0)}</td>
                    <td className="table-td">{(totals.ack_kg_fat - totals.truck_kg_fat).toFixed(4)}</td>
                    <td className="table-td">{(totals.ack_kg_snf - totals.truck_kg_snf).toFixed(4)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="card p-8 text-center text-gray-400">
          <BarChart3 size={40} className="mx-auto mb-3 opacity-30" />
          <p>Click "Generate Report" to view the TS report for the selected date range.</p>
          <p className="text-xs mt-1">Only closed trips (with acknowledgements) are included.</p>
        </div>
      )}
    </div>
  );
}
