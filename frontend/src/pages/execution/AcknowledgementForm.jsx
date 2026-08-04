// frontend/src/pages/execution/AcknowledgementForm.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import { getExecution, saveAcknowledgements } from '../../api/index';

const KG = 1.0285;
const CHAMBERS = ['FC', 'MC', 'BC'];

export default function AcknowledgementForm() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const qc       = useQueryClient();

  const { data: exec } = useQuery({
    queryKey: ['execution', id],
    queryFn:  () => getExecution(id).then(r => r.data)
  });

  const [ackDate, setAckDate] = useState(new Date().toISOString().slice(0,10));
  const [chambers, setChambers] = useState(
    CHAMBERS.map(c => ({ chamber: c, qty_litres: '', qty_kgs: '', fat_pct: '', snf_pct: '',
                          kg_fat: '', kg_snf: '', temperature: '', description: '' }))
  );

  useEffect(() => {
    if (exec?.acknowledgements?.length) {
      setChambers(CHAMBERS.map(c => {
        const existing = exec.acknowledgements.find(a => a.chamber === c);
        return existing || { chamber: c, qty_litres:'', qty_kgs:'', fat_pct:'', snf_pct:'',
                             kg_fat:'', kg_snf:'', temperature:'', description:'' };
      }));
      if (exec.acknowledgements[0]?.ack_date)
        setAckDate(exec.acknowledgements[0].ack_date.slice(0,10));
    }
  }, [exec]);

  // Immediate blocking pop-up when chamber quantities exceed 103% of capacity
  const capAlertRef = useRef(false);
  useEffect(() => {
    const capacity = parseFloat(exec?.capacity_litres) || 0;
    if (capacity <= 0) return;
    const totalL = chambers.reduce((s, c) => s + (parseFloat(c.qty_litres) || 0), 0);
    const over = totalL > capacity * 1.03;
    if (over && !capAlertRef.current) {
      capAlertRef.current = true;
      const fmtL = v => Math.round(v).toLocaleString('en-IN');
      window.alert(`⚠ ABNORMAL ENTRY BLOCKED\n\nAcknowledgement total ${fmtL(totalL)} L exceeds 103% of tanker capacity ${fmtL(capacity)} L (limit ${fmtL(capacity * 1.03)} L).\n\nCorrect the quantity — saving is blocked until it is within the limit.`);
    } else if (!over) capAlertRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chambers]);

  const updateChamber = (idx, field, val) => {
    setChambers(prev => prev.map((c, i) => {
      if (i !== idx) return c;
      const updated = { ...c, [field]: val };
      if (field === 'qty_kgs') {
        // Qty Litres = Qty Kgs ÷ 1.0285 (auto-calculated, read-only)
        updated.qty_litres = val ? +(parseFloat(val) / KG).toFixed(2) : '';
        if (c.fat_pct) updated.kg_fat = +(parseFloat(val) * parseFloat(c.fat_pct) / 100).toFixed(4);
        if (c.snf_pct) updated.kg_snf = +(parseFloat(val) * parseFloat(c.snf_pct) / 100).toFixed(4);
      }
      if (field === 'fat_pct' && updated.qty_kgs)
        updated.kg_fat = +(parseFloat(updated.qty_kgs) * parseFloat(val) / 100).toFixed(4);
      if (field === 'snf_pct' && updated.qty_kgs)
        updated.kg_snf = +(parseFloat(updated.qty_kgs) * parseFloat(val) / 100).toFixed(4);
      return updated;
    }));
  };

  const saveMut = useMutation({
    mutationFn: () => {
      // 103% capacity guard (also enforced server-side)
      const capacity = parseFloat(exec?.capacity_litres) || 0;
      const totalL = chambers.reduce((s, c) => s + (parseFloat(c.qty_litres) || 0), 0);
      if (capacity > 0 && totalL > capacity * 1.03) {
        const fmtL = v => Math.round(v).toLocaleString('en-IN');
        return Promise.reject(new Error(
          `Acknowledgement total ${fmtL(totalL)} L exceeds 103% of tanker capacity ${fmtL(capacity)} L (limit ${fmtL(capacity * 1.03)} L)`));
      }
      return saveAcknowledgements(id, { ack_date: ackDate, chambers });
    },
    onSuccess: () => {
      toast.success('Acknowledgement saved — trip closed');
      qc.invalidateQueries(['execution', id]);
      navigate('/execution/closed');
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message || 'Save failed'),
  });

  const totalAckL = chambers.reduce((s,c) => s + (parseFloat(c.qty_litres)||0), 0);
  const totalAckK = chambers.reduce((s,c) => s + (parseFloat(c.qty_kgs)||0), 0);

  return (
    <div className="w-full space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate(`/execution/${id}`)} className="btn-secondary flex items-center gap-1.5">
          <ChevronLeft size={14}/> Back
        </button>
        <div>
          <h2 className="page-title">Trip Acknowledgement</h2>
          {exec && <p className="text-xs text-gray-500">
            Trip #{exec.trip_no} · {exec.tanker_number} · {exec.delivery_point_name}
          </p>}
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <div>
          <label className="label">Acknowledgement Date</label>
          <input type="date" className="input w-48" value={ackDate}
            onChange={e => setAckDate(e.target.value)}/>
        </div>

        {exec && (
          <div className="bg-gray-50 rounded-lg p-3 text-sm flex gap-6">
            <span>TS Litres: <strong>{parseFloat(exec.total_qty_litres||0).toLocaleString()}</strong></span>
            <span>TS Kgs: <strong>{parseFloat(exec.total_qty_kgs||0).toFixed(2)}</strong></span>
            <span>Avg Fat: <strong>{parseFloat(exec.avg_fat||0).toFixed(3)}%</strong></span>
            <span>Avg SNF: <strong>{parseFloat(exec.avg_snf||0).toFixed(3)}%</strong></span>
          </div>
        )}

        <div className="space-y-4">
          {chambers.map((ch, i) => (
            <div key={ch.chamber} className="border rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 bg-[#0078d4] text-white rounded-lg flex items-center justify-center text-sm font-bold">
                  {ch.chamber}
                </div>
                <span className="font-semibold">{ch.chamber === 'FC' ? 'Front' : ch.chamber === 'MC' ? 'Middle' : 'Back'} Chamber</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label:'Qty Kgs',     field:'qty_kgs',     type:'number' },
                  { label:'Qty Litres (auto)',  field:'qty_litres',  type:'number', readOnly:true },
                  { label:'Fat %',       field:'fat_pct',     type:'number' },
                  { label:'SNF %',       field:'snf_pct',     type:'number' },
                  { label:'Kg Fat',      field:'kg_fat',      type:'number', readOnly:true },
                  { label:'Kg SNF',      field:'kg_snf',      type:'number', readOnly:true },
                  { label:'Temperature', field:'temperature', type:'text' },
                  { label:'Description', field:'description', type:'text' },
                ].map(f => (
                  <div key={f.field}>
                    <label className="label text-xs">{f.label}</label>
                    <input
                      type={f.type} step={f.type==='number'?'0.001':undefined}
                      className={`input w-full py-1.5 text-sm ${f.readOnly?'bg-gray-50 text-gray-500':''}`}
                      readOnly={!!f.readOnly}
                      value={ch[f.field] || ''}
                      onChange={e => updateChamber(i, f.field, e.target.value)}/>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-[#e6f3fb] border border-[#bddff5] rounded-lg p-3 text-sm flex gap-6">
          <span>Ack Total Litres: <strong className="text-[#003a6b]">{totalAckL.toLocaleString()}</strong></span>
          <span>Ack Total Kgs: <strong className="text-[#003a6b]">{totalAckK.toFixed(2)}</strong></span>
          {exec && (
            <>
              <span className={parseFloat(totalAckL - exec.total_qty_litres) >= 0 ? 'text-green-600' : 'text-red-600'}>
                Var L: <strong>{(totalAckL - parseFloat(exec.total_qty_litres||0)).toFixed(2)}</strong>
              </span>
              <span className={parseFloat(totalAckK - exec.total_qty_kgs) >= 0 ? 'text-green-600' : 'text-red-600'}>
                Var Kg: <strong>{(totalAckK - parseFloat(exec.total_qty_kgs||0)).toFixed(4)}</strong>
              </span>
            </>
          )}
        </div>

        <div className="flex justify-end">
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
            className="btn-primary flex items-center gap-2">
            {saveMut.isPending ? 'Saving…' : <><Check size={14}/> Save & Close Trip</>}
          </button>
        </div>
      </div>
    </div>
  );
}
