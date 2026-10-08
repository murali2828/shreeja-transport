// Tanker Rate Master — fortnightly ₹/KM rates per state × capacity (KL) ×
// transport type. Screen entry + Excel template upload; duplicates and
// overlapping periods are rejected by the server.
import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Download, Upload, Plus, Pencil, Trash2, X, Fuel } from 'lucide-react';
import api, {
  getTankerRates, createTankerRate, updateTankerRate, deleteTankerRate,
  downloadTankerRateTemplate, uploadTankerRates,
  getDieselRateMatrix, createDieselRate, updateDieselRate,
} from '../../api';
import { useAuth } from '../../hooks/useAuth';
import { fmtDate } from '../../utils/date';

const STATES = ['Andhra Pradesh', 'Tamil Nadu', 'Karnataka', 'Telangana'];
const TYPES  = ['BMCU/CC to Dairy/CC', 'Point to Point'];
const EMPTY  = { effective_from: '', effective_to: '', state: 'Andhra Pradesh',
  capacity_kl: '', transport_type: TYPES[0], mileage_km_per_litre: '', rate_per_km: '', diesel_price: '' };

const nf = (v, d = 2) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
// Fortnight → dates ('YYYY-MM' + '1' | '2'), as on the billing page.
const fnDates = (month, fortnight) => {
  if (!month) return null;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(y, m, 0).getDate();
  return fortnight === '1' ? { from: `${month}-01`, to: `${month}-15` } : { from: `${month}-16`, to: `${month}-${String(end).padStart(2, '0')}` };
};

// Diesel ₹/L per state for a fortnight (Diesel Rates master, migration 058).
// Filled by the template upload's diesel row and the rate form; this strip
// shows the fortnight's prices and lets masters correct them.
function DieselPanel({ canEdit }) {
  const qc = useQueryClient();
  const now = new Date();
  const [month, setMonth] = useState(now.toISOString().slice(0, 7));
  const [fortnight, setFortnight] = useState(now.getDate() > 15 ? '2' : '1');
  const [prices, setPrices] = useState({});
  const period = fnDates(month, fortnight);
  const { data: matrix } = useQuery({ queryKey: ['diesel-rates', 'matrix'], queryFn: () => getDieselRateMatrix({ periods: 30 }).then(r => r.data) });
  const current = matrix?.periods?.find(p => p.effective_from === period?.from);
  const prevPeriod = matrix?.periods?.find(p => p.effective_from < period?.from);
  const saveMut = useMutation({
    mutationFn: async () => {
      for (const st of STATES) {
        const v = prices[st];
        if (v === undefined || v === '') continue;
        const body = { state: st, effective_from: period.from, effective_to: period.to, price_per_litre: v, source: 'Tanker Rates screen' };
        const row = current?.prices?.[st];
        if (row) await updateDieselRate(row.id, body); else await createDieselRate(body);
      }
    },
    onSuccess: () => { toast.success('Diesel prices saved'); setPrices({}); qc.invalidateQueries({ queryKey: ['diesel-rates'] }); qc.invalidateQueries({ queryKey: ['tanker-rates'] }); },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });
  const dirty = STATES.some(st => prices[st] !== undefined && prices[st] !== '');
  return (
    <div className="card p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Fuel size={14} className="text-[#005ba3]"/><span className="font-semibold">Diesel ₹/litre</span>
        <input type="month" className="input text-xs" value={month} onChange={e => setMonth(e.target.value)}/>
        <select className="input text-xs" value={fortnight} onChange={e => setFortnight(e.target.value)}>
          <option value="1">1 – 15</option><option value="2">16 – month end</option>
        </select>
        {STATES.map(st => {
          const row = current?.prices?.[st], prev = prevPeriod?.prices?.[st]?.price;
          return (
            <label key={st} className="flex items-center gap-1">
              <span className="text-gray-600">{st.split(' ').map(w => w[0]).join('')}</span>
              <input type="number" step="0.01" className="input text-xs w-24 text-right" disabled={!canEdit}
                     placeholder={prev != null ? nf(prev) : '—'} value={prices[st] ?? (row ? row.price : '')}
                     onChange={e => setPrices(p => ({ ...p, [st]: e.target.value }))}/>
            </label>
          );
        })}
        {canEdit && <button className="btn-primary btn-sm text-xs" disabled={!dirty || saveMut.isPending} onClick={() => saveMut.mutate()}>Save diesel</button>}
      </div>
      <div className="text-[11px] text-gray-500">
        {period && `${fmtDate(period.from)} → ${fmtDate(period.to)}`}{prevPeriod && ` · previous entry ${fmtDate(prevPeriod.effective_from)} shown as placeholder`} · the template's "Diesel Price" row and the rate form's diesel field also fill these prices.
      </div>
    </div>
  );
}

export default function TankerRates() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = (user?.roles || [user?.role]).some(r => ['admin', 'planner'].includes(r));
  const fileRef = useRef(null);

  const [fState, setFState] = useState('');
  const [fType, setFType]   = useState('');
  const [fDate, setFDate]   = useState('');
  const [form, setForm]     = useState(null); // null | {..., id?}

  const { data: rows, isLoading } = useQuery({
    queryKey: ['tanker-rates', fState, fType, fDate],
    queryFn: () => getTankerRates({
      state: fState || undefined, transport_type: fType || undefined, on_date: fDate || undefined,
    }).then(r => r.data),
  });

  const saveMut = useMutation({
    mutationFn: () => form.id ? updateTankerRate(form.id, form) : createTankerRate(form),
    onSuccess: () => { toast.success('Rate saved'); setForm(null); qc.invalidateQueries(['tanker-rates']); },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });
  const delMut = useMutation({
    mutationFn: id => deleteTankerRate(id),
    onSuccess: () => { toast.success('Rate deleted'); qc.invalidateQueries(['tanker-rates']); },
    onError: e => toast.error(e.response?.data?.error || e.message),
  });

  const onUpload = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    uploadTankerRates(fd)
      .then(r => {
        const { inserted, skipped, errors } = r.data;
        toast.success(`${inserted} rate(s) uploaded${skipped ? `, ${skipped} skipped` : ''}${r.data.diesel_saved ? `, diesel saved for ${r.data.diesel_saved} state(s)` : ''}`);
        qc.invalidateQueries({ queryKey: ['diesel-rates'] });
        if (errors?.length) toast.error(errors.slice(0, 5).join('\n'), { duration: 9000 });
        qc.invalidateQueries(['tanker-rates']);
      })
      .catch(err => toast.error(err.response?.data?.error || err.message))
      .finally(() => { e.target.value = ''; });
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="page-title">Tanker Rates</h2>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.92)' }}>
            Fortnightly ₹/KM per state · capacity · transport type — vendor payments are made on these rates
          </p>
        </div>
        <div className="flex-1" />
        {canEdit && (
          <>
            <button className="btn-secondary text-xs flex items-center gap-1.5"
                    onClick={() => downloadTankerRateTemplate()}>
              <Download size={13}/> Template
            </button>
            <button className="btn-secondary text-xs flex items-center gap-1.5"
                    onClick={() => fileRef.current?.click()}>
              <Upload size={13}/> Upload Excel
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={onUpload}/>
            <button className="btn-primary text-xs flex items-center gap-1.5"
                    onClick={() => setForm({ ...EMPTY })}>
              <Plus size={13}/> New Rate
            </button>
          </>
        )}
      </div>

      <DieselPanel canEdit={canEdit}/>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select className="input text-xs" value={fState} onChange={e => setFState(e.target.value)}>
          <option value="">All states</option>
          {STATES.map(s => <option key={s}>{s}</option>)}
        </select>
        <select className="input text-xs" value={fType} onChange={e => setFType(e.target.value)}>
          <option value="">All transport types</option>
          {TYPES.map(t => <option key={t}>{t}</option>)}
        </select>
        <input type="date" className="input text-xs" value={fDate} title="Rates effective on this date"
               onChange={e => setFDate(e.target.value)}/>
        {fDate && <button className="text-xs text-white/90 underline" onClick={() => setFDate('')}>clear date</button>}
      </div>

      {/* Entry form */}
      {form && (
        <div className="card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold text-sm">{form.id ? 'Edit Rate' : 'New Rate'}</div>
            <button onClick={() => setForm(null)} className="p-1 rounded hover:bg-gray-100"><X size={14}/></button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <label>Effective From *
              <input type="date" className="input w-full mt-1" value={form.effective_from}
                     onChange={e => set('effective_from', e.target.value)}/>
            </label>
            <label>Effective To *
              <input type="date" className="input w-full mt-1" value={form.effective_to}
                     onChange={e => set('effective_to', e.target.value)}/>
            </label>
            <label>State *
              <select className="input w-full mt-1" value={form.state} onChange={e => set('state', e.target.value)}>
                {STATES.map(s => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label>Transport Type *
              <select className="input w-full mt-1" value={form.transport_type} onChange={e => set('transport_type', e.target.value)}>
                {TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label>Capacity (KL) *
              <input type="number" step="0.1" className="input w-full mt-1" value={form.capacity_kl}
                     onChange={e => set('capacity_kl', e.target.value)}/>
            </label>
            <label>Rate per KM (₹) *
              <input type="number" step="0.01" className="input w-full mt-1" value={form.rate_per_km}
                     onChange={e => set('rate_per_km', e.target.value)}/>
            </label>
            <label>Mileage (KM/Ltr)
              <input type="number" step="0.01" className="input w-full mt-1" value={form.mileage_km_per_litre}
                     onChange={e => set('mileage_km_per_litre', e.target.value)}/>
            </label>
            <label>Diesel Price (₹/Ltr)
              <input type="number" step="0.01" className="input w-full mt-1" value={form.diesel_price}
                     onChange={e => set('diesel_price', e.target.value)}/>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-secondary text-xs" onClick={() => setForm(null)}>Cancel</button>
            <button className="btn-primary text-xs" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
              {saveMut.isPending ? 'Saving…' : 'Save Rate'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[68vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-blue-50">
              <tr className="text-left text-gray-600">
                {['Effective From', 'Effective To', 'State', 'Capacity (KL)', 'Transport Type',
                  'Mileage (KM/L)', 'Rate / KM (₹)', 'Diesel (₹/L)', 'Entered By', canEdit ? 'Actions' : null]
                  .filter(Boolean).map(h => <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={10} className="px-3 py-4 text-gray-400">Loading…</td></tr>}
              {!isLoading && !rows?.length &&
                <tr><td colSpan={10} className="px-3 py-4 text-gray-400">No rates found — add one or upload the template.</td></tr>}
              {(rows || []).map(r => (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-blue-50/50">
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.effective_from}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.effective_to}</td>
                  <td className="px-3 py-1.5">{r.state}</td>
                  <td className="px-3 py-1.5 text-right">{nf(r.capacity_kl, 1)}</td>
                  <td className="px-3 py-1.5">{r.transport_type}</td>
                  <td className="px-3 py-1.5 text-right">{nf(r.mileage_km_per_litre)}</td>
                  <td className="px-3 py-1.5 text-right font-semibold text-[#005ba3]">{nf(r.rate_per_km)}</td>
                  <td className="px-3 py-1.5 text-right">{nf(r.diesel_price)}</td>
                  <td className="px-3 py-1.5">{r.created_by_name || '—'}</td>
                  {canEdit && (
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <button className="p-1 text-gray-500 hover:text-blue-600" title="Edit"
                              onClick={() => setForm({ ...r })}><Pencil size={13}/></button>
                      <button className="p-1 text-gray-500 hover:text-red-600" title="Delete"
                              onClick={() => window.confirm('Delete this rate?') && delMut.mutate(r.id)}>
                        <Trash2 size={13}/>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
