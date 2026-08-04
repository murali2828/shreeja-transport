// frontend/src/pages/planning/TripPlanForm.jsx
import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, ChevronLeft } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/SearchableSelect';
import {
  getTankers, getBmcus, getRoutes, getStartingPoints, getTestingPoints, getDeliveryPoints,
  getPlan, createPlan, updatePlan
} from '../../api/index';

const KG_FACTOR = 1.0285;

export default function TripPlanForm() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const qc       = useQueryClient();
  const isEdit   = !!id;
  const today    = new Date().toISOString().slice(0,10);

  const [form, setForm] = useState({
    plan_date: today, plan_for_date: today, trip_no: '',
    route_id: '', tanker_id: '', start_point_id: '', testing_point_id: '', delivery_point_id: '',
    shifts_milk: '', expected_km: '', expected_total_qty: '',
    driver_name: '', loader_name: '', remarks: '', bmcus: []
  });

  // Load masters
  const { data: tankers   = [] } = useQuery({ queryKey: ['tankers'],  queryFn: () => getTankers().then(r=>r.data) });
  const { data: bmcuList  = [] } = useQuery({ queryKey: ['bmcus'],    queryFn: () => getBmcus().then(r=>r.data) });
  const { data: routes    = [] } = useQuery({ queryKey: ['routes'],   queryFn: () => getRoutes().then(r=>r.data) });
  const { data: startPts  = [] } = useQuery({ queryKey: ['start-pts'],queryFn: () => getStartingPoints().then(r=>r.data) });
  const { data: testPts   = [] } = useQuery({ queryKey: ['test-pts'], queryFn: () => getTestingPoints().then(r=>r.data) });
  const { data: delivPts  = [] } = useQuery({ queryKey: ['deliv-pts'],queryFn: () => getDeliveryPoints().then(r=>r.data) });

  // Load existing plan for edit
  const { data: existing } = useQuery({
    queryKey: ['plan', id], enabled: isEdit,
    queryFn:  () => getPlan(id).then(r=>r.data)
  });

  useEffect(() => {
    if (existing) {
      setForm({
        plan_date: existing.plan_date?.slice(0,10) || today,
        plan_for_date: existing.plan_for_date?.slice(0,10) || today,
        trip_no: existing.trip_no || '',
        route_id: String(existing.route_id || ''),
        tanker_id: String(existing.tanker_id || ''),
        start_point_id: String(existing.start_point_id || ''),
        testing_point_id: String(existing.testing_point_id || ''),
        delivery_point_id: String(existing.delivery_point_id || ''),
        shifts_milk: existing.shifts_milk || '',
        expected_km: existing.expected_km || '',
        expected_total_qty: existing.expected_total_qty || '',
        driver_name: existing.driver_name || '',
        loader_name: existing.loader_name || '',
        remarks: existing.remarks || '',
        bmcus: (existing.bmcus || []).map(b => ({
          seq_no: b.seq_no, bmcu_id: b.bmcu_id, bmcu_code: b.bmcu_code,
          bmcu_name: b.bmcu_name, shift_code: b.shift_code || '', expected_qty: b.expected_qty || '',
          description: b.description || 'RMRD'
        }))
      });
    }
  }, [existing]);

  const selectedTanker = useMemo(
    () => tankers.find(t => t.id === parseInt(form.tanker_id)),
    [tankers, form.tanker_id]
  );

  const totalExpQty = useMemo(
    () => form.bmcus.reduce((s, b) => s + (parseFloat(b.expected_qty) || 0), 0),
    [form.bmcus]
  );

  const totalCost = useMemo(() => {
    if (!selectedTanker || !form.expected_km) return 0;
    return parseFloat(form.expected_km) * parseFloat(selectedTanker.per_km_rate);
  }, [selectedTanker, form.expected_km]);

  const perLitreCost = totalCost && totalExpQty ? totalCost / totalExpQty : 0;
  const utilPct = selectedTanker && totalExpQty ? (totalExpQty / selectedTanker.capacity_litres * 100) : 0;

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }));

  // When route is selected, auto-populate BMCUs
  const handleRouteChange = async (routeId) => {
    set('route_id', routeId);
    if (!routeId) return;
    const routeData = routes.find(r => r.id === parseInt(routeId));
    // Fetch full route with BMCUs
    try {
      const { data } = await import('../../api/index').then(m => m.getRoute(routeId));
      if (data.bmcus?.length) {
        setForm(p => ({
          ...p,
          route_id: routeId,
          start_point_id: data.start_point_id || p.start_point_id,
          delivery_point_id: data.delivery_point_id || p.delivery_point_id,
          testing_point_id: data.testing_point_id || p.testing_point_id,
          expected_km: data.distance_km || p.expected_km,
          bmcus: data.bmcus.map(b => ({
            seq_no: b.seq_no, bmcu_id: b.bmcu_id,
            bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name,
            shift_code: '', expected_qty: '', description: 'RMRD'
          }))
        }));
      }
    } catch { /* ignore */ }
  };

  const addBmcu = (bmcuId) => {
    const bm = bmcuList.find(b => b.id === parseInt(bmcuId));
    if (!bm) return;
    setForm(p => ({
      ...p,
      bmcus: [...p.bmcus, {
        seq_no: p.bmcus.length + 1, bmcu_id: bm.id,
        bmcu_code: bm.bmcu_code, bmcu_name: bm.bmcu_name,
        shift_code: '', expected_qty: '', description: 'RMRD'
      }]
    }));
  };

  const updateBmcu = (i, field, val) =>
    setForm(p => ({ ...p, bmcus: p.bmcus.map((b, idx) => idx===i ? {...b,[field]:val} : b) }));

  const removeBmcu = (i) =>
    setForm(p => ({ ...p, bmcus: p.bmcus.filter((_,idx) => idx!==i).map((b,idx) => ({...b,seq_no:idx+1})) }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.tanker_id || !form.delivery_point_id)
        throw new Error('Tanker and delivery point required');
      const payload = {
        ...form,
        expected_total_qty: totalExpQty || form.expected_total_qty,
        total_cost: totalCost,
        per_liter_cost: perLitreCost,
        expected_utilization_pct: utilPct,
        bmcus: form.bmcus.map(b => ({
          seq_no: b.seq_no, bmcu_id: b.bmcu_id,
          shift_code: b.shift_code || null, expected_qty: parseFloat(b.expected_qty) || 0,
          description: b.description || 'RMRD'
        }))
      };
      return isEdit ? updatePlan(id, payload) : createPlan(payload);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Plan updated' : 'Plan created');
      qc.invalidateQueries(['plans']);
      navigate('/planning');
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  return (
    <div className="w-full space-y-5">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/planning')} className="btn-secondary flex items-center gap-1.5">
          <ChevronLeft size={14}/> Back
        </button>
        <h2 className="page-title">{isEdit ? 'Edit Trip Plan' : 'New Trip Plan'}</h2>
      </div>

      <div className="card p-5 space-y-5">
        {/* Header fields */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className="label">Plan Date</label>
            <input type="date" className="input w-full" value={form.plan_date}
              onChange={e => set('plan_date', e.target.value)}/>
          </div>
          <div>
            <label className="label">Plan For Date *</label>
            <input type="date" className="input w-full" value={form.plan_for_date}
              onChange={e => set('plan_for_date', e.target.value)}/>
          </div>
          <div>
            <label className="label">Trip No</label>
            <input type="number" className="input w-full" value={form.trip_no}
              onChange={e => set('trip_no', e.target.value)}/>
          </div>
          <div>
            <label className="label">Shift (e.g. 06E07M)</label>
            <input className="input w-full" value={form.shifts_milk}
              onChange={e => set('shifts_milk', e.target.value)} placeholder="06E07M"/>
          </div>
        </div>

        {/* Tanker + Route */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Tanker *</label>
            <SearchableSelect
              value={form.tanker_id}
              onChange={v => set('tanker_id', v)}
              placeholder="Select tanker…"
              options={tankers.filter(t => !t.in_maintenance).map(t => ({
                value: String(t.id),
                label: `${t.tanker_number} — ${t.capacity_litres.toLocaleString()}L @ ₹${t.per_km_rate}/km`
              }))}
            />
          </div>
          <div>
            <label className="label">Route (optional)</label>
            <SearchableSelect
              value={form.route_id}
              onChange={v => handleRouteChange(v)}
              placeholder="Select route…"
              options={routes.map(r => ({ value: String(r.id), label: r.route_name }))}
            />
          </div>
        </div>

        {/* Locations */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">Starting Point</label>
            <SearchableSelect
              value={form.start_point_id}
              onChange={v => set('start_point_id', v)}
              placeholder="Select…"
              options={startPts.map(s => ({ value: String(s.id), label: s.name }))}
            />
          </div>
          <div>
            <label className="label">Testing Point</label>
            <SearchableSelect
              value={form.testing_point_id}
              onChange={v => set('testing_point_id', v)}
              placeholder="Select…"
              options={testPts.map(t => ({ value: String(t.id), label: t.name }))}
            />
          </div>
          <div>
            <label className="label">Delivery Point *</label>
            <SearchableSelect
              value={form.delivery_point_id}
              onChange={v => set('delivery_point_id', v)}
              placeholder="Select…"
              options={delivPts.map(d => ({ value: String(d.id), label: d.name }))}
            />
          </div>
        </div>

        {/* KM + Qty */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div>
            <label className="label">Expected KM</label>
            <input type="number" min="0" className="input w-full" value={form.expected_km}
              onChange={e => set('expected_km', e.target.value)}/>
          </div>
          <div>
            <label className="label">Expected Total Qty (L)</label>
            <input type="number" min="0" className="input w-full bg-gray-50"
              value={totalExpQty || form.expected_total_qty}
              readOnly={form.bmcus.length > 0}
              onChange={e => { if (!form.bmcus.length) set('expected_total_qty', e.target.value); }}
              placeholder="Auto from BMCUs"/>
          </div>
          <div>
            <label className="label">Driver Name</label>
            <input className="input w-full" value={form.driver_name}
              onChange={e => set('driver_name', e.target.value)}/>
          </div>
          <div>
            <label className="label">Loader Name</label>
            <input className="input w-full" value={form.loader_name}
              onChange={e => set('loader_name', e.target.value)}/>
          </div>
        </div>

        {/* Cost preview */}
        {totalCost > 0 && (
          <div className="bg-[#e6f3fb] border border-[#bddff5] rounded-lg p-3 flex flex-wrap gap-6 text-sm">
            <span>Total Cost: <strong className="text-[#003a6b]">₹{totalCost.toLocaleString('en-IN',{maximumFractionDigits:2})}</strong></span>
            <span>₹/Litre: <strong className="text-[#003a6b]">{perLitreCost.toFixed(4)}</strong></span>
            <span>Utilisation: <strong className={utilPct>=80?'text-green-600':utilPct>=60?'text-amber-600':'text-red-500'}>
              {utilPct.toFixed(1)}%
            </strong></span>
            {selectedTanker && <span className="text-gray-400 text-xs">@₹{selectedTanker.per_km_rate}/km × {form.expected_km} km</span>}
          </div>
        )}

        {/* Remarks */}
        <div>
          <label className="label">Remarks</label>
          <textarea className="input w-full" rows={2} value={form.remarks}
            onChange={e => set('remarks', e.target.value)}
            placeholder="Special instructions for executors…"/>
        </div>

        {/* BMCU sequence */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">BMCU Visit Sequence</label>
            <div className="flex items-center gap-2">
              {totalExpQty > 0 && (
                <span className="text-xs text-[#0078d4] font-medium">{totalExpQty.toLocaleString()} L total</span>
              )}
              <SearchableSelect
                value=""
                onChange={v => { if (v) addBmcu(v); }}
                placeholder="+ Add BMCU"
                className="w-56"
                options={bmcuList.map(b => ({ value: String(b.id), label: `${b.bmcu_code} — ${b.bmcu_name}` }))}
              />
            </div>
          </div>
          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="table-th w-10">Seq</th>
                  <th className="table-th">Code</th>
                  <th className="table-th">BMCU Name</th>
                  <th className="table-th w-28">Shift Code</th>
                  <th className="table-th w-32">Exp Qty (L)</th>
                  <th className="table-th w-36">Description</th>
                  <th className="table-th w-10"></th>
                </tr>
              </thead>
              <tbody>
                {form.bmcus.length === 0 ? (
                  <tr><td colSpan={7} className="table-td text-center text-gray-400 py-6">
                    Select a route or add BMCUs manually
                  </td></tr>
                ) : form.bmcus.map((b, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="table-td text-center font-bold text-[#0078d4]">{b.seq_no}</td>
                    <td className="table-td font-mono text-xs">{b.bmcu_code}</td>
                    <td className="table-td">{b.bmcu_name}</td>
                    <td className="table-td">
                      <input className="input py-1 text-xs" value={b.shift_code}
                        onChange={e => updateBmcu(i, 'shift_code', e.target.value)} placeholder="06E07M"/>
                    </td>
                    <td className="table-td">
                      <input type="number" min="0" className="input py-1 text-xs" value={b.expected_qty}
                        onChange={e => updateBmcu(i, 'expected_qty', e.target.value)}/>
                    </td>
                    <td className="table-td">
                      <select className="input py-1 text-xs" value={b.description || 'RMRD'}
                        onChange={e => updateBmcu(i, 'description', e.target.value)}>
                        <option value="RMRD">RMRD</option>
                        <option value="Balance Milk">Balance Milk</option>
                        <option value="Internal Shifting">Internal Shifting</option>
                      </select>
                    </td>
                    <td className="table-td">
                      <button onClick={() => removeBmcu(i)} className="btn-danger btn-sm p-1">
                        <Trash2 size={11}/>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-2 border-t">
          <button onClick={() => navigate('/planning')} className="btn-secondary">Cancel</button>
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="btn-primary">
            {saveMut.isPending ? 'Saving…' : isEdit ? 'Update Plan' : 'Create Plan'}
          </button>
        </div>
      </div>
    </div>
  );
}
