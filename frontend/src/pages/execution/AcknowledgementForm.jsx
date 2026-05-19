import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { getExecution, saveAcknowledgements } from '../../api';
import toast from 'react-hot-toast';
import { ArrowLeft, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';

const KG_FACTOR = 1.0285;
const calc = (v) => v ? parseFloat((parseFloat(v) * KG_FACTOR).toFixed(4)) : 0;
const calcFat = (fat, kgs) => fat && kgs ? parseFloat((parseFloat(fat) * parseFloat(kgs) / 100).toFixed(4)) : 0;
const calcSnf = (snf, kgs) => snf && kgs ? parseFloat((parseFloat(snf) * parseFloat(kgs) / 100).toFixed(4)) : 0;

export default function AcknowledgementForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [acks, setAcks] = useState([]);
  const [ackDate, setAckDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [execData, setExecData] = useState(null);

  const { isLoading } = useQuery({
    queryKey: ['execution', id],
    queryFn: () => getExecution(id).then(r => {
      const d = r.data;
      setExecData(d);
      // Init acknowledgement rows based on compartments
      const chambers = d.compartments === 3 ? ['FC', 'MC', 'BC'] : ['FC', 'BC'];
      if (d.acknowledgements?.length) {
        setAcks(d.acknowledgements.map(a => ({ ...a, ack_date: a.ack_date?.slice(0,10) })));
      } else {
        setAcks(chambers.map(c => ({ chamber: c, qty_litres: '', fat_pct: '', snf_pct: '', temperature: '', description: 'Acknowledgement' })));
      }
    })
  });

  const updateAck = (i, k, v) => setAcks(a => a.map((row, j) => {
    if (j !== i) return row;
    const updated = { ...row, [k]: v };
    if (k === 'qty_litres') { updated.qty_kgs = calc(v); updated.kg_fat = calcFat(updated.fat_pct, updated.qty_kgs); updated.kg_snf = calcSnf(updated.snf_pct, updated.qty_kgs); }
    if (k === 'fat_pct') { updated.kg_fat = calcFat(v, row.qty_kgs || calc(row.qty_litres)); }
    if (k === 'snf_pct') { updated.kg_snf = calcSnf(v, row.qty_kgs || calc(row.qty_litres)); }
    return updated;
  }));

  const saveMut = useMutation({
    mutationFn: () => saveAcknowledgements(id, { ack_date: ackDate, acknowledgements: acks }),
    onSuccess: () => { toast.success('Acknowledgement saved — trip closed!'); navigate('/execution'); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });

  const totals = acks.reduce((s, a) => ({
    qty_litres: s.qty_litres + parseFloat(a.qty_litres || 0),
    qty_kgs: s.qty_kgs + parseFloat(a.qty_kgs || calc(a.qty_litres) || 0),
    kg_fat: s.kg_fat + parseFloat(a.kg_fat || calcFat(a.fat_pct, a.qty_kgs || calc(a.qty_litres)) || 0),
    kg_snf: s.kg_snf + parseFloat(a.kg_snf || calcSnf(a.snf_pct, a.qty_kgs || calc(a.qty_litres)) || 0),
  }), { qty_litres: 0, qty_kgs: 0, kg_fat: 0, kg_snf: 0 });

  if (isLoading || !execData) return <div className="p-8 text-center text-gray-400">Loading…</div>;

  const isClosed = execData.status === 'closed';

  // DPS Totals (from BMCU execution rows)
  const dpsTotalLtrs = (execData.bmcu_rows || []).filter(r => !r.is_deleted).reduce((s, r) => s + parseFloat(r.dps_qty_litres || 0), 0);
  const dpsTotalKgs = dpsTotalLtrs * KG_FACTOR;

  return (
    <div className="space-y-5 max-w-3xl">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/execution')} className="btn-secondary"><ArrowLeft size={14} /></button>
        <div>
          <h2 className="text-lg font-semibold">Plant Acknowledgement</h2>
          <p className="text-xs text-gray-500">
            {execData.tanker_number} · {execData.route_name} · Trip #{execData.trip_no}
          </p>
        </div>
      </div>

      {/* Trip Summary */}
      <div className="card p-4">
        <h3 className="font-semibold text-sm mb-3 text-gray-700">Trip Summary (As per Truck Sheet / RMRD)</h3>
        <div className="grid grid-cols-4 gap-3 text-sm">
          <div className="bg-gray-50 rounded p-2">
            <div className="text-xs text-gray-500">Total Qty (L)</div>
            <div className="font-bold">{parseFloat(execData.total_qty_litres || 0).toLocaleString()}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-xs text-gray-500">Total Qty (Kg)</div>
            <div className="font-bold">{parseFloat(execData.total_qty_kgs || 0).toFixed(2)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-xs text-gray-500">Avg Fat %</div>
            <div className="font-bold">{parseFloat(execData.avg_fat || 0).toFixed(4)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-xs text-gray-500">Avg SNF %</div>
            <div className="font-bold">{parseFloat(execData.avg_snf || 0).toFixed(4)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm mt-3">
          <div className="bg-blue-50 rounded p-2">
            <div className="text-xs text-blue-600">DPS Total (L)</div>
            <div className="font-bold text-blue-800">{dpsTotalLtrs.toFixed(2)}</div>
          </div>
          <div className="bg-blue-50 rounded p-2">
            <div className="text-xs text-blue-600">DPS Total (Kg)</div>
            <div className="font-bold text-blue-800">{dpsTotalKgs.toFixed(4)}</div>
          </div>
        </div>
      </div>

      {/* Acknowledgement Form */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="font-semibold text-sm">Acknowledgement by Chamber — As per Balaji Dairy</h3>
          <div className="flex items-center gap-3">
            <div>
              <label className="label mb-0 mr-2 inline">Ack Date:</label>
              <input className="input w-36" type="date" value={ackDate} onChange={e => setAckDate(e.target.value)} disabled={isClosed} />
            </div>
          </div>
        </div>
        <div className="p-4 space-y-4">
          {acks.map((ack, i) => {
            const kgs = ack.qty_kgs || calc(ack.qty_litres);
            const kgFat = ack.kg_fat || calcFat(ack.fat_pct, kgs);
            const kgSnf = ack.kg_snf || calcSnf(ack.snf_pct, kgs);
            return (
              <div key={i} className="border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="font-bold text-brand-700 bg-brand-50 px-2 py-0.5 rounded text-sm">{ack.chamber} Chamber</span>
                  <input className="input flex-1 py-1" placeholder="Temperature (e.g. 5.0/5.4)"
                    value={ack.temperature || ''} onChange={e => updateAck(i, 'temperature', e.target.value)} disabled={isClosed} />
                </div>
                <div className="grid grid-cols-6 gap-3 text-sm">
                  <div>
                    <label className="label">Qty Litres *</label>
                    <input className="input" type="number" value={ack.qty_litres || ''} onChange={e => updateAck(i, 'qty_litres', e.target.value)} disabled={isClosed} />
                  </div>
                  <div>
                    <label className="label">Qty Kgs (auto)</label>
                    <div className="input bg-gray-50 font-mono text-xs">{kgs || '—'}</div>
                  </div>
                  <div>
                    <label className="label">Fat %</label>
                    <input className="input" type="number" step="0.001" value={ack.fat_pct || ''} onChange={e => updateAck(i, 'fat_pct', e.target.value)} disabled={isClosed} />
                  </div>
                  <div>
                    <label className="label">SNF %</label>
                    <input className="input" type="number" step="0.001" value={ack.snf_pct || ''} onChange={e => updateAck(i, 'snf_pct', e.target.value)} disabled={isClosed} />
                  </div>
                  <div>
                    <label className="label">Kg Fat (auto)</label>
                    <div className="input bg-gray-50 font-mono text-xs">{kgFat || '—'}</div>
                  </div>
                  <div>
                    <label className="label">Kg SNF (auto)</label>
                    <div className="input bg-gray-50 font-mono text-xs">{kgSnf || '—'}</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Ack Totals */}
        <div className="px-4 py-3 bg-green-50 border-t">
          <div className="flex gap-6 text-sm">
            <div><span className="text-gray-500">Total Ack Qty (L):</span> <strong>{totals.qty_litres.toFixed(2)}</strong></div>
            <div><span className="text-gray-500">Total Ack Kgs:</span> <strong>{totals.qty_kgs.toFixed(4)}</strong></div>
            <div><span className="text-gray-500">Total Kg Fat:</span> <strong>{totals.kg_fat.toFixed(4)}</strong></div>
            <div><span className="text-gray-500">Total Kg SNF:</span> <strong>{totals.kg_snf.toFixed(4)}</strong></div>
          </div>
        </div>

        {/* Variations */}
        {totals.qty_litres > 0 && (
          <div className="px-4 py-3 border-t">
            <h4 className="text-xs font-semibold text-gray-600 mb-2">Variations (Ack vs Truck Sheet)</h4>
            <div className="grid grid-cols-4 gap-3 text-sm">
              {[
                { label: 'Qty Ltrs', val: totals.qty_litres - parseFloat(execData.total_qty_litres || 0) },
                { label: 'Qty Kgs', val: totals.qty_kgs - parseFloat(execData.total_qty_kgs || 0) },
                { label: 'Kg Fat', val: totals.kg_fat - parseFloat(execData.total_kg_fat || 0) },
                { label: 'Kg SNF', val: totals.kg_snf - parseFloat(execData.total_kg_snf || 0) },
              ].map(v => (
                <div key={v.label} className={`rounded p-2 text-center ${v.val > 0 ? 'bg-green-50' : v.val < 0 ? 'bg-red-50' : 'bg-gray-50'}`}>
                  <div className="text-xs text-gray-500">{v.label}</div>
                  <div className={`font-bold ${v.val > 0 ? 'text-green-700' : v.val < 0 ? 'text-red-700' : ''}`}>
                    {v.val > 0 ? '+' : ''}{v.val.toFixed(4)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {!isClosed && (
        <div className="flex justify-end gap-3">
          <button onClick={() => navigate('/execution')} className="btn-secondary">Cancel</button>
          <button onClick={() => {
            if (confirm('Save acknowledgements and close this trip? This cannot be undone.')) saveMut.mutate();
          }} className="btn-success" disabled={saveMut.isPending}>
            <CheckCircle size={14} /> {saveMut.isPending ? 'Saving…' : 'Save & Close Trip'}
          </button>
        </div>
      )}
    </div>
  );
}
