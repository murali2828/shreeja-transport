// frontend/src/pages/quality/QaDispatchList.jsx
// Quality team: list / report of tanker dispatch vs truck-sheet entries with
// Excel download in the team's format (migration 052).
import { useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/SearchableSelect';
import { getQaLookups, getQaReport, deleteQaEntry, downloadQaEntriesExcel } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';
import { fmtDate } from '../../utils/date';

const fx = (v, d = 2) => (v == null || v === '' ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local date, not UTC

// Column sections (owner, 2026-10-10): colour band per section, light tint on the body cells.
const SEC = { e: 'bg-slate-100', d: 'bg-sky-100', t: 'bg-green-100', v: 'bg-amber-100', a: 'bg-violet-100', r: 'bg-pink-100', x: 'bg-gray-50' };
const SEC_BODY = { d: 'bg-sky-50/60', t: 'bg-green-50/60', v: 'bg-amber-50/60', a: 'bg-violet-50/60', r: 'bg-pink-50/60' };
const SECTIONS = [['Entry', 8, SEC.e], ['Dispatch', 7, SEC.d], ['Truck Sheet (RMRD)', 6, SEC.t], ['Variation', 3, SEC.v],
  ['Plant Acknowledgement (Logistics)', 6, SEC.a], ['Ack vs RMRD (Truck Sheet)', 5, SEC.r], ['', 2, SEC.x]];
const HEADS = [['Submitted', 'e'], ['Route', 'e'], ['Lifting', 'e'], ['Tanker', 'e'], ['BMCU', 'e'], ['Comp', 'e'], ['Scale', 'e'], ['Shift', 'e'],
  ['D Lts', 'd'], ['D Fat%', 'd'], ['CLR', 'd'], ['D SNF', 'd'], ['D Kgs', 'd'], ['D KgFat', 'd'], ['D KgSNF', 'd'],
  ['TS Lts', 't'], ['TS Fat%', 't'], ['TS SNF', 't'], ['TS Kgs', 't'], ['TS KgFat', 't'], ['TS KgSNF', 't'],
  ['Var Lts', 'v'], ['Var Fat', 'v'], ['Var SNF', 'v'],
  ['Ack Lts', 'a'], ['Ack Kgs', 'a'], ['Ack Fat%', 'a'], ['Ack SNF%', 'a'], ['Ack KgFat', 'a'], ['Ack KgSNF', 'a'],
  ['Ack−RMRD Lts', 'r'], ['Ack−RMRD Kgs', 'r'], ['Ack−RMRD Fat', 'r'], ['Ack−RMRD SNF', 'r'], ['Ack−Disp Lts', 'r'],
  ['By', 'x'], ['', 'x']];
const NUM = new Set(HEADS.map(h => h[0]).filter(h => !['Submitted', 'Route', 'Lifting', 'Tanker', 'BMCU', 'Comp', 'Shift', 'By', ''].includes(h)));

export default function QaDispatchList() {
  const qc = useQueryClient(); const navigate = useNavigate(); const { user } = useAuth();
  const [flt, setFlt] = useState({ from: iso(new Date(Date.now() - 6 * 86400000)), to: iso(new Date()), tanker_id: '', bmcu_id: '', route_id: '' });
  const set = (k, v) => setFlt(p => ({ ...p, [k]: v }));
  const { data: lk } = useQuery({ queryKey: ['qa-lookups'], queryFn: () => getQaLookups().then(r => r.data), staleTime: 10 * 60_000 });
  // Grouped by route → tanker × lifting date, with the plant acknowledgement (owner, 2026-10-10).
  const { data: rep, isLoading, error } = useQuery({ queryKey: ['qa-entries', flt], queryFn: () => getQaReport(flt).then(r => r.data) });
  const routes = rep?.routes || [];
  const delMut = useMutation({ mutationFn: id => deleteQaEntry(id), onSuccess: () => { toast.success('Entry deleted'); qc.invalidateQueries(['qa-entries']); },
    onError: e => toast.error(e.response?.data?.error || e.message) });
  const excel = () => downloadQaEntriesExcel(flt).then(r => {
    const url = URL.createObjectURL(r.data); const a = document.createElement('a'); a.href = url; a.download = `qa_tanker_dispatch_${flt.from}_${flt.to}.xlsx`; a.click(); URL.revokeObjectURL(url);
  }).catch(e => toast.error(e.response?.data?.error || e.message));
  const col = (x, d = 2, sec) => <td className={`px-2 py-1 text-right whitespace-nowrap ${sec ? SEC_BODY[sec] : ''}`}>{fx(x, d)}</td>;
  const vcol = (x, sec) => <td className={`px-2 py-1 text-right whitespace-nowrap font-semibold ${sec ? SEC_BODY[sec] : ''} ${x == null ? '' : x < 0 ? 'text-red-600' : x > 0 ? 'text-green-700' : ''}`}>{x == null ? '—' : (x > 0 ? '+' : '') + fx(x)}</td>;
  // Subtotal row: QA dispatch / truck-sheet totals and, beside them, the plant acknowledgement.
  const totRow = (label, t, cls) => (
    <tr key={label} className={`border-t border-gray-300 font-semibold ${cls}`}>
      <td className="px-2 py-1.5 whitespace-nowrap" colSpan={8}>{label}</td>
      {col(t.d_qty_litres, 0)}{col(t.d_fat_pct)}<td/>{col(t.d_snf_pct)}{col(t.d_qty_kgs)}{col(t.d_kg_fat)}{col(t.d_kg_snf)}
      {col(t.ts_qty_litres, 0)}{col(t.ts_fat_pct)}{col(t.ts_snf_pct)}{col(t.ts_qty_kgs)}{col(t.ts_kg_fat)}{col(t.ts_kg_snf)}
      {vcol(t.qty_var_litres)}<td/><td/>
      {t.ack ? <>{col(t.ack.litres, 0)}{col(t.ack.kgs)}{col(t.ack.fat_pct)}{col(t.ack.snf_pct)}{col(t.ack.kg_fat)}{col(t.ack.kg_snf)}
                 {vcol(t.ack_vs_ts_litres)}{vcol(t.ack_vs_ts_kgs)}{vcol(t.ack_vs_ts_fat)}{vcol(t.ack_vs_ts_snf)}{vcol(t.ack_vs_d_litres)}</>
             : <td colSpan={11} className="px-2 py-1 text-center text-gray-400 font-normal">no trip acknowledged</td>}
      <td/><td/>
    </tr>);

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
            <thead className="sticky top-0 text-left text-gray-700 z-10">
              <tr className="text-[11px] font-bold">
                {SECTIONS.map(([label, span, cls]) => <th key={label || 'x'} colSpan={span} className={`px-2 py-1 text-center border-b border-white ${cls}`}>{label}</th>)}
              </tr>
              <tr>{HEADS.map(([h, sec]) => <th key={h} className={`px-2 py-2 whitespace-nowrap ${SEC[sec]} ${NUM.has(h) ? 'text-right' : ''}`}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={HEADS.length} className="px-3 py-4 text-gray-400">Loading…</td></tr>}
              {!isLoading && !routes.length && <tr><td colSpan={HEADS.length} className="px-3 py-4 text-gray-400">No entries for this filter.</td></tr>}
              {routes.map(rg => (
                <Fragment key={rg.route}>
                  {rg.tankers.map(tg => (
                    <Fragment key={tg.key}>
                      {tg.rows.map(r => (
                        <tr key={r.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                          <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.submission_date)}</td>
                          <td className="px-2 py-1">{r.route_name || '—'}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{fmtDate(r.lifting_date)}</td>
                          <td className="px-2 py-1 font-semibold text-[#005ba3] whitespace-nowrap">{r.tanker_number}</td>
                          <td className="px-2 py-1 whitespace-nowrap">{r.bmcu_code} {r.bmcu_name}</td>
                          <td className="px-2 py-1">{r.compartment}</td>
                          {col(r.scale_reading)}<td className="px-2 py-1">{r.shifts || '—'}</td>
                          {col(r.d_qty_litres, 0, 'd')}{col(r.d_fat_pct, 2, 'd')}{col(r.d_clr, 2, 'd')}{col(r.d_snf_pct, 2, 'd')}{col(r.d_qty_kgs, 2, 'd')}{col(r.d_kg_fat, 2, 'd')}{col(r.d_kg_snf, 2, 'd')}
                          {col(r.ts_qty_litres, 0, 't')}{col(r.ts_fat_pct, 2, 't')}{col(r.ts_snf_pct, 2, 't')}{col(r.ts_qty_kgs, 2, 't')}{col(r.ts_kg_fat, 2, 't')}{col(r.ts_kg_snf, 2, 't')}
                          {vcol(r.qty_var_litres, 'v')}{vcol(r.fat_var, 'v')}{vcol(r.snf_var, 'v')}
                          {Array.from({ length: 11 }).map((_, k) => <td key={k} className={k < 6 ? SEC_BODY.a : SEC_BODY.r}/>)}
                          <td className="px-2 py-1 whitespace-nowrap">{r.entered_by_name}</td>
                          <td className="px-2 py-1 whitespace-nowrap">
                            <button className="text-[#005ba3] underline mr-2" onClick={() => navigate(`/quality/entry?id=${r.id}`)}>edit</button>
                            {user?.role === 'admin' && <button className="text-gray-400 hover:text-red-600" onClick={() => window.confirm('Delete this QA entry?') && delMut.mutate(r.id)}><Trash2 size={12}/></button>}
                          </td>
                        </tr>))}
                      {totRow(`Tanker total · ${tg.tanker_number} · ${fmtDate(tg.lifting_date)}`, tg.totals, 'bg-violet-50')}
                    </Fragment>
                  ))}
                  {totRow(`Route total · ${rg.route}`, rg.totals, 'bg-blue-100')}
                </Fragment>
              ))}
              {routes.length > 0 && totRow('GRAND TOTAL', rep.totals, 'bg-yellow-100')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
