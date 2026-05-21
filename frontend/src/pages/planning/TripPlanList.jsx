// frontend/src/pages/planning/TripPlanList.jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Download, Upload, Send, Trash2, Edit2, Zap, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPlans, deletePlan, publishPlans, uploadPlans, downloadPlanTemplate } from '../../api/index';

export default function TripPlanList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().slice(0,10));
  const [statusFilter, setStatusFilter] = useState('');

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans', dateFilter, statusFilter],
    queryFn:  () => getPlans({ plan_for_date: dateFilter || undefined, status: statusFilter || undefined }).then(r => r.data)
  });

  const deleteMut = useMutation({
    mutationFn: deletePlan,
    onSuccess: () => { toast.success('Plan cancelled'); qc.invalidateQueries(['plans']); },
    onError: (e) => toast.error(e.response?.data?.error || 'Delete failed'),
  });

  const publishMut = useMutation({
    mutationFn: () => publishPlans(dateFilter),
    onSuccess: (r) => { toast.success(`${r.data.published} plan(s) published`); qc.invalidateQueries(['plans']); },
    onError: (e) => toast.error(e.response?.data?.error || 'Publish failed'),
  });

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!dateFilter) { toast.error('Set a date filter first'); return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('plan_date', new Date().toISOString().slice(0,10));
    fd.append('plan_for_date', dateFilter);
    try {
      const r = await uploadPlans(fd);
      toast.success(`${r.data.created} plan(s) uploaded`);
      if (r.data.errors?.length) toast.error(`${r.data.errors.length} row(s) had errors`);
      qc.invalidateQueries(['plans']);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    }
    e.target.value = '';
  };

  const hasDrafts = plans.some(p => p.status === 'draft');
  const totalQty  = plans.reduce((s, p) => s + parseFloat(p.expected_total_qty || 0), 0);
  const totalCost = plans.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);

  const statusBadge = (s) => ({
    draft:     'bg-amber-100 text-amber-700',
    published: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-600',
  })[s] || 'bg-gray-100 text-gray-500';

  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span>Trip Plans</span>
          {plans.length > 0 && (
            <span className="text-xs bg-[#e6f3fb] text-[#005ba3] px-2 py-0.5 rounded-full font-medium">
              {plans.length}
            </span>
          )}
        </h2>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => navigate('/planning/optimize')}
            className="btn-secondary flex items-center gap-1.5 text-[#005ba3] border-[#8ec9ef]">
            <Zap size={14}/> Route Optimizer
          </button>
          <button onClick={downloadPlanTemplate} className="btn-secondary flex items-center gap-1.5">
            <Download size={14}/> Template
          </button>
          <label className="btn-secondary flex items-center gap-1.5 cursor-pointer">
            <Upload size={14}/> Upload
            <input type="file" accept=".xlsx,.xls" className="sr-only" onChange={handleUpload}/>
          </label>
          {hasDrafts && (
            <button onClick={() => publishMut.mutate()} disabled={publishMut.isPending}
              className="btn-secondary flex items-center gap-1.5 text-green-700 border-green-300">
              {publishMut.isPending ? <RefreshCw size={14} className="animate-spin"/> : <Send size={14}/>}
              Publish Drafts
            </button>
          )}
          <button onClick={() => navigate('/planning/new')} className="btn-primary flex items-center gap-1.5">
            <Plus size={14}/> New Plan
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-3 flex flex-wrap gap-3 items-center">
        <div>
          <label className="text-xs text-gray-500 block mb-0.5">Plan For Date</label>
          <input type="date" className="input py-1.5 text-sm" value={dateFilter}
            onChange={e => setDateFilter(e.target.value)}/>
        </div>
        <div>
          <label className="text-xs text-gray-500 block mb-0.5">Status</label>
          <select className="input py-1.5 text-sm w-32" value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="published">Published</option>
          </select>
        </div>
        {plans.length > 0 && (
          <div className="ml-auto text-xs text-gray-500 text-right">
            <div>Total Qty: <strong className="text-[#005ba3]">{totalQty.toLocaleString()} L</strong></div>
            <div>Total Cost: <strong className="text-green-700">₹{totalCost.toLocaleString('en-IN',{maximumFractionDigits:0})}</strong></div>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="table-th w-10">Trip</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Route</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Shift</th>
                <th className="table-th">Driver</th>
                <th className="table-th text-right">Qty (L)</th>
                <th className="table-th text-right">KM</th>
                <th className="table-th text-right">Cost</th>
                <th className="table-th text-right">₹/L</th>
                <th className="table-th text-center">Util%</th>
                <th className="table-th">Status</th>
                <th className="table-th w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={13} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && plans.length === 0 && (
                <tr><td colSpan={13} className="table-td text-center py-10 text-gray-400">
                  No plans for this date. Create a plan or use the Route Optimizer.
                </td></tr>
              )}
              {plans.map(p => (
                <tr key={p.id} className="hover:bg-gray-50 border-b border-gray-50">
                  <td className="table-td font-bold text-[#0078d4]">#{p.trip_no}</td>
                  <td className="table-td font-mono text-xs">{p.tanker_number}</td>
                  <td className="table-td text-gray-600 text-xs">{p.route_name || '—'}</td>
                  <td className="table-td text-xs">{p.delivery_point_name || '—'}</td>
                  <td className="table-td">{p.shifts_milk || '—'}</td>
                  <td className="table-td text-xs">{p.driver_name || '—'}</td>
                  <td className="table-td text-right">{parseFloat(p.expected_total_qty||0).toLocaleString()}</td>
                  <td className="table-td text-right">{p.expected_km || '—'}</td>
                  <td className="table-td text-right text-green-700 font-medium">
                    ₹{parseFloat(p.total_cost||0).toLocaleString('en-IN',{maximumFractionDigits:0})}
                  </td>
                  <td className="table-td text-right text-xs">{parseFloat(p.per_liter_cost||0).toFixed(4)}</td>
                  <td className="table-td text-center text-xs">
                    <span className={`font-medium ${parseFloat(p.expected_utilization_pct||0)>=80?'text-green-600':parseFloat(p.expected_utilization_pct||0)>=60?'text-amber-600':'text-red-500'}`}>
                      {parseFloat(p.expected_utilization_pct||0).toFixed(0)}%
                    </span>
                  </td>
                  <td className="table-td">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(p.status)}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      {p.status === 'draft' && (
                        <>
                          <button onClick={() => navigate(`/planning/${p.id}/edit`)}
                            className="btn-secondary btn-sm p-1" title="Edit">
                            <Edit2 size={12}/>
                          </button>
                          <button onClick={() => { if (confirm('Cancel this plan?')) deleteMut.mutate(p.id); }}
                            className="btn-danger btn-sm p-1" title="Cancel">
                            <Trash2 size={12}/>
                          </button>
                        </>
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
