// frontend/src/pages/Dashboard.jsx
// Shreeja Platform Theme: white greeting text, frosted glass cards, sky-blue background
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Truck, ClipboardList, Play, CheckSquare, TrendingUp, Zap, Route } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { getPlans, getExecutions, getDistanceSummary, getTankerPosition } from '../api/index';

// Tanker Position dashboard access: admins + transport incharge/module owner
export const canSeeTankerPosition = (user) =>
  user?.role === 'admin' ||
  ['pp01', 'mahesh.k@shreejamilk.com', 'dceo', 'krithiga.a@shreejamilk.com']
    .includes(String(user?.user_id || '').toLowerCase());

function StatCard({ icon: Icon, label, value, sub, colorClass, onClick }) {
  return (
    <div
      onClick={onClick}
      className={`stat-card ${colorClass} ${onClick ? 'cursor-pointer hover:scale-[1.02] transition-transform' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center">
          <Icon size={18}/>
        </div>
      </div>
      <div className="text-3xl font-bold">{value ?? '—'}</div>
      <div className="text-sm font-medium mt-1 opacity-90">{label}</div>
      {sub && <div className="text-xs opacity-65 mt-0.5">{sub}</div>}
    </div>
  );
}

function QuickAction({ icon: Icon, title, sub, onClick }) {
  return (
    <button
      onClick={onClick}
      className="card card-body text-left group transition-all hover:scale-[1.01]"
      style={{ cursor: 'pointer' }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3"
        style={{ background: 'rgba(0,120,212,0.12)' }}>
        <Icon size={18} style={{ color: '#0078d4' }}/>
      </div>
      <div className="text-sm font-semibold text-gray-800">{title}</div>
      <div className="text-xs text-gray-500 mt-0.5">{sub}</div>
    </button>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const navigate  = useNavigate();
  const today     = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(today);
  const isToday = selectedDate === today;

  const { data: todayPlans = [] } = useQuery({
    queryKey: ['plans', selectedDate],
    queryFn:  () => getPlans({ plan_for_date: selectedDate }).then(r => r.data),
  });

  const { data: activeExecs = [] } = useQuery({
    queryKey: ['executions', selectedDate],
    queryFn:  () => getExecutions({ execution_date: selectedDate }).then(r => r.data),
  });

  const showTankerPos = canSeeTankerPosition(user);
  const { data: tankerPos } = useQuery({
    queryKey: ['tanker-position'],
    queryFn:  () => getTankerPosition().then(r => r.data),
    enabled:  showTankerPos,
    refetchInterval: 60_000,
  });

  const { data: distSummary } = useQuery({
    queryKey: ['distance-summary'],
    queryFn:  () => getDistanceSummary().then(r => r.data),
    enabled:  user?.role !== 'executor',
  });

  const published = todayPlans.filter(p => p.status === 'published').length;
  const drafts    = todayPlans.filter(p => p.status === 'draft').length;
  const inProg    = activeExecs.filter(e => e.status === 'in_progress').length;
  const pendAck   = activeExecs.filter(e => e.status === 'pending_ack').length;
  const closed    = activeExecs.filter(e => e.status === 'closed').length;
  const hour      = new Date().getHours();
  const greet     = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="space-y-6 w-full">

      {/* Hero greeting — white text on sky gradient (matches screenshot) */}
      <div className="py-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-2xl">
            {greet}, {user?.full_name?.split(' ').slice(0, 2).join(' ')}
          </h1>
          <p className="page-sub">
            {new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
          </p>
        </div>
        {/* Date filter — tiles reflect this date */}
        <div className="flex items-center gap-2">
          <input type="date" className="input py-1.5 text-sm" value={selectedDate}
            onChange={e => setSelectedDate(e.target.value || today)}/>
          {!isToday && (
            <button onClick={() => setSelectedDate(today)}
              className="btn-secondary text-xs py-1.5 px-3">Today</button>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard icon={ClipboardList}
          label={isToday ? "Today's Plans" : `Plans — ${selectedDate.split('-').reverse().join('/')}`}
          value={todayPlans.length}
          sub={`${published} published · ${drafts} draft`}
          colorClass="stat-card-blue"  onClick={() => navigate(`/planning?date=${selectedDate}`)}/>
        <StatCard icon={Play}         label="In Progress"       value={inProg}
          sub="active executions"
          colorClass="stat-card-teal"  onClick={() => navigate(`/execution?date=${selectedDate}`)}/>
        <StatCard icon={CheckSquare}  label="Pending Ack"       value={pendAck}
          sub="awaiting acknowledgement"
          colorClass="stat-card-amber" onClick={() => navigate(`/execution?date=${selectedDate}`)}/>
        <StatCard icon={TrendingUp}   label={isToday ? 'Closed Today' : 'Closed'} value={closed}
          sub="trips completed"
          colorClass="stat-card-green" onClick={() => navigate(`/execution/closed?date=${selectedDate}`)}/>
      </div>

      {/* Tanker Position (Level 1) — live status card */}
      {showTankerPos && (
        <div onClick={() => navigate('/tanker-position')}
          className="card card-body cursor-pointer hover:scale-[1.01] transition-transform">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(0,120,212,0.12)' }}>
                <Truck size={18} style={{ color: '#0078d4' }}/>
              </div>
              <div>
                <div className="text-sm font-semibold text-gray-800">Tanker Position</div>
                <div className="text-xs text-gray-500">
                  Last updated: {tankerPos ? new Date(tankerPos.last_updated).toLocaleString('en-IN') : '—'} · click for location-wise view
                </div>
              </div>
            </div>
            <div className="flex gap-6 text-center">
              <div>
                <div className="text-2xl font-bold text-[#0078d4]">{tankerPos?.total_tankers ?? '—'}</div>
                <div className="text-xs text-gray-500">Total Tankers</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green-600">{tankerPos?.active_tankers ?? '—'}</div>
                <div className="text-xs text-gray-500">Active Tankers</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick actions */}
      {user?.role !== 'executor' && (
        <div>
          <h3 className="section-title">Quick Actions</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <QuickAction icon={ClipboardList} title="New Trip Plan"
              sub="Create a manual trip plan" onClick={() => navigate('/planning/new')}/>
            <QuickAction icon={Zap} title="Route Optimizer"
              sub="Auto-generate optimised trips" onClick={() => navigate('/planning/optimize')}/>
            <QuickAction icon={Route} title="Distance Master"
              sub={distSummary ? `${distSummary.coverage_pct}% coverage` : 'Manage road distances'}
              onClick={() => navigate('/masters/distances')}/>
          </div>
        </div>
      )}

      {user?.role === 'executor' && (
        <div>
          <h3 className="section-title">Quick Actions</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <QuickAction icon={Play} title="Start Execution"
              sub="View published plans for today" onClick={() => navigate('/execution')}/>
            <QuickAction icon={CheckSquare} title="Closed Trips"
              sub="View completed trip history" onClick={() => navigate('/execution/closed')}/>
          </div>
        </div>
      )}

      {/* Today's plans table */}
      {todayPlans.length > 0 && (
        <div>
          <h3 className="section-title">Today's Plans — {today}</h3>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    {['Trip','Tanker','Route','Shift','Qty (L)','KM','Cost (₹)','Status'].map(h => (
                      <th key={h} className="table-th">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {todayPlans.map(p => (
                    <tr key={p.id}>
                      <td className="table-td font-bold" style={{ color:'#0078d4' }}>#{p.trip_no}</td>
                      <td className="table-td font-mono text-xs">{p.tanker_number}</td>
                      <td className="table-td text-gray-600">{p.route_name || '—'}</td>
                      <td className="table-td">{p.shifts_milk || '—'}</td>
                      <td className="table-td text-right">{parseFloat(p.expected_total_qty||0).toLocaleString()}</td>
                      <td className="table-td text-right">{p.expected_km || '—'}</td>
                      <td className="table-td text-right">₹{parseFloat(p.total_cost||0).toLocaleString('en-IN',{maximumFractionDigits:0})}</td>
                      <td className="table-td">
                        <span className={`badge badge-${p.status}`}>{p.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
