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
  draft: ['Draft', '#c98500'], pending_l1: ['Awaiting L1 (Mahesh K)', '#2a78d6'],
  pending_l2: ['Awaiting L2 (Krithiga A)', '#2a78d6'], pending_l3: ['Awaiting L3 (Thimmappa)', '#2a78d6'],
  approved: ['APPROVED', '#008300'], rejected: ['REJECTED — correct & resubmit', '#e34948'],
};

export default function TankerBilling() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = ['admin', 'biller'].includes(user?.role);
  const [openRunId, setOpenRunId] = useState(null);
  const [view, setView] = useState('runs'); // runs | report
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [edits, setEdits] = useState({});      // tripId -> {state, billed_km, remarks}
  const [expanded, setExpanded] = useState({}); // tripId -> bool
  const [tab, setTab] = useState('trips');     // trips | tankers | vendors

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
    mutationFn: () => api.post('/billing/runs', { from_date: from, to_date: to }),
    onSuccess: r => {
      toast.success(`Run created — ${r.data.trips} acknowledged trips loaded`);
      qc.invalidateQueries(['billing-runs']);
      setOpenRunId(r.data.id);
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const saveMut = useMutation({
    mutationFn: () => api.put(`/billing/runs/${openRunId}/trips`, {
      trips: Object.entries(edits).map(([id, e]) => ({ id: +id, ...e })),
    }),
    onSuccess: r => {
      const noRate = (r.data.updated || []).filter(u => u.no_rate).length;
      toast.success(`Saved · run total ₹ ${nf(r.data.total_amount)}`);
      if (noRate) toast.error(`${noRate} trip(s) have no matching rate for the selected state/capacity/period — check Tanker Rates`, { duration: 8000 });
      setEdits({});
      qc.invalidateQueries(['billing-run', openRunId]);
      qc.invalidateQueries(['billing-summary']);
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const submitMut = useMutation({
    mutationFn: () => api.post(`/billing/runs/${openRunId}/submit`),
    onSuccess: () => {
      toast.success('Submitted — approval email sent to Mahesh K (Level 1)');
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
    api.get(`/billing/runs/${openRunId}/report`, { responseType: 'blob' }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `tanker_billing_run_${openRunId}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    });

  const setEdit = (tripId, field, val) =>
    setEdits(prev => ({ ...prev, [tripId]: { ...prev[tripId], [field]: val } }));
  const val = (t, field) => edits[t.id]?.[field] !== undefined ? edits[t.id][field] : (t[field] ?? '');
  const editable = canEdit && run && ['draft', 'rejected'].includes(run.status);

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
          <input type="date" className="input text-xs" value={from} onChange={e => setFrom(e.target.value)} />
          <input type="date" className="input text-xs" value={to} min={from} onChange={e => setTo(e.target.value)} />
          <button className="btn-primary text-xs flex items-center gap-1.5" disabled={!from || !to || createMut.isPending}
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
                  <td className="px-3 py-2">
                    {canEdit && ['draft', 'rejected'].includes(r.status) && (
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
  const missing = trips.filter(t => !val(t, 'state') || t.rate_per_km == null).length;

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => { setOpenRunId(null); setEdits({}); }}>
          <ArrowLeft size={13}/> Runs
        </button>
        <div>
          <h2 className="page-title">Billing Run #{openRunId}</h2>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.92)' }}>
            {run?.from_date} → {run?.to_date} · {trips.length} acknowledged trips {isFetching && '· loading…'}
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
        {editable && (<>
          <button className="btn-secondary text-xs" disabled={!Object.keys(edits).length || saveMut.isPending}
                  onClick={() => saveMut.mutate()}>
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
      <div className="flex gap-2">
        {[['trips', 'Trip Wise'], ['dates', 'Date Wise'], ['tankers', 'Tanker Wise'], ['vendors', 'Vendor Wise']].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className="text-xs px-3 py-1.5 rounded-lg font-semibold"
            style={tab === k ? { background: '#cc785c', color: '#fff' } : { background: '#fff', color: '#57534e' }}>
            {l}
          </button>
        ))}
        {missing > 0 && editable && <span className="text-xs text-white/90 self-center">⚠ {missing} trip(s) missing state / rate</span>}
      </div>

      {tab === 'trips' && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto max-h-[62vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
                <tr>{['', 'Date', 'Tanker', 'Cap (KL)', 'Vendor', 'Route', 'Delivery Point', 'BMCUs', 'Ack Kgs',
                     'State *', 'Transport Type', 'System KM', 'Billed KM', 'Rate/KM', 'Amount (₹)', 'Remarks']
                     .map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
              </thead>
              <tbody>
                {trips.map(t => (
                  <FragmentRow key={t.id} t={t} editable={editable} expanded={!!expanded[t.id]}
                    carried={run?.from_date && t.plan_for_date < run.from_date}
                    onToggle={() => setExpanded(p => ({ ...p, [t.id]: !p[t.id] }))}
                    val={val} setEdit={setEdit} />
                ))}
                <tr className="bg-blue-100 font-bold">
                  <td className="px-2 py-2" colSpan={11}>TOTAL — {trips.length} trips</td>
                  <td className="px-2 py-2 text-right">{nf(trips.reduce((s, t) => s + (+t.system_km || 0), 0))}</td>
                  <td className="px-2 py-2 text-right">{nf(trips.reduce((s, t) => s + (+(edits[t.id]?.billed_km ?? t.billed_km) || 0), 0))}</td>
                  <td/>
                  <td className="px-2 py-2 text-right">{nf(trips.reduce((s, t) => s + (+t.amount || 0), 0))}</td>
                  <td/>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab !== 'trips' && (
        <div className="card overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-blue-50 text-left text-gray-600">
              <tr>{(tab === 'tankers'
                ? ['Tanker', 'Vendor', 'Trips', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']
                : tab === 'dates'
                ? ['Date', 'Tankers', 'Trips', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']
                : ['Vendor', 'Tankers', 'Trips', 'Billed KM', 'System KM', 'Google KM', 'Amount (₹)'])
                .map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
            </thead>
            <tbody>
              {((tab === 'tankers' ? summary?.tankers : tab === 'dates' ? summary?.dates : summary?.vendors) || []).map((r, i) => (
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
                </tr>
              ))}
              {(() => {
                const rows = (tab === 'tankers' ? summary?.tankers : tab === 'dates' ? summary?.dates : summary?.vendors) || [];
                return (
                  <tr className="bg-blue-100 font-bold">
                    <td className="px-3 py-2">TOTAL</td>
                    <td className="px-3 py-2"/>
                    <td className="px-3 py-2 text-right">{rows.reduce((s, r) => s + (+r.trips || 0), 0)}</td>
                    <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.billed_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.system_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right">{nf(rows.reduce((s, r) => s + (+r.google_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right text-[#005ba3]">{nf(rows.reduce((s, r) => s + (+r.amount || 0), 0))}</td>
                  </tr>
                );
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FragmentRow({ t, editable, expanded, onToggle, val, setEdit, carried }) {
  const legs = Array.isArray(t.legs) ? t.legs : (t.legs ? JSON.parse(t.legs) : []);
  return (<>
    <tr className="border-t border-gray-100 hover:bg-blue-50/40">
      <td className="px-2 py-1.5">
        <button onClick={onToggle} className="p-0.5 text-gray-500" title="Show distance legs">
          {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
        </button>
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">
        {t.plan_for_date}
        {carried && <span className="ml-1 px-1 rounded bg-amber-500 text-white text-[10px]" title="Late acknowledgement — carried forward from the previous fortnight">carry-fwd</span>}
      </td>
      <td className="px-2 py-1.5 font-semibold text-[#005ba3] whitespace-nowrap">{t.tanker_number}</td>
      <td className="px-2 py-1.5 text-right">{t.capacity_litres ? (t.capacity_litres / 1000).toFixed(1) : '—'}</td>
      <td className="px-2 py-1.5">{t.vendor_name || <span className="text-red-600">no vendor</span>}</td>
      <td className="px-2 py-1.5">{t.route_name || '—'}</td>
      <td className="px-2 py-1.5">{t.delivery_point || '—'}</td>
      <td className="px-2 py-1.5 text-center">{t.bmcu_count}</td>
      <td className="px-2 py-1.5 text-right">{nf(t.ack_kgs, 0)}</td>
      <td className="px-2 py-1.5">
        {editable
          ? <select className="input py-0.5 px-1 text-xs" value={val(t, 'state')}
                    onChange={e => setEdit(t.id, 'state', e.target.value)}>
              <option value="">— select —</option>
              {STATES.map(s => <option key={s}>{s}</option>)}
            </select>
          : (t.state || <span className="text-red-600">—</span>)}
      </td>
      <td className="px-2 py-1.5 whitespace-nowrap">{t.transport_type}</td>
      <td className="px-2 py-1.5 text-right" title={`Master ${nf(t.master_km)} + Google ${nf(t.google_km)} + Estimated ${nf(t.estimated_km)}`}>
        {nf(t.system_km)}
      </td>
      <td className="px-2 py-1.5 text-right">
        {editable
          ? <input type="number" step="0.01" className="input py-0.5 px-1 text-xs w-20 text-right"
                   value={val(t, 'billed_km')} onChange={e => setEdit(t.id, 'billed_km', e.target.value)}/>
          : nf(t.billed_km)}
      </td>
      <td className="px-2 py-1.5 text-right">{t.rate_per_km != null ? nf(t.rate_per_km) : <span className="text-red-600">no rate</span>}</td>
      <td className="px-2 py-1.5 text-right font-bold">{nf(t.amount)}</td>
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
        <td colSpan={15} className="px-3 py-2">
          <div className="text-[11px] font-semibold text-gray-600 mb-1">
            Distance legs — Master {nf(t.master_km)} km · Google {nf(t.google_km)} km · Estimated {nf(t.estimated_km)} km · Total {nf(t.system_km)} km
          </div>
          <table className="text-[11px]">
            <tbody>
              {legs.map((l, i) => (
                <tr key={i}>
                  <td className="pr-3 py-0.5">{l.from_label}</td>
                  <td className="pr-3 py-0.5">→ {l.to_label}</td>
                  <td className="pr-3 py-0.5 text-right font-semibold">{nf(l.km)} km</td>
                  <td className="pr-3 py-0.5">
                    <span className={`px-1.5 rounded text-white text-[10px] ${
                      l.source === 'master' ? 'bg-blue-600' : l.source === 'google' ? 'bg-green-600'
                      : l.source === 'estimated' ? 'bg-amber-500' : 'bg-red-500'}`}>
                      {l.source}
                    </span>
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

          {tab !== 'trips' && (
            <div className="card overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-blue-50 text-left text-gray-600">
                  <tr>{[tab === 'dates' ? 'Date' : tab === 'tankers' ? 'Tanker' : 'Vendor',
                        tab === 'tankers' ? 'Vendor' : 'Tankers', 'Trips',
                        'Billed KM', 'System KM', 'Google KM', 'Amount (₹)']
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
                    </tr>
                  ))}
                  <tr className="bg-blue-100 font-bold">
                    <td className="px-3 py-2">TOTAL</td><td/>
                    <td className="px-3 py-2 text-right">{(rows || []).reduce((s, r) => s + (+r.trips || 0), 0)}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.billed_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.system_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right">{nf((rows || []).reduce((s, r) => s + (+r.google_km || 0), 0))}</td>
                    <td className="px-3 py-2 text-right text-[#005ba3]">{nf((rows || []).reduce((s, r) => s + (+r.amount || 0), 0))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

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
                        <td className="px-2 py-1.5 whitespace-nowrap">
        {t.plan_for_date}
        {carried && <span className="ml-1 px-1 rounded bg-amber-500 text-white text-[10px]" title="Late acknowledgement — carried forward from the previous fortnight">carry-fwd</span>}
      </td>
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
