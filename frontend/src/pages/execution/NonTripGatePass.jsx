// frontend/src/pages/execution/NonTripGatePass.jsx
// Gate passes issued OUTSIDE trip planning: tanker leaves for Maintainance,
// Hot water, RMT, Without driver or Others. RMT captures billing data —
// reimbursed from the Balaji vendor and paid to the tanker vendor at
// different rates.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Printer, Plus, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getTankers, getNonTripGatePasses, createNonTripGatePass } from '../../api/index';
import { printNonTripGatePass } from '../../utils/printDocs';

const REASONS = ['Maintainance', 'Hot water', 'RMT', 'Tankers without driver', 'Others'];
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const fmtTs = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const n2 = v => v == null || v === '' ? '—' : parseFloat(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const EMPTY = { tanker_no: '', reason: 'Maintainance', other_text: '', remarks: '', km: '', tanker_vendor_rate: '', balaji_dairy_rate: '' };

export default function NonTripGatePass() {
  const qc = useQueryClient();
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo]     = useState(today());
  const [form, setForm] = useState({ ...EMPTY });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const isRmt = form.reason === 'RMT';

  const { data: tankers = [] } = useQuery({
    queryKey: ['tankers-active'],
    queryFn:  () => getTankers({ is_active: true }).then(r => r.data),
  });

  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['non-trip-gp', from, to],
    queryFn:  () => getNonTripGatePasses({ from_date: from, to_date: to }).then(r => r.data),
  });

  const matchedTanker = tankers.find(
    t => t.tanker_number.toLowerCase() === form.tanker_no.trim().toLowerCase());

  const createMut = useMutation({
    mutationFn: () => createNonTripGatePass({ ...form, tanker_id: matchedTanker?.id }),
    onSuccess: (res) => {
      toast.success(`Gate pass NT-${res.data.id} issued`);
      qc.invalidateQueries(['non-trip-gp']);
      setForm({ ...EMPTY });
      printNonTripGatePass(res.data);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed to issue gate pass'),
  });

  const submit = () => {
    if (!matchedTanker) return toast.error('Select a valid tanker number from the list');
    if (form.reason === 'Others' && !form.other_text.trim()) return toast.error('Describe the reason');
    if (isRmt && (!form.km || !form.tanker_vendor_rate || !form.balaji_dairy_rate))
      return toast.error('RMT requires KM, Tanker Vendor Rate and Balaji Dairy Rate');
    createMut.mutate();
  };

  const vendorAmt = isRmt && form.km && form.tanker_vendor_rate ? form.km * form.tanker_vendor_rate : null;
  const balajiAmt = isRmt && form.km && form.balaji_dairy_rate ? form.km * form.balaji_dairy_rate : null;

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title">Other Gate Pass</div>
          <div className="page-sub">Gate passes outside trip planning — maintenance, hot water, RMT, and more</div>
        </div>
      </div>

      {/* Issue form */}
      <div className="card card-body space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label">Tanker *</label>
            <input className="input" list="ntgp-tankers" placeholder="Type part of tanker number…"
              value={form.tanker_no} onChange={e => set('tanker_no', e.target.value)}/>
            <datalist id="ntgp-tankers">
              {tankers.map(t => <option key={t.id} value={t.tanker_number}/>)}
            </datalist>
          </div>
          <div>
            <label className="label">Reason *</label>
            <select className="input" value={form.reason} onChange={e => set('reason', e.target.value)}>
              {REASONS.map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          {form.reason === 'Others' && (
            <div className="sm:col-span-2">
              <label className="label">Describe reason *</label>
              <input className="input" maxLength={200} placeholder="Short description…"
                value={form.other_text} onChange={e => set('other_text', e.target.value)}/>
            </div>
          )}
        </div>

        {isRmt && (
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div><label className="label">KM *</label>
                <input type="number" min="0" className="input" value={form.km} onChange={e => set('km', e.target.value)}/></div>
              <div><label className="label">Tanker Vendor Rate (₹/km) *</label>
                <input type="number" min="0" className="input" value={form.tanker_vendor_rate} onChange={e => set('tanker_vendor_rate', e.target.value)}/></div>
              <div><label className="label">Balaji Dairy Rate (₹/km) *</label>
                <input type="number" min="0" className="input" value={form.balaji_dairy_rate} onChange={e => set('balaji_dairy_rate', e.target.value)}/></div>
              <div><label className="label">Remarks</label>
                <input className="input" value={form.remarks} onChange={e => set('remarks', e.target.value)}/></div>
            </div>
            {(vendorAmt != null || balajiAmt != null) && (
              <div className="text-xs text-amber-800">
                Pay tanker vendor: <b>₹{n2(vendorAmt)}</b> · Reimburse from Balaji: <b>₹{n2(balajiAmt)}</b>
                {vendorAmt != null && balajiAmt != null && <> · Difference: <b>₹{n2(balajiAmt - vendorAmt)}</b></>}
              </div>
            )}
          </div>
        )}

        <button onClick={submit} disabled={createMut.isPending}
          className="btn-primary flex items-center gap-1.5 text-sm">
          {createMut.isPending ? <RefreshCw size={14} className="animate-spin"/> : <Plus size={14}/>}
          Issue Gate Pass &amp; Print
        </button>
      </div>

      {/* History */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 bg-gray-50 border-b flex flex-wrap items-center gap-2 justify-between">
          <span className="text-sm font-semibold text-gray-700">Issued gate passes</span>
          <div className="flex items-center gap-2">
            <input type="date" className="input py-1 text-xs" value={from} onChange={e => setFrom(e.target.value)}/>
            <span className="text-gray-400 text-xs">to</span>
            <input type="date" className="input py-1 text-xs" value={to} onChange={e => setTo(e.target.value)}/>
            {isFetching && <RefreshCw size={13} className="animate-spin text-gray-400"/>}
          </div>
        </div>
        <div className="overflow-x-auto max-h-[50vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">No.</th>
                <th className="table-th">Issued At</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Reason</th>
                <th className="table-th text-right">KM</th>
                <th className="table-th text-right">Vendor Rate</th>
                <th className="table-th text-right">Balaji Rate</th>
                <th className="table-th text-right">Pay Vendor (₹)</th>
                <th className="table-th text-right">Reimburse (₹)</th>
                <th className="table-th">Remarks</th>
                <th className="table-th">Issued By</th>
                <th className="table-th">Print</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={12}><div className="empty-state">No gate passes in this date range.</div></td></tr>
              )}
              {rows.map(g => (
                <tr key={g.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td font-bold text-[#0078d4]">NT-{g.id}</td>
                  <td className="table-td whitespace-nowrap">{fmtTs(g.issued_at)}</td>
                  <td className="table-td font-mono font-semibold text-[#005ba3]">{g.tanker_number}</td>
                  <td className="table-td">
                    <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 font-medium">{g.reason}</span>
                    {g.other_text && <span className="text-gray-500"> — {g.other_text}</span>}
                  </td>
                  <td className="table-td text-right">{g.km != null ? n2(g.km) : '—'}</td>
                  <td className="table-td text-right">{g.tanker_vendor_rate != null ? n2(g.tanker_vendor_rate) : '—'}</td>
                  <td className="table-td text-right">{g.balaji_dairy_rate != null ? n2(g.balaji_dairy_rate) : '—'}</td>
                  <td className="table-td text-right">{g.km && g.tanker_vendor_rate ? n2(g.km * g.tanker_vendor_rate) : '—'}</td>
                  <td className="table-td text-right">{g.km && g.balaji_dairy_rate ? n2(g.km * g.balaji_dairy_rate) : '—'}</td>
                  <td className="table-td text-gray-600">{g.remarks || '—'}</td>
                  <td className="table-td text-gray-600">{g.issued_by_name || '—'}</td>
                  <td className="table-td">
                    <button onClick={() => printNonTripGatePass(g, { duplicate: true })}
                      className="btn-secondary btn-sm flex items-center gap-1" title="Reprint (marked DUPLICATE)">
                      <Printer size={12}/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
