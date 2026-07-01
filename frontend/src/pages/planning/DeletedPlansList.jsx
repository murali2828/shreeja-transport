// frontend/src/pages/planning/DeletedPlansList.jsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { getPlans } from '../../api/index';

export default function DeletedPlansList() {
  const [dateFilter, setDateFilter] = useState('');

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans-deleted', dateFilter],
    queryFn:  () => getPlans({ plan_for_date: dateFilter || undefined, status: 'deleted' }).then(r => r.data)
  });

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <AlertTriangle size={18} className="text-amber-500"/>
            Deleted Plans
          </h2>
          <p className="text-xs text-gray-500">Reference only — excluded from all reports, KM calculations and cost summaries</p>
        </div>
      </div>

      <div className="card p-3 flex gap-3 items-center">
        <div>
          <label className="text-xs text-gray-500 block mb-0.5">Plan For Date</label>
          <input type="date" className="input py-1.5 text-sm" value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}/>
        </div>
        {plans.length > 0 && (
          <div className="ml-auto text-xs text-gray-400">{plans.length} deleted plan(s)</div>
        )}
      </div>

      <div className="card overflow-hidden opacity-75">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="table-th w-10">Trip</th>
                <th className="table-th">Plan For Date</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Route</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Shift</th>
                <th className="table-th">Driver</th>
                <th className="table-th text-right">Qty (L)</th>
                <th className="table-th text-right">KM</th>
                <th className="table-th text-right">Cost</th>
                <th className="table-th text-center">Util%</th>
                <th className="table-th">Was Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={12} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && plans.length === 0 && (
                <tr><td colSpan={12} className="table-td text-center py-10 text-gray-400">
                  No deleted plans{dateFilter ? ' for this date' : ''}.
                </td></tr>
              )}
              {plans.map(p => (
                <tr key={p.id} className="border-b border-gray-50 bg-gray-50/50">
                  <td className="table-td font-bold text-gray-400">#{p.trip_no}</td>
                  <td className="table-td text-gray-500">{p.plan_for_date?.slice(0,10)}</td>
                  <td className="table-td font-mono text-xs text-gray-500">{p.tanker_number}</td>
                  <td className="table-td text-xs text-gray-500">{p.route_name || '—'}</td>
                  <td className="table-td text-xs text-gray-500">{p.delivery_point_name || '—'}</td>
                  <td className="table-td text-gray-500">{p.shifts_milk || '—'}</td>
                  <td className="table-td text-xs text-gray-500">{p.driver_name || '—'}</td>
                  <td className="table-td text-right text-gray-500">{parseFloat(p.expected_total_qty||0).toLocaleString()}</td>
                  <td className="table-td text-right text-gray-500">{p.expected_km || '—'}</td>
                  <td className="table-td text-right text-gray-400">₹{parseFloat(p.total_cost||0).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                  <td className="table-td text-center text-xs text-gray-400">
                    {parseFloat(p.expected_utilization_pct||0).toFixed(0)}%
                  </td>
                  <td className="table-td">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-500">deleted</span>
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
