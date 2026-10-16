// frontend/src/pages/reports/DayUtilisation.jsx
// Reports → Tanker Utilisation (renamed from Day Utilisation, owner 2026-10-14):
// tabs Day wise · Month Cumulative · Year Cumulative (the cumulative views
// moved here from the Payment Report; components/TransportCumulative.jsx).
// Day wise Tanker Utilisation (per sample Day_wise_Utilisation.xlsx):
// one row per acknowledged trip by ack date — ack totals, tanker capacity,
// Utilization % = Ack Qty Ltrs / capacity × 100, remark ABOVE/BELOW threshold.
import { useState, useEffect } from 'react';
import { CumulativeMonths, CumulativeYears, FixedCostPanel } from '../../components/TransportCumulative';
import { getCumulative, downloadCumulativeExcel } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';
import { hasRole } from '../../utils/roles';
import toast from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { getDayUtilisation, downloadDayUtilisationExcel, getReportBillingRuns, saveUtilisationRemark,
  saveUtilisationReason, tagUtilisationReasons, getUtilisationNote, getUtilisationApproval, saveUtilisationDraft,
  submitUtilisationApproval, withdrawUtilisationApproval, decideUtilisationApproval } from '../../api/index';
import { fmtDate } from '../../utils/date';

const today = () => new Date().toISOString().slice(0, 10);
const n2 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n0 = v => v == null ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

// Approval remark cell (migration 072): logistics notes CE approval etc.;
// saved on blur, blank deletes; read-only for view-only users.
function RemarkCell({ row, canEdit, onSaved }) {
  const [val, setVal] = useState(row.user_remark || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setVal(row.user_remark || ''); }, [row.user_remark]);
  if (!canEdit) return <span className="whitespace-pre-wrap">{row.user_remark || ''}</span>;
  const save = () => {
    if (val.trim() === (row.user_remark || '').trim()) return;
    setSaving(true);
    saveUtilisationRemark(row.execution_id, val)
      .then(() => onSaved())
      .catch(e => toast.error(e.response?.data?.error || e.message))
      .finally(() => setSaving(false));
  };
  return (
    <input className={`input py-1 text-xs w-56 ${saving ? 'opacity-60' : ''}`} value={val} maxLength={1000}
      placeholder="e.g. CE approved" onChange={e => setVal(e.target.value)} onBlur={save}/>
  );
}

// Under-utilisation reasons (migration 073, owner 2026-10-16).
const REASONS = [
  ['batch_preparation', 'Batch Preparation and Specific Plant Requirements'],
  ['operational_delays', 'Operational Delays and Plant Maintenance'],
];
const REASON_LABEL = Object.fromEntries(REASONS);

function ReasonCells({ row, canEdit, onSaved }) {
  const [detail, setDetail] = useState(row.reason_detail || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDetail(row.reason_detail || ''); }, [row.reason_detail]);
  if (!canEdit) return (<>
    <td className="table-td whitespace-nowrap">{REASON_LABEL[row.reason] || ''}</td>
    <td className="table-td whitespace-pre-wrap">{row.reason_detail || ''}</td>
  </>);
  const save = fields => {
    setSaving(true);
    saveUtilisationReason(row.execution_id, fields)
      .then(() => onSaved())
      .catch(e => toast.error(e.response?.data?.error || e.message))
      .finally(() => setSaving(false));
  };
  return (<>
    <td className="table-td">
      <select className={`input py-1 text-xs w-52 ${saving ? 'opacity-60' : ''}`} value={row.reason || ''}
        onChange={e => save({ reason: e.target.value })}>
        <option value="">—</option>
        {REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </td>
    <td className="table-td">
      <input className={`input py-1 text-xs w-56 ${saving ? 'opacity-60' : ''}`} value={detail} maxLength={1000}
        disabled={!row.reason} placeholder={row.reason ? 'optional detail' : 'pick a reason first'}
        onChange={e => setDetail(e.target.value)}
        onBlur={() => { if (detail.trim() !== (row.reason_detail || '').trim()) save({ reason_detail: detail }); }}/>
    </td>
  </>);
}

// Approval note drafted from the tagged reasons (editable by logistics) and
// its own L1 → L2 → L3 approval (migration 074, owner 2026-10-16).
const UA_BADGE = {
  draft: 'bg-gray-100 text-gray-700', pending_l1: 'bg-amber-100 text-amber-800', pending_l2: 'bg-amber-100 text-amber-800',
  pending_l3: 'bg-amber-100 text-amber-800', approved: 'bg-green-100 text-green-800', rejected: 'bg-red-100 text-red-800',
};
export function UtilisationApprovalBadge({ approval, label }) {
  if (!approval) return <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">Not submitted</span>;
  return <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${UA_BADGE[approval.status] || ''}`}>{label || approval.status}</span>;
}
const fmtTs = t => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

function NotePanel({ runId }) {
  const qc = useQueryClient();
  const { data: note, isError } = useQuery({
    queryKey: ['utilisation-note', runId],
    queryFn: () => getUtilisationNote(runId).then(r => r.data),
    enabled: !!runId, retry: false,
  });
  const { data: ua } = useQuery({
    queryKey: ['utilisation-approval', runId],
    queryFn: () => getUtilisationApproval(runId).then(r => r.data),
    enabled: !!runId, retry: false,
  });
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remarks, setRemarks] = useState('');
  const approval = ua?.approval;
  const live = approval && approval.status !== 'rejected' ? approval : null;
  const editable = !!ua?.can_initiate && (!live || live.status === 'draft');
  useEffect(() => {
    if (dirty) return;
    setText(live?.note_text || note?.text || '');
  }, [live?.note_text, note?.text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDirty(false); }, [runId]);
  if (!note || isError) return null;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['utilisation-approval', runId] }); qc.invalidateQueries({ queryKey: ['utilisation-note', runId] }); };
  const act = (fn, ok) => { setBusy(true); return fn().then(r => { toast.success(ok); setDirty(false); refresh(); return r; })
    .catch(e => toast.error(e.response?.data?.error || e.message)).finally(() => setBusy(false)); };
  const save = () => act(() => saveUtilisationDraft(runId, text), 'Draft saved');
  const regenerate = () => { setText(note.text); setDirty(true); toast('Regenerated from data — Save draft to keep it'); };
  const submit = async () => {
    if (!window.confirm(`Submit the utilisation note of run #${runId} for L1 → L2 → L3 approval?${note.untagged ? `\n\n${note.untagged} under-utilised trip(s) have no reason yet.` : ''}`)) return;
    setBusy(true);
    try {
      if (dirty || !live || live.note_text !== text) await saveUtilisationDraft(runId, text);
      const r = await submitUtilisationApproval(runId);
      if (r.data.mail_error) toast.error(`Submitted, but the L1 mail failed: ${r.data.mail_error}`);
      else toast.success('Submitted — L1 has been mailed');
      setDirty(false); refresh();
    } catch (e) { toast.error(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  };
  const withdraw = () => window.confirm('Withdraw from L1 approval? The mailed link stops working.')
    && act(() => withdrawUtilisationApproval(live.id), 'Withdrawn to draft');
  const decide = d => {
    if (d === 'reject' && !remarks.trim()) return toast.error('Remarks are required to reject');
    act(() => decideUtilisationApproval(live.id, d, remarks.trim()), d === 'approve' ? 'Approved' : 'Rejected').then(() => setRemarks(''));
  };
  const copy = () => navigator.clipboard?.writeText(text)
    .then(() => toast.success('Approval note copied'))
    .catch(() => toast.error('Copy failed — select the text and copy it'));
  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="font-semibold text-sm text-[#003a6b]">Approval note</div>
        <UtilisationApprovalBadge approval={approval} label={ua?.status_label}/>
        {note.untagged > 0 && <span className="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800">{note.untagged} without a reason</span>}
        <span className="text-xs text-gray-500">approved in its own L1 → L2 → L3 chain ({(ua?.approvers || []).map(a => `L${a.level} ${a.name}`).join(' · ')})</span>
        <div className="ml-auto flex gap-2 flex-wrap">
          <button onClick={copy} className="btn-secondary text-xs">Copy</button>
          {editable && <>
            <button disabled={busy} onClick={regenerate} className="btn-secondary text-xs">Regenerate from data</button>
            <button disabled={busy} onClick={save} className="btn-secondary text-xs">Save draft</button>
            <button disabled={busy} onClick={submit} className="btn-primary text-xs">Submit for approval</button>
          </>}
          {ua?.can_initiate && live?.status === 'pending_l1' && !live.steps?.some(s => s.decision) &&
            <button disabled={busy} onClick={withdraw} className="btn-secondary text-xs">Withdraw</button>}
        </div>
      </div>
      {approval?.status === 'rejected' && (
        <div className="text-xs text-red-700">Rejected{(() => { const r = approval.steps?.find(s => s.decision === 'rejected'); return r ? ` at L${r.level} by ${r.decided_by || r.approver_name}${r.remarks ? ` — ${r.remarks}` : ''}` : ''; })()}. Edit the note and submit again.</div>
      )}
      <textarea readOnly={!editable} className="input w-full text-xs font-mono" rows={Math.min(30, text.split('\n').length + 2)}
        value={text} onChange={e => { setText(e.target.value); setDirty(true); }}/>
      {note.plantSummary?.length > 0 && (
        <table className="text-xs border-collapse">
          <thead><tr className="bg-gray-50"><th className="border px-2 py-1 text-left">Plant</th><th className="border px-2 py-1">Trips below {note.threshold}%</th><th className="border px-2 py-1">Avg util %</th></tr></thead>
          <tbody>{note.plantSummary.map(p => <tr key={p.plant}><td className="border px-2 py-1">{p.plant}</td><td className="border px-2 py-1 text-right">{p.count}</td><td className="border px-2 py-1 text-right">{p.avg ?? '—'}</td></tr>)}</tbody>
        </table>
      )}
      {live?.steps?.length > 0 && (
        <ol className="text-xs space-y-1">
          {live.steps.map(s => (
            <li key={s.level} className="flex gap-2 flex-wrap">
              <span className="font-semibold">L{s.level}</span>
              <span>{s.approver_name || s.approver_email}</span>
              <span className={s.decision === 'approved' ? 'text-green-700' : s.decision === 'rejected' ? 'text-red-700' : 'text-gray-400'}>
                {s.decision || (live.status === `pending_l${s.level}` ? 'awaiting' : '—')}</span>
              {s.decided_at && <span className="text-gray-500">{fmtTs(s.decided_at)}{s.decided_by ? ` · ${s.decided_by}` : ''}</span>}
              {s.remarks && <span className="text-gray-700">“{s.remarks}”</span>}
            </li>))}
          {approval?.submitted_at && <li className="text-gray-500">Submitted by {approval.submitted_by_name} · {fmtTs(approval.submitted_at)}</li>}
        </ol>
      )}
      {ua?.can_decide && live && (
        <div className="flex gap-2 items-center flex-wrap border-t pt-2">
          <span className="text-xs font-semibold">Your decision (L{ua.pending_level}):</span>
          <input className="input text-xs flex-1 min-w-[200px]" placeholder="Remarks (required to reject)" value={remarks} onChange={e => setRemarks(e.target.value)}/>
          <button disabled={busy} onClick={() => decide('approve')} className="btn-primary text-xs">Approve</button>
          <button disabled={busy} onClick={() => decide('reject')} className="btn-secondary text-xs text-red-700">Reject</button>
        </div>
      )}
    </div>
  );
}

const MODE_KEY = 'dayUtil.mode';
// Fortnight of a month (YYYY-MM): half 1 = 1–15, half 2 = 16–month end.
const fortnightRange = (month, half) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return half === '1' ? { from: `${month}-01`, to: `${month}-15` } : { from: `${month}-16`, to: `${month}-${String(last).padStart(2, '0')}` };
};
const readMode = () => { try { return localStorage.getItem(MODE_KEY) === 'run' ? 'run' : 'ack'; } catch { return 'ack'; } };

function DayWise() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const canEditRemarks = user?.read_only !== true && (hasRole(user, 'admin') || user?.access?.reports === 'edit'
    || (hasRole(user, 'planner', 'biller') && user?.access?.reports !== 'view'));
  const refreshRows = () => qc.invalidateQueries({ queryKey: ['day-utilisation'] });
  const refreshAll = () => { refreshRows(); qc.invalidateQueries({ queryKey: ['utilisation-note'] }); };
  const [from, setFrom] = useState(today());
  const [to, setTo]     = useState(today());
  const [threshold, setThreshold] = useState(95);
  // "By billing run" (owner, 2026-10-16): exactly the trips of one run, for the
  // CE approval of trips below the threshold after each run.
  const [mode, setMode]   = useState(readMode);
  const [runId, setRunId] = useState('');
  const [month, setMonth] = useState(today().slice(0, 7));
  const [half, setHalf]   = useState(Number(today().slice(8, 10)) <= 15 ? '1' : '2');
  const byRun = mode === 'run';
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState(() => new Set());
  const [tagReason, setTagReason] = useState(REASONS[0][0]);
  const [tagDetail, setTagDetail] = useState('');
  const [tagging, setTagging] = useState(false);
  const fn = month ? fortnightRange(month, half) : null;
  const changeMode = m => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };

  const { data: runs = [], isFetched: runsFetched } = useQuery({
    queryKey: ['report-billing-runs', fn?.from, fn?.to],
    queryFn:  () => getReportBillingRuns({ from: fn.from, to: fn.to }).then(r => r.data),
    enabled:  byRun && !!fn,
  });
  // Runs of the fortnight, latest id first: pick the latest whenever the
  // current choice is not one of them (none → clear).
  useEffect(() => {
    if (!byRun) return;
    if (!runs.some(r => String(r.id) === runId)) setRunId(runs.length ? String(runs[0].id) : '');
  }, [byRun, runId, runs]);

  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['day-utilisation', mode, byRun ? runId : from, byRun ? '' : to, threshold],
    queryFn:  () => getDayUtilisation(byRun ? { run_id: runId, threshold } : { from_date: from, to_date: to, threshold }).then(r => r.data),
    enabled:  byRun ? !!runId : (!!from && !!to),
  });
  const exportExcel = () => downloadDayUtilisationExcel(from, to, threshold, byRun ? runId : null)
    .catch(e => toast.error(e.response?.data?.error || e.message));

  const above = rows.filter(r => r.utilization != null && r.utilization >= threshold).length;
  const below = rows.filter(r => r.utilization != null && r.utilization < threshold).length;
  const isBelow = r => r.utilization != null && r.utilization < threshold;
  const untagged = byRun ? rows.filter(r => isBelow(r) && !r.reason).length : 0;
  const q = search.trim().toLowerCase();
  const matches = r => !q || [r.route_name, r.tanker_number, r.starting_point, r.delivery_point, r.billing_date, r.ack_date,
    fmtDate(r.ack_date), r.remarks, r.user_remark, REASON_LABEL[r.reason], r.reason_detail, r.capacity, r.utilization, r.s_no]
    .some(v => v != null && String(v).toLowerCase().includes(q));
  const shown = (!byRun || filter === 'all' ? rows
    : rows.filter(r => r.utilization != null && (filter === 'below' ? r.utilization < threshold : r.utilization >= threshold))).filter(matches);
  const selecting = byRun && filter === 'below' && canEditRemarks;
  const toggle = id => setSel(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = selecting && shown.length > 0 && shown.every(r => sel.has(r.execution_id));
  const toggleAll = () => setSel(allSel ? new Set() : new Set(shown.map(r => r.execution_id)));
  useEffect(() => { setSel(new Set()); }, [runId, filter, mode]);
  const applyTag = () => {
    if (!sel.size) return toast.error('Tick the trips to tag first');
    setTagging(true);
    tagUtilisationReasons([...sel], tagReason, tagDetail)
      .then(r => { toast.success(`${r.data.updated} trip(s) tagged`); setSel(new Set()); refreshAll(); })
      .catch(e => toast.error(e.response?.data?.error || e.message))
      .finally(() => setTagging(false));
  };
  const totLitres = rows.reduce((s, r) => s + (parseFloat(r.ack_litres) || 0), 0);
  // Fleet utilisation excludes sale tankers (milk sold, not a fleet fill).
  const fleetRows = rows.filter(r => !r.is_sale_tanker);
  const saleCount = rows.length - fleetRows.length;
  const fleetLitres = fleetRows.reduce((s, r) => s + (parseFloat(r.ack_litres) || 0), 0);
  const totCap    = fleetRows.reduce((s, r) => s + (parseFloat(r.capacity) || 0), 0);
  const avgUtil   = totCap ? (fleetLitres / totCap * 100) : null;

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title text-base">Day wise</div>
          <div className="page-sub">Acknowledged quantity vs tanker capacity — {byRun ? 'trips of one billing run' : 'by acknowledgement date'}</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input py-1.5 text-sm" value={mode} onChange={e => changeMode(e.target.value)}>
            <option value="ack">By acknowledgement date</option>
            <option value="run">By billing run</option>
          </select>
          {byRun ? (
            <>
              <input type="month" className="input py-1.5 text-sm" value={month} onChange={e => setMonth(e.target.value)}/>
              <select className="input py-1.5 text-sm" value={half} onChange={e => setHalf(e.target.value)}>
                <option value="1">1–15</option>
                <option value="2">16–month end</option>
              </select>
              {runs.length > 1 && (
                <select className="input py-1.5 text-sm" value={runId} onChange={e => setRunId(e.target.value)}>
                  {runs.map(r => (
                    <option key={r.id} value={r.id}>
                      #{r.id} · {fmtDate(r.from_date)} → {fmtDate(r.to_date)} · {r.status} · {r.trip_count} trips
                    </option>
                  ))}
                </select>
              )}
              {runs.length === 1 && (
                <span className="text-xs text-gray-600">
                  Run #{runs[0].id} · {runs[0].status} · {runs[0].trip_count} trips
                </span>
              )}
              {runsFetched && runs.length === 0 && (
                <span className="text-xs text-amber-700">No billing run for this fortnight yet</span>
              )}
            </>
          ) : (
            <>
              <input type="date" className="input py-1.5 text-sm" value={from} onChange={e => setFrom(e.target.value)}/>
              <span className="text-gray-400 text-sm">to</span>
              <input type="date" className="input py-1.5 text-sm" value={to} onChange={e => setTo(e.target.value)}/>
            </>
          )}
          <label className="text-xs text-gray-500 flex items-center gap-1">
            Threshold %
            <input type="number" min="1" max="100" className="input py-1.5 text-sm w-16"
              value={threshold} onChange={e => setThreshold(parseFloat(e.target.value) || 95)}/>
          </label>
          <button onClick={exportExcel} disabled={byRun && !runId} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download size={14}/> Export Excel
          </button>
          {isFetching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
        </div>
      </div>

      <div className="flex gap-3 text-xs flex-wrap">
        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{rows.length} {byRun ? 'trips in run' : 'acknowledged trips'}</span>
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{above} above {threshold}%</span>
        <span className="px-3 py-1 rounded-full bg-red-100 text-red-600 font-medium">{below} below {threshold}%</span>
        {avgUtil != null && (
          <span className={`px-3 py-1 rounded-full font-medium ${avgUtil >= threshold ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
            fleet utilisation {n2(avgUtil)}%
          </span>
        )}
        {untagged > 0 && (
          <span className="px-3 py-1 rounded-full bg-amber-100 text-amber-800 font-semibold">⚠ Untagged: {untagged} below {threshold}% without a reason</span>
        )}
        {saleCount > 0 && (
          <span className="px-3 py-1 rounded-full bg-violet-100 text-violet-700 font-medium" title="Sale tankers are excluded from fleet utilisation">
            {saleCount} sale tanker{saleCount > 1 ? 's' : ''} (excluded)
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <div className="flex gap-2 items-center text-xs">
          <input className="input py-1 text-xs w-full max-w-sm" placeholder="Search route, tanker, plant, date, remarks, reason…"
            value={search} onChange={e => setSearch(e.target.value)}/>
          {q && <span className="text-gray-500">{shown.length} match{shown.length === 1 ? '' : 'es'}</span>}
          {q && <button className="text-[#005ba3] underline" onClick={() => setSearch('')}>clear</button>}
        </div>
      )}

      {byRun && runId && (
        <div className="flex gap-2 flex-wrap items-center text-xs">
          {[['all', `All (${rows.length})`], ['above', `Above ${threshold}% (${above})`], ['below', `Below ${threshold}% (${below})`]].map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className="px-3 py-1 rounded-full font-semibold border"
              style={filter === k ? { background: '#4a3aa7', color: '#fff', borderColor: '#4a3aa7' } : { background: '#fff', color: '#57534e' }}>{l}</button>
          ))}
          {selecting && (
            <div className="flex gap-2 items-center flex-wrap ml-2 p-1.5 rounded-lg bg-gray-50 border">
              <span className="font-semibold">Tag reason ({sel.size} selected)</span>
              <select className="input py-1 text-xs" value={tagReason} onChange={e => setTagReason(e.target.value)}>
                {REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                <option value="">— clear reason —</option>
              </select>
              <input className="input py-1 text-xs w-64" placeholder="detail (optional)" maxLength={1000}
                value={tagDetail} onChange={e => setTagDetail(e.target.value)} disabled={!tagReason}/>
              <button onClick={applyTag} disabled={tagging || !sel.size} className="btn-primary text-xs py-1">Apply</button>
            </div>
          )}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[68vh]">
          <table className="w-full text-xs" style={{ minWidth: 1300 }}>
            <thead className="sticky top-0 bg-gray-50 z-10 border-b">
              <tr>
                {selecting && <th className="table-th"><input type="checkbox" checked={allSel} onChange={toggleAll}/></th>}
                {['S.NO','Started Point','Delivery Point',...(byRun ? ['Billing Date'] : []),'Ack date','Tanker Number','Route Name']
                  .map(h => <th key={h} className="table-th">{h}</th>)}
                <th className="table-th">Approval remarks</th>
                <th className="table-th text-right">Utilization %</th>
                <th className="table-th text-center">Remarks</th>
                {byRun && <><th className="table-th">Reason</th><th className="table-th">Reason detail</th></>}
                {['Ack Qty Ltrs','Ack Qty Kgs','Fat','SNF','KG Fat','Kg SNF','Tanker Capacity']
                  .map(h => <th key={h} className="table-th text-right">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={byRun ? 19 + (selecting ? 1 : 0) : 16}><div className="empty-state">{byRun ? (runId ? 'No trips in this billing run.' : 'No billing run for this fortnight yet.') : 'No acknowledged trips in this date range.'}</div></td></tr>
              )}
              {shown.map(r => (
                <tr key={r.execution_id || r.s_no} className="border-b border-gray-50 hover:bg-gray-50">
                  {selecting && <td className="table-td"><input type="checkbox" checked={sel.has(r.execution_id)} onChange={() => toggle(r.execution_id)}/></td>}
                  <td className="table-td">{r.s_no}</td>
                  <td className="table-td whitespace-nowrap">{r.starting_point || '—'}</td>
                  <td className="table-td whitespace-nowrap">{r.delivery_point || '—'}</td>
                  {byRun && <td className="table-td whitespace-nowrap">{r.billing_date || '—'}</td>}
                  <td className="table-td whitespace-nowrap">{fmtDate(r.ack_date)}</td>
                  <td className="table-td font-mono font-semibold text-[#005ba3] whitespace-nowrap">
                    {r.tanker_number || '—'}
                    {r.is_sale_tanker && <span className="ml-1 px-1 rounded bg-violet-600 text-white text-[10px] font-sans" title="Sale Tanker — milk sold, not delivered to a plant">SALE</span>}
                  </td>
                  <td className="table-td whitespace-nowrap">{r.route_name || '—'}</td>
                  <td className="table-td"><RemarkCell row={r} canEdit={canEditRemarks} onSaved={refreshRows}/></td>
                  <td className={`table-td text-right font-bold ${r.utilization == null ? 'text-gray-300' : r.utilization >= threshold ? 'text-green-700' : 'text-red-600'}`}>
                    {n2(r.utilization)}
                  </td>
                  <td className="table-td text-center">
                    {r.remarks && (
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${r.remarks.startsWith('ABOVE') ? 'bg-green-100 text-green-700' : r.is_sale_tanker ? 'bg-violet-100 text-violet-700' : 'bg-red-100 text-red-600'}`}>
                        {r.remarks}
                      </span>
                    )}
                  </td>
                  {byRun && (r.is_sale_tanker || r.utilization == null || r.utilization >= threshold
                    ? <><td className="table-td text-gray-400">{REASON_LABEL[r.reason] || ''}</td><td className="table-td text-gray-400">{r.reason_detail || ''}</td></>
                    : <ReasonCells row={r} canEdit={canEditRemarks} onSaved={refreshAll}/>)}
                  <td className="table-td text-right">{n2(r.ack_litres)}</td>
                  <td className="table-td text-right">{n2(r.ack_kgs)}</td>
                  <td className="table-td text-right">{n2(r.fat)}</td>
                  <td className="table-td text-right">{n2(r.snf)}</td>
                  <td className="table-td text-right">{n2(r.kg_fat)}</td>
                  <td className="table-td text-right">{n2(r.kg_snf)}</td>
                  <td className="table-td text-right">{n0(r.capacity)}</td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="bg-blue-50 border-t font-semibold sticky bottom-0">
                <tr>
                  {selecting && <td className="table-td"></td>}
                  <td className="table-td text-[#003a6b]" colSpan={byRun ? 7 : 6}>TOTAL — {rows.length} trips{saleCount > 0 ? ` (utilisation on ${fleetRows.length} non-sale)` : ''}</td>
                  <td className="table-td"></td>
                  <td className={`table-td text-right font-bold ${avgUtil != null && avgUtil >= threshold ? 'text-green-700' : 'text-red-600'}`}>{n2(avgUtil)}</td>
                  <td className="table-td" colSpan={byRun ? 3 : 1}></td>
                  <td className="table-td text-right text-[#003a6b]">{n2(totLitres)}</td>
                  <td className="table-td text-right text-[#003a6b]">{n2(rows.reduce((s, r) => s + (parseFloat(r.ack_kgs) || 0), 0))}</td>
                  <td className="table-td" colSpan={2}></td>
                  <td className="table-td text-right text-[#003a6b]">{n2(rows.reduce((s, r) => s + (parseFloat(r.kg_fat) || 0), 0))}</td>
                  <td className="table-td text-right text-[#003a6b]">{n2(rows.reduce((s, r) => s + (parseFloat(r.kg_snf) || 0), 0))}</td>
                  <td className="table-td text-right text-[#003a6b]">{n0(totCap)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
      {byRun && runId && <NotePanel runId={runId}/>}
    </div>
  );
}

// Financial year (April → March) containing a date: start year.
const fyStartOf = iso => { const [y, m] = iso.split('-').map(Number); return m >= 4 ? y : y - 1; };

function Cumulative({ view }) {
  const { user } = useAuth();
  const isAdmin = hasRole(user, 'admin');
  const [fy, setFy] = useState(fyStartOf(today()));
  const [status, setStatus] = useState('approved');
  const from = `${fy}-04-01`;
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['cumulative', fy, status],
    queryFn: () => getCumulative({ from, status }).then(r => r.data),
  });
  const years = [];
  for (let y = fyStartOf(today()); y >= 2023; y--) years.push(y);
  const excel = () => downloadCumulativeExcel({ from, status }).catch(e => toast.error(e.response?.data?.error || e.message));
  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="text-xs text-gray-600 flex items-center gap-1">Financial year
          <select className="input py-1.5 text-sm" value={fy} onChange={e => setFy(+e.target.value)}>
            {years.map(y => <option key={y} value={y}>{y}-{String(y + 1).slice(2)}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-600 flex items-center gap-1">Runs
          <select className="input py-1.5 text-sm" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="approved">Approved only (payable)</option>
            <option value="all">All runs</option>
          </select>
        </label>
        <button onClick={excel} className="btn-secondary flex items-center gap-1.5 text-sm"><Download size={14}/> Excel</button>
        {isFetching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
      </div>
      {isError && <div className="card p-3 text-red-700 text-sm">Could not load: {error.response?.data?.error || error.message}</div>}
      {data && view === 'months' && <CumulativeMonths months={data.months} total={data.months_total}/>}
      {data && view === 'years' && <CumulativeYears years={data.years} isAdmin={isAdmin} onHistoryChanged={refetch}/>}
    </div>
  );
}

export default function TankerUtilisation() {
  const [tab, setTab] = useState('day');
  const TABS = [['day', 'Day wise'], ['months', 'Month Cumulative'], ['years', 'Year Cumulative'], ['fixed', 'Fixed cost (9,000 km)']];
  const { user } = useAuth();
  const canUpload = hasRole(user, 'admin', 'biller');
  return (
    <div className="space-y-4 w-full">
      <div>
        <div className="page-title">Tanker Utilisation</div>
        <div className="page-sub">Day-wise acknowledged quantity vs capacity, and month / year cumulative of milk, km and transport cost</div>
      </div>
      <div className="flex gap-2">
        {TABS.map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className="text-xs px-3 py-1.5 rounded-lg font-semibold"
            style={tab === k ? { background: '#4a3aa7', color: '#fff' } : { background: '#fff', color: '#57534e' }}>{l}</button>
        ))}
      </div>
      {tab === 'day' ? <DayWise/> : tab === 'fixed' ? <FixedCostPanel canUpload={canUpload}/> : <Cumulative view={tab}/>}
    </div>
  );
}
