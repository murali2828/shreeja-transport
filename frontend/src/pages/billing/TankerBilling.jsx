// Tanker Payment Billing (biller role): execute a fortnight → trips with
// acknowledgements become billing lines. Per trip: select State (mandatory,
// never prefilled), transport type auto-derived (1 BMCU → Point to Point),
// system km (Master+Google, expandable leg breakdown), editable billed km,
// remarks. Rate applied from Tanker Rates by planning date. Submit → 3-level
// email approval (Mahesh → Krithiga → Thimmappa).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ChevronDown, ChevronRight, Download, Send, Trash2, Play, ArrowLeft } from 'lucide-react';
import api from '../../api';
import { useAuth } from '../../hooks/useAuth';

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
  const canEdit = ['admin', 'biller'].includes(user?.role);
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
    mutationFn: () => api.post(`/billing/runs/${openRunId}/submit`),
    onSuccess: r => {
      if (r.data.carried_forward?.length)
        toast(`⚠ ${r.data.carried_forward.length} tanker(s) had no toll challan — ${r.data.carried_trips} trip(s) removed from this run and will be carried forward: ${r.data.carried_forward.join(', ')}`,
              { duration: 12000, icon: '⚠️' });
      if (r.data.status === 'draft')
        toast.error('No tankers had a valid toll challan — nothing was submitted. Add toll challans and submit again.', { duration: 10000 });
      else
        toast.success('Submitted — approval email sent to Mahesh K (Level 1)');
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-runs']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });

  const pushVendorMut = useMutation({
    mutationFn: () => api.post(`/billing/runs/${openRunId}/push-vendor`),
    onSuccess: r => {
      // Report what actually happened per vendor — a vendor with no email in
      // the Vendor master is silently skipped by the mailer, and the biller
      // must know rather than wait for a verification that never arrives.
      const { sent = 0, failed = 0, results = [] } = r.data || {};
      if (sent > 0) toast.success(`Draft tanker cards emailed to ${sent} vendor(s) for verification`);
      if (failed > 0)
        toast.error(`${failed} vendor(s) NOT emailed:\n${results.filter(x => x.startsWith('✗')).join('\n')}`,
                    { duration: 12000 });
      if (!sent && !failed) toast.error('No vendor emails were sent — nothing payable in this run');
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

  // Trip report for one run — works at every status (draft, awaiting vendor
  // verification, under approval, approved), so a run in the payment process
  // can be reviewed at any time. Sheets: Trip Wise (payable trips only),
  // Tanker/Vendor/Date Wise, Sale Tankers (not payable), Toll Challans.
  const downloadRunReport = (runId, meta) =>
    api.get(`/billing/runs/${runId}/report`, { responseType: 'blob' }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = meta?.from_date
        ? `tanker_billing_run_${runId}_${meta.from_date}_${meta.to_date}.xlsx`
        : `tanker_billing_run_${runId}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    }).catch(e => toast.error(e.response?.data?.error || e.message));
  const downloadReport = () => downloadRunReport(openRunId, run);

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
                  <td className="px-3 py-2">{r.from_date} → {r.to_date}</td>
                  <td className="px-3 py-2">{r.trip_count}</td>
                  <td className="px-3 py-2 text-right font-semibold">{nf(r.total_amount)}</td>
                  <td className="px-3 py-2"><span className="font-semibold" style={{ color }}>{label}</span></td>
                  <td className="px-3 py-2">{r.created_by_name || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {/* Report of this run's trips — available at ANY status, so a
                        run still under vendor verification or approval can be
                        reviewed without opening it. */}
                    <button className="p-1 text-gray-400 hover:text-[#005ba3]" title="Download this run's trip report (Excel)"
                            onClick={e => { e.stopPropagation(); downloadRunReport(r.id, r); }}>
                      <Download size={13}/>
                    </button>
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
  // Sale-tanker trips are milk SOLD, not moved for us: they carry no vendor
  // payment, so they live in their own tab and never appear in Trip Wise or
  // in any payment total. (The milk itself is still reported in TS/Analytics,
  // which read trip data directly and are untouched by billing.)
  const payableTrips = trips.filter(t => !t.is_sale_tanker);
  const saleTrips    = trips.filter(t => t.is_sale_tanker);
  const filteredTrips = payableTrips.filter(t =>
    (!searchRoute || (t.route_name || '').toLowerCase().includes(searchRoute.toLowerCase())) &&
    (!searchTanker || (t.tanker_number || '').toLowerCase().includes(searchTanker.toLowerCase())));
  const missing = payableTrips.filter(t => !val(t, 'state') || t.rate_per_km == null).length;
  const newComboCount = trips.reduce((s, t) => {
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
            {run?.from_date} → {run?.to_date} · {payableTrips.length} acknowledged trips
            {saleTrips.length > 0 && ` · ${saleTrips.length} sale tanker trips (not payable)`}
            {isFetching && ' · loading…'}
          </p>
        </div>
        <span className="px-3 py-1 rounded-full text-xs font-bold text-white" style={{ background: color }}>{label}</span>
        <div className="flex-1" />
        <div className="text-right text-white">
          <div className="text-[11px] opacity-85">Total Payable</div>
          <div className="text-xl font-bold">₹ {nf(run?.total_amount)}</div>
        </div>
        <button className="btn-secondary text-xs flex items-center gap-1.5" onClick={downloadReport}>
          <Download size={13}/> Report
        </button>
        {editable && ['draft', 'rejected'].includes(run.status) && (
          <button className="btn-secondary text-xs flex items-center gap-1.5" disabled={pushVendorMut.isPending}
                  title="Email draft tanker cards to each vendor for review before final submission"
                  onClick={() => window.confirm('Email DRAFT tanker cards to all vendors on this run for verification?') && pushVendorMut.mutate()}>
            <Send size={13}/> {pushVendorMut.isPending ? 'Sending…' : 'Push to Vendors'}
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
                  title={missing ? `${missing} trip(s) missing state/rate` : 'Send to Level 1 approver'}
                  onClick={() => {
                    if (Object.keys(edits).length) return toast.error('Save your changes first');
                    window.confirm(`Submit ₹ ${nf(run?.total_amount)} for approval? Email goes to Mahesh K (L1).`) && submitMut.mutate();
                  }}>
            <Send size={13}/> Submit for Approval
          </button>
        </>)}
      </div>

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

      {/* What is actually under payment in this run — visible at every status,
          so a run awaiting vendor verification or approval can be reviewed. */}
      <div className="card p-3 flex flex-wrap gap-6 text-xs">
        <div>
          <div className="text-gray-500">Under payment process</div>
          <div className="font-bold text-sm text-[#005ba3]">
            {payableTrips.filter(t => !val(t, 'excluded')).length} trips · ₹ {nf(
              payableTrips.reduce((s, t) => s + (val(t, 'excluded') ? 0 : (+t.amount || 0)), 0))}
          </div>
        </div>
        <div>
          <div className="text-gray-500">Billed KM</div>
          <div className="font-bold text-sm">{nf(
            payableTrips.reduce((s, t) => s + (val(t, 'excluded') ? 0 : (+(edits[t.id]?.billed_km ?? t.billed_km) || 0)), 0))}</div>
        </div>
        <div>
          <div className="text-gray-500">Excluded by biller</div>
          <div className="font-bold text-sm">{payableTrips.filter(t => val(t, 'excluded')).length} trips</div>
        </div>
        <div>
          <div className="text-gray-500">Sale tankers (not payable)</div>
          <div className="font-bold text-sm text-violet-700">
            {saleTrips.length} trips · {nf(saleTrips.reduce((s, t) => s + (+t.ack_kgs || 0), 0), 0)} kgs
          </div>
        </div>
        {missing > 0 && (
          <div>
            <div className="text-gray-500">Needs attention</div>
            <div className="font-bold text-sm text-red-600">{missing} trips missing state / rate</div>
          </div>
        )}
        <div className="flex-1" />
        <button className="btn-secondary text-xs flex items-center gap-1.5 self-center" onClick={downloadReport}>
          <Download size={13}/> Download trip report
        </button>
      </div>

      {/* tabs */}
      <div className="flex gap-2 items-center flex-wrap">
        {[['trips', 'Trip Wise'], ['dates', 'Date Wise'], ['tankers', 'Tanker Wise'], ['vendors', 'Vendor Wise'],
          ['sale', `Sale Tankers${saleTrips.length ? ` (${saleTrips.length})` : ''}`], ['tolls', 'Toll Challans']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className="text-xs px-3 py-1.5 rounded-lg font-semibold"
            style={tab === k ? { background: '#cc785c', color: '#fff' } : { background: '#fff', color: '#57534e' }}>
            {l}
          </button>
        ))}
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
                    carried={run?.from_date && t.plan_for_date < run.from_date}
                    onToggle={() => setExpanded(p => ({ ...p, [t.id]: !p[t.id] }))}
                    val={val} setEdit={setEdit}
                    legEdits={edits[t.id]?.legs || {}} setLegEdit={setLegEdit}
                    ratePreview={ratePreviews[t.id]} previewRate={previewRate} />
                ))}
                {filteredTrips.length === 0 && (
                  <tr><td colSpan={18} className="px-3 py-4 text-center text-gray-400">No trips match this search.</td></tr>
                )}
                <tr className="bg-blue-100 font-bold">
                  <td className="px-2 py-2" colSpan={12}>
                    TOTAL — {filteredTrips.length}{filteredTrips.length !== payableTrips.length ? ` of ${payableTrips.length}` : ''} trips
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

      {tab === 'tolls' && (
        <TollPanel runId={openRunId} tolls={run?.tolls || []} tankers={summary?.tankers || []} editable={editable}/>
      )}

      {/* Sale tankers — milk sold at the BMCU. Never payable to a transport
          vendor, so this tab is read-only: no state, rate or amount. The milk
          still flows into TS / Analytics reports as usual. */}
      {tab === 'sale' && (
        <div className="card overflow-hidden">
          <div className="px-3 py-2 text-xs" style={{ background: '#f5f3ff', color: '#4a3aa7' }}>
            These trips ran on a <b>sale tanker</b> (milk sold, not moved for us). They are
            <b> not counted in the tanker payment run</b> — no state, rate or amount applies and they are
            never sent to a transport vendor. The milk continues to be reported in TS / Analytics as usual.
          </div>
          <div className="overflow-x-auto max-h-[62vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
                <tr>{['Date', 'Tanker', 'Cap (KL)', 'Vendor', 'Route', 'Delivery Point', 'BMCUs', 'Ack Kgs',
                      'System KM', 'Google KM', 'Remarks']
                     .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {saleTrips.map(t => (
                  <tr key={t.id} className="border-t border-gray-100 hover:bg-violet-50/40">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {t.plan_for_date}
                      {run?.from_date && t.plan_for_date < run.from_date &&
                        <span className="ml-1 px-1 rounded bg-amber-500 text-white text-[10px]" title="Carried forward from the previous fortnight">carry-fwd</span>}
                    </td>
                    <td className="px-2 py-1.5 font-semibold text-[#005ba3] whitespace-nowrap">
                      {t.tanker_number}
                      <span className="ml-1 px-1 rounded bg-violet-600 text-white text-[10px]">Sale</span>
                    </td>
                    <td className="px-2 py-1.5 text-right">{t.capacity_litres ? (t.capacity_litres / 1000).toFixed(1) : '—'}</td>
                    <td className="px-2 py-1.5">{t.vendor_name || '—'}</td>
                    <td className="px-2 py-1.5">{t.route_name || '—'}</td>
                    <td className="px-2 py-1.5">{t.delivery_point || '—'}</td>
                    <td className="px-2 py-1.5 text-center">{t.bmcu_count}</td>
                    <td className="px-2 py-1.5 text-right">{nf(t.ack_kgs, 0)}</td>
                    <td className="px-2 py-1.5 text-right">{nf(t.system_km)}</td>
                    <td className="px-2 py-1.5 text-right text-green-700">{nf(t.google_km)}</td>
                    <td className="px-2 py-1.5">{t.remarks || '—'}</td>
                  </tr>
                ))}
                {saleTrips.length === 0 && (
                  <tr><td colSpan={11} className="px-3 py-4 text-center text-gray-400">No sale tanker trips in this run.</td></tr>
                )}
                <tr className="bg-violet-100 font-bold">
                  <td className="px-2 py-2" colSpan={7}>TOTAL — {saleTrips.length} sale tanker trips (not payable)</td>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+t.ack_kgs || 0), 0), 0)}</td>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+t.system_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(saleTrips.reduce((s, t) => s + (+t.google_km || 0), 0))}</td>
                  <td/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab !== 'trips' && tab !== 'tolls' && tab !== 'sale' && (() => {
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

// One toll-gate challan (document + amount) per tanker for the whole
// fortnight; the amount is reimbursed to the vendor on top of trip amounts.
function TollPanel({ runId, tolls, tankers, editable }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({}); // tanker -> {amount, remarks, file}
  const byTanker = new Map(tolls.map(t => [t.tanker_number, t]));
  const setF = (tn, k, v) => setForm(p => ({ ...p, [tn]: { ...p[tn], [k]: v } }));
  const refresh = () => {
    qc.invalidateQueries(['billing-run', runId]);
    qc.invalidateQueries(['billing-summary']);
    qc.invalidateQueries(['billing-runs']);
  };
  const save = tn => {
    const f = form[tn] || {};
    const existing = byTanker.get(tn);
    const amount = f.amount !== undefined ? f.amount : existing?.amount;
    if (amount === undefined || amount === '' || +amount < 0)
      return toast.error('Enter the toll challan amount');
    const fd = new FormData();
    fd.append('tanker_number', tn);
    fd.append('amount', amount);
    fd.append('remarks', f.remarks !== undefined ? f.remarks : (existing?.remarks || ''));
    if (f.file) fd.append('file', f.file);
    api.post(`/billing/runs/${runId}/tolls`, fd)
      .then(() => { toast.success(`Toll challan saved for ${tn}`); setForm(p => ({ ...p, [tn]: undefined })); refresh(); })
      .catch(e => toast.error(e.response?.data?.error || e.message));
  };
  const del = tn => {
    const ex = byTanker.get(tn);
    if (!ex) return;
    window.confirm(`Remove the toll challan for ${tn}?`) &&
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
        <span>One challan per tanker for the fortnight (PDF/JPG/PNG, max 5 MB). The amount is added to the
        vendor's payable and goes through the same approval chain. · Total tolls: <b>₹ {nf(tollTotal)}</b></span>
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
                  {ex?.has_file && (
                    <button className="text-[#005ba3] underline mr-2" onClick={() => download(ex)}>
                      {ex.file_name || 'challan'}
                    </button>
                  )}
                  {editable && (
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-[11px]"
                           onChange={e => setF(t.tanker_number, 'file', e.target.files[0])}/>
                  )}
                  {!ex?.has_file && !editable && '—'}
                </td>
                <td className="px-3 py-1.5">
                  {editable
                    ? <input type="text" className="input py-0.5 px-1 text-xs w-40" placeholder="remarks"
                             value={f.remarks !== undefined ? f.remarks : (ex?.remarks ?? '')}
                             onChange={e => setF(t.tanker_number, 'remarks', e.target.value)}/>
                    : (ex?.remarks || '—')}
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {editable && (<>
                    <button className="btn-secondary text-[11px] px-2 py-0.5 mr-1" onClick={() => save(t.tanker_number)}>
                      {ex ? 'Update' : 'Save'}
                    </button>
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
        </tbody>
      </table>
    </div>
  );
}

function FragmentRow({ t, editable, expanded, onToggle, val, setEdit, carried,
                       legEdits = {}, setLegEdit, ratePreview, previewRate }) {
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
      <td className="px-2 py-1.5 text-center" title="Exclude this trip from vendor billing (e.g. Sale Tanker trips)">
        <input type="checkbox" checked={!!val(t, 'excluded')} disabled={!editable}
               onChange={e => setEdit(t.id, 'excluded', e.target.checked)}/>
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {t.plan_for_date}
        {carried && <span className="ml-1 px-1 rounded bg-amber-500 text-white text-[10px]" title="Late acknowledgement — carried forward from the previous fortnight">carry-fwd</span>}
      </td>
      <td className="px-2 py-1.5 font-semibold text-[#005ba3] whitespace-nowrap">
        {t.tanker_number}
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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('approved');
  const [tanker, setTanker] = useState('');
  const [vendor, setVendor] = useState('');
  const [tab, setTab] = useState('vendors');
  const [params, setParams] = useState(null); // executed filters

  const { data, isFetching } = useQuery({
    queryKey: ['billing-report', params],
    queryFn: () => api.get('/billing/report-data', { params }).then(r => r.data),
    enabled: !!params,
  });

  const run = () => {
    if (!from || !to) return toast.error('Select From and To dates');
    setParams({ from, to, status, tanker: tanker || undefined, vendor: vendor || undefined });
  };
  const excel = () => {
    if (!params) return toast.error('Run the report first');
    api.get('/billing/report-excel', { params, responseType: 'blob' }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `tanker_payment_report_${params.from}_${params.to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    });
  };

  const tankerOpts = [...new Set((data?.tankers || []).map(t => t.tanker_number))];
  const vendorOpts = [...new Set((data?.vendors || []).map(v => v.vendor_name))];
  const rows = tab === 'dates' ? data?.dates : tab === 'tankers' ? data?.tankers : tab === 'vendors' ? data?.vendors : null;

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-end gap-2 text-xs">
        <label>From *<input type="date" className="input mt-1" value={from} onChange={e => setFrom(e.target.value)}/></label>
        <label>To *<input type="date" className="input mt-1" value={to} min={from} onChange={e => setTo(e.target.value)}/></label>
        <label>Runs
          <select className="input mt-1" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="approved">Approved only (payable)</option>
            <option value="all">All runs (any status)</option>
          </select>
        </label>
        <label>Tanker
          <select className="input mt-1" value={tanker} onChange={e => setTanker(e.target.value)}>
            <option value="">All</option>
            {tankerOpts.map(t => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Vendor
          <select className="input mt-1" value={vendor} onChange={e => setVendor(e.target.value)}>
            <option value="">All</option>
            {vendorOpts.map(v => <option key={v}>{v}</option>)}
          </select>
        </label>
        <button className="btn-primary text-xs" onClick={run}>{isFetching ? 'Loading…' : 'Run Report'}</button>
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={excel}><Download size={12}/> Excel</button>
      </div>

      {data && (
        <>
          <div className="flex gap-2">
            {[['vendors', 'Vendor Wise'], ['tankers', 'Tanker Wise'], ['dates', 'Date Wise'], ['trips', 'Trip Wise']].map(([k, l]) => (
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

          {tab !== 'trips' && (() => {
            const withToll = tab === 'tankers' || tab === 'vendors';
            return (
            <div className="card overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-blue-50 text-left text-gray-600">
                  <tr>{[tab === 'dates' ? 'Date' : tab === 'tankers' ? 'Tanker' : 'Vendor',
                        tab === 'tankers' ? 'Vendor' : 'Tankers', 'Trips',
                        'Billed KM', 'System KM', 'Google KM', 'Amount (₹)',
                        ...(withToll ? ['Toll (₹)', 'Total Payable (₹)'] : [])]
                        .map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {(rows || []).map((r, i) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="px-3 py-1.5 font-semibold">{r.date || r.tanker_number || r.vendor_name}</td>
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
                    <td className="px-3 py-2">TOTAL</td><td/>
                    <td className="px-3 py-2 text-right">{(rows || []).reduce((s, r) => s + (+r.trips || 0), 0)}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.billed_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.system_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.google_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right text-[#005ba3]">{nf((rows || []).reduce((s, r) => s + (+r.amount || 0), 0))}</td>
                    {withToll && <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.toll_amount || 0), 0))}</td>}
                    {withToll && <td className="px-3 py-2 text-right text-[#005ba3]">{nf((rows || []).reduce((s, r) => s + (+r.total_payable || 0), 0))}</td>}
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
                    <tr>{['Date', 'Run #', 'Status', 'Tanker', 'Vendor', 'Route', 'Delivery Point', 'State',
                          'Transport Type', 'System KM', 'Google KM', 'Billed KM', 'Rate/KM', 'Amount (₹)', 'Remarks']
                          .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {data.trips.map((t, i) => (
                      <tr key={i} className="border-t border-gray-100">
                        <td className="px-2 py-1.5 whitespace-nowrap">{t.plan_for_date}</td>
                        <td className="px-2 py-1.5">#{t.run_id}</td>
                        <td className="px-2 py-1.5">{t.run_status}</td>
                        <td className="px-2 py-1.5 font-semibold text-[#005ba3]">{t.tanker_number}</td>
                        <td className="px-2 py-1.5">{t.vendor_name}</td>
                        <td className="px-2 py-1.5">{t.route_name || '—'}</td>
                        <td className="px-2 py-1.5">{t.delivery_point || '—'}</td>
                        <td className="px-2 py-1.5">{t.state || '—'}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{t.transport_type}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.system_km)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.google_km)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.billed_km)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(t.rate_per_km)}</td>
                        <td className="px-2 py-1.5 text-right font-bold">{nf(t.amount)}</td>
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
    </div>
  );
}
