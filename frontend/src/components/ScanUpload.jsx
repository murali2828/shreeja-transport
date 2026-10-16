// frontend/src/components/ScanUpload.jsx
// Trip scans (migration 071, ADR-025): 📎 picker for the BMCU dispatch challan
// of a BMCU line (kind 'bmcu_dc', tebId = trip_execution_bmcus.id) or the plant
// acknowledgement slip (kind 'ack'). Several files at once (camera or files);
// each file is compressed in the browser and uploaded in the background with a
// progress chip and one retry. Adding is free on any non-cancelled trip, also
// closed / billed ones. Replacing or deleting an uploaded scan is a change
// request the approver decides (admins may delete directly).
// All scans of one execution come from one cached query; images load only
// when the viewer opens.
import { useState, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Paperclip, X, ChevronLeft, ChevronRight, Trash2, RefreshCw, Clock } from 'lucide-react';
import toast from 'react-hot-toast';
import { getTripScans, uploadTripScans, getTripScanBlob, deleteTripScan, requestTripScanChange } from '../api/index';
import { compressForUpload } from '../utils/imageCompress';
import { useAuth } from '../hooks/useAuth';

const errMsg = e => e?.response?.data?.error || e?.message || 'Failed';

export function useTripScans(executionId) {
  return useQuery({
    queryKey: ['trip-scans', String(executionId)],
    queryFn: () => getTripScans(executionId).then(r => r.data),
    enabled: !!executionId,
    staleTime: 60_000,
  });
}

// Same rule as Scan Status (routes/tripScans.js): acknowledged = has
// trip_acknowledgements rows (list flag `acknowledged`; closed implies it).
export const isAcked = (exec) => !!exec && (exec.acknowledged === true || exec.status === 'closed');
// Scans pending: a live BMCU line without a DC scan, or an acknowledged trip without an ack slip.
export const scansPending = (exec) => !!exec && exec.status !== 'cancelled'
  && (Number(exec.dc_done || 0) < Number(exec.dc_total || 0) || (isAcked(exec) && Number(exec.ack_scans || 0) === 0));

// Toggle state for the "Scans pending" filter, per viewer (localStorage may throw).
export function usePendingToggle(key) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const set = (v) => { setOn(v); try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ } };
  return [on, set];
}

export function ScansPendingButton({ on, onToggle, count }) {
  return (
    <button type="button" onClick={() => onToggle(!on)}
      className={`btn-sm inline-flex items-center gap-1 ${on ? 'btn-primary' : 'btn-secondary'}`}
      title="Show only trips with a missing DC or acknowledgement scan">
      <Paperclip size={12}/> Scans pending ({count})
    </button>
  );
}

// "📎 Scans" link: read-only modal of every scan of one trip, grouped DC per BMCU
// and Ack slip. Scans are fetched only when the modal opens.
export function ViewScansLink({ executionId, className = '' }) {
  const [open, setOpen] = useState(false);
  if (!executionId) return null;
  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        className={`text-[11px] text-[#0078d4] hover:underline whitespace-nowrap ${className}`} title="View this trip's scans">📎 Scans</button>
      {open && <TripScansModal executionId={executionId} onClose={() => setOpen(false)}/>}
    </>
  );
}

function TripScansModal({ executionId, onClose }) {
  const { data: all = [], isLoading, error } = useTripScans(executionId);
  const [view, setView] = useState(null); // { scans, title }
  const groups = [];
  const byTeb = new Map();
  for (const s of all.filter(x => x.kind === 'bmcu_dc')) {
    const k = s.teb_id;
    if (!byTeb.has(k)) {
      const name = [s.bmcu_code, s.bmcu_name].filter(Boolean).join(' · ') || `BMCU line ${k}`;
      byTeb.set(k, { title: `DC — ${name}`, scans: [] });
      groups.push(byTeb.get(k));
    }
    byTeb.get(k).scans.push(s);
  }
  const ack = all.filter(x => x.kind === 'ack');
  if (ack.length) groups.push({ title: 'Ack slip', scans: ack });
  return (
    <div className="fixed inset-0 z-40 bg-black/50 flex items-center justify-center p-3" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-lg max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-3 py-2 border-b text-sm font-semibold text-gray-700">
          Trip scans
          <button type="button" className="p-1 text-gray-500 hover:text-gray-800" onClick={onClose}><X size={16}/></button>
        </div>
        <div className="p-3 space-y-2 text-sm">
          {isLoading && <div className="text-gray-400">Loading…</div>}
          {error && <div className="text-red-600">{errMsg(error)}</div>}
          {!isLoading && !error && !groups.length && <div className="text-gray-400">No scans uploaded for this trip.</div>}
          {groups.map(g => (
            <div key={g.title} className="flex items-center justify-between gap-2 border-b border-gray-100 pb-1.5">
              <span className="text-gray-700">{g.title}</span>
              <button type="button" className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200"
                onClick={() => setView(g)}>View {g.scans.length}</button>
            </div>
          ))}
        </div>
      </div>
      {view && <ScanViewer scans={view.scans} title={view.title} readOnly hideAdmin onClose={() => setView(null)} onChanged={() => {}}/>}
    </div>
  );
}

// List chip: "DC 3/5 · Ack ✓" from the executions list aggregate (no extra request).
export function ScanChip({ exec }) {
  if (!exec) return null;
  const total = Number(exec.dc_total || 0), done = Number(exec.dc_done || 0), ack = Number(exec.ack_scans || 0) > 0;
  const dcOk = total > 0 && done >= total;
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold whitespace-nowrap" title="Scanned dispatch challans · acknowledgement slip">
      <span className={`px-1.5 py-0.5 rounded ${dcOk ? 'bg-green-100 text-green-700' : total ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'}`}>DC {done}/{total}</span>
      <span className={`px-1.5 py-0.5 rounded ${ack ? 'bg-green-100 text-green-700' : acked ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'}`}>Ack {ack ? '✓' : '✗'}</span>
    </span>
  );
}

export default function ScanUpload({ executionId, kind, tebId, label, readOnly = false, compact = false }) {
  const qc = useQueryClient();
  const { data: all = [] } = useTripScans(executionId);
  const scans = all.filter(s => s.kind === kind && (kind !== 'bmcu_dc' || s.teb_id === tebId));
  const [queue, setQueue] = useState([]); // { key, name, progress, state: 'compressing'|'uploading'|'retrying'|'failed' }
  const [viewerOpen, setViewerOpen] = useState(false);
  const inputRef = useRef(null);
  const tag = label || (kind === 'ack' ? 'Ack slip' : 'DC');

  const setItem = (key, patch) => setQueue(q => q.map(x => (x.key === key ? { ...x, ...patch } : x)));
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['trip-scans', String(executionId)] });
    qc.invalidateQueries({ queryKey: ['executions'] });
  };

  const uploadOne = async (file) => {
    const key = `${Date.now()}-${Math.random()}`;
    setQueue(q => [...q, { key, name: file.name, progress: 0, state: 'compressing' }]);
    let item;
    try { item = await compressForUpload(file); }
    catch (e) { setItem(key, { state: 'failed', error: errMsg(e) }); toast.error(`${file.name}: ${errMsg(e)}`); return; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        setItem(key, { state: attempt ? 'retrying' : 'uploading', progress: 0 });
        await uploadTripScans({ executionId, kind, tebId, items: [item] }, p => setItem(key, { progress: p }));
        setQueue(q => q.filter(x => x.key !== key));
        refresh();
        return;
      } catch (e) {
        const status = e?.response?.status;
        if (attempt === 1 || (status && status < 500)) {
          setItem(key, { state: 'failed', error: errMsg(e) });
          toast.error(`${file.name}: ${errMsg(e)}`);
          return;
        }
      }
    }
  };

  const onPick = (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length > 10) toast('Uploading the first 10 files — pick the rest afterwards');
    files.slice(0, 10).forEach(uploadOne); // background, the form never waits
  };

  if (!executionId) return null;
  const canAdd = !readOnly;
  const n = scans.length;
  const hasPending = scans.some(s => s.pending_change);

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      {canAdd && (
        <>
          <button type="button" onClick={() => inputRef.current?.click()}
            className="btn-secondary btn-sm p-1 inline-flex items-center gap-0.5" title={`Attach ${tag} (camera or files, several pages allowed)`}>
            <Paperclip size={11}/>{!compact && <span className="text-[10px]">{tag}</span>}
          </button>
          <input ref={inputRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={onPick}/>
        </>
      )}
      <button type="button" onClick={() => n && setViewerOpen(true)}
        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${n ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-50 text-red-600 cursor-default'}`}
        title={n ? 'View scans' : `${tag} scan pending`}>
        {n ? `${tag} ✓ ${n}` : `${tag} pending`}{hasPending ? ' ⏳' : ''}
      </button>
      {queue.map(x => (
        <span key={x.key} className={`text-[10px] px-1.5 py-0.5 rounded ${x.state === 'failed' ? 'bg-red-100 text-red-700' : 'bg-blue-50 text-blue-700'}`}
          title={x.error || x.name}>
          {x.state === 'compressing' ? 'Preparing…' : x.state === 'failed' ? 'Failed' : `${x.state === 'retrying' ? 'Retry ' : ''}${Math.round((x.progress || 0) * 100)}%`}
          {x.state === 'failed' && (
            <button type="button" className="ml-1" onClick={() => setQueue(q => q.filter(y => y.key !== x.key))}><X size={9}/></button>
          )}
        </span>
      ))}
      {viewerOpen && <ScanViewer scans={scans} title={tag} readOnly={readOnly} onClose={() => setViewerOpen(false)} onChanged={refresh}/>}
    </span>
  );
}

// Object URL of one scan file / thumb, fetched with the auth header (browser
// caches the response: Cache-Control private, immutable).
function useScanBlob(id, which, enabled = true) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!id || !enabled) return undefined;
    let u = null, alive = true;
    getTripScanBlob(id, which).then(r => { if (!alive) return; u = URL.createObjectURL(r.data); setUrl(u); }).catch(() => alive && setUrl(''));
    return () => { alive = false; if (u) URL.revokeObjectURL(u); setUrl(null); };
  }, [id, which, enabled]);
  return url;
}

function Thumb({ scan, active, onClick }) {
  const url = useScanBlob(scan.id, 'thumb', scan.has_thumb);
  return (
    <button type="button" onClick={onClick}
      className={`shrink-0 w-16 h-16 rounded border-2 overflow-hidden bg-gray-100 flex items-center justify-center text-[10px] text-gray-500 ${active ? 'border-[#0078d4]' : 'border-transparent'}`}>
      {scan.mime === 'application/pdf' ? 'PDF' : url ? <img src={url} alt="" className="w-full h-full object-cover"/> : '…'}
    </button>
  );
}

export function ScanViewer({ scans, title, readOnly, hideAdmin = false, onClose, onChanged }) {
  const { user } = useAuth();
  const isAdmin = (user?.roles || [user?.role]).includes('admin');
  const [i, setI] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [busy, setBusy] = useState(false);
  const replaceRef = useRef(null);
  const s = scans[Math.min(i, scans.length - 1)];
  const url = useScanBlob(s?.id, 'file', !!s);

  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') setI(x => Math.min(x + 1, scans.length - 1)); if (e.key === 'ArrowLeft') setI(x => Math.max(x - 1, 0)); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [scans.length, onClose]);
  useEffect(() => { if (!scans.length) onClose(); }, [scans.length, onClose]);
  if (!s) return null;

  const askReason = (what) => {
    const r = window.prompt(`Reason to ${what} this scan (sent to the approver):`);
    if (r == null) return null;
    if (r.trim().length < 3) { toast.error('Please give a reason'); return null; }
    return r.trim();
  };
  const requestDelete = async () => {
    const reason = askReason('delete'); if (!reason) return;
    setBusy(true);
    try { const r = await requestTripScanChange({ scanId: s.id, action: 'delete', reason }); toast.success(r.data.emailed ? 'Delete requested — sent for approval' : 'Delete requested — pending approval'); onChanged(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const requestReplace = async (e) => {
    const files = Array.from(e.target.files || []).slice(0, 10); e.target.value = '';
    if (!files.length) return;
    const reason = askReason('replace'); if (!reason) return;
    setBusy(true);
    try {
      const items = [];
      for (const f of files) items.push(await compressForUpload(f));
      const r = await requestTripScanChange({ scanId: s.id, action: 'replace', reason, items });
      toast.success(r.data.emailed ? 'Replacement requested — sent for approval' : 'Replacement requested — pending approval');
      onChanged();
    } catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };
  const adminDelete = async () => {
    if (!window.confirm('Delete this scan? (admin)')) return;
    setBusy(true);
    try { await deleteTripScan(s.id); toast.success('Scan deleted'); setI(0); onChanged(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const when = s.uploaded_at ? new Date(s.uploaded_at).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-6" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-5xl max-h-full flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-3 py-2 border-b text-sm">
          <div className="font-semibold text-gray-700">{title} · {i + 1} / {scans.length}
            <span className="ml-2 text-xs font-normal text-gray-500">{s.uploaded_by_name || '—'} · {when}</span>
          </div>
          <div className="flex items-center gap-1">
            {!readOnly && !s.pending_change && (
              <>
                <button type="button" disabled={busy} className="btn-secondary btn-sm inline-flex items-center gap-1" onClick={() => replaceRef.current?.click()}>
                  <RefreshCw size={12}/> Request replace
                </button>
                <input ref={replaceRef} type="file" accept="image/*,application/pdf" multiple className="hidden" onChange={requestReplace}/>
                <button type="button" disabled={busy} className="btn-secondary btn-sm inline-flex items-center gap-1" onClick={requestDelete}>
                  <Trash2 size={12}/> Request delete
                </button>
              </>
            )}
            {isAdmin && !hideAdmin && (
              <button type="button" disabled={busy} className="btn-danger btn-sm inline-flex items-center gap-1" onClick={adminDelete}><Trash2 size={12}/> Delete</button>
            )}
            <button type="button" className="p-1 text-gray-500 hover:text-gray-800" onClick={onClose}><X size={18}/></button>
          </div>
        </div>
        {s.pending_change && (
          <div className="px-3 py-1.5 bg-amber-50 text-amber-800 text-xs flex items-center gap-1">
            <Clock size={12}/> Change requested — pending approval ({s.pending_change.action}, by {s.pending_change.requested_by_name}: “{s.pending_change.reason}”)
          </div>
        )}
        <div className="relative flex-1 min-h-[50vh] bg-gray-900 overflow-auto flex items-center justify-center">
          {!url ? <span className="text-gray-400 text-sm">{url === '' ? 'Could not load the file' : 'Loading…'}</span>
            : s.mime === 'application/pdf'
              ? <iframe title="scan" src={url} className="w-full h-[70vh] bg-white"/>
              : <img src={url} alt="scan" onClick={() => setZoom(z => !z)}
                  className={`max-w-full transition-transform ${zoom ? 'cursor-zoom-out' : 'max-h-[70vh] cursor-zoom-in'}`}
                  style={zoom ? { transform: 'scale(2)', transformOrigin: 'top left' } : undefined}/>}
          {i > 0 && <button type="button" className="absolute left-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-1" onClick={() => { setI(i - 1); setZoom(false); }}><ChevronLeft size={20}/></button>}
          {i < scans.length - 1 && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 bg-white/80 rounded-full p-1" onClick={() => { setI(i + 1); setZoom(false); }}><ChevronRight size={20}/></button>}
        </div>
        {scans.length > 1 && (
          <div className="flex gap-2 overflow-x-auto p-2 border-t">
            {scans.map((x, k) => <Thumb key={x.id} scan={x} active={k === i} onClick={() => { setI(k); setZoom(false); }}/>)}
          </div>
        )}
      </div>
    </div>
  );
}
