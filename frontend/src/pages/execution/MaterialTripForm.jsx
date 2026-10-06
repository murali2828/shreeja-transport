// frontend/src/pages/execution/MaterialTripForm.jsx
// Execution of a material (pasteurised milk) trip — migration 049.
// Supplier document (purchased qty / fat / SNF + scan) → km to the customer
// (keyed, with the Google / Distance Master reference) → customer
// acknowledgement (qty / fat / SNF + scan) → close. No BMCU chain; the trip
// is paid to the vendor like any other and listed under "Material Trips" in
// billing. Gate pass / COA printing and change requests stay on the normal
// execution page (link in the header).
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Save, CheckCircle2, FileText, RefreshCw, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import api, { getExecution, getMaterials, getStartingPoints, getDeliveryPoints, saveMaterialTrip, getMaterialDistance, materialDocUrl } from '../../api/index';
import SearchableSelect from '../../components/SearchableSelect';
import { fmtDate } from '../../utils/date';

const KG_FACTOR = 1.0285;
const n = v => (v === '' || v == null ? null : parseFloat(v));
const fmtN = (v, d = 2) => (v == null || v === '' || isNaN(v) ? '—' : parseFloat(v).toLocaleString('en-IN', { maximumFractionDigits: d }));

async function openDoc(execId, which) {
  try {
    const r = await api.get(materialDocUrl(execId, which).replace(/^\/api/, ''), { responseType: 'blob' });
    window.open(URL.createObjectURL(r.data), '_blank');
  } catch (e) { toast.error(e.response?.data?.error || e.message); }
}

export default function MaterialTripForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: exec, isLoading } = useQuery({ queryKey: ['execution', id], queryFn: () => getExecution(id).then(r => r.data) });
  const { data: materials = [] } = useQuery({ queryKey: ['materials'], queryFn: () => getMaterials().then(r => r.data) });
  const { data: startPts = [] }  = useQuery({ queryKey: ['start-pts'], queryFn: () => getStartingPoints().then(r => r.data) });
  const { data: delivPts = [] }  = useQuery({ queryKey: ['deliv-pts'], queryFn: () => getDeliveryPoints().then(r => r.data) });
  const { data: dist, refetch: refetchDist, isFetching: distLoading } = useQuery({
    queryKey: ['material-distance', id], queryFn: () => getMaterialDistance(id).then(r => r.data), enabled: !!id,
  });

  const [f, setF] = useState({
    material_id: '', start_point_id: '', delivery_point_id: '', supplier_doc_no: '',
    purchase_qty_kgs: '', purchase_kg_fat: '', purchase_kg_snf: '', manual_km: '',
    ack_date: '', ack_qty_kgs: '', ack_kg_fat: '', ack_kg_snf: '', remarks: '',
  });
  const [purchaseDoc, setPurchaseDoc] = useState(null);
  const [ackDoc, setAckDoc] = useState(null);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  useEffect(() => {
    if (!exec) return;
    const m = exec.material || {};
    const ack = (exec.acknowledgements || [])[0] || {};
    setF({
      material_id: String(m.material_id || exec.material_id || ''),
      start_point_id: String(exec.start_point_id || ''), delivery_point_id: String(exec.delivery_point_id || ''),
      supplier_doc_no: m.supplier_doc_no || '',
      purchase_qty_kgs: m.purchase_qty_kgs ?? '', purchase_kg_fat: m.purchase_kg_fat ?? '', purchase_kg_snf: m.purchase_kg_snf ?? '',
      manual_km: m.manual_km ?? exec.actual_km ?? '',
      ack_date: ack.ack_date || exec.execution_date || '', ack_qty_kgs: ack.qty_kgs ?? '', ack_kg_fat: ack.kg_fat ?? '', ack_kg_snf: ack.kg_snf ?? '',
      remarks: m.remarks || '',
    });
  }, [exec]);

  const saveMut = useMutation({
    mutationFn: (close) => {
      const fd = new FormData();
      Object.entries(f).forEach(([k, v]) => fd.append(k, v ?? ''));
      fd.append('close', close ? 'true' : 'false');
      if (purchaseDoc) fd.append('purchase_doc', purchaseDoc);
      if (ackDoc) fd.append('ack_doc', ackDoc);
      return saveMaterialTrip(id, fd);
    },
    onSuccess: (r, close) => {
      toast.success(close ? 'Trip acknowledged and closed' : 'Saved');
      setPurchaseDoc(null); setAckDoc(null);
      qc.invalidateQueries(['execution', id]); qc.invalidateQueries(['executions']); refetchDist();
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });

  if (isLoading) return <div className="p-8 text-gray-500">Loading…</div>;
  if (!exec) return <div className="text-red-500 p-8">Execution not found</div>;
  const closed = exec.status === 'closed';
  const m = exec.material || {};
  // Documents give kgs + kg fat + kg SNF; litres and % are derived (KG_FACTOR 1.0285)
  const derive = (kgs, kgFat, kgSnf) => ({
    ltrs: kgs != null ? kgs / KG_FACTOR : null,
    fat: kgs && kgFat != null ? kgFat / kgs * 100 : null,
    snf: kgs && kgSnf != null ? kgSnf / kgs * 100 : null,
    ts: kgFat != null || kgSnf != null ? (kgFat || 0) + (kgSnf || 0) : null,
  });
  const Pd = derive(n(f.purchase_qty_kgs), n(f.purchase_kg_fat), n(f.purchase_kg_snf));
  const Ad = derive(n(f.ack_qty_kgs), n(f.ack_kg_fat), n(f.ack_kg_snf));
  const pKgs = n(f.purchase_qty_kgs), aKgs = n(f.ack_qty_kgs);
  const variation = pKgs != null && aKgs != null ? aKgs - pKgs : null;
  const tsVariation = Pd.ts != null && Ad.ts != null ? Ad.ts - Pd.ts : null;
  const ro = (v, d = 2) => <input className="input w-full bg-gray-50" value={fmtN(v, d)} readOnly/>;
  const material = materials.find(x => String(x.id) === f.material_id);

  const num = (k, step = '0.01') => (
    <input type="number" min="0" step={step} className="input w-full" value={f[k]} disabled={closed}
      onChange={e => set(k, e.target.value)}/>
  );
  const docRow = (which, file, setFile, name) => (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {name
        ? <button type="button" className="btn-secondary btn-sm flex items-center gap-1" onClick={() => openDoc(id, which)}><FileText size={12}/> {name}</button>
        : <span className="text-gray-400">No scan uploaded</span>}
      {!closed && (
        <label className="btn-secondary btn-sm cursor-pointer">
          {file ? `Selected: ${file.name}` : (name ? 'Replace scan' : 'Upload scan (PDF / image)')}
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" onChange={e => setFile(e.target.files?.[0] || null)}/>
        </label>
      )}
    </div>
  );

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => navigate('/execution')} className="btn-secondary flex items-center gap-1.5"><ChevronLeft size={14}/> Back</button>
        <div>
          <h2 className="page-title">Material Trip #{exec.trip_no || exec.id} — {exec.tanker_number}</h2>
          <p className="text-xs font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {fmtDate(exec.execution_date)} · {exec.start_point_name || 'supplier ?'} → {exec.delivery_point_name || 'customer ?'}
            {material && <> · {material.name} (SAP {material.sap_code})</>}
            {exec.entered_by_user_id && <> · Entered by: <span style={{ color: 'white', fontFamily: 'monospace' }}>{exec.entered_by_user_id}</span></>}
          </p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${closed ? 'bg-green-100 text-green-700' : exec.status === 'saved' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>{exec.status.replace('_', ' ')}</span>
        <button onClick={() => navigate(`/execution/${id}?view=standard`)} className="btn-secondary btn-sm flex items-center gap-1 ml-auto" title="Gate pass / COA printing, OUT & IN times, change requests">
          <Printer size={12}/> Gate pass / COA / changes
        </button>
      </div>

      {/* 1. Purchase from the supplier */}
      <div className="card p-4 space-y-3">
        <div className="font-semibold text-sm text-[#003a6b]">1. Purchase — supplier's document</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label className="label">Material *</label>
            <SearchableSelect value={f.material_id} onChange={v => set('material_id', v)} placeholder="Select material…" disabled={closed}
              options={materials.map(x => ({ value: String(x.id), label: `${x.name} (SAP ${x.sap_code})` }))}/></div>
          <div><label className="label">Supplier (starting point) *</label>
            <SearchableSelect value={f.start_point_id} onChange={v => set('start_point_id', v)} placeholder="Select…" disabled={closed}
              options={startPts.map(s => ({ value: String(s.id), label: s.name }))}/></div>
          <div><label className="label">Customer (delivery point) *</label>
            <SearchableSelect value={f.delivery_point_id} onChange={v => set('delivery_point_id', v)} placeholder="Select…" disabled={closed}
              options={delivPts.map(d => ({ value: String(d.id), label: d.name }))}/></div>
          <div><label className="label">Supplier document no.</label>
            <input className="input w-full" value={f.supplier_doc_no} disabled={closed} onChange={e => set('supplier_doc_no', e.target.value)}/></div>
          <div><label className="label">Purchased Qty (Kgs) *</label>{num('purchase_qty_kgs')}</div>
          <div><label className="label">Qty (Ltrs) — derived</label>{ro(Pd.ltrs)}</div>
          <div><label className="label">Kg Fat *</label>{num('purchase_kg_fat', '0.001')}</div>
          <div><label className="label">Kg SNF *</label>{num('purchase_kg_snf', '0.001')}</div>
          <div><label className="label">Fat % — derived</label>{ro(Pd.fat)}</div>
          <div><label className="label">SNF % — derived</label>{ro(Pd.snf)}</div>
          <div><label className="label">TS (Kg Fat + Kg SNF)</label>{ro(Pd.ts, 3)}</div>
        </div>
        {docRow('purchase', purchaseDoc, setPurchaseDoc, m.purchase_doc_name)}
      </div>

      {/* 2. Km to the customer */}
      <div className="card p-4 space-y-3">
        <div className="font-semibold text-sm text-[#003a6b]">2. Distance to the customer</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-end">
          <div><label className="label">Km travelled (keyed) *</label>{num('manual_km', '0.1')}</div>
          <div><label className="label">Google reference km</label>
            <input className="input w-full bg-gray-50" readOnly value={dist ? fmtN(dist.google_km || dist.system_km) : '—'}/></div>
          <div><label className="label">System km (Distance Master / Google)</label>
            <input className="input w-full bg-gray-50" readOnly value={dist ? fmtN(dist.system_km) : '—'}/></div>
          <button type="button" className="btn-secondary text-xs flex items-center gap-1" onClick={() => refetchDist()} disabled={distLoading}>
            <RefreshCw size={12} className={distLoading ? 'animate-spin' : ''}/> Refresh reference
          </button>
        </div>
        {dist?.incomplete && <div className="text-xs text-amber-700">Reference not available: the supplier or customer has no coordinates in Masters.</div>}
        {dist?.legs?.length > 0 && (
          <div className="text-xs text-gray-500">{dist.legs.map((l, i) => <span key={i}>{l.from_label} → {l.to_label}: {fmtN(l.km)} km ({l.source}){i < dist.legs.length - 1 ? ' · ' : ''}</span>)}</div>
        )}
        <div className="text-xs text-gray-500">The keyed km is what billing uses by default; the references stay visible to the biller and approvers.</div>
      </div>

      {/* 3. Customer acknowledgement */}
      <div className="card p-4 space-y-3">
        <div className="font-semibold text-sm text-[#003a6b]">3. Acknowledgement by the customer</div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><label className="label">Ack date</label>
            <input type="date" className="input w-full" value={f.ack_date} disabled={closed} onChange={e => set('ack_date', e.target.value)}/></div>
          <div><label className="label">Acknowledged Qty (Kgs) *</label>{num('ack_qty_kgs')}</div>
          <div><label className="label">Qty (Ltrs) — derived</label>{ro(Ad.ltrs)}</div>
          <div><label className="label">Kg Fat *</label>{num('ack_kg_fat', '0.001')}</div>
          <div><label className="label">Kg SNF *</label>{num('ack_kg_snf', '0.001')}</div>
          <div><label className="label">Fat % — derived</label>{ro(Ad.fat)}</div>
          <div><label className="label">SNF % — derived</label>{ro(Ad.snf)}</div>
          <div><label className="label">TS (Kg Fat + Kg SNF)</label>{ro(Ad.ts, 3)}</div>
        </div>
        {variation != null && (
          <div className={`text-xs font-medium ${Math.abs(variation) < 1 ? 'text-gray-500' : variation < 0 ? 'text-red-600' : 'text-green-700'}`}>
            Variation (acknowledged − purchased): {variation >= 0 ? '+' : ''}{fmtN(variation)} kg{tsVariation != null && <> · TS {tsVariation >= 0 ? '+' : ''}{fmtN(tsVariation, 3)} kg</>}
          </div>
        )}
        {docRow('ack', ackDoc, setAckDoc, m.ack_doc_name)}
        <div><label className="label">Remarks</label>
          <textarea className="input w-full" rows={2} value={f.remarks} disabled={closed} onChange={e => set('remarks', e.target.value)}/></div>
      </div>

      {!closed && (
        <div className="flex flex-wrap gap-2 justify-end">
          <button className="btn-secondary flex items-center gap-1.5" disabled={saveMut.isPending} onClick={() => saveMut.mutate(false)}>
            <Save size={14}/> Save
          </button>
          <button className="btn-primary flex items-center gap-1.5" disabled={saveMut.isPending}
            onClick={() => window.confirm('Acknowledge and close this material trip? It then goes to billing and can only be corrected through a change request.') && saveMut.mutate(true)}>
            <CheckCircle2 size={14}/> Acknowledge & Close
          </button>
        </div>
      )}
      {closed && <div className="text-xs text-white/90">Closed trip — corrections go through Request Changes on the standard execution page.</div>}
    </div>
  );
}
