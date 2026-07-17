// frontend/src/pages/execution/ExecutionList.jsx
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Eye, RefreshCw, XCircle, ChevronDown, ChevronRight, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPlans, getExecutions, createExecution, cancelExecution, getExecutionCoverage, getTripDocStatus, printTripDoc } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';
import { printGatePass, printCoa } from '../../utils/printDocs';

// Coverage panel: trips status split, BMCUs collected, BMCUs missed (expandable).
function CoveragePanel({ date }) {
  const [open, setOpen] = useState(false);
  const { data: cov } = useQuery({
    queryKey: ['exec-coverage', date],
    queryFn:  () => getExecutionCoverage(date).then(r => r.data),
    refetchInterval: 60_000, // live tracker during the day
  });
  if (!cov) return null;
  const t = cov.trips || {};
  const missedCount = (cov.missed || []).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card p-4 text-center border-2" style={{ borderColor: '#3b82f6' }}>
          <div className="text-3xl font-bold text-blue-600">{t.planned || 0}</div>
          <div className="text-sm font-medium text-gray-700">Trips Planned</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {t.in_progress || 0} in progress · {t.saved || 0} saved · {t.pending_ack || 0} pending ack · {t.closed || 0} closed
            {t.not_started ? ` · ${t.not_started} not started` : ''}
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

  // Gate Pass / COA print status per plan (first print = trip start / arrival time)
  const { data: docStatus = {} } = useQuery({
    queryKey: ['trip-doc-status', date],
    queryFn:  () => getTripDocStatus(date).then(r => r.data),
  });

  const printMut = useMutation({
    mutationFn: ({ planId, docType }) => printTripDoc(planId, docType),
    onSuccess: (res, { docType }) => {
      qc.invalidateQueries(['trip-doc-status']);
      if (docType === 'unloading') {
        toast.success(res.data.is_duplicate
          ? `Already recorded — unloading completed at ${new Date(res.data.first_printed_at).toLocaleString('en-IN')}`
          : `Unloading completed recorded at ${new Date(res.data.printed_at).toLocaleString('en-IN')}`);
        return;
      }
      if (docType === 'gate_pass') printGatePass(res.data); else printCoa(res.data);
      if (res.data.is_duplicate) toast('Duplicate print — original timestamp kept', { icon: 'ℹ️' });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Print failed'),
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
                <th className="table-th">Action</th>
              </tr>
            </thead>
            <tbody>
              {loadingPlans && (
                <tr><td colSpan={9} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!loadingPlans && visiblePlans.length === 0 && (
                <tr><td colSpan={9} className="table-td text-center py-10 text-gray-400">
                  No published plans for {date}
                </td></tr>
              )}
              {visiblePlans.map(p => {
                const exec = execMap[p.id];
                return (
                  <tr key={p.id} className="hover:bg-gray-50 border-b border-gray-50">
                    <td className="table-td font-bold text-[#0078d4]">#{p.trip_no}</td>
                    <td className="table-td font-mono text-xs">{p.tanker_number}</td>
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
                    <td className="table-td">
                      <div className="flex items-center gap-1.5">
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
                        {(() => {
                          const ds = docStatus[p.id] || {};
                          const gpDone = !!ds.gate_pass;
                          const coaDone = !!ds.coa;
                          const fmt = ts => ts ? new Date(ts).toLocaleString('en-IN') : '';
                          return (<>
                            <button onClick={() => printMut.mutate({ planId: p.id, docType: 'gate_pass' })}
                              disabled={printMut.isPending}
                              title={gpDone ? `Trip started — first printed ${fmt(ds.gate_pass.first_printed_at)} (reprint = duplicate)` : 'Print Gate Pass (starts the trip clock)'}
                              className={`btn-sm flex items-center gap-1 ${gpDone ? 'bg-green-100 text-green-700 rounded-lg px-2 py-1 text-xs font-medium' : 'btn-secondary'}`}>
                              <Printer size={12}/> GP{gpDone ? ' ✓' : ''}
                            </button>
                            <button onClick={() => printMut.mutate({ planId: p.id, docType: 'coa' })}
                              disabled={printMut.isPending || !gpDone}
                              title={!gpDone ? 'Print the Gate Pass first' : coaDone ? `Arrived — first printed ${fmt(ds.coa.first_printed_at)} (reprint = duplicate)` : 'Print COA (marks arrival at delivery point)'}
                              className={`btn-sm flex items-center gap-1 ${coaDone ? 'bg-green-100 text-green-700 rounded-lg px-2 py-1 text-xs font-medium' : 'btn-secondary'} ${!gpDone ? 'opacity-40 cursor-not-allowed' : ''}`}>
                              <Printer size={12}/> COA{coaDone ? ' ✓' : ''}
                            </button>
                            {(() => {
                              const unloadDone = !!ds.unloading;
                              return (
                                <button
                                  onClick={() => {
                                    if (unloadDone) return toast(`Unloading was completed at ${fmt(ds.unloading.first_printed_at)}`, { icon: 'ℹ️' });
                                    if (window.confirm(`Record UNLOADING COMPLETED for Trip #${p.trip_no} now? This timestamp cannot be changed.`))
                                      printMut.mutate({ planId: p.id, docType: 'unloading' });
                                  }}
                                  disabled={printMut.isPending || !coaDone}
                                  title={!coaDone ? 'Print the COA first (tanker must arrive)' : unloadDone ? `Unloading completed at ${fmt(ds.unloading.first_printed_at)}` : 'Record unloading completed'}
                                  className={`btn-sm flex items-center gap-1 ${unloadDone ? 'bg-green-100 text-green-700 rounded-lg px-2 py-1 text-xs font-medium' : 'btn-secondary'} ${!coaDone ? 'opacity-40 cursor-not-allowed' : ''}`}>
                                  ⬇ Unload{unloadDone ? ' ✓' : ''}
                                </button>
                              );
                            })()}
                          </>);
                        })()}
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
