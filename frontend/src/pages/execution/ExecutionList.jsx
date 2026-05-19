import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPlans, getExecutions, createExecution } from '../../api';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { PlayCircle, Eye, CheckCircle } from 'lucide-react';

const STATUS_BADGE = {
  in_progress: 'badge-yellow',
  saved: 'badge-blue',
  pending_ack: 'badge-red',
  closed: 'badge-green'
};
const STATUS_LABEL = {
  in_progress: 'In Progress',
  saved: 'Saved',
  pending_ack: 'Pending Ack.',
  closed: 'Closed'
};

export default function ExecutionList() {
  const [date, setDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: plans = [] } = useQuery({
    queryKey: ['plans', date],
    queryFn: () => getPlans({ plan_for_date: date, status: 'published' }).then(r => r.data)
  });

  const { data: executions = [], isLoading } = useQuery({
    queryKey: ['executions', date],
    queryFn: () => getExecutions({ execution_date: date }).then(r => r.data)
  });

  const startMut = useMutation({
    mutationFn: (planId) => createExecution({ trip_plan_id: planId, execution_date: date }),
    onSuccess: (r) => { toast.success('Trip started'); qc.invalidateQueries(['executions']); navigate(`/execution/${r.data.id}`); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to start trip')
  });

  const execMap = new Map(executions.map(e => [e.trip_plan_id, e]));

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Trip Execution</h2>
          <p className="text-xs text-gray-500">Select a date to view planned trips and start/continue execution</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div>
          <label className="label">Execution Date</label>
          <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="flex gap-4 text-sm text-gray-500 pt-4">
          <span>{plans.length} planned · {executions.filter(e => ['in_progress','saved'].includes(e.status)).length} active · {executions.filter(e => e.status === 'pending_ack').length} pending ack</span>
        </div>
      </div>

      {plans.length === 0 && executions.filter(e => !execMap.has(e.trip_plan_id)).length === 0 && (
        <div className="card p-8 text-center text-gray-400">
          <p className="text-sm">No published trip plans found for {date}.</p>
          <p className="text-xs mt-1">Plans must be published by the planner before execution can begin.</p>
        </div>
      )}

      {plans.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2 bg-brand-50 border-b text-xs font-semibold text-brand-700">
            Published Plans for {date}
          </div>
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-th">Trip#</th>
                <th className="table-th">Route</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Exp. Qty (L)</th>
                <th className="table-th">Driver</th>
                <th className="table-th">Remarks</th>
                <th className="table-th">Exec. Status</th>
                <th className="table-th">Action</th>
              </tr>
            </thead>
            <tbody>
              {plans.map(p => {
                const exec = execMap.get(p.id);
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="table-td font-bold text-brand-700">{p.trip_no}</td>
                    <td className="table-td font-medium">{p.route_name || '—'}</td>
                    <td className="table-td font-mono text-xs">{p.tanker_number || '—'}</td>
                    <td className="table-td text-xs">{p.delivery_point_name || '—'}</td>
                    <td className="table-td">{p.expected_total_qty ? parseFloat(p.expected_total_qty).toLocaleString() : '—'}</td>
                    <td className="table-td text-xs">{p.driver_name || '—'}</td>
                    <td className="table-td text-xs max-w-[150px] truncate" title={p.remarks}>{p.remarks || '—'}</td>
                    <td className="table-td">
                      {exec ? <span className={STATUS_BADGE[exec.status]}>{STATUS_LABEL[exec.status]}</span>
                            : <span className="badge-gray">Not Started</span>}
                    </td>
                    <td className="table-td">
                      {!exec ? (
                        <button onClick={() => startMut.mutate(p.id)} className="btn-primary btn-sm" disabled={startMut.isPending}>
                          <PlayCircle size={12} /> Start
                        </button>
                      ) : exec.status === 'pending_ack' ? (
                        <button onClick={() => navigate(`/execution/${exec.id}/acknowledge`)} className="btn-success btn-sm">
                          <CheckCircle size={12} /> Acknowledge
                        </button>
                      ) : exec.status !== 'closed' ? (
                        <button onClick={() => navigate(`/execution/${exec.id}`)} className="btn-primary btn-sm">
                          <Eye size={12} /> Continue
                        </button>
                      ) : (
                        <button onClick={() => navigate(`/execution/${exec.id}`)} className="btn-secondary btn-sm">
                          <Eye size={12} /> View
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Show active executions not in plans (edge cases) */}
      {executions.filter(e => e.status !== 'closed').length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2 bg-amber-50 border-b text-xs font-semibold text-amber-700">
            Active Executions
          </div>
          <table className="w-full">
            <thead><tr>
              <th className="table-th">Trip#</th><th className="table-th">Tanker</th><th className="table-th">Route</th>
              <th className="table-th">Exec. Date</th><th className="table-th">Qty (L)</th><th className="table-th">Status</th><th className="table-th">Action</th>
            </tr></thead>
            <tbody>
              {executions.filter(e => e.status !== 'closed').map(e => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="table-td font-bold">{e.trip_no}</td>
                  <td className="table-td font-mono text-xs">{e.tanker_number}</td>
                  <td className="table-td">{e.route_name}</td>
                  <td className="table-td">{e.execution_date?.slice(0,10)}</td>
                  <td className="table-td">{parseFloat(e.total_qty_litres || 0).toLocaleString()}</td>
                  <td className="table-td"><span className={STATUS_BADGE[e.status]}>{STATUS_LABEL[e.status]}</span></td>
                  <td className="table-td">
                    {e.status === 'pending_ack' ? (
                      <button onClick={() => navigate(`/execution/${e.id}/acknowledge`)} className="btn-success btn-sm"><CheckCircle size={12}/> Ack</button>
                    ) : (
                      <button onClick={() => navigate(`/execution/${e.id}`)} className="btn-primary btn-sm"><Eye size={12}/> Open</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
