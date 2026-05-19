import { useQuery } from '@tanstack/react-query';
import { getPlans, getExecutions } from '../api';
import { Truck, ClipboardList, PlayCircle, CheckCircle, Archive } from 'lucide-react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

function StatCard({ icon: Icon, label, value, color, onClick }) {
  return (
    <button onClick={onClick}
      className={`card p-4 flex items-center gap-4 hover:shadow-md transition-shadow text-left w-full ${onClick ? 'cursor-pointer' : ''}`}>
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div>
        <div className="text-2xl font-bold text-gray-800">{value ?? '—'}</div>
        <div className="text-xs text-gray-500">{label}</div>
      </div>
    </button>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const today = format(new Date(), 'yyyy-MM-dd');

  const { data: todayPlans } = useQuery({
    queryKey: ['plans', today],
    queryFn: () => getPlans({ plan_for_date: today }).then(r => r.data)
  });
  const { data: activeExecs } = useQuery({
    queryKey: ['executions', 'active'],
    queryFn: () => getExecutions({ status: 'saved' }).then(r => r.data)
  });
  const { data: pendingAck } = useQuery({
    queryKey: ['executions', 'pending_ack'],
    queryFn: () => getExecutions({ status: 'pending_ack' }).then(r => r.data)
  });
  const { data: inProgress } = useQuery({
    queryKey: ['executions', 'in_progress'],
    queryFn: () => getExecutions({ status: 'in_progress' }).then(r => r.data)
  });

  const allActive = [...(inProgress || []), ...(activeExecs || [])];

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h2 className="text-xl font-semibold text-gray-800">Dashboard</h2>
        <p className="text-sm text-gray-500">Welcome back, {user?.full_name} · {format(new Date(), 'dd MMM yyyy')}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={ClipboardList} label={`Plans for Today (${format(new Date(),'dd MMM')})`}
          value={todayPlans?.length} color="bg-brand-600"
          onClick={() => navigate(`/planning?date=${today}`)} />
        <StatCard icon={PlayCircle} label="Active Trips (In Progress)"
          value={allActive.length} color="bg-amber-500"
          onClick={() => navigate('/execution')} />
        <StatCard icon={CheckCircle} label="Pending Acknowledgement"
          value={pendingAck?.length} color="bg-purple-600"
          onClick={() => navigate('/execution')} />
        <StatCard icon={Archive} label="Completed Today"
          value={undefined} color="bg-green-600"
          onClick={() => navigate('/execution/closed')} />
      </div>

      {todayPlans && todayPlans.length > 0 && (
        <div className="card">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="font-semibold text-gray-700">Today's Trip Plans ({format(new Date(),'dd MMM yyyy')})</h3>
            <button onClick={() => navigate('/planning')} className="text-xs text-brand-600 hover:underline">View all</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-th">Trip#</th>
                  <th className="table-th">Route</th>
                  <th className="table-th">Tanker</th>
                  <th className="table-th">Delivery Point</th>
                  <th className="table-th">Exp. Qty (L)</th>
                  <th className="table-th">Status</th>
                </tr>
              </thead>
              <tbody>
                {todayPlans.slice(0,10).map(p => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="table-td font-medium">{p.trip_no}</td>
                    <td className="table-td">{p.route_name || '—'}</td>
                    <td className="table-td">{p.tanker_number || '—'}</td>
                    <td className="table-td">{p.delivery_point_name || '—'}</td>
                    <td className="table-td">{p.expected_total_qty?.toLocaleString() || '—'}</td>
                    <td className="table-td">
                      <span className={`badge ${p.status === 'published' ? 'badge-green' : p.status === 'cancelled' ? 'badge-red' : 'badge-yellow'}`}>
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pendingAck && pendingAck.length > 0 && (
        <div className="card">
          <div className="px-4 py-3 border-b border-gray-100">
            <h3 className="font-semibold text-gray-700 text-amber-700">⚠ Pending Acknowledgements ({pendingAck.length})</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="table-th">Tanker</th>
                  <th className="table-th">Route</th>
                  <th className="table-th">Execution Date</th>
                  <th className="table-th">Qty (L)</th>
                  <th className="table-th">Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingAck.map(e => (
                  <tr key={e.id} className="hover:bg-gray-50">
                    <td className="table-td font-medium">{e.tanker_number}</td>
                    <td className="table-td">{e.route_name}</td>
                    <td className="table-td">{e.execution_date?.slice(0,10)}</td>
                    <td className="table-td">{parseFloat(e.total_qty_litres || 0).toLocaleString()}</td>
                    <td className="table-td">
                      <button onClick={() => navigate(`/execution/${e.id}/acknowledge`)}
                        className="btn-primary btn-sm">Enter Acknowledgement</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
