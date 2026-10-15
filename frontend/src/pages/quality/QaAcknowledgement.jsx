// frontend/src/pages/quality/QaAcknowledgement.jsx
// Quality team's own plant acknowledgement (migration 069, owner 2026-10-15).
// Kgs first like the logistics Acknowledgement screen: litres = kgs / 1.0285,
// kg fat / SNF = kgs × % / 100 (the server recomputes and stores them). The
// QA Dispatch Report compares RMRD (adjusted) with these figures instead of
// the tanker team's acknowledgement; nothing else reads them.
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { getQaAckTankers, getQaAck, saveQaAck } from '../../api/index';

const KG_FACTOR = 1.0285;
const n = v => (v === '' || v == null ? null : parseFloat(v));
const fx = (v, d = 2) => (v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pad = v => String(v).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (iso, k) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const derive = c => {
  const kgs = n(c.qty_kgs); const fat = n(c.fat_pct); const snf = n(c.snf_pct);
  return { kgs, litres: kgs != null ? kgs / KG_FACTOR : null, kg_fat: kgs != null && fat != null ? kgs * fat / 100 : null, kg_snf: kgs != null && snf != null ? kgs * snf / 100 : null };
};

export default function QaAcknowledgement() {
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const [tankerId, setTankerId] = useState('');
  const [ackDate, setAckDate] = useState(addDays(today(), 1));
  const [rows, setRows] = useState([]);

  const { data: tankers = [] } = useQuery({ queryKey: ['qa-ack-tankers', date], enabled: !!date,
    queryFn: () => getQaAckTankers(date).then(r => r.data) });
  const { data: ack } = useQuery({ queryKey: ['qa-ack', date, tankerId], enabled: !!date && !!tankerId,
    queryFn: () => getQaAck({ date, tanker_id: tankerId }).then(r => r.data) });

  useEffect(() => { setTankerId(''); setAckDate(addDays(date, 1)); }, [date]);
  useEffect(() => {
    if (!ack) { setRows([]); return; }
    setAckDate(ack.ack_date || addDays(ack.lifting_date, 1));
    setRows(ack.chambers.map(c => ({ chamber: c.chamber, qty_kgs: c.qty_kgs ?? '', fat_pct: c.fat_pct ?? '', snf_pct: c.snf_pct ?? '', mbrt_mins: c.mbrt_mins ?? '', remarks: c.remarks || '',
      outside: !ack.compartment_codes.includes(c.chamber) })));
  }, [ack]);
  const setRow = (i, k, v) => setRows(p => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)));

  const saveMut = useMutation({
    mutationFn: () => saveQaAck({ lifting_date: date, tanker_id: parseInt(tankerId, 10), ack_date: ackDate || null,
      chambers: rows.map(r => ({ chamber: r.chamber, qty_kgs: r.qty_kgs, fat_pct: r.fat_pct, snf_pct: r.snf_pct, mbrt_mins: r.mbrt_mins, remarks: r.remarks })) }),
    onSuccess: res => {
      toast.success('QA acknowledgement saved');
      qc.setQueryData(['qa-ack', date, tankerId], res.data);
      qc.invalidateQueries({ queryKey: ['qa-ack-tankers', date] });
      qc.invalidateQueries({ queryKey: ['qa-entries'] });
    },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const d = rows.map(derive);
  const tot = d.reduce((s, x) => ({ kgs: s.kgs + (x.kgs || 0), litres: s.litres + (x.litres || 0), kg_fat: s.kg_fat + (x.kg_fat || 0), kg_snf: s.kg_snf + (x.kg_snf || 0) }),
    { kgs: 0, litres: 0, kg_fat: 0, kg_snf: 0 });
  const mbrts = rows.map(r => parseFloat(r.mbrt_mins)).filter(Number.isFinite);
  const mbrtMin = mbrts.length ? Math.min(...mbrts) : null;   // lowest chamber MBRT = weakest milk
  const ref = ack?.reference;
  const Ro = ({ label, value, dp = 2 }) => (
    <div><span className="text-[11px] font-semibold text-gray-600">{label}</span>
      <div className="input w-full bg-gray-50 py-2 text-gray-800">{fx(value, dp)}</div></div>);

  return (
    <div className="max-w-xl mx-auto space-y-3 pb-24">
      <h1 className="text-lg font-bold text-gray-800">QA Acknowledgement</h1>
      <div className="card p-4 space-y-3">
        <label className="block"><span className="text-[11px] font-semibold text-gray-600">Milk lifting date *</span>
          <input type="date" className="input w-full py-2 text-lg" value={date} max={today()} onChange={e => setDate(e.target.value)}/></label>
        <label className="block"><span className="text-[11px] font-semibold text-gray-600">Tanker *</span>
          <select className="input w-full py-2 text-lg" value={tankerId} onChange={e => setTankerId(e.target.value)}>
            <option value="">{tankers.length ? 'Select tanker' : 'No QA entries on this date'}</option>
            {tankers.map(t => <option key={t.id} value={t.id}>{t.tanker_number}{t.has_ack ? ' ✓' : ''}</option>)}
          </select></label>
        {tankerId && <label className="block"><span className="text-[11px] font-semibold text-gray-600">Acknowledgement date</span>
          <input type="date" className="input w-full py-2" value={ackDate} min={date} onChange={e => setAckDate(e.target.value)}/></label>}
      </div>

      {ref && (
        <div className="card p-3 text-xs text-gray-700 grid grid-cols-2 gap-2 bg-blue-50">
          <div><div className="font-semibold text-gray-500">QA dispatch ({ref.entries} rows)</div>{fx(ref.d_qty_litres)} L · {fx(ref.d_qty_kgs)} kg</div>
          <div><div className="font-semibold text-gray-500">RMRD adjusted</div>{fx(ref.rmrd_adj_qty_litres)} L · {fx(ref.rmrd_adj_qty_kgs)} kg
            <div className="text-gray-500">Fat {fx(ref.rmrd_adj_fat_pct)} % · SNF {fx(ref.rmrd_adj_snf_pct)} %</div></div>
        </div>
      )}

      {rows.map((r, i) => (
        <div key={r.chamber} className="card p-4 space-y-2">
          <div className="font-semibold text-gray-800">{r.chamber}{r.outside && <span className="ml-2 text-xs text-amber-600">not in Tanker Master — clear qty to remove</span>}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block"><span className="text-[11px] font-semibold text-gray-600">Qty (Kgs)</span>
              <input type="number" inputMode="decimal" className="input w-full py-2" value={r.qty_kgs} onChange={e => setRow(i, 'qty_kgs', e.target.value)}/></label>
            <Ro label="Litres" value={d[i].litres}/>
            <label className="block"><span className="text-[11px] font-semibold text-gray-600">Fat %</span>
              <input type="number" inputMode="decimal" step="0.01" className="input w-full py-2" value={r.fat_pct} onChange={e => setRow(i, 'fat_pct', e.target.value)}/></label>
            <label className="block"><span className="text-[11px] font-semibold text-gray-600">SNF %</span>
              <input type="number" inputMode="decimal" step="0.01" className="input w-full py-2" value={r.snf_pct} onChange={e => setRow(i, 'snf_pct', e.target.value)}/></label>
            <Ro label="Kg fat" value={d[i].kg_fat}/>
            <Ro label="Kg SNF" value={d[i].kg_snf}/>
            <label className="block"><span className="text-[11px] font-semibold text-gray-600">MBRT (mins)</span>
              <input type="number" inputMode="decimal" step="1" min="0" max="1440" className="input w-full py-2" value={r.mbrt_mins} onChange={e => setRow(i, 'mbrt_mins', e.target.value)}/></label>
          </div>
          <input className="input w-full py-2 text-sm" placeholder="Remarks" value={r.remarks} onChange={e => setRow(i, 'remarks', e.target.value)}/>
        </div>
      ))}

      {rows.length > 0 && (
        <div className="card p-3 text-sm font-semibold text-gray-800 grid grid-cols-2 gap-1">
          <div>Total {fx(tot.kgs)} kg</div><div>{fx(tot.litres)} L</div>
          <div>Kg fat {fx(tot.kg_fat)} ({tot.kgs > 0 ? fx(tot.kg_fat / tot.kgs * 100) : '—'} %)</div>
          <div>Kg SNF {fx(tot.kg_snf)} ({tot.kgs > 0 ? fx(tot.kg_snf / tot.kgs * 100) : '—'} %)</div>
          <div>MBRT (lowest) {mbrtMin == null ? '—' : `${fx(mbrtMin, 0)} mins`}</div>
        </div>
      )}

      {tankerId && rows.length > 0 && (
        <div className="flex justify-end">
          <button className="btn-primary flex items-center gap-1.5 py-2.5 px-4" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}><Save size={15}/> Save</button>
        </div>
      )}
    </div>
  );
}
