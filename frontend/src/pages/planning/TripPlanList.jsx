import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPlans, deletePlan, publishPlans, uploadPlans } from '../../api';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, Upload, CheckCircle, Download, Send } from 'lucide-react';
import { format } from 'date-fns';

const STATUS_BADGE = { draft: 'badge-yellow', published: 'badge-green', cancelled: 'badge-red' };

export default function TripPlanList() {
  const [params] = useSearchParams();
  const [date, setDate] = useState(params.get('date') || format(new Date(), 'yyyy-MM-dd'));
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans', date],
    queryFn: () => getPlans({ plan_for_date: date }).then(r => r.data),
    enabled: !!date
  });

  const deleteMut = useMutation({
    mutationFn: deletePlan,
    onSuccess: () => { toast.success('Plan cancelled'); qc.invalidateQueries(['plans']); }
  });

  const publishMut = useMutation({
    mutationFn: () => publishPlans(date),
    onSuccess: () => { toast.success('Plans published for trip executors'); qc.invalidateQueries(['plans']); }
  });

  const [uploading, setUploading] = useState(false);
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('plan_date', format(new Date(), 'yyyy-MM-dd'));
    fd.append('plan_for_date', date);
    setUploading(true);
    try {
      const r = await uploadPlans(fd);
      toast.success(`Uploaded: ${r.data.created} plans created. ${r.data.errors?.length ? r.data.errors.length + ' errors.' : ''}`);
      if (r.data.errors?.length) console.warn('Upload errors:', r.data.errors);
      qc.invalidateQueries(['plans']);
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    finally { setUploading(false); e.target.value = ''; }
  };

  const draftCount = plans.filter(p => p.status === 'draft').length;
  const totalQty = plans.reduce((s, p) => s + parseFloat(p.expected_total_qty || 0), 0);
  const totalCost = plans.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold">Trip Planning</h2>
          <p className="text-xs text-gray-500">Plan tanker routes — today's plan becomes tomorrow's trips</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <label className={`btn-secondary cursor-pointer ${uploading ? 'opacity-50' : ''}`}>
            <Upload size={14} /> {uploading ? 'Uploading…' : 'Upload Excel'}
            <input type="file" accept=".xlsx,.xls" className="hidden" onChange={handleFileUpload} disabled={uploading} />
          </label>
          <a href="/api/plans/template/download" className="btn-secondary">
            <Download size={14} /> Template
          </a>
          {draftCount > 0 && (
            <button onClick={() => { if (confirm(`Publish ${draftCount} draft plans for ${date}?`)) publishMut.mutate(); }} className="btn-success">
              <Send size={14} /> Publish {draftCount} Plans
            </button>
          )}
          <button onClick={() => navigate('/planning/new')} className="btn-primary">
            <Plus size={14} /> Add Trip Plan
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div>
          <label className="label">Plan for Date</label>
          <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        {plans.length > 0 && (
          <div className="flex gap-4 text-sm text-gray-600 pt-4">
            <span><strong>{plans.length}</strong> trips</span>
            <span><strong>{totalQty.toLocaleString()} L</strong> exp. qty</span>
            <span><strong>₹{totalCost.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong> est. cost</span>
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-th">Trip#</th>
                <th className="table-th">Route</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Start Point</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Shifts</th>
                <th className="table-th">Exp. Qty (L)</th>
                <th className="table-th">Exp. KM</th>
                <th className="table-th">Total Cost</th>
                <th className="table-th">₹/L</th>
                <th className="table-th">Driver</th>
                <th className="table-th">Status</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={13} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              ) : plans.length === 0 ? (
                <tr><td colSpan={13} className="table-td text-center py-10 text-gray-400">
                  No plans for {date}. Click "Add Trip Plan" or upload an Excel file.
                </td></tr>
              ) : plans.map(p => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="table-td font-bold text-brand-700">{p.trip_no}</td>
                  <td className="table-td font-medium">{p.route_name || '—'}</td>
                  <td className="table-td font-mono text-xs">{p.tanker_number || '—'}</td>
                  <td className="table-td text-xs">{p.start_point_name || '—'}</td>
                  <td className="table-td text-xs">{p.delivery_point_name || '—'}</td>
                  <td className="table-td text-xs">{p.shifts_milk || '—'}</td>
                  <td className="table-td font-medium">{p.expected_total_qty ? parseFloat(p.expected_total_qty).toLocaleString() : '—'}</td>
                  <td className="table-td">{p.expected_km || '—'}</td>
                  <td className="table-td">₹{p.total_cost ? parseFloat(p.total_cost).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '—'}</td>
                  <td className="table-td">{p.per_liter_cost ? parseFloat(p.per_liter_cost).toFixed(3) : '—'}</td>
                  <td className="table-td text-xs">{p.driver_name || '—'}</td>
                  <td className="table-td">
                    <span className={STATUS_BADGE[p.status] || 'badge-gray'}>{p.status}</span>
                  </td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      {p.status !== 'cancelled' && (
                        <button onClick={() => navigate(`/planning/${p.id}/edit`)} className="btn-secondary btn-sm"><Pencil size={12} /></button>
                      )}
                      {p.status === 'draft' && (
                        <button onClick={() => { if (confirm('Cancel this plan?')) deleteMut.mutate(p.id); }} className="btn-danger btn-sm"><Trash2 size={12} /></button>
                      )}
                    </div>
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
