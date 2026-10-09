// Tanker Payment Billing (biller role): execute a fortnight → trips with
// acknowledgements become billing lines. Per trip: select State (mandatory,
// never prefilled), transport type auto-derived (1 BMCU → Point to Point),
// system km (Master+Google, expandable leg breakdown), editable billed km,
// remarks. Rate applied from Tanker Rates by planning date. Submit → 3-level
// email approval (Mahesh → Krithiga → Thimmappa).
import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronDown, ChevronRight, Download, Upload, Send, Trash2, Play, ArrowLeft, RefreshCw, RotateCcw, Undo2 } from 'lucide-react';
import api from '../../api';
import { useAuth } from '../../hooks/useAuth';
import { hasRole } from '../../utils/roles';
import { fmtDate } from '../../utils/date';

const STATES = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];
const nf = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const STATUS_LABEL = {
  draft: ['Draft', '#c98500'], pending_vendor: ['Awaiting Vendor Verification', '#4a3aa7'],
  pending_l1: ['Awaiting L1 (Mahesh K)', '#2a78d6'],
  pending_l2: ['Awaiting L2 (Krithiga A)', '#2a78d6'], pending_l3: ['Awaiting L3 (Thimmappa)', '#2a78d6'],
  approved: ['APPROVED', '#008300'], rejected: ['REJECTED — correct & resubmit', '#e34948'],
};

export default function TankerBilling() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = user?.read_only !== true && (user?.roles || [user?.role]).some(r => ['admin', 'biller'].includes(r));
  const [openRunId, setOpenRunId] = useState(null);
  const [view, setView] = useState('runs'); // runs | report
  // Billing periods are strictly fortnights: 1–15 or 16–month-end.
  const [month, setMonth] = useState('');       // 'YYYY-MM'
  const [fortnight, setFortnight] = useState('1');
  const fnDates = () => {
    if (!month) return null;
    const [y, m] = month.split('-').map(Number);
    const end = new Date(y, m, 0).getDate();
    return fortnight === '1'
      ? { from: `${month}-01`, to: `${month}-15` }
      : { from: `${month}-16`, to: `${month}-${String(end).padStart(2, '0')}` };
  };
  const [edits, setEdits] = useState({});      // tripId -> {state, billed_km, remarks}
  const [ratePreviews, setRatePreviews] = useState({}); // tripId -> rate_per_km | null (unsaved)
  const [expanded, setExpanded] = useState({}); // tripId -> bool
  const [tab, setTab] = useState('trips');     // trips | tankers | vendors
  const [searchRoute, setSearchRoute] = useState('');
  const [searchTanker, setSearchTanker] = useState('');

  const { data: runs } = useQuery({
    queryKey: ['billing-runs'],
    queryFn: () => api.get('/billing/runs').then(r => r.data),
  });
  const { data: run, isFetching } = useQuery({
    queryKey: ['billing-run', openRunId],
    queryFn: () => api.get(`/billing/runs/${openRunId}`).then(r => r.data),
    enabled: !!openRunId,
  });
  const { data: summary } = useQuery({
    queryKey: ['billing-summary', openRunId, run?.updated_at],
    queryFn: () => api.get(`/billing/runs/${openRunId}/summary`).then(r => r.data),
    enabled: !!openRunId,
  });
  const { data: vendorList } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get('/vendors').then(r => r.data),
  });

  const assignVendorMut = useMutation({
    mutationFn: ({ tanker_number, vendor_id }) => api.post(`/billing/runs/${openRunId}/assign-vendor`, { tanker_number, vendor_id }),
    onSuccess: (r, vars) => {
      toast.success(`${vars.tanker_number} → ${r.data.vendor_name} (${r.data.trips_updated} trip(s) updated)`);
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-summary']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const createMut = useMutation({
    mutationFn: () => {
      const d = fnDates();
      return api.post('/billing/runs', { from_date: d.from, to_date: d.to });
    },
    onSuccess: r => {
      toast.success(`Run created — ${r.data.trips} acknowledged trips loaded`);
      if (r.data.new_combinations > 0)
        toast(`⚠ ${r.data.new_combinations} new route combination(s) not in the KM Master — flagged for the approval chain`,
              { duration: 9000, icon: '⚠️' });
      qc.invalidateQueries(['billing-runs']);
      setOpenRunId(r.data.id);
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const saveMut = useMutation({
    mutationFn: () => api.put(`/billing/runs/${openRunId}/trips`, {
      trips: Object.entries(edits).map(([id, e]) => ({
        id: +id, ...e,
        legs: e.legs ? Object.entries(e.legs).map(([i, km]) => ({ index: +i, km: +km })) : undefined,
      })),
    }),
    onSuccess: r => {
      const noRate = (r.data.updated || []).filter(u => u.no_rate).length;
      toast.success(`Saved · run total ₹ ${nf(r.data.total_amount)}`);
      if (noRate) toast.error(`${noRate} trip(s) have no matching rate for the selected state/capacity/period — check Tanker Rates`, { duration: 8000 });
      setEdits({});
      setRatePreviews({});
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-summary']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const submitMut = useMutation({
    mutationFn: (body) => api.post(`/billing/runs/${openRunId}/submit`, body || {}),
    onSuccess: r => {
      // Trips are never dropped for a missing toll challan (2026-09-29): only
      // the toll carries forward, uploaded against this period in the next cycle.
      const pending = r.data.tolls_pending || [];
      if (pending.length)
        toast(`Submitted. Toll challans pending for ${pending.length} tanker(s) — upload them in the next cycle: ${pending.join(', ')}`,
              { duration: 12000, icon: 'ℹ️' });
      else
        toast.success('Submitted — approval email sent to Mahesh K (Level 1)');
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });

  const withdrawMut = useMutation({
    mutationFn: () => api.post(`/billing/runs/${openRunId}/withdraw`),
    onSuccess: () => {
      toast.success('Withdrawn from approval — the run is a draft again; the Level 1 email links are void');
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });

  // Trips of this run's period that are in NO billing run (e.g. dropped by
  // the old Submit) — offered back on draft runs.
  const { data: readdPreview } = useQuery({
    queryKey: ['billing-readd-preview', openRunId, run?.updated_at],
    queryFn: () => api.get(`/billing/runs/${openRunId}/readd-preview`).then(r => r.data),
    enabled: !!openRunId && canEdit && ['draft', 'rejected', 'pending_vendor'].includes(run?.status),
  });
  // 'YYYY-MM-DD HH:MM:SS' from the API → 'DD-MM-YYYY HH:MM' for the dialogs
  const fmtCutoff = c => c ? `${fmtDate(c.slice(0, 10))} ${c.slice(11, 16)}` : '';
  const removeMut = useMutation({
    mutationFn: (tripId) => api.delete(`/billing/runs/${openRunId}/trips/${tripId}`),
    onSuccess: r => {
      toast.success(`${r.data.removed.tanker_number} ${fmtDate(r.data.removed.plan_for_date)} removed — it carries forward to the next fortnight's run`, { duration: 8000 });
      qc.invalidateQueries(['billing-run', openRunId]); qc.invalidateQueries(['billing-summary']); qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });
  const removeTrip = (t) => window.confirm(`Remove ${t.tanker_number} ${fmtDate(t.plan_for_date)} (${t.route_name || ''}) from this run?\n\nThe trip is not lost: it returns to the unbilled pool and the next fortnight's Execute / Re-add picks it up as carried forward. Use "Excl." instead if it must stay in this run unpaid.`) && removeMut.mutate(t.id);
  // Pull one trip from outside the period / after the cutoff into this run (biller override, 2026-10-06)
  const [pull, setPull] = useState(null); // null | { tanker_number, plan_for_date }
  const pullMut = useMutation({
    mutationFn: (body) => api.post(`/billing/runs/${openRunId}/pull-trip`, body),
    onSuccess: r => {
      toast.success(`${r.data.tanker_number} ${fmtDate(r.data.plan_for_date)} added to this run — key its state / km as usual`, { duration: 8000 });
      setPull(null);
      qc.invalidateQueries(['billing-run', openRunId]); qc.invalidateQueries(['billing-summary']); qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });
  const readdMut = useMutation({
    mutationFn: (includeLate) => api.post(`/billing/runs/${openRunId}/readd-trips`, { include_late_acks: !!includeLate }),
    onSuccess: r => {
      toast.success(`${r.data.added} trip(s) re-added across ${r.data.tankers.length} tanker(s)${r.data.late_added ? `, ${r.data.late_added} acknowledged after the cutoff` : ''} — key their state / km as usual`, { duration: 10000 });
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-summary']);
      qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });

  const [vendorFilter, setVendorFilter] = useState([]); // [{id, vendor_name}] — empty = all vendors

  const recalcMut = useMutation({
    mutationFn: () => api.post(`/billing/runs/${openRunId}/recalc-distances`),
    onSuccess: r => {
      const d = r.data;
      toast.success(`Distances recalculated: ${d.changed} of ${d.trips} trips updated` +
        (d.still_missing_legs ? ` · ${d.still_missing_legs} trip(s) still have a leg without coordinates` : ''), { duration: 8000 });
      qc.invalidateQueries({ queryKey: ['billing-run', openRunId] });
    },
    onError: e => toast.error(e.response?.data?.error || 'Recalculation failed'),
  });
  const pushVendorMut = useMutation({
    mutationFn: () => api.post(`/billing/runs/${openRunId}/push-vendor`,
      vendorFilter.length ? { vendor_ids: vendorFilter.map(v => v.id) } : {}),
    onSuccess: r => {
      const results = r.data.results || [];
      const sent = results.filter(x => x.startsWith('✓')).length;
      const failed = results.filter(x => x.startsWith('✗'));
      if (sent > 0) toast.success(`Draft tanker cards emailed to ${sent} vendor(s)${vendorFilter.length ? ' (selected only)' : ''} for verification`);
      if (!sent && !failed.length) toast('Nothing to push — no billable trips for the current selection.', { icon: 'ℹ️', duration: 8000 });
      failed.forEach(msg => toast.error(msg, { duration: 12000 }));
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });

  const delMut = useMutation({
    mutationFn: id => api.delete(`/billing/runs/${id}`),
    onSuccess: () => { toast.success('Run deleted'); setOpenRunId(null); qc.invalidateQueries(['billing-runs']); },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const downloadReport = () =>
    api.get(`/billing/runs/${openRunId}/report`, {
      responseType: 'blob',
      params: vendorFilter.length ? { vendor_ids: vendorFilter.map(v => v.id).join(',') } : undefined,
    }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `tanker_billing_run_${openRunId}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    });

  const setEdit = (tripId, field, val) =>
    setEdits(prev => ({ ...prev, [tripId]: { ...prev[tripId], [field]: val } }));
  // Fetch the rate as soon as a state is picked so the biller sees rate +
  // amount BEFORE saving. The save still recomputes authoritatively.
  const previewRate = (t, state, transportType) => {
    if (!state) return setRatePreviews(p => ({ ...p, [t.id]: undefined }));
    api.get('/billing/rate-lookup', { params: {
      state, transport_type: transportType || t.transport_type,
      capacity_litres: t.capacity_litres, plan_date: t.plan_for_date,
    } }).then(r => setRatePreviews(p => ({ ...p, [t.id]: r.data.rate_per_km })))
      .catch(() => {});
  };
  const setLegEdit = (tripId, index, km) =>
    setEdits(prev => ({ ...prev, [tripId]: {
      ...prev[tripId], legs: { ...(prev[tripId]?.legs || {}), [index]: km },
    } }));
  const val = (t, field) => edits[t.id]?.[field] !== undefined ? edits[t.id][field] : (t[field] ?? '');
  const editable = canEdit && run && ['draft', 'rejected', 'pending_vendor'].includes(run.status);

  // ── runs list / payment report ─────────────────────────────────────────────
  if (!openRunId) return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="page-title">Tanker Payment Billing</h2>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.92)' }}>
            Fortnightly vendor payments — execute a period, price each acknowledged trip, submit for 3-level approval
          </p>
        </div>
        <div className="flex gap-2 ml-2">
          {[['runs', 'Billing Runs'], ['report', 'Payment Report']].map(([k, l]) => (
            <button key={k} onClick={() => setView(k)}
              className="text-xs px-3 py-1.5 rounded-lg font-semibold"
              style={view === k ? { background: '#cc785c', color: '#fff' } : { background: '#fff', color: '#57534e' }}>
              {l}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {view === 'runs' && canEdit && (<>
          <input type="month" className="input text-xs" value={month} onChange={e => setMonth(e.target.value)}
                 title="Billing month"/>
          <select className="input text-xs" value={fortnight} onChange={e => setFortnight(e.target.value)}
                  title="Billing is strictly fortnightly">
            <option value="1">1st fortnight (1 – 15)</option>
            <option value="2">2nd fortnight (16 – month end)</option>
          </select>
          {month && <span className="text-xs text-white/90 self-center">{fnDates().from} → {fnDates().to}</span>}
          <button className="btn-primary text-xs flex items-center gap-1.5" disabled={!month || createMut.isPending}
                  onClick={() => createMut.mutate()}>
            <Play size={13}/> {createMut.isPending ? 'Executing…' : 'Execute'}
          </button>
        </>)}
      </div>

      {view === 'runs' && user?.role === 'admin' && <VendorEmailToggle/>}
      {view === 'runs' && canEdit && month && <MissingCoordinates from={fnDates().from} to={fnDates().to} />}

      {view === 'report' && <PaymentReport />}

      {view === 'runs' && <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-blue-50 text-left text-gray-600">
            <tr>{['Run #', 'Period', 'Trips', 'Total (₹)', 'Status', 'Created By', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
          </thead>
          <tbody>
            {!runs?.length && <tr><td colSpan={7} className="px-3 py-4 text-gray-400">No billing runs yet — pick a fortnight and Execute.</td></tr>}
            {(runs || []).map(r => {
              const [label, color] = STATUS_LABEL[r.status] || [r.status, '#666'];
              return (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-blue-50/50 cursor-pointer" onClick={() => setOpenRunId(r.id)}>
                  <td className="px-3 py-2 font-bold text-[#005ba3]">#{r.id}</td>
                  <td className="px-3 py-2">{fmtDate(r.from_date)} → {fmtDate(r.to_date)}</td>
                  <td className="px-3 py-2">{r.trip_count}</td>
                  <td className="px-3 py-2 text-right font-semibold">{nf(r.total_amount)}</td>
                  <td className="px-3 py-2"><span className="font-semibold" style={{ color }}>{label}</span></td>
                  <td className="px-3 py-2">{r.created_by_name || '—'}</td>
                  <td className="px-3 py-2">
                    {canEdit && ['draft', 'rejected', 'pending_vendor'].includes(r.status) && (
                      <button className="p-1 text-gray-400 hover:text-red-600" title="Delete run"
                              onClick={e => { e.stopPropagation(); window.confirm('Delete this run?') && delMut.mutate(r.id); }}>
                        <Trash2 size={13}/>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
    </div>
  );

  // ── run detail ─────────────────────────────────────────────────────────────
  const [label, color] = STATUS_LABEL[run?.status] || ['…', '#666'];
  const trips = run?.trips || [];
  const saleTrips = trips.filter(t => t.is_sale_tanker);
  const materialTrips = trips.filter(t => !t.is_sale_tanker && t.trip_kind === 'material');
  const vendorFilterIds = new Set(vendorFilter.map(v => v.id));
  const filteredTrips = trips.filter(t => !t.is_sale_tanker && t.trip_kind !== 'material' &&
    (!vendorFilterIds.size || vendorFilterIds.has(t.vendor_id)) &&
    (!searchRoute || (t.route_name || '').toLowerCase().includes(searchRoute.toLowerCase())) &&
    (!searchTanker || (t.tanker_number || '').toLowerCase().includes(searchTanker.toLowerCase())));
  const missing = trips.filter(t => !t.is_sale_tanker && (!val(t, 'state') || t.rate_per_km == null)).length;
  const unassignedTankers = [...new Set(trips.filter(t => !t.is_sale_tanker && !val(t, 'excluded') && !t.vendor_id).map(t => t.tanker_number))];
  const newComboCount = trips.reduce((s, t) => {
    if (t.is_sale_tanker) return s; // sale-tanker legs are not paid or approved
    const legs = Array.isArray(t.legs) ? t.legs : (t.legs ? JSON.parse(t.legs) : []);
    return s + legs.filter(l => l.is_new).length;
  }, 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => { setOpenRunId(null); setEdits({}); }}>
          <ArrowLeft size={13}/> Runs
        </button>
        <div>
          <h2 className="page-title">Billing Run #{openRunId}</h2>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.92)' }}>
            {fmtDate(run?.from_date)} → {fmtDate(run?.to_date)} · {trips.length} acknowledged trips {isFetching && '· loading…'}
          </p>
        </div>
        <span className="px-3 py-1 rounded-full text-xs font-bold text-white" style={{ background: color }}>{label}</span>
        <div className="flex-1" />
        <div className="text-right text-white">
          <div className="text-[11px] opacity-85">Total Payable</div>
          <div className="text-xl font-bold">₹ {nf(run?.total_amount)}</div>
        </div>
        <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={downloadReport}>
          <Download size={13}/> Report{vendorFilter.length ? ` (${vendorFilter.length})` : ''}
        </button>
        {editable && ['draft', 'rejected', 'pending_vendor'].includes(run.status) && (
          <button className="btn-secondary text-xs flex items-center gap-1.5" disabled={recalcMut.isPending}
            title="Recompute System / Google / Master KM and the leg breakdown for every trip (e.g. after plant coordinates or Distance Master rows were added). Billed KM, state, rate and amount are not touched."
            onClick={() => recalcMut.mutate()}>
            <RefreshCw size={13} className={recalcMut.isPending ? 'animate-spin' : ''}/> {recalcMut.isPending ? 'Recalculating…' : 'Recalc Distances'}
          </button>
        )}
        {editable && readdPreview?.missing > 0 && (
          <button className="btn-secondary text-xs flex items-center gap-1.5" disabled={readdMut.isPending}
            title={`${readdPreview.missing} acknowledged trip(s) of this period are in no billing run (tankers: ${readdPreview.tankers.join(', ')}). Re-add them to this run exactly as Execute would; existing lines are untouched.`}
            onClick={() => window.confirm(`Re-add ${readdPreview.missing} unbilled trip(s) of ${fmtDate(run.from_date)} → ${fmtDate(run.to_date)} to this run?\n\nTankers: ${readdPreview.tankers.join(', ')}\n\nExisting lines keep their keyed values; the re-added lines need state / km keyed again.`) && readdMut.mutate(false)}>
            <RotateCcw size={13}/> {readdMut.isPending ? 'Re-adding…' : `Re-add unbilled trips of this period (${readdPreview.missing})`}
          </button>
        )}
        {editable && readdPreview?.late_missing > 0 && (
          <button className="btn-secondary text-xs flex items-center gap-1.5 border-amber-300 text-amber-800" disabled={readdMut.isPending}
            title={`${readdPreview.late_missing} trip(s) of this period were acknowledged AFTER the fortnight cutoff (${fmtCutoff(readdPreview.ack_cutoff)}) and would normally carry forward to the next run. Tankers: ${readdPreview.late_tankers.join(', ')}. Adding them here is a biller override; each line is marked "Acknowledged after cutoff".`}
            onClick={() => window.confirm(`Include ${readdPreview.late_missing} trip(s) acknowledged after the cutoff (${fmtCutoff(readdPreview.ack_cutoff)}) in this run?\n\nTankers: ${readdPreview.late_tankers.join(', ')}\n\nThey would otherwise carry forward to the next fortnight. Each line will carry the remark "Acknowledged after cutoff".${readdPreview.missing ? `\n\nThe ${readdPreview.missing} regular unbilled trip(s) are added as well.` : ''}`) && readdMut.mutate(true)}>
            <RotateCcw size={13}/> {readdMut.isPending ? 'Re-adding…' : `Include late acknowledgements (${readdPreview.late_missing})`}
          </button>
        )}
        {editable && (
          <button className="btn-secondary text-xs flex items-center gap-1.5"
            title="Add one closed, acknowledged trip by tanker and lifting date even though it falls outside this period or was acknowledged after the cutoff. The line is remarked for approvers."
            onClick={() => setPull({ tanker_number: '', plan_for_date: run.to_date })}>
            <Play size={13}/> Pull trip…
          </button>
        )}
        {pull && (
          <div className="flex items-center gap-2 bg-white rounded-lg px-2 py-1 border border-amber-300">
            <input className="input text-xs py-1 px-2 w-32" placeholder="Tanker no." value={pull.tanker_number} autoFocus
              onChange={e => setPull(p => ({ ...p, tanker_number: e.target.value.toUpperCase() }))}/>
            <input type="date" className="input text-xs py-1 px-2" value={pull.plan_for_date}
              onChange={e => setPull(p => ({ ...p, plan_for_date: e.target.value }))} title="Milk lifting date"/>
            <button className="btn-primary text-xs py-1 px-2" disabled={pullMut.isPending || !pull.tanker_number || !pull.plan_for_date}
              onClick={() => window.confirm(`Add ${pull.tanker_number} lifted ${fmtDate(pull.plan_for_date)} to run #${openRunId}?\n\nThis bypasses the period / cutoff rule for that one trip; the line is remarked "Pulled into run by biller".`) && pullMut.mutate(pull)}>
              {pullMut.isPending ? 'Adding…' : 'Add'}
            </button>
            <button className="text-xs text-gray-500" onClick={() => setPull(null)}>cancel</button>
          </div>
        )}
        {canEdit && run?.status === 'pending_l1' && !(run?.approvals || []).some(a => a.decided_at) && (
          <button className="btn-secondary text-xs flex items-center gap-1.5" disabled={withdrawMut.isPending}
            title="Take the run back from Level 1 before the approver decides — it returns to Draft, the approval email links become void, and you can edit and resubmit"
            onClick={() => window.confirm('Withdraw this run from approval? It returns to Draft and the Level 1 approval links stop working. You can edit and resubmit.') && withdrawMut.mutate()}>
            <Undo2 size={13}/> {withdrawMut.isPending ? 'Withdrawing…' : 'Withdraw from approval'}
          </button>
        )}
        {editable && ['draft', 'rejected', 'pending_vendor'].includes(run.status) && (
          <button className="btn-secondary text-xs flex items-center gap-1.5" disabled={pushVendorMut.isPending}
                  title={vendorFilter.length
                    ? `Email draft tanker cards to only: ${vendorFilter.map(v => v.vendor_name).join(', ')}`
                    : 'Email draft tanker cards to each vendor for review before final submission — safe to re-send after editing more trips'}
                  onClick={() => window.confirm(vendorFilter.length
                      ? `Email DRAFT tanker cards to ${vendorFilter.length} selected vendor(s) only?`
                      : 'Email DRAFT tanker cards to all vendors on this run for verification?') && pushVendorMut.mutate()}>
            <Send size={13}/> {pushVendorMut.isPending ? 'Sending…' : (run.status === 'pending_vendor' ? 'Push to Vendors Again' : 'Push to Vendors')}
            {vendorFilter.length ? ` (${vendorFilter.length})` : ''}
          </button>
        )}
        {editable && (<>
          <button className="btn-secondary text-xs" disabled={!Object.keys(edits).length || saveMut.isPending}
                  onClick={() => {
                    const missingRemark = Object.entries(edits).some(([id, e]) =>
                      e.legs && Object.keys(e.legs).length &&
                      !String(e.remarks ?? trips.find(t => t.id === +id)?.remarks ?? '').trim());
                    if (missingRemark) return toast.error('Remarks are mandatory for trips whose leg distances were changed');
                    saveMut.mutate();
                  }}>
            {saveMut.isPending ? 'Saving…' : `Save (${Object.keys(edits).length})`}
          </button>
          <button className="btn-primary text-xs flex items-center gap-1.5" disabled={submitMut.isPending}
                  title={unassignedTankers.length ? `No vendor mapped for: ${unassignedTankers.join(', ')} — assign on the Vendor Wise tab`
                         : missing ? `${missing} trip(s) missing state/rate` : 'Send to Level 1 approver'}
                  onClick={() => {
                    if (Object.keys(edits).length) return toast.error('Save your changes first');
                    if (unassignedTankers.length)
                      return toast.error(`No vendor mapped for: ${unassignedTankers.join(', ')} — assign a vendor on the Vendor Wise tab first`, { duration: 8000 });
                    window.confirm(`Submit ₹ ${nf(run?.total_amount)} for approval? Email goes to Mahesh K (L1).`) && submitMut.mutate({});
                  }}>
            <Send size={13}/> Submit for Approval
          </button>
        </>)}
      </div>

      <MissingCoordinates runId={openRunId} />

      {/* new route combinations — approval-chain notice */}
      {newComboCount > 0 && (
        <div className="card p-3 text-xs" style={{ background: '#fdf3e3', border: '1px solid #c98500' }}>
          <span className="font-bold" style={{ color: '#8a5a00' }}>⚠ {newComboCount} new route combination(s)</span>
          <span style={{ color: '#57534e' }}> — leg distances whose pair was not in the KM Master (marked
          <span className="mx-1 px-1.5 rounded text-white text-[10px]" style={{ background: '#c98500' }}>new combo</span>
          in the leg breakdown). They are listed in the approval emails; approval of this run by all three levels
          constitutes the competent-authority approval of these combinations.</span>
        </div>
      )}

      {/* approval trail */}
      {run?.approvals?.length > 0 && (
        <div className="card p-3 flex flex-wrap gap-4 text-xs">
          {run.approvals.map(a => (
            <div key={a.level} className="flex items-center gap-2">
              <span className="font-bold">L{a.level}</span>
              <span className="text-gray-600">{a.approver_email}</span>
              <span className="font-semibold" style={{ color: a.status === 'approved' ? '#008300' : a.status === 'rejected' ? '#e34948' : '#c98500' }}>
                {a.status.toUpperCase()}
              </span>
              {a.remarks && <span className="text-gray-500 italic">“{a.remarks}”</span>}
            </div>
          ))}
        </div>
      )}

      {/* tabs */}
      <div className="flex gap-2 items-center flex-wrap">
        {[['trips', 'Trip Wise'], ['vendors', 'Vendor Wise'], ...(materialTrips.length ? [['material', `Material Trips (${materialTrips.length})`]] : []), ['saleTankers', 'Sale Tankers'], ['tolls', 'Toll Challans']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className="text-xs px-3 py-1.5 rounded-lg font-semibold"
            style={tab === k ? { background: '#cc785c', color: '#fff' } : { background: '#fff', color: '#57534e' }}>
            {l}
          </button>
        ))}
        <VendorFilterPicker vendorList={vendorList || []} selected={vendorFilter} onChange={setVendorFilter}/>
        {tab === 'trips' && (<>
          <input type="text" placeholder="Search route…" value={searchRoute}
                 onChange={e => setSearchRoute(e.target.value)}
                 className="input text-xs py-1 px-2 w-36"/>
          <input type="text" placeholder="Search tanker…" value={searchTanker}
                 onChange={e => setSearchTanker(e.target.value)}
                 className="input text-xs py-1 px-2 w-32"/>
          {(searchRoute || searchTanker) && (
            <button className="text-xs text-white/90 underline" onClick={() => { setSearchRoute(''); setSearchTanker(''); }}>
              clear
            </button>
          )}
        </>)}
        {missing > 0 && editable && <span className="text-xs text-white/90 self-center">⚠ {missing} trip(s) missing state / rate</span>}
        {unassignedTankers.length > 0 && editable &&
          <span className="text-xs text-white font-semibold self-center bg-red-600/80 px-2 py-1 rounded"
                title={unassignedTankers.join(', ')}>
            ⚠ {unassignedTankers.length} tanker(s) with no vendor mapped — payment cannot run for {unassignedTankers.length > 3 ? `${unassignedTankers.slice(0,3).join(', ')}…` : unassignedTankers.join(', ')} (fix on Vendor Wise tab)
          </span>}
      </div>

      {tab === 'trips' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[62vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
                <tr>{['', 'Excl.', 'Date', 'Tanker', 'Cap (KL)', 'Vendor', 'Route', 'Delivery Point', 'BMCUs', 'Ack Kgs',
                     'State *', 'Transport Type', 'System KM', 'Google KM', 'Billed KM', 'Rate/KM', 'Amount (₹)', 'Remarks']
                     .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {filteredTrips.map(t => (
                  <FragmentRow key={t.id} t={t} editable={editable} expanded={!!expanded[t.id]}
                    carried={!!t.carried_forward}
                    onToggle={() => setExpanded(p => ({ ...p, [t.id]: !p[t.id] }))}
                    val={val} setEdit={setEdit}
                    legEdits={edits[t.id]?.legs || {}} setLegEdit={setLegEdit}
                    ratePreview={ratePreviews[t.id]} previewRate={previewRate} onRemove={removeTrip} />
                ))}
                {filteredTrips.length === 0 && (
                  <tr><td colSpan={18} className="px-3 py-4 text-center text-gray-400">No trips match this search.</td></tr>
                )}
                <tr className="bg-blue-100 font-bold">
                  <td className="px-2 py-2" colSpan={12}>
                    TOTAL — {filteredTrips.length}{filteredTrips.length !== trips.length ? ` of ${trips.length}` : ''} trips
                    ({filteredTrips.filter(t => val(t,"excluded")).length} excluded)
                  </td>
                  <td className="px-2 py-2 text-right">{nf(filteredTrips.reduce((s, t) => s + (+t.system_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(filteredTrips.reduce((s, t) => s + (+t.google_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(filteredTrips.reduce((s, t) => s + (+(edits[t.id]?.billed_km ?? t.billed_km) || 0), 0))}</td>
                  <td/>
                  <td className="px-2 py-2 text-right">{nf(filteredTrips.reduce((s, t) => s + (val(t,"excluded") ? 0 : (+t.amount || 0)), 0))}</td>
                  <td/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'material' && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 text-xs text-gray-600 bg-purple-50 border-b border-purple-100">
            Pasteurised-milk / material trips: supplier → customer, no BMCU chain. Billed KM defaults to the km keyed by the executor; System / Google KM are the reference. Paid to the vendor like any other trip and listed in their own section of the vendor email and Excel.
          </div>
          <div className="overflow-x-auto max-h-[62vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
                <tr>{['', 'Excl.', 'Date', 'Tanker', 'Cap (KL)', 'Vendor', 'Route', 'Delivery Point', 'BMCUs', 'Ack Kgs',
                     'State *', 'Transport Type', 'System KM', 'Google KM', 'Billed KM', 'Rate/KM', 'Amount (₹)', 'Remarks']
                     .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {materialTrips.map(t => (
                  <FragmentRow key={t.id} t={t} editable={editable} expanded={!!expanded[t.id]}
                    carried={!!t.carried_forward}
                    onToggle={() => setExpanded(p => ({ ...p, [t.id]: !p[t.id] }))}
                    val={val} setEdit={setEdit}
                    legEdits={edits[t.id]?.legs || {}} setLegEdit={setLegEdit}
                    ratePreview={ratePreviews[t.id]} previewRate={previewRate} onRemove={removeTrip} />
                ))}
                <tr className="bg-blue-100 font-bold">
                  <td className="px-2 py-2" colSpan={12}>TOTAL — {materialTrips.length} material trip(s) ({materialTrips.filter(t => val(t,"excluded")).length} excluded)</td>
                  <td className="px-2 py-2 text-right">{nf(materialTrips.reduce((s, t) => s + (+t.system_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(materialTrips.reduce((s, t) => s + (+t.google_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(materialTrips.reduce((s, t) => s + (+(edits[t.id]?.billed_km ?? t.billed_km) || 0), 0))}</td>
                  <td/>
                  <td className="px-2 py-2 text-right">{nf(materialTrips.reduce((s, t) => s + (val(t,"excluded") ? 0 : (+t.amount || 0)), 0))}</td>
                  <td/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'saleTankers' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[62vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
                <tr>{['', 'Excl.', 'Date', 'Tanker', 'Cap (KL)', 'Vendor', 'Route', 'Delivery Point', 'BMCUs', 'Ack Kgs',
                     'State *', 'Transport Type', 'System KM', 'Google KM', 'Billed KM', 'Rate/KM', 'Amount (₹)', 'Remarks']
                     .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {saleTrips.map(t => (
                  <FragmentRow key={t.id} t={t} editable={editable} expanded={!!expanded[t.id]}
                    carried={!!t.carried_forward}
                    onToggle={() => setExpanded(p => ({ ...p, [t.id]: !p[t.id] }))}
                    val={val} setEdit={setEdit}
                    legEdits={edits[t.id]?.legs || {}} setLegEdit={setLegEdit}
                    ratePreview={ratePreviews[t.id]} previewRate={previewRate} onRemove={removeTrip} />
                ))}
                {saleTrips.length === 0 && (
                  <tr><td colSpan={18} className="px-3 py-4 text-center text-gray-400">No Sale Tanker trips in this run.</td></tr>
                )}
                <tr className="bg-blue-100 font-bold">
                  <td className="px-2 py-2" colSpan={12}>TOTAL — {saleTrips.length} Sale Tanker trip(s), not billed to vendors</td>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+t.system_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+t.google_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+(edits[t.id]?.billed_km ?? t.billed_km) || 0), 0))}</td>
                  <td/>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+t.amount || 0), 0))}</td>
                  <td/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'tolls' && (
        <TollPanel runId={openRunId} tolls={run?.tolls || []} pendingEarlier={run?.tolls_pending_earlier || []}
                   tankers={summary?.tankers || []} editable={editable} runStatus={run?.status}/>
      )}

      {tab === 'vendors' && unassignedTankers.length > 0 && editable && (
        <div className="card p-3 space-y-2" style={{ background: '#fef2f2', border: '1px solid #dc2626' }}>
          <div className="text-xs font-bold" style={{ color: '#991b1b' }}>
            ⚠ {unassignedTankers.length} tanker(s) have no vendor mapped — payment cannot run for these until a vendor is assigned.
          </div>
          {unassignedTankers.map(tn => (
            <VendorAssignRow key={tn} tankerNumber={tn} vendorList={vendorList || []}
              onAssign={vendor_id => assignVendorMut.mutate({ tanker_number: tn, vendor_id })}
              pending={assignVendorMut.isPending}/>
          ))}
        </div>
      )}

      {tab !== 'trips' && tab !== 'tolls' && tab !== 'saleTankers' && (() => {
        const withToll = tab === 'tankers' || tab === 'vendors';
        const rows = (tab === 'tankers' ? summary?.tankers : tab === 'dates' ? summary?.dates : summary?.vendors) || [];
        return (
        <div className="card overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-blue-50 text-left text-gray-600">
              <tr>{[(tab === 'tankers' ? 'Tanker' : tab === 'dates' ? 'Date' : 'Vendor'),
                    (tab === 'tankers' ? 'Vendor' : 'Tankers'),
                    'Trips', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)',
                    ...(withToll ? ['Toll (₹)', 'Total Payable (₹)'] : [])]
                .map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-semibold">
                    {tab === 'tankers' ? r.tanker_number : tab === 'dates' ? r.date : r.vendor_name}
                  </td>
                  <td className="px-3 py-1.5">{tab === 'tankers' ? r.vendor_name : r.tankers}</td>
                  <td className="px-3 py-1.5 text-right">{r.trips}</td>
                  <td className="px-3 py-1.5 text-right">{nf(r.billed_km)}</td>
                  <td className="px-3 py-1.5 text-right">{nf(r.system_km)}</td>
                  <td className="px-3 py-1.5 text-right">{nf(r.google_km)}</td>
                  <td className="px-3 py-1.5 text-right font-bold text-[#005ba3]">{nf(r.amount)}</td>
                  {withToll && <td className="px-3 py-1.5 text-right">{nf(r.toll_amount)}</td>}
                  {withToll && <td className="px-3 py-1.5 text-right font-bold text-[#005ba3]">{nf(r.total_payable)}</td>}
                </tr>
              ))}
              <tr className="bg-blue-100 font-bold">
                <td className="px-3 py-2">TOTAL</td>
                <td className="px-3 py-2"/>
                <td className="px-3 py-2 text-right">{rows.reduce((s, r) => s + (+r.trips || 0), 0)}</td>
                <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.billed_km || 0), 0))}</td>
                <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.system_km || 0), 0))}</td>
                <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.google_km || 0), 0))}</td>
                <td className="px-3 py-2 text-right text-[#005ba3]">{nf(rows.reduce((s, r) => s + (+r.amount || 0), 0))}</td>
                {withToll && <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.toll_amount || 0), 0))}</td>}
                {withToll && <td className="px-3 py-2 text-right text-[#005ba3]">{nf(rows.reduce((s, r) => s + (+r.total_payable || 0), 0))}</td>}
              </tr>
            </tbody>
          </table>
        </div>
        );
      })()}
    </div>
  );
}

// One toll-gate challan (document + amount) per tanker per period; the
// amount is reimbursed to the vendor on top of trip amounts. A missing
// challan never blocks submit or drops trips (2026-09-29): it is uploaded in
// a later run against the earlier period ("Pending from earlier cycles")
// and paid in that run's total.
function TollPanel({ runId, tolls, pendingEarlier, tankers, editable, runStatus }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({}); // key -> {amount, remarks, file}; key = tanker or `${tanker}|${for_run_id}`
  const [saveState, setSaveState] = useState({}); // key -> 'saving' | 'saved HH:MM' | 'error …'
  const timers = useRef({});
  const byTanker = new Map(tolls.filter(t => !t.for_run_id).map(t => [t.tanker_number, t]));
  const carriedIn = tolls.filter(t => t.for_run_id);
  // Auto-save (owner, 2026-10-06): amount / remarks are saved 1.5 s after the
  // last keystroke, a chosen file is saved at once — as long as the row has an
  // amount and a challan (new or already on file). The Save button stays as a
  // manual trigger.
  const setF = (key, k, v) => {
    setForm(p => ({ ...p, [key]: { ...p[key], [k]: v } }));
    clearTimeout(timers.current[key]);
    const [tn, forRun] = key.split('|');
    timers.current[key] = setTimeout(() => save(tn, forRun ? parseInt(forRun, 10) : null, { silent: true, override: { [k]: v } }), k === 'file' ? 50 : 1500);
  };
  // Change requests once the run is under approval (migration 051)
  const locked = !editable && ['pending_l1', 'pending_l2', 'pending_l3', 'approved'].includes(runStatus);
  const [req, setReq] = useState(null); // { tn, forRunId, amount, remarks, noToll, reason, file }
  const { data: changeReqs, refetch: refetchReqs } = useQuery({
    queryKey: ['toll-changes', runId], enabled: !!runId,
    queryFn: () => api.get('/billing/toll-changes', { params: { run_id: runId } }).then(r => r.data),
  });
  const submitReq = () => {
    if (!req) return;
    if (!req.reason?.trim()) return toast.error('Give the reason for the change');
    if (!req.noToll && (req.amount === '' || req.amount == null || +req.amount < 0)) return toast.error('Enter the new toll amount or tick No toll');
    const fd = new FormData();
    fd.append('tanker_number', req.tn); if (req.forRunId) fd.append('for_run_id', req.forRunId);
    fd.append('amount', req.noToll ? 0 : req.amount); fd.append('not_applicable', req.noToll ? 'true' : 'false');
    fd.append('remarks', req.remarks || ''); fd.append('reason', req.reason.trim());
    if (req.file) fd.append('file', req.file);
    api.post(`/billing/toll-changes/runs/${runId}`, fd)
      .then(r => { toast.success(r.data.message, { duration: 8000 }); setReq(null); refetchReqs(); })
      .catch(e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }));
  };
  const decideReq = (id, decision) => window.confirm(`${decision === 'approve' ? 'Approve' : 'Reject'} toll change request #${id}?`) &&
    api.post(`/billing/toll-changes/${id}/${decision}`).then(() => { toast.success(`Request #${id} ${decision}d`); refetchReqs(); refresh(); })
      .catch(e => toast.error(e.response?.data?.error || e.message));
  const downloadProposed = cr => api.get(`/billing/toll-changes/${cr.id}/file`, { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data); const a = document.createElement('a'); a.href = url; a.download = cr.new_file_name || 'challan'; a.click(); URL.revokeObjectURL(url);
  });
  const periodLabel = t => `for run #${t.for_run_id ?? t.run_id} · ${fmtDate(t.for_from_date ?? t.from_date)} → ${fmtDate(t.for_to_date ?? t.to_date)}`;
  const refresh = () => {
    qc.invalidateQueries(['billing-run', runId]);
    qc.invalidateQueries(['billing-summary']);
    qc.invalidateQueries(['billing-runs']);
  };
  // forRunId set = challan for an EARLIER run's period, paid in this run.
  const save = (tn, forRunId = null, { silent = false, override = {} } = {}) => {
    const key = forRunId ? `${tn}|${forRunId}` : tn;
    const f = { ...(formRef.current[key] || {}), ...override };
    const existing = forRunId ? carriedIn.find(t => t.tanker_number === tn && t.for_run_id === forRunId) : byTanker.get(tn);
    const amount = f.amount !== undefined ? f.amount : existing?.amount;
    if (amount === undefined || amount === '' || +amount < 0)
      return silent ? undefined : toast.error('Enter the toll challan amount');
    if (!f.file && !existing?.has_file)
      return silent ? setSaveState(p => ({ ...p, [key]: 'needs challan' })) : toast.error(`${tn}: choose a toll challan attachment (PDF/JPG/PNG) before saving — a record can't be saved without one`, { duration: 7000 });
    setSaveState(p => ({ ...p, [key]: 'saving' }));
    const fd = new FormData();
    fd.append('tanker_number', tn);
    fd.append('amount', amount);
    fd.append('remarks', f.remarks !== undefined ? f.remarks : (existing?.remarks || ''));
    if (forRunId) fd.append('for_run_id', forRunId);
    if (f.file) fd.append('file', f.file);
    api.post(`/billing/runs/${runId}/tolls`, fd)
      .then(() => {
        if (!silent) toast.success(`Toll challan saved for ${tn}${forRunId ? ` (run #${forRunId})` : ''}`);
        setSaveState(p => ({ ...p, [key]: `saved ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` }));
        setForm(p => ({ ...p, [key]: undefined })); refresh();
      })
      .catch(e => { setSaveState(p => ({ ...p, [key]: 'error' })); toast.error(e.response?.data?.error || e.message); });
  };
  const formRef = useRef(form); formRef.current = form;
  const stateBadge = key => saveState[key] ? <span className={`ml-1 text-[10px] ${saveState[key] === 'saving' ? 'text-amber-600' : saveState[key] === 'error' ? 'text-red-600' : saveState[key] === 'needs challan' ? 'text-gray-400' : 'text-green-700'}`}>{saveState[key]}</span> : null;
  // "No toll" — route without toll plazas: satisfies the challan requirement
  // for this tanker-period so it is never listed as pending or carried forward.
  const markNoToll = (tn, forRunId = null) => {
    if (!window.confirm(`Mark ${tn}${forRunId ? ` (run #${forRunId})` : ''} as "No toll" for this period? It will not be carried forward.`)) return;
    api.post(`/billing/runs/${runId}/tolls/not-applicable`, { tanker_number: tn, for_run_id: forRunId || undefined,
      remarks: (form[forRunId ? `${tn}|${forRunId}` : tn]?.remarks) || '' })
      .then(() => { toast.success(`${tn}: no toll for this period`); refresh(); })
      .catch(e => toast.error(e.response?.data?.error || e.message));
  };
  const del = (tn, ex = byTanker.get(tn)) => {
    if (!ex) return;
    window.confirm(`Remove the toll challan for ${tn}${ex.for_run_id ? ` (run #${ex.for_run_id})` : ''}?`) &&
      api.delete(`/billing/runs/${runId}/tolls/${ex.id}`)
        .then(refresh)
        .catch(e => toast.error(e.response?.data?.error || e.message));
  };
  const download = ex =>
    api.get(`/billing/runs/${runId}/tolls/${ex.id}/file`, { responseType: 'blob' }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = ex.file_name || 'challan'; a.click();
      URL.revokeObjectURL(url);
    });

  const uploadStatement = file => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    toast.loading('Parsing FASTag statement…', { id: 'fastag' });
    api.post(`/billing/runs/${runId}/fastag`, fd)
      .then(r => {
        const { matched, unmatched } = r.data;
        toast.success(
          `FASTag: ${matched.length} tanker(s) filled — ` +
          matched.map(m => `${m.tanker_number} ₹${nf(m.toll_amount)} (${m.trips} tolls)`).join(', '),
          { id: 'fastag', duration: 10000 });
        if (unmatched.length)
          toast(`⚠ Not in this run (ignored): ${unmatched.map(u => `${u.plate} ₹${nf(u.toll_amount)}`).join(', ')}`,
                { icon: '⚠️', duration: 10000 });
        refresh();
      })
      .catch(e => toast.error(e.response?.data?.error || e.message, { id: 'fastag' }));
  };

  const tollTotal = tolls.reduce((s, t) => s + (+t.amount || 0), 0);
  return (
    <div className="card overflow-hidden">
      <div className="px-3 py-2 text-xs text-gray-600 bg-blue-50/60 flex flex-wrap items-center gap-3">
        <span>One challan per tanker for the fortnight (PDF/JPG/PNG, max 15 MB). The amount is added to the
        vendor's payable and goes through the same approval chain. A missing challan never blocks submit or
        removes trips — the toll is uploaded in the next cycle against this period. · Total tolls: <b>₹ {nf(tollTotal)}</b></span>
        {editable && (
          <label className="btn-secondary text-[11px] px-2 py-1 cursor-pointer whitespace-nowrap"
                 title="Upload a FASTag statement PDF (ICICI E-Statement or account summary) — per-tanker toll amounts are read and filled automatically">
            ⚡ Upload FASTag Statement
            <input type="file" accept=".pdf" className="sr-only"
                   onChange={e => { uploadStatement(e.target.files[0]); e.target.value = ''; }}/>
          </label>
        )}
      </div>
      <table className="w-full text-xs">
        <thead className="bg-blue-50 text-left text-gray-600">
          <tr>{['Tanker', 'Vendor', 'Toll Amount (₹)', 'Challan', 'Remarks', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {tankers.map(t => {
            const ex = byTanker.get(t.tanker_number);
            const f = form[t.tanker_number] || {};
            return (
              <tr key={t.tanker_number} className="border-t border-gray-100">
                <td className="px-3 py-1.5 font-semibold text-[#005ba3]">{t.tanker_number}</td>
                <td className="px-3 py-1.5">{t.vendor_name || '—'}</td>
                <td className="px-3 py-1.5 text-right">
                  {editable
                    ? <input type="number" step="0.01" min="0" className="input py-0.5 px-1 text-xs w-28 text-right"
                             value={f.amount !== undefined ? f.amount : (ex?.amount ?? '')}
                             onChange={e => setF(t.tanker_number, 'amount', e.target.value)}/>
                    : nf(ex?.amount)}
                </td>
                <td className="px-3 py-1.5">
                  {ex?.not_applicable && (
                    <span className="mr-2 px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-[10px] font-semibold" title="No toll on this route for this period">NO TOLL</span>
                  )}
                  {ex?.has_file && (
                    <button className="text-[#005ba3] underline mr-2" onClick={() => download(ex)}>
                      {ex.file_name || 'challan'}
                    </button>
                  )}
                  {editable && !ex?.not_applicable && (
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-[11px]"
                           onChange={e => setF(t.tanker_number, 'file', e.target.files[0])}/>
                  )}
                  {!ex?.has_file && !ex?.not_applicable && !editable && '—'}
                </td>
                <td className="px-3 py-1.5">
                  {editable
                    ? <input type="text" className="input py-0.5 px-1 text-xs w-40" placeholder="remarks"
                             value={f.remarks !== undefined ? f.remarks : (ex?.remarks ?? '')}
                             onChange={e => setF(t.tanker_number, 'remarks', e.target.value)}/>
                    : (ex?.remarks || '—')}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {locked && (
                    <button className="text-[11px] px-2 py-0.5 rounded border border-amber-400 text-amber-800 hover:bg-amber-50"
                            title="The run is under approval — propose a change; PP01 approves by email"
                            onClick={() => setReq({ tn: t.tanker_number, forRunId: null, amount: ex?.amount ?? '', remarks: ex?.remarks || '', noToll: !!ex?.not_applicable, reason: '', file: null })}>
                      Request change
                    </button>
                  )}
                  {editable && (<>
                    {!ex?.not_applicable && (
                      <button className="btn-secondary text-[11px] px-2 py-0.5 mr-1" onClick={() => save(t.tanker_number)} title="Auto-saves 1.5 s after typing / on file choice; click to save now">
                        {ex ? 'Update' : 'Save'}
                      </button>
                    )}
                    {stateBadge(t.tanker_number)}
                    {!ex && (
                      <button className="text-[11px] px-2 py-0.5 mr-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                              title="No toll plazas on this tanker's routes this period — do not carry forward"
                              onClick={() => markNoToll(t.tanker_number)}>No toll</button>
                    )}
                    {ex && (
                      <button className="p-1 text-gray-400 hover:text-red-600" title="Remove challan"
                              onClick={() => del(t.tanker_number)}>
                        <Trash2 size={12}/>
                      </button>
                    )}
                  </>)}
                </td>
              </tr>
            );
          })}
          {!tankers.length && <tr><td colSpan={6} className="px-3 py-4 text-gray-400">No tankers in this run.</td></tr>}
          {carriedIn.map(ex => (
            <tr key={`c-${ex.id}`} className="border-t border-gray-100 bg-amber-50/40">
              <td className="px-3 py-1.5 font-semibold text-[#005ba3]">{ex.tanker_number}
                <span className="ml-1 px-1 rounded bg-amber-500 text-white text-[10px]" title="Challan for an earlier period, paid in this run">{periodLabel(ex)}</span></td>
              <td className="px-3 py-1.5">{tankers.find(t => t.tanker_number === ex.tanker_number)?.vendor_name || '—'}</td>
              <td className="px-3 py-1.5 text-right">{nf(ex.amount)}</td>
              <td className="px-3 py-1.5">{ex.not_applicable
                ? <span className="px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 text-[10px] font-semibold">NO TOLL</span>
                : ex.has_file ? <button className="text-[#005ba3] underline" onClick={() => download(ex)}>{ex.file_name || 'challan'}</button> : '—'}</td>
              <td className="px-3 py-1.5">{ex.remarks || '—'}</td>
              <td className="px-3 py-1.5 whitespace-nowrap">
                {locked && (
                  <button className="text-[11px] px-2 py-0.5 rounded border border-amber-400 text-amber-800 hover:bg-amber-50"
                          onClick={() => setReq({ tn: ex.tanker_number, forRunId: ex.for_run_id, amount: ex.amount ?? '', remarks: ex.remarks || '', noToll: !!ex.not_applicable, reason: '', file: null })}>
                    Request change
                  </button>
                )}
                {editable && (
                  <button className="p-1 text-gray-400 hover:text-red-600" title="Remove challan" onClick={() => del(ex.tanker_number, ex)}>
                    <Trash2 size={12}/>
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Tankers of earlier submitted / approved runs still owing a challan —
          uploaded here against that period and paid in this run. */}
      {pendingEarlier.length > 0 && (
        <div className="border-t border-amber-200">
          <div className="px-3 py-2 text-xs bg-amber-50 text-amber-900">
            <b>Pending from earlier cycles</b> — {pendingEarlier.length} tanker-period(s) had no toll challan when their run was
            submitted. Upload the challan here: it is recorded against that period and paid in <b>this</b> run's total.
          </div>
          <table className="w-full text-xs">
            <thead className="bg-blue-50 text-left text-gray-600">
              <tr>{['Tanker', 'Vendor', 'Period', 'Toll Amount (₹)', 'Challan', 'Remarks', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
            </thead>
            <tbody>
              {pendingEarlier.map(p => {
                const key = `${p.tanker_number}|${p.run_id}`;
                const f = form[key] || {};
                return (
                  <tr key={key} className="border-t border-gray-100">
                    <td className="px-3 py-1.5 font-semibold text-[#005ba3]">{p.tanker_number}</td>
                    <td className="px-3 py-1.5">{p.vendor_name || '—'}</td>
                    <td className="px-3 py-1.5">Run #{p.run_id} · {fmtDate(p.from_date)} → {fmtDate(p.to_date)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {editable
                        ? <input type="number" step="0.01" min="0" className="input py-0.5 px-1 text-xs w-28 text-right"
                                 value={f.amount ?? ''} onChange={e => setF(key, 'amount', e.target.value)}/>
                        : '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable
                        ? <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-[11px]"
                                 onChange={e => setF(key, 'file', e.target.files[0])}/>
                        : 'pending'}
                    </td>
                    <td className="px-3 py-1.5">
                      {editable
                        ? <input type="text" className="input py-0.5 px-1 text-xs w-40" placeholder="remarks"
                                 value={f.remarks ?? ''} onChange={e => setF(key, 'remarks', e.target.value)}/>
                        : '—'}
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {editable && (<>
                        <button className="btn-secondary text-[11px] px-2 py-0.5" onClick={() => save(p.tanker_number, p.run_id)}>Save</button>
                        {stateBadge(key)}
                        <button className="text-[11px] px-2 py-0.5 ml-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                title="No toll for that period — clear it without a challan"
                                onClick={() => markNoToll(p.tanker_number, p.run_id)}>No toll</button>
                      </>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Change request form (run under approval) */}
      {req && (
        <div className="border-t border-amber-200 bg-amber-50/60 px-3 py-3 text-xs space-y-2">
          <div className="font-semibold text-amber-900">Request a toll challan change — {req.tn}{req.forRunId ? ` (run #${req.forRunId})` : ''}</div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col">New amount (₹)
              <input type="number" step="0.01" min="0" className="input py-0.5 px-1 text-xs w-28 text-right" value={req.amount} disabled={req.noToll}
                     onChange={e => setReq(p => ({ ...p, amount: e.target.value }))}/></label>
            <label className="flex items-center gap-1 pb-1"><input type="checkbox" checked={req.noToll} onChange={e => setReq(p => ({ ...p, noToll: e.target.checked }))}/> No toll</label>
            <label className="flex flex-col">New challan (PDF / JPG / PNG)
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-[11px]" disabled={req.noToll} onChange={e => setReq(p => ({ ...p, file: e.target.files[0] || null }))}/></label>
            <label className="flex flex-col">Remarks
              <input type="text" className="input py-0.5 px-1 text-xs w-40" value={req.remarks} onChange={e => setReq(p => ({ ...p, remarks: e.target.value }))}/></label>
            <label className="flex flex-col flex-1 min-w-[16rem]">Reason for the change *
              <input type="text" className="input py-0.5 px-1 text-xs w-full" value={req.reason} onChange={e => setReq(p => ({ ...p, reason: e.target.value }))}/></label>
            <button className="btn-primary text-[11px] px-3 py-1" onClick={submitReq}>Send for approval</button>
            <button className="text-[11px] text-gray-500" onClick={() => setReq(null)}>cancel</button>
          </div>
          <div className="text-gray-600">PP01 receives an email with the current and proposed values and the attachment; the row changes only on approval.</div>
        </div>
      )}

      {/* Change requests of this run */}
      {changeReqs?.rows?.length > 0 && (
        <div className="border-t border-gray-200">
          <div className="px-3 py-2 text-xs bg-gray-50 font-semibold text-gray-700">Toll challan change requests · approver {changeReqs.approver_name}</div>
          <table className="w-full text-xs">
            <thead className="bg-blue-50 text-left text-gray-600">
              <tr>{['#', 'Tanker', 'Period', 'Current', 'Proposed', 'Reason', 'Requested by', 'Status', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
            </thead>
            <tbody>
              {changeReqs.rows.map(cr => (
                <tr key={cr.id} className="border-t border-gray-100">
                  <td className="px-3 py-1.5">{cr.id}</td>
                  <td className="px-3 py-1.5 font-semibold text-[#005ba3]">{cr.tanker_number}</td>
                  <td className="px-3 py-1.5">{cr.for_run_id ? `run #${cr.for_run_id}` : 'this run'}</td>
                  <td className="px-3 py-1.5 text-gray-600">{cr.old_not_applicable ? 'No toll' : cr.old_amount == null ? 'no challan' : `₹ ${nf(cr.old_amount)}`}{cr.old_file_name ? ` · ${cr.old_file_name}` : ''}</td>
                  <td className="px-3 py-1.5 font-semibold">{cr.new_not_applicable ? 'No toll' : `₹ ${nf(cr.new_amount)}`}
                    {cr.has_new_file && <button className="ml-1 text-[#005ba3] underline font-normal" onClick={() => downloadProposed(cr)}>{cr.new_file_name}</button>}</td>
                  <td className="px-3 py-1.5 italic text-gray-600">{cr.reason}</td>
                  <td className="px-3 py-1.5">{cr.requested_by_name}<div className="text-[10px] text-gray-400">{fmtDate(String(cr.created_at).slice(0, 10))}</div></td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${cr.status === 'pending' ? 'bg-amber-100 text-amber-800' : cr.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{cr.status}</span>
                    {cr.decided_by_name && <div className="text-[10px] text-gray-400">{cr.decided_by_name}{cr.decision_note ? ` · ${cr.decision_note}` : ''}</div>}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {cr.status === 'pending' && changeReqs.is_approver && (<>
                      <button className="text-[11px] px-2 py-0.5 rounded bg-green-600 text-white mr-1" onClick={() => decideReq(cr.id, 'approve')}>Approve</button>
                      <button className="text-[11px] px-2 py-0.5 rounded bg-red-600 text-white" onClick={() => decideReq(cr.id, 'reject')}>Reject</button>
                    </>)}
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

// Type-to-search, multi-select vendor filter — scopes Push to Vendors and
// the Report download to only the selected vendor(s). Empty = all vendors.
// Admin-only switch: while off, all vendor-facing tanker-card emails (Push
// to Vendors + final approval) are diverted to one inbox instead of real
// vendor addresses — used to trial-run billing against real data without
// contacting vendors. Approver/biller notification emails are unaffected.
function VendorEmailToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['billing-vendor-email-settings'],
    queryFn: () => api.get('/billing/vendor-email-settings').then(r => r.data),
  });
  const [redirectTo, setRedirectTo] = useState('');
  useEffect(() => { if (data?.redirect_to !== undefined) setRedirectTo(data.redirect_to); }, [data?.redirect_to]);

  const save = useMutation({
    mutationFn: body => api.put('/billing/vendor-email-settings', body),
    onSuccess: r => {
      qc.setQueryData(['billing-vendor-email-settings'], r.data);
      toast.success(r.data.enabled ? 'Vendor emails are now ON — real vendors will receive mail' : 'Vendor emails are now OFF — diverted to the redirect address');
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  if (!data) return null;
  return (
    <div className="card p-3 flex flex-wrap items-center gap-3 text-xs"
         style={{ background: data.enabled ? '#eafbea' : '#fef2f2', border: `1px solid ${data.enabled ? '#86d992' : '#f0b4ae'}` }}>
      <label className="flex items-center gap-2 cursor-pointer select-none font-semibold"
             style={{ color: data.enabled ? '#0a7a1e' : '#a3231d' }}>
        <input type="checkbox" checked={!!data.enabled}
               onChange={e => save.mutate({ enabled: e.target.checked, redirect_to: redirectTo })}
               disabled={save.isPending}/>
        Vendor emails: {data.enabled ? 'ON — sent to real vendors' : 'OFF — diverted for trial run'}
      </label>
      {!data.enabled && (<>
        <span className="text-gray-500">Redirect address:</span>
        <input type="email" className="input text-xs py-1 px-2 w-64" value={redirectTo}
               onChange={e => setRedirectTo(e.target.value)} placeholder="you@shreejamilk.com"/>
        <button className="btn-secondary text-xs" disabled={save.isPending}
                onClick={() => save.mutate({ enabled: false, redirect_to: redirectTo })}>
          Save address
        </button>
      </>)}
    </div>
  );
}

function VendorFilterPicker({ vendorList, selected, onChange }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const selectedIds = new Set(selected.map(v => v.id));
  const matches = vendorList
    .filter(v => !selectedIds.has(v.id))
    .filter(v => !q.trim() || (v.vendor_name || '').toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 8);
  return (
    <div className="relative">
      <div className="flex items-center gap-1 flex-wrap max-w-md">
        {selected.map(v => (
          <span key={v.id} className="bg-white/20 text-white text-[11px] px-2 py-0.5 rounded-full flex items-center gap-1">
            {v.vendor_name}
            <button onClick={() => onChange(selected.filter(s => s.id !== v.id))} className="hover:text-red-200">×</button>
          </span>
        ))}
        <input type="text" placeholder={selected.length ? 'add vendor…' : 'Filter by vendor…'}
               className="input text-xs py-1 px-2 w-40" value={q}
               onFocus={() => setOpen(true)} onChange={e => { setQ(e.target.value); setOpen(true); }}
               onBlur={() => setTimeout(() => setOpen(false), 150)}/>
        {selected.length > 0 && (
          <button className="text-[11px] text-white/80 underline" onClick={() => onChange([])}>clear</button>
        )}
      </div>
      {open && (
        <div className="absolute left-0 top-8 z-10 bg-white border border-gray-200 rounded shadow-lg w-64 max-h-48 overflow-y-auto text-xs">
          {matches.length === 0 && <div className="px-3 py-2 text-gray-400">No matching vendor.</div>}
          {matches.map(v => (
            <button key={v.id} className="w-full text-left px-3 py-1.5 hover:bg-blue-50"
                    onClick={() => { onChange([...selected, v]); setQ(''); setOpen(false); }}>
              {v.vendor_name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Inline searchable vendor picker for a tanker with no vendor mapped —
// shown on the Vendor Wise tab so the biller can fix it without leaving
// the billing screen. Searches vendor name, code and email.
function VendorAssignRow({ tankerNumber, vendorList, onAssign, pending }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const matches = q.trim()
    ? vendorList.filter(v => [v.vendor_name, v.vendor_code, v.email].some(f => (f || '').toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 8)
    : vendorList.slice(0, 8);
  return (
    <div className="flex items-center gap-2 relative">
      <span className="font-semibold text-[#005ba3] text-xs w-32">{tankerNumber}</span>
      <input type="text" className="input text-xs py-1 px-2 w-72" placeholder="Search vendor by name, code or email…"
             value={q} onFocus={() => setOpen(true)}
             onChange={e => { setQ(e.target.value); setOpen(true); }} disabled={pending}/>
      {open && (
        <div className="absolute left-32 top-7 z-10 bg-white border border-gray-200 rounded shadow-lg w-96 max-h-48 overflow-y-auto text-xs">
          {matches.length === 0 && <div className="px-3 py-2 text-gray-400">No matching vendor.</div>}
          {matches.map(v => (
            <button key={v.id} className="w-full text-left px-3 py-1.5 hover:bg-blue-50 flex flex-col"
                    onClick={() => { onAssign(v.id); setQ(''); setOpen(false); }}>
              <span className="font-semibold">{v.vendor_name} <span className="text-gray-400 font-normal">({v.vendor_code})</span></span>
              <span className="text-gray-500">{v.email || 'no email in Vendor master'}</span>
            </button>
          ))}
          <button className="w-full text-center px-3 py-1 text-gray-400 hover:bg-gray-50 border-t" onClick={() => setOpen(false)}>close</button>
        </div>
      )}
    </div>
  );
}

// Points (BMCU / starting / delivery) without coordinates among the trips of a
// run, or of the fortnight about to be executed. Every leg touching one of
// them gets 0 km ("missing") and no Google reference — fix the master first.
function MissingCoordinates({ runId, from, to }) {
  const [open, setOpen] = useState(false);
  const enabled = !!runId || (!!from && !!to);
  const { data } = useQuery({
    queryKey: ['billing-missing-coords', runId || null, from || null, to || null],
    queryFn: () => api.get('/billing/missing-coordinates', { params: runId ? { run_id: runId } : { from_date: from, to_date: to } }).then(r => r.data),
    enabled,
  });
  if (!enabled || !data) return null;
  const pts = data.points || [];
  if (!pts.length) return (
    <div className="card p-2.5 text-xs" style={{ background: '#edf7ee', border: '1px solid #008300', color: '#1f5e21' }}>
      ✓ Every BMCU, starting point and delivery point on {runId ? 'this run' : 'this fortnight'} has coordinates — Google KM will cover the full round trip.
    </div>);
  const KIND = { bmcu: 'BMCU', starting_point: 'Starting Point', delivery_point: 'Delivery Point' };
  const LINK = { bmcu: '/masters/bmcus', starting_point: '/masters/locations', delivery_point: '/masters/locations' };
  return (
    <div className="card p-3 text-xs" style={{ background: '#fdecec', border: '1px solid #e34948' }}>
      <button className="w-full text-left flex items-center gap-2" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        <span className="font-bold" style={{ color: '#9b1c1c' }}>⚠ {pts.length} location(s) without coordinates</span>
        <span style={{ color: '#57534e' }}>— {data.trips_affected} trip(s) {runId ? 'in this run' : 'in this fortnight'} will have a leg at 0 km and no Google KM reference. Add latitude/longitude in the masters{runId ? ', then click Recalc Distances' : ' before executing'}.</span>
      </button>
      {open && (
        <table className="mt-2 w-full text-xs">
          <thead><tr className="text-left text-gray-500"><th className="pr-3">Type</th><th className="pr-3">Location</th><th className="text-right">Trips</th></tr></thead>
          <tbody>{pts.map(p => (
            <tr key={p.kind + p.id} className="border-t border-red-100">
              <td className="pr-3 py-0.5">{KIND[p.kind]}</td>
              <td className="pr-3 py-0.5"><a className="text-blue-700 hover:underline" href={LINK[p.kind]} target="_blank" rel="noreferrer">{p.name}</a></td>
              <td className="text-right py-0.5">{p.trips}</td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  );
}

function FragmentRow({ t, editable, expanded, onToggle, val, setEdit, carried,
                       legEdits = {}, setLegEdit, ratePreview, previewRate, onRemove }) {
  // Unsaved rate preview (fetched on state selection) takes display precedence
  const hasPreview = ratePreview !== undefined;
  const effRate = hasPreview ? ratePreview : t.rate_per_km;
  const effBilled = +(val(t, 'billed_km') || 0);
  const effAmount = hasPreview
    ? (effRate != null ? effBilled * effRate : null)
    : t.amount;
  const legs = Array.isArray(t.legs) ? t.legs : (t.legs ? JSON.parse(t.legs) : []);
  const legKm = (l, i) => legEdits[i] !== undefined && legEdits[i] !== '' ? +legEdits[i] : (+l.km || 0);
  const legsTotal = legs.reduce((s, l, i) => s + legKm(l, i), 0);
  const legsEdited = Object.keys(legEdits).length > 0;
  return (<>
    <tr className={`border-t border-gray-100 hover:bg-blue-50/40 ${val(t,'excluded') ? 'opacity-50' : ''}`}>
      <td className="px-2 py-1.5">
        <button onClick={onToggle} className="p-0.5 text-gray-500" title="Show distance legs">
          {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        </button>
      </td>
      <td className="px-2 py-1.5 text-center whitespace-nowrap" title="Exclude this trip from vendor billing (e.g. Sale Tanker trips). ✕ removes it from the run so it carries forward to the next fortnight.">
        <input type="checkbox" checked={!!val(t, 'excluded')} disabled={!editable}
               onChange={e => setEdit(t.id, 'excluded', e.target.checked)}/>
        {editable && onRemove && (
          <button type="button" className="ml-1 text-red-500 hover:text-red-700 font-bold" title="Remove from this run (carries forward to the next fortnight)"
                  onClick={() => onRemove(t)}>✕</button>
        )}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {fmtDate(t.plan_for_date)}
        {carried && <span className="ml-1 px-1 rounded bg-amber-500 text-white text-[10px]" title="Late acknowledgement — carried forward from the previous fortnight">carry-fwd</span>}
      </td>
      <td className="px-2 py-1.5 font-semibold text-[#005ba3] whitespace-nowrap">
        {t.tanker_number}
        {t.is_sale_tanker && <span className="ml-1 px-1 rounded bg-violet-600 text-white text-[10px]" title="Sale Tanker — milk sold directly at the BMCU, not billed to any vendor. Milk still counts in TS/Analytics reports.">Sale</span>}
      </td>
      <td className="px-2 py-1.5 text-right">{t.capacity_litres ? (t.capacity_litres / 1000).toFixed(1) : '—'}</td>
      <td className="px-2 py-1.5">{t.vendor_name || <span className="text-red-600">no vendor</span>}</td>
      <td className="px-2 py-1.5">{t.route_name || '—'}</td>
      <td className="px-2 py-1.5">{t.delivery_point || '—'}</td>
      <td className="px-2 py-1.5 text-center">{t.bmcu_count}</td>
      <td className="px-2 py-1.5 text-right">{nf(t.ack_kgs, 0)}</td>
      <td className="px-2 py-1.5">
        {editable
          ? <select className="input py-0.5 px-1 text-xs" value={val(t, 'state')}
                    onChange={e => { setEdit(t.id, 'state', e.target.value); previewRate(t, e.target.value, val(t, 'transport_type')); }}>
              <option value="">— select —</option>
              {STATES.map(s => <option key={s}>{s}</option>)}
            </select>
          : (t.state || <span className="text-red-600">—</span>)}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {editable
          ? <select className="input py-0.5 px-1 text-xs"
                    title="Auto-derived from BMCU count — biller may override; rate refreshes"
                    value={val(t, 'transport_type')}
                    onChange={e => { setEdit(t.id, 'transport_type', e.target.value); previewRate(t, val(t, 'state'), e.target.value); }}>
              <option>BMCU/CC to Dairy/CC</option>
              <option>Point to Point</option>
            </select>
          : t.transport_type}
      </td>
      <td className="px-2 py-1.5 text-right" title={`Master ${nf(t.master_km)} + Google ${nf(t.google_km)} + Estimated ${nf(t.estimated_km)}`}>
        {nf(t.system_km)}
      </td>
      <td className="px-2 py-1.5 text-right text-green-700" title="Google Routes API distance (part of System KM)">
        {nf(t.google_km)}
      </td>
      <td className="px-2 py-1.5 text-right">
        {editable
          ? <input type="number" step="0.01" className="input py-0.5 px-1 text-xs w-20 text-right"
                   value={val(t, 'billed_km')} onChange={e => setEdit(t.id, 'billed_km', e.target.value)}/>
          : nf(t.billed_km)}
      </td>
      <td className="px-2 py-1.5 text-right" title={hasPreview ? 'Fetched for the selected state — click Save to apply' : undefined}>
        {effRate != null
          ? <span className={hasPreview ? 'text-amber-700 font-semibold' : ''}>{nf(effRate)}</span>
          : <span className="text-red-600">no rate</span>}
      </td>
      <td className={`px-2 py-1.5 text-right font-bold ${hasPreview ? 'text-amber-700' : ''}`}>{nf(effAmount)}</td>
      <td className="px-2 py-1.5">
        {editable
          ? <input type="text" className="input py-0.5 px-1 text-xs w-36" placeholder="remarks"
                   value={val(t, 'remarks')} onChange={e => setEdit(t.id, 'remarks', e.target.value)}/>
          : (t.remarks || '—')}
      </td>
    </tr>
    {expanded && (
      <tr className="bg-gray-50">
        <td/>
        <td colSpan={17} className="px-3 py-2">
          <div className="text-[11px] font-semibold text-gray-600 mb-1">
            Distance legs — Master {nf(t.master_km)} km · Google {nf(t.google_km)} km · Estimated {nf(t.estimated_km)} km ·
            Total {nf(legsTotal)} km
            {legsEdited && <span className="ml-2 text-purple-700">✎ edited — billed km follows the new total on save; remarks mandatory</span>}
          </div>
          <table className="text-[11px]">
            <tbody>
              {legs.map((l, i) => (
                <tr key={i}>
                  <td className="pr-3 py-0.5">{l.from_label}</td>
                  <td className="pr-3 py-0.5">→ {l.to_label}</td>
                  <td className="pr-3 py-0.5 text-right font-semibold">
                    {editable
                      ? <input type="number" step="0.01" min="0"
                               className="input py-0 px-1 text-[11px] w-20 text-right"
                               value={legEdits[i] !== undefined ? legEdits[i] : (l.km ?? '')}
                               onChange={e => setLegEdit(t.id, i, e.target.value)}/>
                      : <>{nf(l.km)} km</>}
                  </td>
                  <td className="pr-3 py-0.5">
                    <span className={`px-1.5 rounded text-white text-[10px] ${
                      legEdits[i] !== undefined || l.source === 'manual' ? 'bg-purple-600'
                      : l.source === 'master' ? 'bg-blue-600' : l.source === 'google' ? 'bg-green-600'
                      : l.source === 'estimated' ? 'bg-amber-500' : 'bg-red-500'}`}>
                      {legEdits[i] !== undefined || l.source === 'manual' ? 'manual' : l.source}
                    </span>
                  </td>
                  <td className="pr-3 py-0.5">
                    {l.is_new && <span className="px-1.5 rounded text-white text-[10px]" style={{ background: '#c98500' }}
                                       title="This pair was not in the KM Master when the run executed — approval of the run approves this combination">new combo</span>}
                  </td>
                  <td className="pr-3 py-0.5 text-gray-400">
                    {l.orig_km != null && <span title="Original system distance">was {nf(l.orig_km)} km</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </td>
      </tr>
    )}
  </>);
}


// ── Cross-run Payment Report: date range + filters, results across runs ──────
function PaymentReport() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = hasRole(user, 'admin');
  // Period = a fortnight or a full month (finance, 2026-10-08): tolls are per
  // fortnight, so a free date range cannot be reconciled.
  const [month, setMonth] = useState('');       // 'YYYY-MM'
  const [part, setPart] = useState('full');     // '1' | '2' | 'full'
  const periodDates = () => {
    if (!month) return null;
    const [y, m] = month.split('-').map(Number);
    const end = String(new Date(y, m, 0).getDate()).padStart(2, '0');
    if (part === '1') return { from: `${month}-01`, to: `${month}-15` };
    if (part === '2') return { from: `${month}-16`, to: `${month}-${end}` };
    return { from: `${month}-01`, to: `${month}-${end}` };
  };
  const [status, setStatus] = useState('approved');
  const [tab, setTab] = useState('vendors');
  const [params, setParams] = useState(null); // executed filters

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['billing-report', params],
    queryFn: () => api.get('/billing/report-data', { params }).then(r => r.data),
    enabled: !!params,
    retry: false,
  });

  const run = () => {
    const pd = periodDates();
    if (!pd) return toast.error('Select the month');
    setParams({ from: pd.from, to: pd.to, status });
  };
  const excel = () => {
    if (!params) return toast.error('Run the report first');
    api.get('/billing/report-excel', { params, responseType: 'blob' }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `tanker_payment_report_${params.from}_${params.to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    }).catch(async e => {
      let msg = e.message;
      try { msg = JSON.parse(await e.response?.data?.text?.())?.error || msg; } catch { /* not JSON */ }
      toast.error(msg);
    });
  };
  const rows = tab === 'dates' ? data?.dates : tab === 'tankers' ? data?.tankers : tab === 'vendors' ? data?.vendors : null;

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
        <label>Month *<input type="month" className="input mt-1" value={month} onChange={e => setMonth(e.target.value)}/></label>
        <label>Period *
          <select className="input mt-1" value={part} onChange={e => setPart(e.target.value)}>
            <option value="1">1st fortnight (1 – 15)</option>
            <option value="2">2nd fortnight (16 – month end)</option>
            <option value="full">Full month</option>
          </select>
        </label>
        <label>Runs
          <select className="input mt-1" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="approved">Approved only (payable)</option>
            <option value="all">All runs (any status)</option>
          </select>
        </label>
        <button className="btn-primary text-xs" onClick={run}>{isFetching ? 'Loading…' : 'Run Report'}</button>
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={excel}><Download size={12}/> Excel</button>
      </div>

      {data && (
        <>
          <div className="flex gap-2">
            {[['vendors', 'Vendor Wise'], ['tankers', 'Tanker Wise'], ['dates', 'Date Wise'], ['trips', 'Trip Wise'], ['months', `Month Cumulative FY ${data.fy_label || ''}`], ['years', 'Year Cumulative']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                className="text-xs px-3 py-1.5 rounded-lg font-semibold"
                style={tab === k ? { background: '#4a3aa7', color: '#fff' } : { background: '#fff', color: '#57534e' }}>
                {l}
              </button>
            ))}
            <span className="text-xs text-white/90 self-center">
              {data.trips.length} trips · ₹ {nf(data.trips.reduce((s, t) => s + (+t.amount || 0), 0))}
            </span>
          </div>

          {tab === 'months' && <CumulativeMonths months={data.months} total={data.months_total}/>}
          {tab === 'years' && <CumulativeYears years={data.years} isAdmin={isAdmin} onHistoryChanged={() => qc.invalidateQueries({ queryKey: ['billing-report'] })}/>}

          {!['trips', 'months', 'years'].includes(tab) && (() => {
            const withToll = tab === 'tankers' || tab === 'vendors';
            const fmtDateDot = d => fmtDate(d).replace(/-/g, '.'); // Date Wise shows DD.MM.YYYY (finance, 2026-10-08)
            const fortnights = tab === 'dates' ? (data.fortnights || []) : [];
            return (
            <div className="card overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-blue-50 text-left text-gray-600">
                  <tr>{[tab === 'dates' ? 'Date' : tab === 'tankers' ? 'Tanker' : 'Vendor',
                        tab === 'tankers' ? 'Vendor' : 'Tankers', 'Trips',
                        'Billed KM', 'Amount (₹)',
                        ...(withToll || tab === 'dates' ? ['Toll (₹)', 'Total Payable (₹)'] : [])]
                        .map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {(rows || []).map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 font-semibold">{tab === 'dates' ? fmtDateDot(r.date) : (r.tanker_number || r.vendor_name)}</td>
                      <td className="px-3 py-1.5">{tab === 'tankers' ? r.vendor_name : r.tankers}</td>
                      <td className="px-3 py-1.5 text-right">{r.trips}</td>
                      <td className="px-3 py-1.5 text-right">{nf(r.billed_km)}</td>
                      <td className="px-3 py-1.5 text-right font-bold text-[#005ba3]">{nf(r.amount)}</td>
                      {withToll && <td className="px-3 py-1.5 text-right">{nf(r.toll_amount)}</td>}
                      {withToll && <td className="px-3 py-1.5 text-right font-bold text-[#005ba3]">{nf(r.total_payable)}</td>}
                      {tab === 'dates' && <td/>}{tab === 'dates' && <td/>}
                    </tr>
                  ))}
                  {/* Date Wise: one subtotal row per billing run (fortnight) carrying that run's toll — tolls are per run, never per day. */}
                  {fortnights.map(f => (
                    <tr key={f.run_id} className="bg-amber-50 font-semibold border-t border-amber-200">
                      <td className="px-3 py-1.5 whitespace-nowrap">Run #{f.run_id} · {fmtDateDot(f.from_date)} → {fmtDateDot(f.to_date)}</td>
                      <td className="px-3 py-1.5">{f.tankers}</td>
                      <td className="px-3 py-1.5 text-right">{f.trips}</td>
                      <td className="px-3 py-1.5 text-right">{nf(f.billed_km)}</td>
                      <td className="px-3 py-1.5 text-right text-[#005ba3]">{nf(f.amount)}</td>
                      <td className="px-3 py-1.5 text-right">{nf(f.toll_amount)}</td>
                      <td className="px-3 py-1.5 text-right text-[#005ba3]">{nf(f.total_payable)}</td>
                    </tr>
                  ))}
                  <tr className="bg-blue-100 font-bold">
                    <td className="px-3 py-2">TOTAL</td><td/>
                    <td className="px-3 py-2 text-right">{(rows || []).reduce((s, r) => s + (+r.trips || 0), 0)}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.billed_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right text-[#005ba3]">{nf((rows || []).reduce((s, r) => s + (+r.amount || 0), 0))}</td>
                    {(withToll || tab === 'dates') && <td className="px-3 py-2 text-right">{nf((withToll ? rows || [] : fortnights).reduce((s, r) => s + (+r.toll_amount || 0), 0))}</td>}
                    {(withToll || tab === 'dates') && <td className="px-3 py-2 text-right text-[#005ba3]">{nf((withToll ? rows || [] : fortnights).reduce((s, r) => s + (+r.total_payable || 0), 0))}</td>}
                  </tr>
                </tbody>
              </table>
            </div>
            );
          })()}

          {tab === 'trips' && (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto max-h-[60vh]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
                    <tr>{['Date', 'Run #', 'Status', 'Tanker', 'SAP Code', 'Vendor', 'Route', 'Delivery Point', 'State',
                          'Transport Type', 'Billed KM', 'Rate/KM', 'Amount (₹)', 'Qty Lts', 'Qty Kgs', 'Fat %', 'SNF %', 'Cost/Ltr', 'Util %', 'BMCUs', 'Remarks']
                          .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.trips.map((t, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-2 py-1.5 whitespace-nowrap">{fmtDate(t.plan_for_date)}</td>
                        <td className="px-2 py-1.5">#{t.run_id}</td>
                        <td className="px-2 py-1.5">{t.run_status}</td>
                        <td className="px-2 py-1.5 font-semibold text-[#005ba3]">{t.tanker_number}</td>
                        <td className="px-2 py-1.5 font-mono">{t.vendor_sap_code || '—'}</td>
                        <td className="px-2 py-1.5">{t.vendor_name}</td>
                        <td className="px-2 py-1.5">{t.route_name || '—'}</td>
                        <td className="px-2 py-1.5">{t.delivery_point || '—'}</td>
                        <td className="px-2 py-1.5">{t.state || '—'}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{t.transport_type}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.billed_km)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.rate_per_km)}</td>
                        <td className="px-2 py-1.5 text-right font-bold">{nf(t.amount)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.milk_litres)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.milk_kgs)}</td>
                        <td className="px-2 py-1.5 text-right">{t.fat_pct ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right">{t.snf_pct ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right">{t.cost_per_litre ?? '—'}</td>
                        <td className="px-2 py-1.5 text-right">{t.utilisation_pct ?? '—'}</td>
                        <td className="px-2 py-1.5 max-w-[16rem] truncate" title={t.bmcu_coverage || ''}>{t.bmcu_coverage || '—'}</td>
                        <td className="px-2 py-1.5">{t.remarks || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
      {!data && params && isFetching && <div className="text-white/90 text-sm">Loading…</div>}
      {isError && <div className="card p-3 text-sm text-red-600">{error?.response?.data?.error || error?.message}</div>}
    </div>
  );
}


// ── Month Cumulative (financial year of the From date) ───────────────────────
const MC_COLS = [
  ['Tankers capacity (L)', 'capacity_litres', 0], ['Milk received (L)', 'milk_litres', 0], ['Milk received (kg)', 'milk_kgs', 0],
  ['Fat %', 'fat_pct', 3], ['SNF %', 'snf_pct', 3], ['TS %', 'ts_pct', 3], ['Fat kgs', 'kg_fat', 0], ['SNF kgs', 'kg_snf', 0],
  ['Total KM', 'total_km', 0], ['Rate/KM', 'rate_per_km', 2], ['Amount (₹)', 'amount', 0], ['Cost/Ltr', 'cost_per_litre', 4],
  ['Util %', 'utilisation_pct', 2], ['Trips', 'trips', 0], ['Avg KM', 'avg_km', 2], ['Diesel Price', 'diesel_sum', 2], ['Diesel Rate', 'diesel_price', 2],
];
function CumulativeMonths({ months, total }) {
  const cell = (m, k, d) => m[k] == null ? '—' : nf(m[k], d);
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-blue-50 text-left text-gray-600">
            <tr><th className="px-2 py-2">Month</th>{MC_COLS.map(c => <th key={c[1]} className="px-2 py-2 text-right whitespace-nowrap">{c[0]}</th>)}<th className="px-2 py-2">Source</th></tr>
          </thead>
          <tbody>
            {(months || []).map(m => (
              <tr key={m.month} className={`border-t border-gray-100 ${!m.trips && !m.source ? 'text-gray-400' : ''}`}>
                <td className="px-2 py-1.5 whitespace-nowrap font-semibold">{m.month_name.slice(0, 3)} {m.year}</td>
                {MC_COLS.map(c => <td key={c[1]} className="px-2 py-1.5 text-right">{cell(m, c[1], c[2])}</td>)}
                <td className="px-2 py-1.5 text-gray-500">{m.source || ''}</td>
              </tr>
            ))}
            {total && (
              <tr className="bg-blue-100 font-bold"><td className="px-2 py-2">TOTAL / YTD</td>
                {MC_COLS.map(c => <td key={c[1]} className="px-2 py-2 text-right">{cell(total, c[1], c[2])}</td>)}<td/></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-500">Milk received = plant acknowledgements of the billed trips; amount and km from the billing lines; diesel = average of the Diesel Rates master over the month. Months before the portal come from the keyed monthly history (Year Cumulative tab).</div>
    </div>
  );
}

// ── Year Cumulative (month × FY matrix with YTD) + history upload (admin) ────
const YC_ROWS = [
  ['Tanker capacities (L)', 'capacity_litres', 0], ['Milk received (L)', 'milk_litres', 0], ['Milk received (kg)', 'milk_kgs', 0],
  ['Fat %', 'fat_pct', 3], ['SNF %', 'snf_pct', 3], ['TS %', 'ts_pct', 3], ['Kg fat', 'kg_fat', 0], ['Kg SNF', 'kg_snf', 0],
  ['Milk per day (L)', 'milk_per_day', 0], ['Total KM', 'total_km', 0], ['Rate/KM', 'rate_per_km', 2], ['Amount (₹)', 'amount', 0],
  ['Cost/Ltr', 'cost_per_litre', 4], ['Util %', 'utilisation_pct', 2], ['Diesel ₹/L', 'diesel_price', 2], ['Trips', 'trips', 0], ['Avg KM', 'avg_km', 2],
];
function CumulativeYears({ years, isAdmin, onHistoryChanged }) {
  const fileRef = useRef(null);
  const [metric, setMetric] = useState('cost_per_litre');
  const [showAll, setShowAll] = useState(false);
  const months = years?.[0]?.months || [];
  const onUpload = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    api.post('/billing/history-upload', fd).then(r => {
      toast.success(`${r.data.saved} month(s) saved`);
      if (r.data.errors?.length) toast.error(r.data.errors.slice(0, 5).join('\n'), { duration: 9000 });
      onHistoryChanged?.();
    }).catch(err => toast.error(err.response?.data?.error || err.message)).finally(() => { e.target.value = ''; });
  };
  const template = () => api.get('/billing/history-template', { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data); const a = document.createElement('a');
    a.href = url; a.download = 'transport_monthly_history_template.xlsx'; a.click(); URL.revokeObjectURL(url);
  });
  const rowsToShow = showAll ? YC_ROWS : YC_ROWS.filter(r => r[1] === metric);
  const val = (m, k, d) => (m.trips || m.source) && m[k] != null ? nf(m[k], d) : '—';
  return (
    <div className="space-y-2">
      <div className="card p-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold">Metric</span>
        <select className="input text-xs" value={metric} onChange={e => setMetric(e.target.value)} disabled={showAll}>
          {YC_ROWS.map(r => <option key={r[1]} value={r[1]}>{r[0]}</option>)}
        </select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}/> all metrics</label>
        <div className="flex-1"/>
        {isAdmin && (
          <>
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={template}><Download size={12}/> History template</button>
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => fileRef.current?.click()}><Upload size={12}/> Upload earlier years</button>
            <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={onUpload}/>
          </>
        )}
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-blue-50 text-left text-gray-600">
              <tr><th className="px-2 py-2">Metric</th><th className="px-2 py-2">FY</th>
                {months.map(m => <th key={m.month} className="px-2 py-2 text-right">{m.month_name.slice(0, 3)}</th>)}<th className="px-2 py-2 text-right">YTD</th></tr>
            </thead>
            <tbody>
              {rowsToShow.map(([label, k, d]) => (years || []).map((y, yi) => (
                <tr key={k + y.fy_start_year} className={`border-t border-gray-100 ${yi === 0 ? 'border-t-2 border-gray-300' : ''}`}>
                  <td className="px-2 py-1.5 font-semibold whitespace-nowrap">{yi === 0 ? label : ''}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{y.fy_label}</td>
                  {y.months.map(m => <td key={m.month} className="px-2 py-1.5 text-right" title={m.source || ''}>{val(m, k, d)}</td>)}
                  <td className="px-2 py-1.5 text-right font-semibold">{val(y.ytd, k, d)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 text-[11px] text-gray-500">Months in the portal come from billing runs (approved or all, per the filter above); earlier years from the keyed monthly history. A month present in the portal always wins.</div>
      </div>
    </div>
  );
}
