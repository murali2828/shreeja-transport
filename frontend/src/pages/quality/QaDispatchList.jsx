// frontend/src/pages/quality/QaDispatchList.jsx
// Quality team: list / report of tanker dispatch vs truck-sheet entries with
// Excel download in the team's format (migration 052).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/SearchableSelect';
import { getQaLookups, getQaEntries, deleteQaEntry, downloadQaEntriesExcel } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';
import { fmtDate } from '../../utils/date';

const fx = (v, d = 2) => (v == null || v === '' ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local date, not UTC

export default function QaDispatchList() {
  const qc = useQueryClient(); const navigate = useNavigate(); const { user } = useAuth();
  const [flt, setFlt] = useState({ from: iso(new Date(Date.now() - 6 * 86400000)), to: iso(new Date()), tanker_id: '', bmcu_id: '', route_id: '' });
  const set = (k, v) => setFlt(p => ({ ...p, [k]: v }));
  const { data: lk } = useQuery({ queryKey: ['qa-lookups'], queryFn: () => getQaLookups().then(r => r.data), staleTime: 10 * 60_000 });
  const { data: rows = [], isLoading, error } = useQuery({ queryKey: ['qa-entries', flt], queryFn: () => getQaEntries(flt).then(r => r.data) });
  const delMut = useMutation({ mutationFn: id => deleteQaEntry(id), onSuccess: () => { toast.success('Entry deleted'); qc.invalidateQueries(['qa-entries']); },
    onError: e => toast.error(e.response?.data?.error || e.message) });
  const excel = () => downloadQaEntriesExcel(flt).then(r => {
    const url = URL.createObjectURL(r.data); const a = document.createElement('a'); a.href = url; a.download = `qa_tanker_dispatch_${flt.from}_${flt.to}.xlsx`; a.click(); URL.revokeObjectURL(url);
  }).catch(e => toast.error(e.response?.data?.error || e.message));
  const col = (x, d = 2) => <td className="px-2 py-1 text-right whitespace-nowrap">{fx(x, d)}</td>;
  const vcol = x => <td className={`px-2 py-1 text-right whitespace-nowrap font-semibold ${x == null ? '' : x < 0 ? 'text-red-600' : x > 0 ? 'text-green-700' : ''}`}>{x == null ? '—' : (x > 0 ? '+' : '') + fx(x)}</td>;

  return (
    <div className="space-y-3 w-full">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="page-title">QA Tanker Dispatch Report</h2>
        <button className="btn-primary flex items-center gap-1.5 ml-auto" onClick={() => navigate('/quality/entry')}><Plus size={14}/> New entry</button>
        <button className="btn-secondary flex items-center gap-1.5" onClick={excel}><Download size={14}/> Excel</button>
      </div>
      {error && <div className="card p-3 text-sm text-red-700 bg-red-50">Could not load entries: {error.response?.data?.error || error.message}</div>}
      {/* relative z-20: the table card below has a backdrop blur that would otherwise paint over the open dropdowns */}
      <div className="card p-3 grid grid-cols-2 md:grid-cols-5 gap-2 items-end relative z-20">
        <label className="text-xs">From<input type="date" className="input w-full py-1.5" value={flt.from} onChange={e => set('from', e.target.value)}/></label>
        <label className="text-xs">To<input type="date" className="input w-full py-1.5" value={flt.to} onChange={e => set('to', e.target.value)}/></label>
        <div className="text-xs">Tanker<SearchableSelect value={flt.tanker_id} onChange={v => set('tanker_id', v)} placeholder="All" options={(lk?.tankers || []).map(t => ({ value: String(t.id), label: t.tanker_number }))}/></div>
        <div className="text-xs">BMCU<SearchableSelect value={flt.bmcu_id} onChange={v => set('bmcu_id', v)} placeholder="All" options={(lk?.bmcus || []).map(b => ({ value: String(b.id), label: `${b.bmcu_code} — ${b.bmcu_name}` }))}/></div>
        <div className="text-xs">Route<SearchableSelect value={flt.route_id} onChange={v => set('route_id', v)} placeholder="All" options={(lk?.routes || []).map(r => ({ value: String(r.id), label: r.route_name }))}/></div>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[70vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-blue-50 text-left text-gray-600">
              <tr>{['Submitted', 'Route', 'Lifting', 'Tanker', 'BMCU', 'Comp', 'Scale', 'Shift', 'D Lts', 'D Fat%', 'CLR', 'D SNF', 'D Kgs', 'D KgFat', 'D KgSNF',
                   'TS Lts', 'TS Fat%', 'TS SNF', 'TS Kgs', 'TS KgFat', 'TS KgSNF', 'Var Lts', 'Var Fat', 'Var SNF', 'By', ''].map(h => <th key={h} className="px-2 py-2 whitespace-nowrap">{h}</th>)}</tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={26} className="px-3 py-4 text-gray-400">Loading…</td></tr>}
              {!isLoading && !rows.length && <tr><td colSpan={26} className="px-3 py-4 text-gray-400">No entries for this filter.</td></tr>}
              {rows.map(r => (
                <tr key={r.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                  <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.submission_date)}</td>
                  <td className="px-2 py-1">{r.route_name || '—'}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.lifting_date)}</td>
                  <td className="px-2 py-1 font-semibold text-[#005ba3] whitespace-nowrap">{r.tanker_number}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.bmcu_code} {r.bmcu_name}</td>
                  <td className="px-2 py-1">{r.compartment}</td>
                  {col(r.scale_reading)}<td className="px-2 py-1">{r.shifts || '—'}</td>
                  {col(r.d_qty_litres, 0)}{col(r.d_fat_pct)}{col(r.d_clr)}{col(r.d_snf_pct)}{col(r.d_qty_kgs)}{col(r.d_kg_fat)}{col(r.d_kg_snf)}
                  {col(r.ts_qty_litres, 0)}{col(r.ts_fat_pct)}{col(r.ts_snf_pct)}{col(r.ts_qty_kgs)}{col(r.ts_kg_fat)}{col(r.ts_kg_snf)}
                  {vcol(r.qty_var_litres)}{vcol(r.fat_var)}{vcol(r.snf_var)}
                  <td className="px-2 py-1 whitespace-nowrap">{r.entered_by_name}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <button className="text-[#005ba3] underline mr-2" onClick={() => navigate(`/quality/entry?id=${r.id}`)}>edit</button>
                    {user?.role === 'admin' && <button className="text-gray-400 hover:text-red-600" onClick={() => window.confirm('Delete this QA entry?') && delMut.mutate(r.id)}><Trash2 size={12}/></button>}
                  </td>
                </tr>))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
