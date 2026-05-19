import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getExecutions, getTankers } from '../../api';
import { useNavigate } from 'react-router-dom';
import { Eye } from 'lucide-react';
import { format, subDays } from 'date-fns';

export default function ClosedTrips() {
  const navigate = useNavigate();
  const [from, setFrom] = useState(format(subDays(new Date(), 7), 'yyyy-MM-dd'));
  const [to, setTo] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [tankerFilter, setTankerFilter] = useState('');

  const { data: executions = [], isLoading } = useQuery({
    queryKey: ['executions-closed', from, to, tankerFilter],
    queryFn: () => getExecutions({ status: 'closed', from_date: from, to_date: to, ...(tankerFilter ? { tanker_id: tankerFilter } : {}) }).then(r => r.data)
  });
  const { data: tankers = [] } = useQuery({ queryKey: ['tankers'], queryFn: () => getTankers().then(r => r.data.filter(t => t.is_active)) });

  return (
    <div className="space-y-4 max-w-6xl">
      <div>
        <h2 className="text-lg font-semibold">Closed Trips</h2>
        <p className="text-xs text-gray-500">View completed trips with acknowledgements</p>
      </div>

      <div className="flex gap-3 flex-wrap items-end">
        <div>
          <label className="label">From Date</label>
          <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label">To Date</label>
          <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div>
          <label className="label">Filter by Tanker</label>
          <select className="input" value={tankerFilter} onChange={e => setTankerFilter(e.target.value)}>
            <option value="">All Tankers</option>
            {tankers.map(t => <option key={t.id} value={t.id}>{t.tanker_number}</option>)}
          </select>
        </div>
        <div className="text-sm text-gray-500 pb-1">{executions.length} trips</div>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-th">Exec. Date</th>
                <th className="table-th">Trip#</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Route</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Total Qty (L)</th>
                <th className="table-th">Total Kgs</th>
                <th className="table-th">Avg Fat%</th>
                <th className="table-th">Avg SNF%</th>
                <th className="table-th">Actual KM</th>
                <th className="table-th">Action</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={11} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              ) : executions.length === 0 ? (
                <tr><td colSpan={11} className="table-td text-center py-8 text-gray-400">No closed trips found for the selected period</td></tr>
              ) : executions.map(e => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="table-td">{e.execution_date?.slice(0,10)}</td>
                  <td className="table-td font-bold text-brand-700">{e.trip_no}</td>
                  <td className="table-td font-mono text-xs">{e.tanker_number}</td>
                  <td className="table-td">{e.route_name}</td>
                  <td className="table-td text-xs">{e.delivery_point_name}</td>
                  <td className="table-td">{parseFloat(e.total_qty_litres || 0).toLocaleString()}</td>
                  <td className="table-td">{parseFloat(e.total_qty_kgs || 0).toFixed(2)}</td>
                  <td className="table-td">{parseFloat(e.avg_fat || 0).toFixed(4)}</td>
                  <td className="table-td">{parseFloat(e.avg_snf || 0).toFixed(4)}</td>
                  <td className="table-td">{e.actual_km || '—'}</td>
                  <td className="table-td">
                    <button onClick={() => navigate(`/execution/${e.id}`)} className="btn-secondary btn-sm"><Eye size={12} /> View</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
