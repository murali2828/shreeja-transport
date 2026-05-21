// frontend/src/pages/execution/ExecutionList.jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Eye, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPlans, getExecutions, createExecution } from '../../api/index';

export default function ExecutionList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));

  const { data: plans = [], isLoading: loadingPlans } = useQuery({
    queryKey: ['plans', date, 'published'],
    queryFn:  () => getPlans({ plan_for_date: date, status: 'published' }).then(r => r.data)
  });

  const { data: execs = [] } = useQuery({
    queryKey: ['executions', date],
    queryFn:  () => getExecutions({ execution_date: date }).then(r => r.data)
  });

  const startMut = useMutation({
    mutationFn: (planId) => createExecution({ trip_plan_id: planId, execution_date: date }),
    onSuccess: (res) => {
      toast.success('Execution started');
      qc.invalidateQueries(['executions']);
      navigate(`/execution/${res.data.id}`);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to start'),
  });

  const statusBadge = (s) => ({
    in_progress: 'bg-blue-100 text-blue-700',
    saved:       'bg-amber-100 text-amber-700',
    pending_ack: 'bg-purple-100 text-purple-700',
    closed:      'bg-green-100 text-green-700',
  })[s] || 'bg-gray-100 text-gray-500';

  const execMap = Object.fromEntries(execs.map(e => [e.trip_plan_id, e]));

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="page-title">Active Trips</h2>
        <input type="date" className="input py-1.5 text-sm" value={date}
          onChange={e => setDate(e.target.value)}/>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="table-th">Trip</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Shift</th>
                <th className="table-th">Driver</th>
                <th className="table-th text-right">Exp Qty (L)</th>
                <th className="table-th text-right">KM</th>
                <th className="table-th">Execution Status</th>
                <th className="table-th w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {loadingPlans && (
                <tr><td colSpan={9} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!loadingPlans && plans.length === 0 && (
                <tr><td colSpan={9} className="table-td text-center py-10 text-gray-400">
                  No published plans for {date}
                </td></tr>
              )}
              {plans.map(p => {
                const exec = execMap[p.id];
                return (
                  <tr key={p.id} className="hover:bg-gray-50 border-b border-gray-50">
                    <td className="table-td font-bold text-[#0078d4]">#{p.trip_no}</td>
                    <td className="table-td font-mono text-xs">{p.tanker_number}</td>
                    <td className="table-td text-xs">{p.delivery_point_name || '—'}</td>
                    <td className="table-td">{p.shifts_milk || '—'}</td>
                    <td className="table-td text-xs">{p.driver_name || '—'}</td>
                    <td className="table-td text-right">{parseFloat(p.expected_total_qty||0).toLocaleString()}</td>
                    <td className="table-td text-right">{p.expected_km || '—'}</td>
                    <td className="table-td">
                      {exec ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(exec.status)}`}>
                          {exec.status.replace('_',' ')}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">Not started</span>
                      )}
                    </td>
                    <td className="table-td">
                      {exec ? (
                        <button onClick={() => navigate(`/execution/${exec.id}`)}
                          className="btn-secondary btn-sm flex items-center gap-1">
                          <Eye size={12}/> View
                        </button>
                      ) : (
                        <button onClick={() => startMut.mutate(p.id)}
                          disabled={startMut.isPending}
                          className="btn-primary btn-sm flex items-center gap-1">
                          {startMut.isPending ? <RefreshCw size={12} className="animate-spin"/> : <Play size={12}/>}
                          Start
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
