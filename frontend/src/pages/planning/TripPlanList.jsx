// frontend/src/pages/planning/TripPlanList.jsx
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Download, Upload, Send, Trash2, Edit2, Zap, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPlans, deletePlan, publishPlans, uploadPlans, downloadPlanTemplate, getPlanCoverage } from '../../api/index';

export default function TripPlanList() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().slice(0,10));
  const [statusFilter, setStatusFilter] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // { plan, force }
  const [deleteReason, setDeleteReason] = useState('');
  const [uploadErrors, setUploadErrors] = useState([]);
  const [showMissed, setShowMissed] = useState(false);

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['plans', dateFilter, statusFilter],
    queryFn:  () => getPlans({ plan_for_date: dateFilter || undefined, status: statusFilter || undefined }).then(r => r.data)
  });

  const { data: coverage } = useQuery({
    queryKey: ['plan-coverage', dateFilter],
    queryFn: () => dateFilter ? getPlanCoverage(dateFilter).then(r => r.data) : Promise.resolve(null),
    enabled: !!dateFilter,
  });

  const { data: deletedPlans = [] } = useQuery({
    queryKey: ['plans-deleted', dateFilter],
    enabled: showDeleted,
    queryFn: () => getPlans({ plan_for_date: dateFilter || undefined, status: 'deleted' }).then(r => r.data)
  });

  const deleteMut = useMutation({
    mutationFn: ({ id, force }) => deletePlan(id, force),
    onSuccess: () => {
      toast.success('Plan moved to deleted');
      setDeleteTarget(null);
      setDeleteReason('');
      qc.invalidateQueries(['plans']);
      qc.invalidateQueries(['plans-deleted']);
      qc.invalidateQueries(['plan-coverage']);
    },
    onError: (e) => {
      const data = e.response?.data;
      if (data?.hasExecution) {
        // Backend warned us — ask user to confirm force delete
        setDeleteTarget(prev => ({ ...prev, force: true, executions: data.executions }));
      } else {
        toast.error(data?.error || 'Delete failed');
      }
    }
  });

  const publishMut = useMutation({
    mutationFn: () => publishPlans(dateFilter),
    onSuccess: (r) => { toast.success(`${r.data.published} plan(s) published`); qc.invalidateQueries(['plans']); qc.invalidateQueries(['plan-coverage']); },
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
      if (r.data.created === 0 && !r.data.errors?.length) {
        toast.error('0 plans uploaded — no trip rows detected. Re-download the template and ensure column headers match exactly (row 3).');
        setUploadErrors(['No trip rows were found in the file. Make sure you are using the latest template downloaded from this page, and that column headers in row 3 are unchanged.']);
      } else {
        toast.success(`${r.data.created} plan(s) uploaded`);
        if (r.data.errors?.length) {
          toast.error(`${r.data.errors.length} row(s) had errors`);
          setUploadErrors(r.data.errors);
        } else {
          setUploadErrors([]);
        }
      }
      qc.invalidateQueries(['plans']);
      qc.invalidateQueries(['plan-coverage']);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    }
    e.target.value = '';
  };

  const handleDeleteClick = (p) => {
    if (p.status === 'published') {
      setDeleteTarget({ plan: p, force: false });
    } else {
      if (confirm(`Cancel plan #${p.trip_no}?`)) deleteMut.mutate({ id: p.id, force: false });
    }
  };

  const handleEditClick = (p) => {
    if (p.status === 'published') {
      if (!confirm(`Plan #${p.trip_no} is already published. Editing it may affect active executions. Continue?`)) return;
    }
    navigate(`/planning/${p.id}/edit`);
  };

  const hasDrafts = plans.some(p => p.status === 'draft');
  const activePlans = plans.filter(p => p.status !== 'deleted');
  const totalQty  = activePlans.reduce((s, p) => s + parseFloat(p.expected_total_qty || 0), 0);
  const totalCost = activePlans.reduce((s, p) => s + parseFloat(p.total_cost || 0), 0);

  const statusBadge = (s) => ({
    draft:     'bg-amber-100 text-amber-700',
    published: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-600',
    deleted:   'bg-gray-200 text-gray-500',
  })[s] || 'bg-gray-100 text-gray-500';

  const PlanTable = ({ rows, dimmed = false }) => (
    <table className={`w-full text-sm ${dimmed ? 'opacity-60' : ''}`}>
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
          {!dimmed && <th className="table-th w-20">Actions</th>}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && (
          <tr><td colSpan={dimmed ? 12 : 13} className="table-td text-center py-6 text-gray-400">
            No plans found.
          </td></tr>
        )}
        {rows.map(p => (
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
            {!dimmed && (
              <td className="table-td">
                <div className="flex gap-1">
                  <button onClick={() => handleEditClick(p)}
                    className="btn-secondary btn-sm p-1" title="Edit">
                    <Edit2 size={12}/>
                  </button>
                  <button onClick={() => handleDeleteClick(p)}
                    className="btn-danger btn-sm p-1" title="Delete">
                    <Trash2 size={12}/>
                  </button>
                </div>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <span>Trip Plans</span>
          {activePlans.length > 0 && (
            <span className="text-xs bg-[#e6f3fb] text-[#005ba3] px-2 py-0.5 rounded-full font-medium">
              {activePlans.length}
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
        {activePlans.length > 0 && (
          <div className="ml-auto text-xs text-gray-500 text-right">
            <div>Total Qty: <strong className="text-[#005ba3]">{totalQty.toLocaleString()} L</strong></div>
            <div>Total Cost: <strong className="text-green-700">₹{totalCost.toLocaleString('en-IN',{maximumFractionDigits:0})}</strong></div>
          </div>
        )}
      </div>

      {/* Coverage summary */}
      {coverage && dateFilter && (
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-4 text-center border-l-4 border-[#005ba3]">
            <div className="text-2xl font-bold text-[#005ba3]">{coverage.total_plans}</div>
            <div className="text-xs text-gray-500 mt-0.5">Trips Planned</div>
          </div>
          <div className="card p-4 text-center border-l-4 border-green-500">
            <div className="text-2xl font-bold text-green-600">{coverage.bmcus_covered}</div>
            <div className="text-xs text-gray-500 mt-0.5">BMCUs Covered</div>
            <div className="text-xs text-gray-400">of {coverage.total_active_bmcus} active</div>
          </div>
          <div className={`card p-4 text-center border-l-4 ${coverage.bmcus_missed > 0 ? 'border-red-400' : 'border-gray-200'}`}>
            <button className="w-full" onClick={() => coverage.bmcus_missed > 0 && setShowMissed(v => !v)}>
              <div className={`text-2xl font-bold ${coverage.bmcus_missed > 0 ? 'text-red-500' : 'text-gray-400'}`}>
                {coverage.bmcus_missed}
              </div>
              <div className="text-xs text-gray-500 mt-0.5 flex items-center justify-center gap-1">
                BMCUs Missed
                {coverage.bmcus_missed > 0 && (
                  showMissed ? <ChevronDown size={12}/> : <ChevronRight size={12}/>
                )}
              </div>
            </button>
            {showMissed && coverage.missed_list?.length > 0 && (
              <div className="mt-2 text-left max-h-36 overflow-y-auto border-t pt-2">
                {coverage.missed_list.map(b => (
                  <div key={b.id} className="text-xs text-red-600 py-0.5">
                    <span className="font-mono font-medium">{b.bmcu_code}</span>
                    {' — '}{b.bmcu_name}
                    {b.district && <span className="text-gray-400"> ({b.district})</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upload errors */}
      {uploadErrors.length > 0 && (
        <div className="card p-4 border-red-200 bg-red-50">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-red-700">Upload Errors ({uploadErrors.length} row{uploadErrors.length !== 1 ? 's' : ''})</h3>
            <button onClick={() => setUploadErrors([])} className="text-xs text-red-500 hover:text-red-700">Dismiss</button>
          </div>
          <ul className="space-y-1 max-h-48 overflow-y-auto">
            {uploadErrors.map((err, i) => (
              <li key={i} className="text-xs text-red-600 bg-white rounded px-2 py-1 border border-red-100">
                {typeof err === 'string' ? err : (err.message || err.error || JSON.stringify(err))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Active plans table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="text-center py-10 text-gray-400 text-sm">Loading…</div>
          ) : (
            <PlanTable rows={activePlans} />
          )}
        </div>
      </div>

      {/* Deleted plans section */}
      <div className="card overflow-hidden">
        <button
          onClick={() => setShowDeleted(!showDeleted)}
          className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium text-gray-500 hover:bg-gray-50 transition-colors">
          {showDeleted ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}
          Deleted Plans (reference only — excluded from all reports)
          {deletedPlans.length > 0 && (
            <span className="ml-1 text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">
              {deletedPlans.length}
            </span>
          )}
        </button>
        {showDeleted && (
          <div className="overflow-x-auto border-t">
            <PlanTable rows={deletedPlans} dimmed={true} />
          </div>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
            <h3 className="text-base font-semibold mb-3 text-red-600">
              Delete Plan #{deleteTarget.plan.trip_no}?
            </h3>

            {deleteTarget.plan.status === 'published' && !deleteTarget.force && (
              <p className="text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mb-3">
                This plan is <strong>published</strong>. Deleting it will move it to the Deleted Plans section and exclude it from all reports and calculations.
              </p>
            )}

            {deleteTarget.force && (
              <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-3">
                This plan has <strong>active execution data</strong> ({deleteTarget.executions?.length} execution(s)). Deleting it will still keep execution records but the plan will be excluded from all reports and KM calculations. This action cannot be undone.
              </p>
            )}

            <p className="text-sm text-gray-600 mb-4">
              The plan will be moved to "Deleted Plans" (reference only) and will not appear in reports, KM calculations, trip counts, or cost summaries.
            </p>

            <div className="flex gap-3 justify-end">
              <button onClick={() => { setDeleteTarget(null); setDeleteReason(''); }}
                className="btn-secondary">Cancel</button>
              <button
                onClick={() => deleteMut.mutate({ id: deleteTarget.plan.id, force: deleteTarget.force })}
                disabled={deleteMut.isPending}
                className="btn-danger flex items-center gap-1.5">
                {deleteMut.isPending ? <RefreshCw size={13} className="animate-spin"/> : <Trash2 size={13}/>}
                {deleteTarget.force ? 'Delete Anyway' : 'Delete Plan'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
