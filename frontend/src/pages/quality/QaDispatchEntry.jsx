// frontend/src/pages/quality/QaDispatchEntry.jsx
// Quality team: tanker dispatch vs truck-sheet (RMRD) entry (migration 052).
// Phone-first: one column, big inputs, chips for compartment and shifts, live
// derived figures. Independent of the tanker team's screens; no execution
// data is shown here (owner decision 2026-10-07).
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, SaveAll, ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/SearchableSelect';
import { getQaLookups, getQaEntries, createQaEntry, updateQaEntry } from '../../api/index';
import { fmtDate } from '../../utils/date';

const KG_FACTOR = 1.0285;
const n = v => (v === '' || v == null ? null : parseFloat(v));
const fx = (v, d = 2) => (v == null || isNaN(v) ? '—' : v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Local-date arithmetic: toISOString() would shift midnight IST back to the previous UTC day.
const pad = v => String(v).padStart(2, '0');
const addDays = (iso, k) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const EMPTY = { lifting_date: today(), route_id: '', tanker_id: '', bmcu_id: '', compartment: ['FC'], milk_type: '', scale_reading: '', shifts: [],
  d_qty_litres: '', d_fat_pct: '', d_clr: '', ts_date: '', ts_shift: '', ts_qty_litres: '', ts_fat_pct: '', ts_snf_pct: '', ts_mbrt_mins: '', remarks: '' };

export default function QaDispatchEntry() {
  const qc = useQueryClient(); const navigate = useNavigate();
  const [params] = useSearchParams();
  const editId = params.get('id');
  const [f, setF] = useState(EMPTY);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const { data: lk } = useQuery({ queryKey: ['qa-lookups'], queryFn: () => getQaLookups().then(r => r.data), staleTime: 10 * 60_000 });
  const { data: todayRows = [] } = useQuery({
    queryKey: ['qa-entries', f.lifting_date, f.tanker_id], enabled: !!f.lifting_date && !!f.tanker_id,
    queryFn: () => getQaEntries({ from: f.lifting_date, to: f.lifting_date, tanker_id: f.tanker_id }).then(r => r.data),
  });
  const { data: editing } = useQuery({ queryKey: ['qa-entry', editId], enabled: !!editId,
    queryFn: () => getQaEntries({ from: '2000-01-01' }).then(r => r.data.find(x => String(x.id) === editId)) });
  useEffect(() => {
    if (!editing) return;
    setF({ lifting_date: editing.lifting_date, route_id: String(editing.route_id || ''), tanker_id: String(editing.tanker_id), bmcu_id: String(editing.bmcu_id),
      compartment: editing.compartment ? editing.compartment.split(',') : [], milk_type: editing.milk_type || '', scale_reading: editing.scale_reading ?? '', shifts: editing.shifts ? editing.shifts.split(',') : [],
      d_qty_litres: editing.d_qty_litres ?? '', d_fat_pct: editing.d_fat_pct ?? '', d_clr: editing.d_clr ?? '',
      ts_date: editing.ts_date || '', ts_shift: editing.ts_shift || '', ts_qty_litres: editing.ts_qty_litres ?? '', ts_fat_pct: editing.ts_fat_pct ?? '', ts_snf_pct: editing.ts_snf_pct ?? '', ts_mbrt_mins: editing.ts_mbrt_mins ?? '',
      remarks: editing.remarks || '' });
  }, [editing]);

  const tanker = lk?.tankers.find(t => String(t.id) === f.tanker_id);
  const route  = lk?.routes.find(r => String(r.id) === f.route_id);
  const bmcuOptions = useMemo(() => {
    const all = lk?.bmcus || [];
    const member = new Set(route?.bmcu_ids || []);
    const sorted = member.size ? [...all].sort((a, b) => (member.has(b.id) - member.has(a.id)) || a.bmcu_code.localeCompare(b.bmcu_code)) : all;
    return sorted.map(b => ({ value: String(b.id), label: `${b.bmcu_code} — ${b.bmcu_name}${member.has(b.id) ? ' ★' : ''}` }));
  }, [lk, route]);
  // Chips from Tanker Master ('2C' → FC, BC; '3C' → FC, MC, BC); several may be ticked when one BMCU's milk is split.
  const compartments = tanker?.compartment_codes || ['FC', 'MC', 'BC'];
  const toggleComp = c => set('compartment', f.compartment.includes(c) ? f.compartment.filter(x => x !== c) : ['FC', 'MC', 'BC'].filter(x => x === c || f.compartment.includes(x)));
  // Shift chips: previous day's M and E, then the lifting day's M and E (e.g. 06M 06E 07M 07E)
  const shiftChips = f.lifting_date ? (() => { const p = addDays(f.lifting_date, -1).slice(8), d = f.lifting_date.slice(8); return [`${p}M`, `${p}E`, `${d}M`, `${d}E`]; })() : [];
  const toggleShift = s => set('shifts', f.shifts.includes(s) ? f.shifts.filter(x => x !== s) : [...f.shifts, s].sort());

  // Live derived figures (same formulas as the server)
  const dSnf = n(f.d_clr) != null && n(f.d_fat_pct) != null ? n(f.d_clr) / 4 + 0.21 * n(f.d_fat_pct) + 0.36 : null;
  const dKgs = n(f.d_qty_litres) != null ? n(f.d_qty_litres) * KG_FACTOR : null;
  const dKgFat = dKgs != null && n(f.d_fat_pct) != null ? dKgs * n(f.d_fat_pct) / 100 : null;
  const dKgSnf = dKgs != null && dSnf != null ? dKgs * dSnf / 100 : null;
  const tKgs = n(f.ts_qty_litres) != null ? n(f.ts_qty_litres) * KG_FACTOR : null;
  const tKgFat = tKgs != null && n(f.ts_fat_pct) != null ? tKgs * n(f.ts_fat_pct) / 100 : null;
  const tKgSnf = tKgs != null && n(f.ts_snf_pct) != null ? tKgs * n(f.ts_snf_pct) / 100 : null;
  const v = (a, b) => (a != null && b != null ? a - b : null);
  const vars = { qty: v(n(f.d_qty_litres), n(f.ts_qty_litres)), fat: v(n(f.d_fat_pct), n(f.ts_fat_pct)), snf: v(dSnf, n(f.ts_snf_pct)) };

  const payload = () => ({ ...f, compartment: f.compartment.join(','), shifts: f.shifts.join(','), ts_date: f.ts_date || f.lifting_date });
  const saveMut = useMutation({
    mutationFn: ({ next }) => (editId ? updateQaEntry(editId, payload()) : createQaEntry(payload())).then(r => ({ row: r.data, next })),
    onSuccess: ({ row, next }) => {
      toast.success(`${row.tanker_number} · ${row.bmcu_code} ${row.compartment} saved`);
      qc.invalidateQueries(['qa-entries']);
      if (editId) return navigate('/quality/entries');
      if (next) setF(p => ({ ...EMPTY, lifting_date: p.lifting_date, route_id: p.route_id, tanker_id: p.tanker_id, shifts: p.shifts, ts_date: p.ts_date, ts_shift: p.ts_shift }));
      else setF(p => ({ ...EMPTY, lifting_date: p.lifting_date }));
    },
    onError: e => toast.error(e.response?.data?.error || e.message, { duration: 8000 }),
  });
  const check = () => {
    const miss = [];
    if (!f.lifting_date) miss.push('lifting date'); if (!f.tanker_id) miss.push('tanker'); if (!f.bmcu_id) miss.push('BMCU');
    if (!f.compartment.length) miss.push('at least one compartment');
    if (!f.milk_type) miss.push('milk type');
    if (f.d_qty_litres === '') miss.push('dispatch litres');
    if (miss.length) { toast.error('Enter: ' + miss.join(', ')); return false; }
    return true;
  };

  const num = (k, label, step = '0.01', big = false) => (
    <label className="block">
      <span className="text-[11px] font-semibold text-gray-600">{label}</span>
      <input type="number" inputMode="decimal" min="0" step={step} value={f[k]} onChange={e => set(k, e.target.value)}
             className={`input w-full ${big ? 'text-lg py-2.5' : 'py-2'}`}/>
    </label>
  );
  const ro = (label, value, d = 2) => (
    <div><span className="text-[11px] font-semibold text-gray-500">{label}</span>
      <div className="input w-full bg-gray-50 py-2 text-gray-800">{fx(value, d)}</div></div>
  );
  const chips = (items, selected, onPick, multi = false) => (
    <div className="flex flex-wrap gap-2">
      {items.map(x => { const on = multi ? selected.includes(x) : selected === x;
        return <button key={x} type="button" onClick={() => onPick(x)}
          className={`px-4 py-2 rounded-full text-sm font-semibold border ${on ? 'bg-[#0078d4] text-white border-[#0078d4]' : 'bg-white text-gray-700 border-gray-300'}`}>{x}</button>; })}
    </div>
  );

  return (
    <div className="max-w-xl mx-auto space-y-3 pb-24">
      <div className="flex items-center gap-2">
        {editId && <button onClick={() => navigate('/quality/entries')} className="btn-secondary flex items-center gap-1"><ChevronLeft size={14}/> Back</button>}
        <h2 className="page-title">{editId ? `Edit entry #${editId}` : 'QA Tanker Dispatch Entry'}</h2>
      </div>

      <div className="card p-4 space-y-3">
        <label className="block"><span className="text-[11px] font-semibold text-gray-600">Milk lifting date *</span>
          <input type="date" className="input w-full py-2 text-lg" value={f.lifting_date} max={today()} onChange={e => set('lifting_date', e.target.value)}/></label>
        <div><span className="text-[11px] font-semibold text-gray-600">Route</span>
          <SearchableSelect value={f.route_id} onChange={v => set('route_id', v)} placeholder="Select route…" options={(lk?.routes || []).map(r => ({ value: String(r.id), label: r.route_name }))}/></div>
        <div><span className="text-[11px] font-semibold text-gray-600">Tanker *</span>
          <SearchableSelect value={f.tanker_id} onChange={v => set('tanker_id', v)} placeholder="Select tanker…" options={(lk?.tankers || []).map(t => ({ value: String(t.id), label: t.tanker_number }))}/></div>
        <div><span className="text-[11px] font-semibold text-gray-600">BMCU * {route?.bmcu_ids?.length ? <span className="text-gray-400 font-normal">(★ = on this route)</span> : null}</span>
          <SearchableSelect value={f.bmcu_id} onChange={v => set('bmcu_id', v)} placeholder="Select BMCU…" options={bmcuOptions}/></div>
        <div><span className="text-[11px] font-semibold text-gray-600">Compartment(s) * <span className="text-gray-400 font-normal">tick all the milk went into</span></span>{chips(compartments, f.compartment, toggleComp, true)}</div>
        <div><span className="text-[11px] font-semibold text-gray-600">Milk type * <span className="text-gray-400 font-normal">milk in the ticked compartment(s)</span></span>{chips(['Cow', 'Buffalo', 'Mixed'], f.milk_type, v => set('milk_type', v))}</div>
        {num('scale_reading', 'Scale reading', '0.01')}
        <div><span className="text-[11px] font-semibold text-gray-600">Shifts</span>
          {chips(shiftChips, f.shifts, toggleShift, true)}
          <input className="input w-full py-1.5 mt-2 text-sm" placeholder="or type e.g. 23E,24M,24E" value={f.shifts.join(',')}
                 onChange={e => set('shifts', e.target.value.toUpperCase().split(',').map(s => s.trim()).filter(Boolean))}/></div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="font-semibold text-sm text-[#003a6b]">Dispatch</div>
        {num('d_qty_litres', 'Qty (Lts) *', '0.01', true)}
        <div className="grid grid-cols-2 gap-3">{num('d_fat_pct', 'Fat %')}{num('d_clr', 'CLR')}</div>
        <div className="grid grid-cols-2 gap-3">{ro('SNF % (CLR/4 + 0.21×Fat + 0.36)', dSnf, 2)}{ro('Qty (Kgs)', dKgs)}</div>
        <div className="grid grid-cols-2 gap-3">{ro('KG Fat', dKgFat)}{ro('KG SNF', dKgSnf)}</div>
      </div>

      <div className="card p-4 space-y-3">
        <div className="font-semibold text-sm text-[#003a6b]">Truck sheet (RMRD)</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-[11px] font-semibold text-gray-600">Date</span>
            <input type="date" className="input w-full py-2" value={f.ts_date || f.lifting_date} onChange={e => set('ts_date', e.target.value)}/></label>
          <label className="block"><span className="text-[11px] font-semibold text-gray-600">Shift</span>
            <input className="input w-full py-2" placeholder="e.g. 24M" value={f.ts_shift} onChange={e => set('ts_shift', e.target.value.toUpperCase())}/></label>
        </div>
        {num('ts_qty_litres', 'Qty (Lts)', '0.01', true)}
        <div className="grid grid-cols-3 gap-3">{num('ts_fat_pct', 'Fat %')}{num('ts_snf_pct', 'SNF %')}{num('ts_mbrt_mins', 'MBRT (mins)')}</div>
        <div className="grid grid-cols-3 gap-3">{ro('Qty (Kgs)', tKgs)}{ro('KG Fat', tKgFat)}{ro('KG SNF', tKgSnf)}</div>
      </div>

      <div className="card p-4">
        <div className="font-semibold text-sm text-[#003a6b] mb-2">Variation (dispatch − truck sheet)</div>
        <div className="grid grid-cols-3 gap-3 text-center">
          {[['Qty (Lts)', vars.qty, 2], ['Fat', vars.fat, 2], ['SNF', vars.snf, 2]].map(([l, x, d]) => (
            <div key={l} className={`rounded-lg py-2 ${x == null ? 'bg-gray-50 text-gray-400' : Math.abs(x) < 0.005 ? 'bg-gray-100' : x < 0 ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
              <div className="text-[11px]">{l}</div><div className="text-lg font-bold">{x == null ? '—' : (x > 0 ? '+' : '') + fx(x, d)}</div>
            </div>))}
        </div>
        <label className="block mt-3"><span className="text-[11px] font-semibold text-gray-600">Remarks</span>
          <textarea className="input w-full" rows={2} value={f.remarks} onChange={e => set('remarks', e.target.value)}/></label>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-gray-200 p-3 flex gap-2 justify-end md:static md:bg-transparent md:border-0 md:p-0">
        <button className="btn-secondary flex items-center gap-1.5 py-2.5 px-4" disabled={saveMut.isPending} onClick={() => check() && saveMut.mutate({ next: false })}><Save size={15}/> Save</button>
        {!editId && <button className="btn-primary flex items-center gap-1.5 py-2.5 px-4" disabled={saveMut.isPending} onClick={() => check() && saveMut.mutate({ next: true })}><SaveAll size={15}/> Save & next BMCU</button>}
      </div>

      {!editId && todayRows.length > 0 && (
        <div className="card p-3">
          <div className="text-xs font-semibold text-gray-600 mb-1">Entered for {tanker?.tanker_number} on {fmtDate(f.lifting_date)}</div>
          {todayRows.map(r => (
            <div key={r.id} className="flex items-center justify-between text-xs py-1 border-t border-gray-100">
              <span>{r.bmcu_code} {r.bmcu_name} · <b>{r.compartment}</b> · {fx(parseFloat(r.d_qty_litres), 0)} L / {fx(parseFloat(r.ts_qty_litres), 0)} L</span>
              <button className="text-[#005ba3] underline" onClick={() => navigate(`/quality/entry?id=${r.id}`)}>edit</button>
            </div>))}
        </div>
      )}
    </div>
  );
}
