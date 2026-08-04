// frontend/src/pages/execution/ClosedTrips.jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { getExecutions } from '../../api/index';

export default function ClosedTrips() {
  const today = new Date().toISOString().slice(0,10);
  const [searchParams] = useSearchParams();
  const urlDate = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') || '') ? searchParams.get('date') : null;
  const [from, setFrom] = useState(urlDate || today);
  const [to,   setTo]   = useState(urlDate || today);
  const navigate = useNavigate();

  const { data: execs = [], isLoading } = useQuery({
    queryKey: ['executions', 'closed', from, to],
    queryFn:  () => getExecutions({ status: 'closed', from_date: from, to_date: to }).then(r => r.data)
  });

  const totalLitres = execs.reduce((s,e) => s + parseFloat(e.total_qty_litres||0), 0);
  const totalKgs    = execs.reduce((s,e) => s + parseFloat(e.total_qty_kgs||0), 0);

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="page-title">Closed Trips</h2>
        <div className="flex gap-2 items-center">
          <input type="date" className="input py-1.5 text-sm" value={from}
            onChange={e => setFrom(e.target.value)}/>
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" className="input py-1.5 text-sm" value={to}
            onChange={e => setTo(e.target.value)}/>
        </div>
      </div>

      {execs.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label:'Total Trips',  value: execs.length },
            { label:'Total Litres', value: totalLitres.toLocaleString() },
            { label:'Total Kgs',    value: totalKgs.toFixed(0) },
          ].map(s => (
            <div key={s.label} className="card p-3 text-center">
              <div className="text-xl font-bold text-gray-800">{s.value}</div>
              <div className="page-sub">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="table-th">Date</th>
                <th className="table-th">Trip</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">DC No</th>
                <th className="table-th text-right">Actual KM</th>
                <th className="table-th text-right">TS Litres</th>
                <th className="table-th text-right">TS Kgs</th>
                <th className="table-th text-right">Avg Fat%</th>
                <th className="table-th text-right">Avg SNF%</th>
                <th className="table-th">Entered By</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={11} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && execs.length === 0 && (
                <tr><td colSpan={11} className="table-td text-center py-10 text-gray-400">
                  No closed trips in this date range
                </td></tr>
              )}
              {execs.map(e => (
                <tr key={e.id}
                  className="hover:bg-blue-50 border-b border-gray-50 cursor-pointer"
                  onClick={() => navigate(`/execution/${e.id}`)}>
                  <td className="table-td">{e.execution_date?.slice(0,10)}</td>
                  <td className="table-td font-bold text-[#0078d4]">#{e.trip_no}</td>
                  <td className="table-td font-mono text-xs">{e.tanker_number}</td>
                  <td className="table-td text-xs">{e.delivery_point_name || '—'}</td>
                  <td className="table-td text-xs">{e.dc_number || '—'}</td>
                  <td className="table-td text-right">{e.actual_km || '—'}</td>
                  <td className="table-td text-right">{parseFloat(e.total_qty_litres||0).toLocaleString()}</td>
                  <td className="table-td text-right">{parseFloat(e.total_qty_kgs||0).toFixed(2)}</td>
                  <td className="table-td text-right">{parseFloat(e.avg_fat||0).toFixed(3)}</td>
                  <td className="table-td text-right">{parseFloat(e.avg_snf||0).toFixed(3)}</td>
                  <td className="table-td font-mono text-[11px] text-gray-600">{e.entered_by_user_id || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

