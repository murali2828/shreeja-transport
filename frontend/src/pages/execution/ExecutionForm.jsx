import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getExecution, updateExecution, submitForAck, getBmcus } from '../../api';
import toast from 'react-hot-toast';
import { ArrowLeft, Plus, Trash2, Save, Send, Info } from 'lucide-react';

const KG_FACTOR = 1.0285;
const calc = (v) => v ? parseFloat((parseFloat(v) * KG_FACTOR).toFixed(4)) : 0;
const calcFat = (fat, kgs) => fat && kgs ? parseFloat((parseFloat(fat) * parseFloat(kgs) / 100).toFixed(4)) : 0;
const calcSnf = (snf, kgs) => snf && kgs ? parseFloat((parseFloat(snf) * parseFloat(kgs) / 100).toFixed(4)) : 0;

const DESCRIPTIONS = ['RMRD', 'Balance Milk', 'Internal Shifting'];
const CHAMBERS = ['FC', 'MC', 'BC'];

function BmcuRow({ row, idx, bmcuList, compartments, onChange, onDelete, onAddBelow }) {
  const kgs = calc(row.qty_litres);
  const kgFat = calcFat(row.fat_pct, kgs);
  const kgSnf = calcSnf(row.snf_pct, kgs);
  const dpsKgs = calc(row.dps_qty_litres);

  return (
    <tr className={`hover:bg-gray-50 ${row.is_deleted ? 'opacity-40 line-through' : ''}`}>
      <td className="table-td text-center text-gray-400 text-xs">{idx + 1}</td>
      <td className="table-td w-40">
        <select className="input text-xs py-1" value={row.bmcu_id} onChange={e => onChange('bmcu_id', e.target.value)}
          disabled={row.is_deleted}>
          <option value="">— Select BMCU —</option>
          {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} - {b.bmcu_name}</option>)}
        </select>
      </td>
      <td className="table-td w-28">
        <input className="input text-xs py-1" type="date" value={row.milk_date || ''} onChange={e => onChange('milk_date', e.target.value)} disabled={row.is_deleted} />
      </td>
      <td className="table-td w-16">
        <select className="input text-xs py-1" value={row.shift || ''} onChange={e => onChange('shift', e.target.value)} disabled={row.is_deleted}>
          <option value="">—</option>
          <option value="AM">AM</option>
          <option value="PM">PM</option>
        </select>
      </td>
      <td className="table-td w-24">
        <input className="input text-xs py-1" type="number" value={row.qty_litres || ''} onChange={e => onChange('qty_litres', e.target.value)} disabled={row.is_deleted} />
      </td>
      <td className="table-td text-xs text-gray-600 font-mono">{kgs || '—'}</td>
      <td className="table-td w-18">
        <input className="input text-xs py-1 w-16" type="number" step="0.001" value={row.fat_pct || ''} onChange={e => onChange('fat_pct', e.target.value)} disabled={row.is_deleted} />
      </td>
      <td className="table-td w-18">
        <input className="input text-xs py-1 w-16" type="number" step="0.001" value={row.snf_pct || ''} onChange={e => onChange('snf_pct', e.target.value)} disabled={row.is_deleted} />
      </td>
      <td className="table-td text-xs text-gray-600 font-mono">{kgFat || '—'}</td>
      <td className="table-td text-xs text-gray-600 font-mono">{kgSnf || '—'}</td>
      <td className="table-td w-36">
        <select className="input text-xs py-1" value={row.description || ''} onChange={e => onChange('description', e.target.value)} disabled={row.is_deleted}>
          <option value="">—</option>
          {DESCRIPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </td>
      {row.description === 'Internal Shifting' ? (
        <td className="table-td w-40">
          <select className="input text-xs py-1" value={row.source_bmcu_id || ''} onChange={e => onChange('source_bmcu_id', e.target.value)}>
            <option value="">— Source BMCU —</option>
            {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} - {b.bmcu_name}</option>)}
          </select>
        </td>
      ) : <td className="table-td"></td>}
      <td className="table-td w-16">
        <select className="input text-xs py-1" value={row.chamber || ''} onChange={e => onChange('chamber', e.target.value)} disabled={row.is_deleted}>
          <option value="">—</option>
          {compartments === 3 ? CHAMBERS.map(c => <option key={c} value={c}>{c}</option>) : ['FC','BC'].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </td>
      <td className="table-td w-20">
        <input className="input text-xs py-1" type="number" value={row.dps_qty_litres || ''} onChange={e => onChange('dps_qty_litres', e.target.value)} disabled={row.is_deleted} />
      </td>
      <td className="table-td text-xs font-mono">{dpsKgs || '—'}</td>
      <td className="table-td w-20">
        <input className="input text-xs py-1" type="number" value={row.rmrd_qty || ''} onChange={e => onChange('rmrd_qty', e.target.value)} disabled={row.is_deleted} />
      </td>
      <td className="table-td">
        <div className="flex gap-1">
          {!row.is_deleted ? (
            <button onClick={onDelete} className="btn-danger btn-sm" title="Remove row"><Trash2 size={11} /></button>
          ) : (
            <button onClick={() => onChange('is_deleted', false)} className="btn-secondary btn-sm text-xs">Restore</button>
          )}
          <button onClick={onAddBelow} className="btn-secondary btn-sm" title="Add row below"><Plus size={11} /></button>
        </div>
      </td>
    </tr>
  );
}

export default function ExecutionForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ dc_number: '', actual_km: '' });
  const [execData, setExecData] = useState(null);

  const { data: bmcuList = [] } = useQuery({ queryKey: ['bmcus'], queryFn: () => getBmcus().then(r => r.data.filter(b => b.is_active)) });

  const { isLoading } = useQuery({
    queryKey: ['execution', id],
    queryFn: () => getExecution(id).then(r => {
      const d = r.data;
      setExecData(d);
      setMeta({ dc_number: d.dc_number || '', actual_km: d.actual_km || '' });
      setRows((d.bmcu_rows || []).map(r => ({ ...r, id: r.id })));
    })
  });

  const saveMut = useMutation({
    mutationFn: () => updateExecution(id, { ...meta, bmcu_rows: rows }),
    onSuccess: () => toast.success('Trip data saved'),
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });

  const submitMut = useMutation({
    mutationFn: () => submitForAck(id),
    onSuccess: () => { toast.success('Submitted for acknowledgement'); navigate('/execution'); },
    onError: (e) => toast.error(e.response?.data?.error || 'Submit failed')
  });

  const updateRow = (i, k, v) => setRows(r => r.map((row, j) => {
    if (j !== i) return row;
    const updated = { ...row, [k]: v };
    // Auto-calc derived fields
    if (k === 'qty_litres') { updated.qty_kgs = calc(v); updated.kg_fat = calcFat(updated.fat_pct, updated.qty_kgs); updated.kg_snf = calcSnf(updated.snf_pct, updated.qty_kgs); }
    if (k === 'fat_pct') { updated.kg_fat = calcFat(v, row.qty_kgs || calc(row.qty_litres)); }
    if (k === 'snf_pct') { updated.kg_snf = calcSnf(v, row.qty_kgs || calc(row.qty_litres)); }
    if (k === 'dps_qty_litres') { updated.dps_qty_kgs = calc(v); }
    return updated;
  }));

  const deleteRow = (i) => setRows(r => r.map((row, j) => j === i ? { ...row, is_deleted: true } : row));

  const addRowBelow = (i) => setRows(r => {
    const newRow = { seq_no: i + 2, bmcu_id: '', milk_date: '', shift: '', qty_litres: '', fat_pct: '', snf_pct: '', description: 'RMRD', chamber: '', dps_qty_litres: '', rmrd_qty: '', is_deleted: false };
    const arr = [...r.slice(0, i + 1), newRow, ...r.slice(i + 1)].map((row, j) => ({ ...row, seq_no: j + 1 }));
    return arr;
  });

  // Totals
  const activeRows = rows.filter(r => !r.is_deleted && r.description !== 'Balance Milk');
  const totals = activeRows.reduce((s, r) => ({
    qty_litres: s.qty_litres + parseFloat(r.qty_litres || 0),
    qty_kgs: s.qty_kgs + parseFloat(r.qty_kgs || calc(r.qty_litres) || 0),
    kg_fat: s.kg_fat + parseFloat(r.kg_fat || calcFat(r.fat_pct, r.qty_kgs || calc(r.qty_litres)) || 0),
    kg_snf: s.kg_snf + parseFloat(r.kg_snf || calcSnf(r.snf_pct, r.qty_kgs || calc(r.qty_litres)) || 0),
    dps: s.dps + parseFloat(r.dps_qty_litres || 0),
  }), { qty_litres: 0, qty_kgs: 0, kg_fat: 0, kg_snf: 0, dps: 0 });

  const avgFat = totals.qty_kgs > 0 ? (totals.kg_fat / totals.qty_kgs * 100) : 0;
  const avgSnf = totals.qty_kgs > 0 ? (totals.kg_snf / totals.qty_kgs * 100) : 0;

  if (isLoading) return <div className="p-8 text-center text-gray-400">Loading…</div>;
  if (!execData) return null;

  const isClosed = execData.status === 'closed';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/execution')} className="btn-secondary"><ArrowLeft size={14} /></button>
        <div>
          <h2 className="text-lg font-semibold">Trip Execution — {execData.route_name}</h2>
          <p className="text-xs text-gray-500">
            {execData.tanker_number} · {execData.compartments} chambers · {execData.capacity_litres?.toLocaleString()} L capacity · Trip #{execData.trip_no}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {!isClosed && (
            <>
              <button onClick={() => saveMut.mutate()} className="btn-secondary" disabled={saveMut.isPending}><Save size={14} /> Save</button>
              <button onClick={() => { if (confirm('Submit for acknowledgement? Make sure all data is entered.')) submitMut.mutate(); }}
                className="btn-success" disabled={submitMut.isPending}><Send size={14} /> Submit for Acknowledgement</button>
            </>
          )}
        </div>
      </div>

      {execData.remarks && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-2 text-sm text-amber-800">
          <Info size={14} className="shrink-0 mt-0.5" />
          <span><strong>Planner Remarks:</strong> {execData.remarks}</span>
        </div>
      )}

      {/* Trip Header */}
      <div className="card p-4">
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="label">Tanker Number</label>
            <div className="input bg-gray-50 font-mono">{execData.tanker_number}</div>
          </div>
          <div>
            <label className="label">Route Name</label>
            <div className="input bg-gray-50">{execData.route_name}</div>
          </div>
          <div>
            <label className="label">DC Number</label>
            <input className="input" value={meta.dc_number} onChange={e => setMeta(m => ({ ...m, dc_number: e.target.value }))} disabled={isClosed} />
          </div>
          <div>
            <label className="label">Actual KMs Travelled</label>
            <input className="input" type="number" value={meta.actual_km} onChange={e => setMeta(m => ({ ...m, actual_km: e.target.value }))} disabled={isClosed} placeholder={execData.expected_km} />
          </div>
        </div>
      </div>

      {/* BMCU Entry Table */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2 bg-gray-50 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm">Milk Lifting Details</h3>
          <div className="text-xs text-gray-500">Chambers: {execData.compartments === 3 ? 'FC, MC, BC' : 'FC, BC'}</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="table-th">#</th>
                <th className="table-th">BMCU</th>
                <th className="table-th">Date</th>
                <th className="table-th">Shift</th>
                <th className="table-th">Qty Ltrs</th>
                <th className="table-th">Qty Kgs</th>
                <th className="table-th">Fat%</th>
                <th className="table-th">SNF%</th>
                <th className="table-th">Kg Fat</th>
                <th className="table-th">Kg SNF</th>
                <th className="table-th">Description</th>
                <th className="table-th">Source BMCU</th>
                <th className="table-th">Chamber</th>
                <th className="table-th">DPS Ltrs</th>
                <th className="table-th">DPS Kgs</th>
                <th className="table-th">RMRD Qty</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <BmcuRow key={i} row={row} idx={i} bmcuList={bmcuList} compartments={execData.compartments}
                  onChange={(k, v) => updateRow(i, k, v)}
                  onDelete={() => deleteRow(i)}
                  onAddBelow={() => addRowBelow(i)} />
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={17} className="table-td text-center py-6 text-gray-400">No BMCU rows</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-brand-50 font-semibold">
                <td colSpan={4} className="table-td text-right text-xs text-gray-600">TOTALS:</td>
                <td className="table-td text-brand-700">{totals.qty_litres.toFixed(2)}</td>
                <td className="table-td text-brand-700">{totals.qty_kgs.toFixed(4)}</td>
                <td className="table-td">{avgFat.toFixed(4)}</td>
                <td className="table-td">{avgSnf.toFixed(4)}</td>
                <td className="table-td">{totals.kg_fat.toFixed(4)}</td>
                <td className="table-td">{totals.kg_snf.toFixed(4)}</td>
                <td colSpan={3}></td>
                <td className="table-td">{totals.dps.toFixed(2)}</td>
                <td colSpan={3}></td>
              </tr>
            </tfoot>
          </table>
        </div>
        {!isClosed && (
          <div className="p-2 border-t">
            <button onClick={() => addRowBelow(rows.length - 1)} className="btn-secondary btn-sm">
              <Plus size={12} /> Add BMCU Row
            </button>
          </div>
        )}
      </div>

      {/* Totals Summary */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'Total Qty (L)', value: totals.qty_litres.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
          { label: 'Total Qty (Kg)', value: totals.qty_kgs.toLocaleString(undefined, { maximumFractionDigits: 2 }) },
          { label: 'Avg Fat %', value: avgFat.toFixed(4) },
          { label: 'Avg SNF %', value: avgSnf.toFixed(4) },
          { label: 'Utilization %', value: execData.capacity_litres > 0 ? `${(totals.qty_litres / execData.capacity_litres * 100).toFixed(2)}%` : '—' },
        ].map(s => (
          <div key={s.label} className="card p-3 text-center">
            <div className="text-lg font-bold text-brand-700">{s.value}</div>
            <div className="text-xs text-gray-500">{s.label}</div>
          </div>
        ))}
      </div>

      {isClosed && execData.acknowledgements?.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2 bg-green-50 border-b font-semibold text-sm text-green-800">Acknowledgements (Closed)</div>
          <table className="w-full text-sm">
            <thead><tr>
              <th className="table-th">Chamber</th><th className="table-th">Ack Date</th><th className="table-th">Qty Ltrs</th><th className="table-th">Qty Kgs</th><th className="table-th">Fat%</th><th className="table-th">SNF%</th><th className="table-th">Kg Fat</th><th className="table-th">Kg SNF</th><th className="table-th">Temp</th>
            </tr></thead>
            <tbody>
              {execData.acknowledgements.map((a, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="table-td font-bold text-brand-600">{a.chamber}</td>
                  <td className="table-td">{a.ack_date?.slice(0,10)}</td>
                  <td className="table-td">{parseFloat(a.qty_litres || 0).toLocaleString()}</td>
                  <td className="table-td">{parseFloat(a.qty_kgs || 0).toFixed(4)}</td>
                  <td className="table-td">{parseFloat(a.fat_pct || 0).toFixed(3)}</td>
                  <td className="table-td">{parseFloat(a.snf_pct || 0).toFixed(3)}</td>
                  <td className="table-td">{parseFloat(a.kg_fat || 0).toFixed(4)}</td>
                  <td className="table-td">{parseFloat(a.kg_snf || 0).toFixed(4)}</td>
                  <td className="table-td">{a.temperature || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
