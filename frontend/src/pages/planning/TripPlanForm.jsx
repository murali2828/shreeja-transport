import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  getPlan, createPlan, updatePlan,
  getTankers, getBmcus, getRoutes, getRoute,
  getStartingPoints, getTestingPoints, getDeliveryPoints
} from '../../api';
import toast from 'react-hot-toast';
import { format } from 'date-fns';
import { ArrowLeft, Plus, Trash2, Calculator } from 'lucide-react';

const EMPTY_PLAN = {
  plan_date: format(new Date(), 'yyyy-MM-dd'),
  plan_for_date: format(new Date(Date.now() + 86400000), 'yyyy-MM-dd'),
  trip_no: '', route_id: '', tanker_id: '', start_point_id: '', testing_point_id: '', delivery_point_id: '',
  shifts_milk: '', expected_km: '', expected_utilization_pct: '', expected_total_qty: '',
  driver_name: '', loader_name: '', remarks: '', status: 'draft', bmcus: []
};

export default function TripPlanForm() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState(EMPTY_PLAN);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const { data: tankers = [] } = useQuery({ queryKey: ['tankers'], queryFn: () => getTankers().then(r => r.data.filter(t => t.is_active)) });
  const { data: bmcuList = [] } = useQuery({ queryKey: ['bmcus'], queryFn: () => getBmcus().then(r => r.data.filter(b => b.is_active)) });
  const { data: routes = [] } = useQuery({ queryKey: ['routes'], queryFn: () => getRoutes().then(r => r.data.filter(r => r.is_active)) });
  const { data: startPts = [] } = useQuery({ queryKey: ['starting-points'], queryFn: () => getStartingPoints().then(r => r.data) });
  const { data: testPts = [] } = useQuery({ queryKey: ['testing-points'], queryFn: () => getTestingPoints().then(r => r.data) });
  const { data: delivPts = [] } = useQuery({ queryKey: ['delivery-points'], queryFn: () => getDeliveryPoints().then(r => r.data) });

  useQuery({
    queryKey: ['plan', id],
    queryFn: () => getPlan(id).then(r => {
      const d = r.data;
      setForm({
        ...d,
        plan_date: d.plan_date?.slice(0,10),
        plan_for_date: d.plan_for_date?.slice(0,10),
        bmcus: (d.bmcus || []).map(b => ({ seq_no: b.seq_no, bmcu_id: b.bmcu_id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, shift_code: b.shift_code || '', expected_qty: b.expected_qty || '' }))
      });
    }),
    enabled: !!id
  });

  const selectedTanker = tankers.find(t => t.id === parseInt(form.tanker_id));

  // Auto-calculate cost
  useEffect(() => {
    if (form.expected_km && selectedTanker?.per_km_rate) {
      const cost = parseFloat(form.expected_km) * parseFloat(selectedTanker.per_km_rate);
      const perLiter = form.expected_total_qty > 0 ? cost / parseFloat(form.expected_total_qty) : 0;
      setForm(f => ({ ...f, total_cost: cost.toFixed(2), per_liter_cost: perLiter.toFixed(4) }));
    }
  }, [form.expected_km, form.tanker_id, form.expected_total_qty]);

  // Auto-fill from route
  const handleRouteChange = async (routeId) => {
    set('route_id', routeId);
    if (!routeId) return;
    try {
      const r = await getRoute(routeId);
      const d = r.data;
      setForm(f => ({
        ...f, route_id: routeId,
        start_point_id: d.start_point_id || f.start_point_id,
        testing_point_id: d.testing_point_id || f.testing_point_id,
        delivery_point_id: d.delivery_point_id || f.delivery_point_id,
        expected_km: d.distance_km || f.expected_km,
        bmcus: (d.bmcus || []).map(b => ({ seq_no: b.seq_no, bmcu_id: b.bmcu_id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, shift_code: '', expected_qty: '' }))
      }));
    } catch {}
  };

  const saveMut = useMutation({
    mutationFn: () => id ? updatePlan(id, form) : createPlan(form),
    onSuccess: () => { toast.success(id ? 'Plan updated' : 'Plan created'); navigate('/planning'); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });

  const addBmcu = (bmcuId) => {
    const b = bmcuList.find(x => x.id === parseInt(bmcuId));
    if (!b || form.bmcus.find(x => x.bmcu_id === b.id)) return;
    setForm(f => ({ ...f, bmcus: [...f.bmcus, { seq_no: f.bmcus.length + 1, bmcu_id: b.id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name, shift_code: '', expected_qty: '' }] }));
  };
  const removeBmcu = (i) => setForm(f => ({ ...f, bmcus: f.bmcus.filter((_, j) => j !== i).map((b, j) => ({ ...b, seq_no: j + 1 })) }));
  const updateBmcu = (i, k, v) => setForm(f => ({ ...f, bmcus: f.bmcus.map((b, j) => j === i ? { ...b, [k]: v } : b) }));

  const totalExpQty = form.bmcus.reduce((s, b) => s + parseFloat(b.expected_qty || 0), 0);

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/planning')} className="btn-secondary"><ArrowLeft size={14} /></button>
        <div>
          <h2 className="text-lg font-semibold">{id ? 'Edit Trip Plan' : 'New Trip Plan'}</h2>
          <p className="text-xs text-gray-500">Fill in route details. Plan created today will be executed tomorrow.</p>
        </div>
      </div>

      <div className="card p-5 space-y-5">
        {/* Dates & Trip */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Plan Date (Today)</label>
            <input className="input" type="date" value={form.plan_date} onChange={e => set('plan_date', e.target.value)} />
          </div>
          <div>
            <label className="label">Plan for Date (Trip Date) *</label>
            <input className="input" type="date" value={form.plan_for_date} onChange={e => set('plan_for_date', e.target.value)} />
          </div>
          <div>
            <label className="label">Trip Number</label>
            <input className="input" type="number" value={form.trip_no} onChange={e => set('trip_no', e.target.value)} placeholder="e.g. 1" />
          </div>
        </div>

        {/* Route & Tanker */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Route</label>
            <select className="input" value={form.route_id || ''} onChange={e => handleRouteChange(e.target.value)}>
              <option value="">— Select or fill manually below —</option>
              {routes.map(r => <option key={r.id} value={r.id}>{r.route_name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Tanker *</label>
            <select className="input" value={form.tanker_id || ''} onChange={e => set('tanker_id', e.target.value)}>
              <option value="">— Select Tanker —</option>
              {tankers.map(t => <option key={t.id} value={t.id}>{t.tanker_number} ({t.capacity_litres.toLocaleString()} L, {t.compartments} chambers)</option>)}
            </select>
            {selectedTanker && <p className="text-xs text-gray-500 mt-1">Per KM rate: ₹{selectedTanker.per_km_rate}</p>}
          </div>
        </div>

        {/* Points */}
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="label">Starting Point</label>
            <select className="input" value={form.start_point_id || ''} onChange={e => set('start_point_id', e.target.value)}>
              <option value="">— Select —</option>
              {startPts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Testing Point</label>
            <select className="input" value={form.testing_point_id || ''} onChange={e => set('testing_point_id', e.target.value)}>
              <option value="">— Select —</option>
              {testPts.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Delivery Point</label>
            <select className="input" value={form.delivery_point_id || ''} onChange={e => set('delivery_point_id', e.target.value)}>
              <option value="">— Select —</option>
              {delivPts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
        </div>

        {/* Quantities & Cost */}
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="label">Shifts Milk (e.g. 06E07M)</label>
            <input className="input" value={form.shifts_milk} onChange={e => set('shifts_milk', e.target.value)} placeholder="06E07M" />
          </div>
          <div>
            <label className="label">Expected KM</label>
            <input className="input" type="number" value={form.expected_km} onChange={e => set('expected_km', e.target.value)} />
          </div>
          <div>
            <label className="label">Expected Total Qty (L)</label>
            <input className="input" type="number" value={form.expected_total_qty} onChange={e => set('expected_total_qty', e.target.value)} placeholder="Auto from BMCUs" />
          </div>
          <div>
            <label className="label">Utilization %</label>
            <input className="input" type="number" value={form.expected_utilization_pct}
              onChange={e => set('expected_utilization_pct', e.target.value)}
              placeholder={selectedTanker && form.expected_total_qty ? `${(form.expected_total_qty / selectedTanker.capacity_litres * 100).toFixed(1)}%` : ''} />
          </div>
        </div>

        {/* Cost display */}
        {form.total_cost > 0 && (
          <div className="bg-brand-50 border border-brand-200 rounded-lg p-3 flex gap-6 text-sm">
            <div><span className="text-gray-500">Total Cost:</span> <strong>₹{parseFloat(form.total_cost).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong></div>
            <div><span className="text-gray-500">Cost per Litre:</span> <strong>₹{parseFloat(form.per_liter_cost || 0).toFixed(4)}</strong></div>
            {selectedTanker && <div><span className="text-gray-500">Rate used:</span> ₹{selectedTanker.per_km_rate}/km × {form.expected_km} km</div>}
          </div>
        )}

        {/* Driver & Loader */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Driver Name</label>
            <input className="input" value={form.driver_name} onChange={e => set('driver_name', e.target.value)} />
          </div>
          <div>
            <label className="label">Loader Name</label>
            <input className="input" value={form.loader_name} onChange={e => set('loader_name', e.target.value)} />
          </div>
        </div>

        <div>
          <label className="label">Remarks</label>
          <textarea className="input" rows={2} value={form.remarks} onChange={e => set('remarks', e.target.value)} placeholder="Any special instructions for trip executors…" />
        </div>

        {/* BMCU Table */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">BMCU Visit Sequence *</label>
            <div className="flex items-center gap-2">
              {totalExpQty > 0 && <span className="text-xs text-brand-600 font-medium">Total exp. qty: {totalExpQty.toLocaleString()} L</span>}
              <select className="input text-xs py-1" defaultValue="" onChange={e => { if (e.target.value) { addBmcu(e.target.value); e.target.value=''; } }}>
                <option value="">+ Add BMCU</option>
                {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} — {b.bmcu_name}</option>)}
              </select>
            </div>
          </div>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="table-th w-10">Seq</th>
                  <th className="table-th">Code</th>
                  <th className="table-th">BMCU Name</th>
                  <th className="table-th w-32">Shift Code</th>
                  <th className="table-th w-36">Expected Qty (L)</th>
                  <th className="table-th w-10"></th>
                </tr>
              </thead>
              <tbody>
                {form.bmcus.length === 0 ? (
                  <tr><td colSpan={6} className="table-td text-center text-gray-400 py-4">Select a route above or add BMCUs manually</td></tr>
                ) : form.bmcus.map((b, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="table-td text-center font-bold text-brand-600">{b.seq_no}</td>
                    <td className="table-td font-mono text-xs">{b.bmcu_code}</td>
                    <td className="table-td">{b.bmcu_name}</td>
                    <td className="table-td"><input className="input py-1 text-xs" value={b.shift_code} onChange={e => updateBmcu(i, 'shift_code', e.target.value)} placeholder="06E07M" /></td>
                    <td className="table-td"><input className="input py-1 text-xs" type="number" value={b.expected_qty} onChange={e => updateBmcu(i, 'expected_qty', e.target.value)} /></td>
                    <td className="table-td"><button onClick={() => removeBmcu(i)} className="btn-danger btn-sm"><Trash2 size={11} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2 border-t">
          <button onClick={() => navigate('/planning')} className="btn-secondary">Cancel</button>
          <button onClick={() => saveMut.mutate()} className="btn-primary" disabled={saveMut.isPending}>
            {saveMut.isPending ? 'Saving…' : id ? 'Update Plan' : 'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
