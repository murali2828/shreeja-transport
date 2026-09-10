// frontend/src/pages/execution/ExecutionList.jsx
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Eye, RefreshCw, XCircle, ChevronDown, ChevronRight, MapPin } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPlans, getExecutions, createExecution, cancelExecution, getExecutionCoverage, setMissedBmcuRemark } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';
import { fmtDate } from '../../utils/date';

// Fixed remark vocabulary for missed BMCUs — must match MISSED_REMARKS in backend/src/routes/executions.js
const MISSED_REMARK_OPTIONS = ['BMCU Break down', '3 shifts planning'];

// Same thresholds/colours as the Trip Plans page's day utilisation card.
const utilColor  = v => v == null ? '#9ca3af' : v >= 80 ? '#22c55e' : v >= 60 ? '#f59e0b' : '#ef4444';
const utilText   = v => v == null ? 'text-gray-400' : v >= 80 ? 'text-green-600' : v >= 60 ? 'text-amber-600' : 'text-red-500';
const pctStr     = v => v == null ? '—' : `${parseFloat(v).toFixed(1)}%`;
const nL         = v => (parseFloat(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

// Coverage panel: trips status split, sale tankers, tanker utilisation,
// BMCUs collected, BMCUs missed (expandable).
function CoveragePanel({ date }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { data: cov } = useQuery({
    queryKey: ['exec-coverage', date],
    queryFn:  () => getExecutionCoverage(date).then(r => r.data),
    refetchInterval: 60_000, // live tracker during the day
  });
  const remarkMut = useMutation({
    mutationFn: ({ bmcu_id, remark }) => setMissedBmcuRemark({ date, bmcu_id, remark: remark || null }),
    onMutate: async ({ bmcu_id, remark }) => {
      // Optimistic: patch the cached row so the select doesn't snap back before refetch
      qc.setQueryData(['exec-coverage', date], old => old && ({
        ...old, missed: (old.missed || []).map(m => m.bmcu_id === bmcu_id ? { ...m, remark: remark || null } : m),
      }));
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['exec-coverage', date] }),
    onError: e => { toast.error(e.response?.data?.error || 'Could not save remark'); qc.invalidateQueries({ queryKey: ['exec-coverage', date] }); },
  });
  if (!cov) return null;
  const t = cov.trips || {};
  const s = cov.sale_trips || {};
  const u = cov.utilisation || {};
  const missedCount = (cov.missed || []).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <div className="card p-4 text-center border-2" style={{ borderColor: '#3b82f6' }}>
          <div className="text-3xl font-bold text-blue-600">{t.planned || 0}</div>
          <div className="text-sm font-medium text-gray-700">Trips Planned</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {t.in_progress || 0} in progress · {t.saved || 0} saved · {t.pending_ack || 0} pending ack · {t.closed || 0} closed
            {t.not_started ? ` · ${t.not_started} not started` : ''}
          </div>
        </div>
        <div className="card p-4 text-center border-2" style={{ borderColor: s.planned ? '#7c3aed' : '#d1d5db' }}
          title="Sale tankers — milk sold rather than delivered to a plant (planner flag or SALE… tanker). Included in Trips Planned, excluded from Tanker Utilisation.">
          <div className={`text-3xl font-bold ${s.planned ? 'text-violet-700' : 'text-gray-400'}`}>{s.planned || 0}</div>
          <div className="text-sm font-medium text-gray-700">Sale Tankers</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {s.planned
              ? `${(s.in_progress || 0) + (s.saved || 0) + (s.pending_ack || 0)} in progress · ${s.closed || 0} closed${s.not_started ? ` · ${s.not_started} not started` : ''}`
              : `none on ${fmtDate(date)}`}
          </div>
        </div>
        <div className="card p-4 text-center border-2" style={{ borderColor: utilColor(u.planned_pct) }}
          title="Planned: Σ expected qty ÷ Σ tanker capacity over the day's non-sale trips (one capacity per trip). Actual: Σ dispatched litres ÷ Σ capacity of non-sale trips that have dispatch data.">
          <div className={`text-3xl font-bold ${utilText(u.planned_pct)}`}>{pctStr(u.planned_pct)}</div>
          <div className="text-sm font-medium text-gray-700">Tanker Utilisation</div>
          <div className="text-xs text-gray-500 mt-0.5">
            planned {nL(u.planned_litres)} L of {nL(u.capacity_litres)} L
            {u.actual_pct != null && (
              <> · actual <span className={`font-medium ${utilText(u.actual_pct)}`}>{pctStr(u.actual_pct)}</span> ({nL(u.dispatched_litres)} L)</>
            )}
            {s.planned ? ' · sale excl.' : ''}
          </div>
        </div>
        <div className="card p-4 text-center border-2" style={{ borderColor: '#22c55e' }}>
          <div className="text-3xl font-bold text-green-600">{cov.bmcus_collected}</div>
          <div className="text-sm font-medium text-gray-700">BMCUs Collected</div>
          <div className="text-xs text-gray-500 mt-0.5">
            of {cov.total_active_bmcus} active ({cov.coverage_pct}%) — milk qty recorded
          </div>
        </div>
        <div className="card p-4 text-center border-2 cursor-pointer select-none"
          style={{ borderColor: missedCount ? '#ef4444' : '#d1d5db' }}
          onClick={() => setOpen(o => !o)}>
          <div className={`text-3xl font-bold ${missedCount ? 'text-red-600' : 'text-gray-400'}`}>{missedCount}</div>
          <div className="text-sm font-medium text-gray-700 flex items-center justify-center gap-1">
            BMCUs Missed {open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
          </div>
          <div className="text-xs mt-0.5">
            <span className="text-amber-600 font-medium">{cov.missed_planned} planned — not collected</span>
            {' · '}
            <span className="text-red-600 font-medium">{cov.missed_unplanned} not planned</span>
          </div>
        </div>
      </div>

      {open && missedCount > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 border-b">
                <tr>
                  <th className="table-th">BMCU</th>
                  <th className="table-th">Name</th>
                  <th className="table-th">District</th>
                  <th className="table-th">Planned on</th>
                  <th className="table-th">Remarks</th>
                  <th className="table-th">Trip Status</th>
                </tr>
              </thead>
              <tbody>
                {cov.missed.map((m, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="table-td font-mono font-semibold text-[#005ba3]">{m.bmcu_code}</td>
                    <td className="table-td">{m.bmcu_name}</td>
                    <td className="table-td text-gray-600">{m.district || '—'}</td>
                    <td className="table-td">
                      {m.planned
                        ? <span className="text-amber-700">Trip #{m.trip_no} — {m.tanker_number || ''}</span>
                        : <span className="text-red-600 font-medium">not planned</span>}
                    </td>
                    <td className="table-td">
                      <select className="input py-0.5 text-xs w-44"
                        value={m.remark || ''}
                        onChange={e => remarkMut.mutate({ bmcu_id: m.bmcu_id, remark: e.target.value })}>
                        <option value="">— Select —</option>
                        {MISSED_REMARK_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </td>
                    <td className="table-td text-gray-600">{m.planned ? (m.exec_status || '').replace('_', ' ') : '—'}</td>
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

export default function ExecutionList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [searchParams] = useSearchParams();
  const urlDate = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') || '') ? searchParams.get('date') : null;
  const [date, setDate] = useState(urlDate || new Date().toISOString().slice(0,10));
  const [search, setSearch] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelTarget, setCancelTarget] = useState(null); // { execId, planId, tripNo }

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

  const cancelMut = useMutation({
    mutationFn: ({ execId, reason }) => cancelExecution(execId, reason),
    onSuccess: () => {
      toast.success('Trip cancelled');
      setCancelTarget(null);
      setCancelReason('');
      qc.invalidateQueries(['executions']);
      qc.invalidateQueries(['plans']);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Cancel failed'),
  });

  const statusBadge = (s) => ({
    in_progress: 'bg-blue-100 text-blue-700',
    saved:       'bg-amber-100 text-amber-700',
    pending_ack: 'bg-purple-100 text-purple-700',
    closed:      'bg-green-100 text-green-700',
    cancelled:   'bg-red-100 text-red-600',
  })[s] || 'bg-gray-100 text-gray-500';

  const execMap = Object.fromEntries(execs.map(e => [e.trip_plan_id, e]));

  const visiblePlans = plans.filter(p => {
    const exec = execMap[p.id];
    if (exec?.status === 'cancelled') return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return p.tanker_number?.toLowerCase().includes(q) || p.route_name?.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <h2 className="page-title">Active Trips</h2>
        <div className="flex items-center gap-2">
          <input type="text" placeholder="Search route or tanker…"
            className="input py-1.5 text-sm w-52"
            value={search} onChange={e => setSearch(e.target.value)}/>
          <input type="date" className="input py-1.5 text-sm" value={date}
            onChange={e => setDate(e.target.value)}/>
        </div>
      </div>

      {/* Collection coverage — live tracker for the selected date */}
      <CoveragePanel date={date}/>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="table-th">Trip</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Route</th>
                <th className="table-th">Shift</th>
                <th className="table-th text-right">Exp Qty (L)</th>
                <th className="table-th text-right">KM</th>
                <th className="table-th">Execution Status</th>
                <th className="table-th">Entered By</th>
                <th className="table-th">Action</th>
              </tr>
            </thead>
            <tbody>
              {loadingPlans && (
                <tr><td colSpan={9} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!loadingPlans && visiblePlans.length === 0 && (
                <tr><td colSpan={9} className="table-td text-center py-10 text-gray-400">
                  No published plans for {fmtDate(date)}
                </td></tr>
              )}
              {visiblePlans.map(p => {
                const exec = execMap[p.id];
                return (
                  <tr key={p.id} className="hover:bg-gray-50 border-b border-gray-50">
                    <td className="table-td font-bold text-[#0078d4]">#{p.trip_no}</td>
                    <td className="table-td font-mono text-xs">
                      {p.tanker_number}
                      {p.is_sale_tanker && <span className="ml-1 px-1 rounded bg-violet-600 text-white text-[10px] font-sans" title="Sale Tanker — milk sold, not delivered to a plant">SALE</span>}
                    </td>
                    <td className="table-td text-xs">{p.delivery_point_name || '—'}</td>
                    <td className="table-td text-xs text-gray-600">{p.route_name || '—'}</td>
                    <td className="table-td">{p.shifts_milk || '—'}</td>
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
                    <td className="table-td font-mono text-[11px] text-gray-600">{exec?.entered_by_user_id || '—'}</td>
                    <td className="table-td">
                      <div className="flex items-center gap-1.5">
                        {exec ? (
                          <button onClick={() => navigate(`/execution/${exec.id}`)}
                            className="btn-secondary btn-sm flex items-center gap-1">
                            <Eye size={12}/> View
                          </button>
                        ) : null}
                        {exec && (
                          <button onClick={() => navigate(`/tracking?execution=${exec.id}`)}
                            className="btn-secondary btn-sm flex items-center gap-1" title="View on map (planned vs actual route)">
                            <MapPin size={12}/>
                          </button>
                        )}
                        {!exec && (
                          <button onClick={() => startMut.mutate(p.id)}
                            disabled={startMut.isPending}
                            className="btn-primary btn-sm flex items-center gap-1">
                            {startMut.isPending ? <RefreshCw size={12} className="animate-spin"/> : <Play size={12}/>}
                            Start
                          </button>
                        )}
                        {isAdmin && exec && exec.status !== 'closed' && (
                          <button
                            onClick={() => setCancelTarget({ execId: exec.id, planId: p.id, tripNo: p.trip_no })}
                            className="btn-danger btn-sm flex items-center gap-1"
                            title="Cancel trip">
                            <XCircle size={12}/> Cancel
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Cancel confirmation modal */}
      {cancelTarget && (
        <div className="modal-overlay" onClick={() => setCancelTarget(null)}>
          <div className="modal-box max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Cancel Trip #{cancelTarget.tripNo}</span>
              <button onClick={() => setCancelTarget(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="modal-body space-y-3">
              <p className="text-sm text-gray-600">
                This will cancel the trip execution and the plan. This action cannot be undone from the UI.
              </p>
              <div>
                <label className="label">Reason (optional)</label>
                <input className="input" placeholder="e.g. Duplicate entry, Wrong tanker..."
                  value={cancelReason} onChange={e => setCancelReason(e.target.value)}/>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setCancelTarget(null)} className="btn-secondary">Back</button>
              <button
                onClick={() => cancelMut.mutate({ execId: cancelTarget.execId, reason: cancelReason })}
                disabled={cancelMut.isPending}
                className="btn-danger flex items-center gap-1.5">
                {cancelMut.isPending ? <RefreshCw size={13} className="animate-spin"/> : <XCircle size={13}/>}
                Confirm Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
