// frontend/src/pages/execution/ExecutionForm.jsx
import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ChevronLeft, Send, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getExecution, updateExecution, submitForAck, getBmcus, getDeliveryPoints } from '../../api/index';

const KG = 1.0285;
const calc = {
  kgs:   (l)    => l ? +(parseFloat(l) * KG).toFixed(4) : '',
  kgFat: (k, f) => k && f ? +(parseFloat(k) * parseFloat(f) / 100).toFixed(4) : '',
  kgSnf: (k, s) => k && s ? +(parseFloat(k) * parseFloat(s) / 100).toFixed(4) : '',
};

const DESCRIPTIONS = ['RMRD', 'Balance Milk', 'Internal Shifting'];
const CHAMBERS     = ['FC', 'MC', 'BC'];
const SHIFTS       = ['AM', 'PM'];

function BmcuRow({ row, idx, bmcuList, onUpdate, onDelete, onInsertAfter }) {
  const u = (field, val) => onUpdate(idx, field, val);
  const kgs    = calc.kgs(row.qty_litres);
  const kgFat  = calc.kgFat(kgs, row.fat_pct);
  const kgSnf  = calc.kgSnf(kgs, row.snf_pct);
  const dpsKgs = calc.kgs(row.dps_qty_litres);

  const syncCalc = (field, val) => {
    onUpdate(idx, field, val);
    if (field === 'qty_litres') {
      const k = calc.kgs(val);
      onUpdate(idx, 'qty_kgs', k);
      if (row.fat_pct) onUpdate(idx, 'kg_fat', calc.kgFat(k, row.fat_pct));
      if (row.snf_pct) onUpdate(idx, 'kg_snf', calc.kgSnf(k, row.snf_pct));
    }
    if (field === 'fat_pct') onUpdate(idx, 'kg_fat', calc.kgFat(kgs, val));
    if (field === 'snf_pct') onUpdate(idx, 'kg_snf', calc.kgSnf(kgs, val));
    if (field === 'dps_qty_litres') onUpdate(idx, 'dps_qty_kgs', calc.kgs(val));
  };

  return (
    <tr className="hover:bg-gray-50 border-b border-gray-50 text-xs">
      <td className="table-td font-bold text-[#0078d4] text-center">{row.seq_no}</td>
      <td className="table-td font-mono whitespace-nowrap">{row.bmcu_code}</td>
      <td className="table-td text-xs max-w-24 truncate">{row.bmcu_name}</td>
      <td className="table-td">
        <input type="date" className="input py-0.5 px-1 text-xs w-28"
          value={row.milk_date || ''} onChange={e => u('milk_date', e.target.value)}/>
      </td>
      <td className="table-td">
        <select className="input py-0.5 px-1 text-xs w-14"
          value={row.shift || ''} onChange={e => u('shift', e.target.value)}>
          <option value="">—</option>
          {SHIFTS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </td>
      <td className="table-td">
        <input type="number" min="0" step="0.01" className="input py-0.5 px-1 text-xs w-20"
          value={row.qty_litres || ''} onChange={e => syncCalc('qty_litres', e.target.value)}/>
      </td>
      <td className="table-td text-gray-500">{row.qty_kgs || kgs || '—'}</td>
      <td className="table-td">
        <input type="number" min="0" step="0.001" className="input py-0.5 px-1 text-xs w-16"
          value={row.fat_pct || ''} onChange={e => syncCalc('fat_pct', e.target.value)}/>
      </td>
      <td className="table-td">
        <input type="number" min="0" step="0.001" className="input py-0.5 px-1 text-xs w-16"
          value={row.snf_pct || ''} onChange={e => syncCalc('snf_pct', e.target.value)}/>
      </td>
      <td className="table-td text-gray-500">{row.kg_fat || kgFat || '—'}</td>
      <td className="table-td text-gray-500">{row.kg_snf || kgSnf || '—'}</td>
      <td className="table-td">
        <select className="input py-0.5 px-1 text-xs w-28"
          value={row.description || 'RMRD'} onChange={e => u('description', e.target.value)}>
          {DESCRIPTIONS.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </td>
      {row.description === 'Internal Shifting' && (
        <td className="table-td">
          <select className="input py-0.5 px-1 text-xs w-32"
            value={row.source_bmcu_id || ''} onChange={e => u('source_bmcu_id', e.target.value)}>
            <option value="">Source BMCU</option>
            {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code}</option>)}
          </select>
        </td>
      )}
      <td className="table-td">
        <select className="input py-0.5 px-1 text-xs w-16"
          value={row.chamber || ''} onChange={e => u('chamber', e.target.value)}>
          <option value="">—</option>
          {CHAMBERS.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </td>
      <td className="table-td">
        <input type="number" min="0" step="0.01" className="input py-0.5 px-1 text-xs w-20"
          value={row.dps_qty_litres || ''} onChange={e => syncCalc('dps_qty_litres', e.target.value)}
          placeholder="DPS L"/>
      </td>
      <td className="table-td">
        <input type="number" min="0" step="0.001" className="input py-0.5 px-1 text-xs w-16"
          value={row.dps_fat_pct || ''} onChange={e => u('dps_fat_pct', e.target.value)}
          placeholder="Fat%"/>
      </td>
      <td className="table-td">
        <input type="number" min="0" step="0.001" className="input py-0.5 px-1 text-xs w-16"
          value={row.dps_snf_pct || ''} onChange={e => u('dps_snf_pct', e.target.value)}
          placeholder="SNF%"/>
      </td>
      <td className="table-td">
        <input type="number" min="0" step="0.01" className="input py-0.5 px-1 text-xs w-20"
          value={row.rmrd_qty || ''} onChange={e => u('rmrd_qty', e.target.value)}
          placeholder="RMRD"/>
      </td>
      <td className="table-td">
        <div className="flex gap-1">
          <button onClick={() => onInsertAfter(idx)} className="btn-secondary btn-sm p-1" title="Add row below">
            <Plus size={10}/>
          </button>
          <button onClick={() => onDelete(idx)} className="btn-danger btn-sm p-1">
            <Trash2 size={10}/>
          </button>
        </div>
      </td>
    </tr>
  );
}

export default function ExecutionForm() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const qc       = useQueryClient();

  const [dcNumber,         setDcNumber]         = useState('');
  const [actualKm,         setActualKm]         = useState('');
  const [deliveryPointId,  setDeliveryPointId]  = useState('');
  const [bmcuRows,         setBmcuRows]         = useState([]);

  const { data: exec, isLoading } = useQuery({
    queryKey: ['execution', id],
    queryFn:  () => getExecution(id).then(r => r.data)
  });
  const { data: bmcuList = [] } = useQuery({
    queryKey: ['bmcus'], queryFn: () => getBmcus().then(r => r.data)
  });
  const { data: deliveryPoints = [] } = useQuery({
    queryKey: ['delivery-points'], queryFn: () => getDeliveryPoints().then(r => r.data)
  });

  useEffect(() => {
    if (exec) {
      setDcNumber(exec.dc_number || '');
      setActualKm(exec.actual_km || '');
      setDeliveryPointId(exec.delivery_point_id || '');
      setBmcuRows((exec.bmcus || []).map(b => ({
        ...b,
        milk_date: b.milk_date ? b.milk_date.slice(0, 10) : ''
      })));
    }
  }, [exec]);

  const updateRow = (idx, field, val) =>
    setBmcuRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: val } : r));

  const deleteRow = (idx) =>
    setBmcuRows(prev => prev.map((r, i) => i === idx ? { ...r, is_deleted: true } : r));

  const makeEmptyRow = (bm, seqNo) => ({
    bmcu_id: bm.id, bmcu_code: bm.bmcu_code, bmcu_name: bm.bmcu_name,
    seq_no: seqNo,
    milk_date: exec?.execution_date?.slice(0,10) || '',
    shift: '', qty_litres: '', qty_kgs: '', fat_pct: '', snf_pct: '',
    kg_fat: '', kg_snf: '', description: 'RMRD', chamber: '',
    dps_qty_litres: '', dps_fat_pct: '', dps_snf_pct: '', rmrd_qty: '', is_deleted: false
  });

  const addRow = (bmcuId) => {
    const bm = bmcuList.find(b => b.id === parseInt(bmcuId));
    if (!bm) return;
    setBmcuRows(prev => {
      const next = [...prev, makeEmptyRow(bm, prev.filter(r => !r.is_deleted).length + 1)];
      return next;
    });
  };

  const insertRowAfter = (idx) => {
    const srcRow = bmcuRows[idx];
    const bm = bmcuList.find(b => b.id === srcRow.bmcu_id);
    if (!bm) return;
    setBmcuRows(prev => {
      const next = [...prev];
      next.splice(idx + 1, 0, makeEmptyRow(bm, 0));
      return next.map((r, i) => ({ ...r, seq_no: i + 1 }));
    });
  };

  const saveMut = useMutation({
    mutationFn: () => updateExecution(id, { dc_number: dcNumber, actual_km: actualKm, delivery_point_id: deliveryPointId || null, bmcus: bmcuRows }),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries(['execution', id]); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed'),
  });

  const submitMut = useMutation({
    mutationFn: () => submitForAck(id),
    onSuccess: () => {
      toast.success('Submitted for acknowledgement');
      navigate(`/execution/${id}/acknowledge`);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Submit failed'),
  });

  if (isLoading) return <div className="text-gray-400 p-8">Loading…</div>;
  if (!exec) return <div className="text-red-500 p-8">Execution not found</div>;

  const visibleRows = bmcuRows.filter(r => !r.is_deleted);
  const totalLitres = visibleRows.filter(r => r.description !== 'Balance Milk').reduce((s,r) => s + (parseFloat(r.qty_litres)||0), 0);
  const totalKgs    = visibleRows.filter(r => r.description !== 'Balance Milk').reduce((s,r) => s + (parseFloat(r.qty_kgs) || parseFloat(r.qty_litres||0)*1.0285), 0);
  const isClosed    = exec.status === 'closed';
  const canSubmit   = exec.status === 'saved';

  return (
    <div className="space-y-4 max-w-screen-xl">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => navigate('/execution')} className="btn-secondary flex items-center gap-1.5">
          <ChevronLeft size={14}/> Back
        </button>
        <div>
          <h2 className="page-title">
            Trip #{exec.trip_no} — {exec.tanker_number}
          </h2>
          <p className="text-xs text-gray-500">
            {exec.execution_date?.slice(0,10)} · {exec.delivery_point_name} · {exec.shifts_milk}
          </p>
        </div>
        <span className={`ml-auto text-xs px-2.5 py-1 rounded-full font-medium
          ${ exec.status==='in_progress' ? 'bg-blue-100 text-blue-700' :
             exec.status==='saved'       ? 'bg-amber-100 text-amber-700' :
             exec.status==='pending_ack' ? 'bg-purple-100 text-purple-700' :
             'bg-green-100 text-green-700'}`}>
          {exec.status.replace('_',' ')}
        </span>
      </div>

      {/* Trip summary */}
      <div className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
        <div>
          <label className="label text-xs">DC Number</label>
          <input className="input w-full py-1.5" value={dcNumber}
            disabled={isClosed} onChange={e => setDcNumber(e.target.value)}/>
        </div>
        <div>
          <label className="label text-xs">Actual KM</label>
          <input type="number" className="input w-full py-1.5" value={actualKm}
            disabled={isClosed} onChange={e => setActualKm(e.target.value)}/>
        </div>
        <div>
          <label className="label text-xs">Delivery Point</label>
          <select className="input w-full py-1.5" value={deliveryPointId}
            disabled={isClosed} onChange={e => setDeliveryPointId(e.target.value)}>
            <option value="">— Select —</option>
            {deliveryPoints.map(dp => <option key={dp.id} value={dp.id}>{dp.name}</option>)}
          </select>
        </div>
        <div className="text-xs">
          <div className="text-gray-500">Total Litres (TS)</div>
          <div className="font-bold text-lg">{totalLitres.toLocaleString()}</div>
        </div>
        <div className="text-xs">
          <div className="text-gray-500">Total Kgs (TS)</div>
          <div className="font-bold text-lg">{totalKgs.toFixed(2)}</div>
        </div>
        <div className="text-xs">
          <div className="text-gray-500">Expected</div>
          <div className="font-bold text-lg">{parseFloat(exec.expected_total_qty||0).toLocaleString()} L</div>
        </div>
      </div>

      {/* BMCU data table */}
      <div className="card">
        <div className="p-3 border-b flex items-center justify-between">
          <span className="text-sm font-medium">BMCU Data Entry ({visibleRows.length} rows)</span>
          {!isClosed && (
            <select className="input text-xs py-1 w-48" defaultValue=""
              onChange={e => { if (e.target.value) { addRow(e.target.value); e.target.value=''; } }}>
              <option value="">+ Add BMCU row</option>
              {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} — {b.bmcu_name}</option>)}
            </select>
          )}
        </div>
        <div className="overflow-x-scroll max-h-[55vh]">
          <table className="text-xs" style={{ minWidth: '1400px' }}>
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                {['#','Code','Name','Date','Shift','Qty L','Qty Kg','Fat%','SNF%','Kg Fat','Kg SNF',
                  'Description','Chamber','DPS L','DPS Fat%','DPS SNF%','RMRD',''].map(h => (
                  <th key={h} className="table-th py-1.5 text-xs whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bmcuRows.map((row, i) =>
                row.is_deleted ? null : (
                  <BmcuRow key={i} row={row} idx={i}
                    bmcuList={bmcuList}
                    onUpdate={updateRow}
                    onDelete={isClosed ? () => {} : deleteRow}
                    onInsertAfter={isClosed ? () => {} : insertRowAfter}/>
                )
              )}
              {visibleRows.length === 0 && (
                <tr><td colSpan={18} className="table-td text-center py-8 text-gray-400">No BMCU rows</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Action buttons */}
      {!isClosed && (
        <div className="flex justify-end gap-3">
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="btn-secondary">
            {saveMut.isPending ? <><RefreshCw size={14} className="animate-spin"/> Saving…</> : 'Save'}
          </button>
          {canSubmit && (
            <button onClick={() => submitMut.mutate()} disabled={submitMut.isPending} className="btn-primary flex items-center gap-2">
              {submitMut.isPending ? <RefreshCw size={14} className="animate-spin"/> : <Send size={14}/>}
              Submit for Acknowledgement
            </button>
          )}
          {exec.status === 'in_progress' && (
            <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="btn-primary">
              Save Progress
            </button>
          )}
        </div>
      )}

      {exec.status === 'pending_ack' && (
        <div className="flex justify-end">
          <button onClick={() => navigate(`/execution/${id}/acknowledge`)} className="btn-primary flex items-center gap-2">
            <Send size={14}/> Enter Acknowledgement
          </button>
        </div>
      )}
    </div>
  );
}
