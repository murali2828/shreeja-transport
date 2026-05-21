// frontend/src/pages/planning/RouteOptimizer.jsx
// Route Optimizer Wizard — uses Distance Master for accurate KM
// Algorithm: Clarke-Wright Savings with manual distance matrix

import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap, ChevronRight, ChevronLeft, Check, X, AlertTriangle,
  Truck, BarChart3, RefreshCw, Save, TrendingDown,
  Info, Eye, Route, DollarSign, Layers, MapPin
} from 'lucide-react';
import toast from 'react-hot-toast';
import axios from 'axios';

const api = {
  getBmcus:          () => axios.get('/api/bmcus'),
  getTankers:        () => axios.get('/api/tankers'),
  getDeliveryPoints: () => axios.get('/api/masters/delivery-points'),
  getStartPoints:    () => axios.get('/api/masters/starting-points'),
  getDistSummary:    () => axios.get('/api/distances/summary'),
  runOptimizer:      (p) => axios.post('/api/optimize/run', p),
  saveAsPlans:       (sid, trips) => axios.post(`/api/optimize/${sid}/save-as-plans`, { trips }),
};

// ─── UI helpers ───────────────────────────────────────────────────────────────
function StepDot({ num, label, active, done }) {
  return (
    <div className={`flex items-center gap-2 ${active ? 'text-[#0078d4]' : done ? 'text-green-600' : 'text-gray-400'}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2
        ${active ? 'border-[#0078d4] bg-[#e6f3fb] text-[#005ba3]'
          : done  ? 'border-green-500 bg-green-50 text-green-700'
          : 'border-gray-300 bg-white text-gray-400'}`}>
        {done ? <Check size={13}/> : num}
      </div>
      <span className="text-sm font-medium hidden sm:block">{label}</span>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }) {
  const colors = {
    blue:   'bg-blue-50 text-blue-700 border-blue-200',
    green:  'bg-green-50 text-green-700 border-green-200',
    amber:  'bg-amber-50 text-amber-700 border-amber-200',
    purple: 'bg-purple-50 text-purple-700 border-purple-200',
    red:    'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${colors[color]}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-70 mb-1">
        {Icon && <Icon size={11}/>} {label}
      </div>
      <div className="text-xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-60 mt-0.5">{sub}</div>}
    </div>
  );
}

function UtilBar({ pct }) {
  const color = pct >= 90 ? 'bg-green-500' : pct >= 70 ? 'bg-blue-500' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }}/>
      </div>
      <span className={`text-xs font-semibold w-10 text-right
        ${pct >= 90 ? 'text-green-600' : pct >= 70 ? 'text-blue-600' : pct >= 50 ? 'text-amber-600' : 'text-red-500'}`}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

// =============================================================================
export default function RouteOptimizer() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [step, setStep] = useState(1);
  const [config, setConfig] = useState({
    plan_for_date: new Date().toISOString().slice(0, 10),
    delivery_point_id: '',
    start_point_id: '',
    shifts_milk: 'AM',
    strategy: 'distance_savings',
  });

  const [bmcuSel, setBmcuSel] = useState({}); // { [bmcu_id]: { selected, qty, shift_code } }
  const [search, setSearch]   = useState('');
  const [stateFilter, setStateFilter]     = useState('');
  const [districtFilter, setDistrictFilter] = useState('');

  const [result, setResult]     = useState(null);
  const [overrides, setOverrides] = useState({}); // { [opt_trip_id]: { accepted, tanker_id, expected_km, driver_name, loader_name, remarks } }

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: bmcus = [], isLoading: loadingBmcus } =
    useQuery({ queryKey: ['bmcus'], queryFn: () => api.getBmcus().then(r => r.data) });
  const { data: tankers = [] } =
    useQuery({ queryKey: ['tankers'], queryFn: () => api.getTankers().then(r => r.data) });
  const { data: delivPts = [] } =
    useQuery({ queryKey: ['delivery-points'], queryFn: () => api.getDeliveryPoints().then(r => r.data) });
  const { data: startPts = [] } =
    useQuery({ queryKey: ['starting-points'], queryFn: () => api.getStartPoints().then(r => r.data) });
  const { data: distSummary } =
    useQuery({ queryKey: ['distance-summary'], queryFn: () => api.getDistSummary().then(r => r.data) });

  const activeTankers = tankers.filter(t => t.is_active);

  const states    = useMemo(() => [...new Set(bmcus.map(b => b.state).filter(Boolean))].sort(), [bmcus]);
  const districts = useMemo(() => {
    const src = stateFilter ? bmcus.filter(b => b.state === stateFilter) : bmcus;
    return [...new Set(src.map(b => b.district).filter(Boolean))].sort();
  }, [bmcus, stateFilter]);

  const filteredBmcus = useMemo(() => {
    const q = search.toLowerCase();
    return bmcus.filter(b => {
      if (!b.is_active) return false;
      if (stateFilter    && b.state    !== stateFilter)    return false;
      if (districtFilter && b.district !== districtFilter) return false;
      if (q && !b.bmcu_code?.toLowerCase().includes(q) &&
               !b.bmcu_name?.toLowerCase().includes(q) &&
               !b.district?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [bmcus, search, stateFilter, districtFilter]);

  const selectedList = useMemo(() =>
    Object.entries(bmcuSel).filter(([, v]) => v.selected), [bmcuSel]);
  const totalQty = useMemo(() =>
    selectedList.reduce((s, [, v]) => s + (parseFloat(v.qty) || 0), 0), [selectedList]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const optimizeMut = useMutation({
    mutationFn: () => api.runOptimizer({
      ...config,
      bmcus: selectedList.map(([bmcu_id, v]) => ({
        bmcu_id: parseInt(bmcu_id),
        expected_qty_litres: parseFloat(v.qty) || 0,
        shift_code: v.shift_code || config.shifts_milk,
      }))
    }),
    onSuccess: (res) => {
      setResult(res.data);
      const init = {};
      res.data.trips.forEach(t => {
        init[t.opt_trip_id] = {
          accepted: true, tanker_id: t.tanker.id,
          expected_km: t.estimated_km,
          driver_name: '', loader_name: '', remarks: ''
        };
      });
      setOverrides(init);
      setStep(3);
      if (res.data.warning) toast(res.data.warning, { icon: '⚠️', duration: 6000 });
      else toast.success(`${res.data.trips.length} optimized trips generated`);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Optimization failed'),
  });

  const saveMut = useMutation({
    mutationFn: () => api.saveAsPlans(
      result.session_id,
      result.trips.map(t => ({ opt_trip_id: t.opt_trip_id, ...(overrides[t.opt_trip_id] || { accepted: true }) }))
    ),
    onSuccess: (res) => {
      toast.success(res.data.message);
      qc.invalidateQueries(['plans']);
      setStep(4);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed'),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const toggleBmcu = (id) => setBmcuSel(prev => ({
    ...prev,
    [id]: { ...(prev[id] || {}), selected: !prev[id]?.selected, shift_code: prev[id]?.shift_code || config.shifts_milk }
  }));
  const setBmcuQty = (id, qty) => setBmcuSel(prev => ({ ...prev, [id]: { ...prev[id], qty } }));
  const selectAll = () => {
    const u = {};
    filteredBmcus.forEach(b => { u[b.id] = { selected: true, qty: bmcuSel[b.id]?.qty || '', shift_code: bmcuSel[b.id]?.shift_code || config.shifts_milk }; });
    setBmcuSel(prev => ({ ...prev, ...u }));
  };
  const clearAll = () => {
    const u = {};
    filteredBmcus.forEach(b => { u[b.id] = { ...(bmcuSel[b.id] || {}), selected: false }; });
    setBmcuSel(prev => ({ ...prev, ...u }));
  };
  const setOv = (id, field, value) =>
    setOverrides(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));
  const acceptedCount = result
    ? result.trips.filter(t => overrides[t.opt_trip_id]?.accepted !== false).length : 0;

  // ─── STEP 1: Configure ────────────────────────────────────────────────────
  const renderStep1 = () => {
    const strategies = [
      {
        key: 'distance_savings',
        label: 'Distance Savings (Best)',
        badge: 'Min Total KM',
        desc: 'Clarke-Wright algorithm using your real road distances. Groups BMCUs to minimise total kilometres driven.',
        requires: 'Distances in Distance Master',
        recommended: true,
      },
      {
        key: 'district',
        label: 'District + Savings',
        badge: 'Cluster by Area',
        desc: 'Groups BMCUs by district first, then applies savings within each group. Useful when tankers serve specific regions.',
        requires: 'District info in BMCU Master + distances',
        recommended: false,
      },
      {
        key: 'best_fit',
        label: 'Capacity Fit',
        badge: 'Max Utilisation',
        desc: 'Bin-packing algorithm. Fills each tanker as full as possible before opening a new one. Good when distances are uniform.',
        requires: 'Nothing extra needed',
        recommended: false,
      },
      {
        key: 'cheapest',
        label: 'Lowest Rate Tanker',
        badge: 'Min ₹/km',
        desc: 'Assigns lowest per-km rate tanker to each route. Best when tanker rates vary significantly.',
        requires: 'Per-km rates in Tanker Master',
        recommended: false,
      },
    ];

    return (
      <div className="space-y-6">
        {/* Distance coverage info */}
        {distSummary && (
          <div className={`rounded-xl border p-4 flex gap-3 text-sm
            ${distSummary.coverage_pct >= 80 ? 'bg-green-50 border-green-200' :
              distSummary.coverage_pct >= 30 ? 'bg-amber-50 border-amber-200' :
              'bg-red-50 border-red-200'}`}>
            <div className="shrink-0 mt-0.5">
              {distSummary.coverage_pct >= 80 ? <CheckCircle size={16} className="text-green-500"/> :
               distSummary.coverage_pct >= 30 ? <AlertTriangle size={16} className="text-amber-500"/> :
               <AlertTriangle size={16} className="text-red-500"/>}
            </div>
            <div>
              <div className="font-medium">
                Distance Master: <span className={
                  distSummary.coverage_pct >= 80 ? 'text-green-700' :
                  distSummary.coverage_pct >= 30 ? 'text-amber-700' : 'text-red-700'
                }>{distSummary.coverage_pct}% coverage</span>
                {' '}({distSummary.entered_bmcu_pairs} of {distSummary.max_bmcu_pairs} BMCU pairs entered)
              </div>
              {distSummary.coverage_pct < 100 && (
                <div className="text-xs text-gray-600 mt-0.5">
                  Missing pairs use district-based estimates (20 km same-district / 50 km different).
                  {' '}<button onClick={() => navigate('/masters/distances')}
                    className="underline text-[#0078d4] hover:text-[#003a6b]">
                    Add more distances →
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="label">Plan For Date *</label>
            <input type="date" className="input w-full" value={config.plan_for_date}
              onChange={e => setConfig(p => ({ ...p, plan_for_date: e.target.value }))}/>
          </div>
          <div>
            <label className="label">Shift</label>
            <select className="input w-full" value={config.shifts_milk}
              onChange={e => setConfig(p => ({ ...p, shifts_milk: e.target.value }))}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
              <option value="AM+PM">AM + PM</option>
            </select>
          </div>
          <div>
            <label className="label">Delivery Point (Plant) *</label>
            <select className="input w-full" value={config.delivery_point_id}
              onChange={e => setConfig(p => ({ ...p, delivery_point_id: e.target.value }))}>
              <option value="">Select…</option>
              {delivPts.filter(d => d.is_active).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Starting Point (Depot) *</label>
            <select className="input w-full" value={config.start_point_id}
              onChange={e => setConfig(p => ({ ...p, start_point_id: e.target.value }))}>
              <option value="">Select…</option>
              {startPts.filter(s => s.is_active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        {/* Strategy */}
        <div>
          <label className="label mb-3">Optimization Strategy</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {strategies.map(opt => {
              const active = config.strategy === opt.key;
              return (
                <label key={opt.key}
                  className={`border-2 rounded-xl p-4 cursor-pointer transition-all
                    ${active ? 'border-[#0078d4] bg-[#e6f3fb]' : 'border-gray-200 hover:border-gray-300 bg-white'}`}>
                  <input type="radio" className="sr-only" checked={active}
                    onChange={() => setConfig(p => ({ ...p, strategy: opt.key }))}/>
                  <div className="flex items-center gap-2 mb-1.5">
                    <div className={`w-3 h-3 rounded-full border-2 shrink-0
                      ${active ? 'border-[#0078d4] bg-[#0078d4]' : 'border-gray-400'}`}/>
                    <span className="text-sm font-semibold">{opt.label}</span>
                    {opt.recommended && (
                      <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-medium ml-auto">
                        Recommended
                      </span>
                    )}
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded font-medium
                    ${active ? 'bg-[#e6f3fb] text-[#005ba3]' : 'bg-gray-100 text-gray-500'}`}>
                    {opt.badge}
                  </span>
                  <p className="text-xs text-gray-500 mt-2">{opt.desc}</p>
                  <p className="text-xs text-gray-400 mt-1">Requires: {opt.requires}</p>
                </label>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <button className="btn-primary flex items-center gap-2"
            onClick={() => {
              if (!config.plan_for_date || !config.delivery_point_id || !config.start_point_id) {
                toast.error('Fill all required fields'); return;
              }
              setStep(2);
            }}>
            Next: Select BMCUs <ChevronRight size={16}/>
          </button>
        </div>
      </div>
    );
  };

  // ─── STEP 2: BMCU Selection ───────────────────────────────────────────────
  const renderStep2 = () => (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <input className="input w-52 text-sm py-1.5" placeholder="Search code, name, district…"
          value={search} onChange={e => setSearch(e.target.value)}/>
        <select className="input w-32 text-sm py-1.5" value={stateFilter}
          onChange={e => { setStateFilter(e.target.value); setDistrictFilter(''); }}>
          <option value="">All States</option>
          {states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="input w-36 text-sm py-1.5" value={districtFilter}
          onChange={e => setDistrictFilter(e.target.value)}>
          <option value="">All Districts</option>
          {districts.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <button onClick={selectAll} className="btn-secondary text-xs py-1.5">✓ All Visible</button>
        <button onClick={clearAll}  className="btn-secondary text-xs py-1.5">✗ Clear</button>
        <div className="ml-auto text-sm font-medium text-[#005ba3]">
          {selectedList.length} selected · {totalQty.toLocaleString()} L
        </div>
      </div>

      <div className="border rounded-xl overflow-hidden">
        <div className="max-h-[52vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b z-10">
              <tr>
                <th className="table-th w-8">✓</th>
                <th className="table-th">Code</th>
                <th className="table-th">BMCU Name</th>
                <th className="table-th">District</th>
                <th className="table-th">State</th>
                <th className="table-th w-36">Exp. Qty (L) *</th>
              </tr>
            </thead>
            <tbody>
              {loadingBmcus && (
                <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              )}
              {filteredBmcus.map(b => {
                const sel = bmcuSel[b.id] || {};
                return (
                  <tr key={b.id}
                    className={`cursor-pointer hover:bg-gray-50 ${sel.selected ? 'bg-blue-50' : ''}`}
                    onClick={() => toggleBmcu(b.id)}>
                    <td className="table-td">
                      <input type="checkbox" checked={!!sel.selected} readOnly
                        className="w-4 h-4 accent-[#0078d4] pointer-events-none"/>
                    </td>
                    <td className="table-td font-mono font-semibold text-[#005ba3]">{b.bmcu_code}</td>
                    <td className="table-td">{b.bmcu_name}</td>
                    <td className="table-td text-gray-500">{b.district || '—'}</td>
                    <td className="table-td text-gray-500">{b.state || '—'}</td>
                    <td className="table-td" onClick={e => e.stopPropagation()}>
                      {sel.selected && (
                        <input type="number" min="0" step="100" placeholder="Enter qty"
                          className={`input py-1 px-2 text-sm w-full ${sel.selected && (!sel.qty || parseFloat(sel.qty) <= 0) ? 'border-red-300' : ''}`}
                          value={sel.qty || ''}
                          onChange={e => setBmcuQty(b.id, e.target.value)}/>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loadingBmcus && filteredBmcus.length === 0 && (
                <tr><td colSpan={6} className="table-td text-center py-10 text-gray-400">No BMCUs found</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selectedList.length > 0 && (
        <div className="bg-[#e6f3fb] border border-[#bddff5] rounded-lg px-4 py-2 text-sm flex flex-wrap gap-4">
          <span><strong>{selectedList.length}</strong> BMCUs</span>
          <span><strong>{totalQty.toLocaleString()}</strong> L total</span>
          {selectedList.filter(([,v]) => !v.qty || parseFloat(v.qty)<=0).length > 0
            ? <span className="text-red-500 font-medium">⚠ {selectedList.filter(([,v])=>!v.qty||parseFloat(v.qty)<=0).length} missing qty</span>
            : <span className="text-green-600">✓ All quantities entered</span>}
        </div>
      )}

      <div className="flex justify-between pt-1">
        <button onClick={() => setStep(1)} className="btn-secondary flex items-center gap-2">
          <ChevronLeft size={16}/> Back
        </button>
        <button className="btn-primary flex items-center gap-2"
          disabled={optimizeMut.isPending}
          onClick={() => {
            if (!selectedList.length) { toast.error('Select at least one BMCU'); return; }
            const missing = selectedList.filter(([,v]) => !v.qty || parseFloat(v.qty) <= 0);
            if (missing.length) { toast.error(`Enter quantity for ${missing.length} BMCU(s)`); return; }
            optimizeMut.mutate();
          }}>
          {optimizeMut.isPending
            ? <><RefreshCw size={14} className="animate-spin"/> Optimizing…</>
            : <><Zap size={14}/> Run Optimizer ({selectedList.length} BMCUs)</>}
        </button>
      </div>
    </div>
  );

  // ─── STEP 3: Results ──────────────────────────────────────────────────────
  const renderStep3 = () => {
    if (!result) return null;
    const { summary, trips, has_estimated_legs, km_coverage_pct } = result;

    return (
      <div className="space-y-5">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard icon={Truck}        label="Trips"           value={summary.trip_count}                              color="blue"/>
          <StatCard icon={Layers}       label="Total Milk"      value={`${summary.total_qty_litres?.toLocaleString()} L`} color="purple"/>
          <StatCard icon={Route}        label="Total KM"        value={`${summary.total_km?.toLocaleString()} km`}      color="amber"
                    sub={`${km_coverage_pct}% from real distances`}/>
          <StatCard icon={TrendingDown} label="Est. Total Cost" value={`₹${summary.total_cost?.toLocaleString()}`}      color="green"/>
          <StatCard icon={BarChart3}    label="Avg Utilisation" value={`${summary.avg_utilization}%`}
                    color={summary.avg_utilization >= 80 ? 'green' : 'amber'}/>
        </div>

        {has_estimated_legs && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-2 text-sm text-amber-800">
            <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-500"/>
            <span>
              <strong>Some KM values are estimated</strong> (marked ⚠) because those BMCU pairs aren't in
              Distance Master. <button onClick={() => navigate('/masters/distances')}
                className="underline font-medium">Add missing distances</button> for precise planning.
            </span>
          </div>
        )}

        <div className="text-xs bg-gray-50 border rounded-lg px-3 py-2 text-gray-500">
          ⚡ <strong>
            {config.strategy === 'distance_savings' ? 'Clarke-Wright Savings' :
             config.strategy === 'district' ? 'District + Savings' :
             config.strategy === 'cheapest' ? 'Lowest Rate' : 'Best Fit'}
          </strong>
          {' '}algorithm · {km_coverage_pct}% of distances from Distance Master ·
          Missing pairs use district-based fallbacks · Review and save accepted trips as draft plans
        </div>

        {/* Trip cards */}
        <div className="space-y-3">
          {trips.map(trip => {
            const ov = overrides[trip.opt_trip_id] || {};
            const accepted = ov.accepted !== false;
            const tid = ov.tanker_id || trip.tanker?.id;
            const selTanker = activeTankers.find(t => t.id === parseInt(tid)) || trip.tanker;
            const km   = parseFloat(ov.expected_km || trip.estimated_km);
            const cost = km * parseFloat(selTanker?.per_km_rate || 0);
            const perL = trip.total_qty_litres > 0 ? cost / trip.total_qty_litres : 0;
            const util = selTanker?.capacity_litres > 0
              ? (trip.total_qty_litres / selTanker.capacity_litres) * 100 : 0;

            return (
              <div key={trip.opt_trip_id}
                className={`border-2 rounded-xl transition-all
                  ${accepted ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>

                {/* Header */}
                <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center font-bold text-sm shrink-0
                    ${accepted ? 'bg-[#0078d4] text-white' : 'bg-gray-300 text-gray-600'}`}>
                    {trip.trip_seq}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-sm mb-1">
                      <span className="font-semibold">{trip.bmcus?.length} stops</span>
                      <span className="text-gray-400">·</span>
                      <span>{trip.total_qty_litres?.toLocaleString()} L</span>
                      <span className="text-gray-400">·</span>
                      <span className="font-medium">{km} km</span>
                      {trip.km_is_estimated && <span className="text-amber-500 text-xs font-bold" title="Some KM estimated">⚠ est.</span>}
                      <span className="text-gray-400">·</span>
                      <span className="font-medium text-green-700">₹{Math.round(cost).toLocaleString()}</span>
                      <span className="text-gray-400">·</span>
                      <span className="text-xs text-gray-500">{selTanker?.tanker_number}</span>
                    </div>
                    <UtilBar pct={util}/>
                  </div>
                  <button
                    onClick={() => setOv(trip.opt_trip_id, 'accepted', !accepted)}
                    className={`btn-sm shrink-0 flex items-center gap-1 text-xs
                      ${accepted ? 'btn-secondary text-red-600 hover:bg-red-50' : 'btn-primary'}`}>
                    {accepted ? <><X size={11}/> Reject</> : <><Check size={11}/> Accept</>}
                  </button>
                </div>

                {accepted && (
                  <div className="px-4 pb-4 pt-3 space-y-3">
                    {/* Override controls */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <div className="sm:col-span-2">
                        <label className="text-xs text-gray-500 mb-1 block">Tanker</label>
                        <select className="input py-1.5 text-sm w-full"
                          value={tid}
                          onChange={e => setOv(trip.opt_trip_id, 'tanker_id', parseInt(e.target.value))}>
                          {activeTankers.map(t =>
                            <option key={t.id} value={t.id}>
                              {t.tanker_number} — {t.capacity_litres.toLocaleString()}L @ ₹{t.per_km_rate}/km
                            </option>
                          )}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Expected KM</label>
                        <input type="number" min="0" className="input py-1.5 text-sm w-full"
                          value={ov.expected_km || trip.estimated_km}
                          onChange={e => setOv(trip.opt_trip_id, 'expected_km', parseFloat(e.target.value))}/>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Driver</label>
                        <input className="input py-1.5 text-sm w-full" placeholder="Optional"
                          value={ov.driver_name || ''}
                          onChange={e => setOv(trip.opt_trip_id, 'driver_name', e.target.value)}/>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500 mb-1 block">Loader</label>
                        <input className="input py-1.5 text-sm w-full" placeholder="Optional"
                          value={ov.loader_name || ''}
                          onChange={e => setOv(trip.opt_trip_id, 'loader_name', e.target.value)}/>
                      </div>
                    </div>

                    {/* Live cost strip */}
                    <div className="flex flex-wrap gap-4 text-xs bg-gray-50 border rounded-lg px-3 py-1.5 text-gray-600">
                      <span>Cost: <strong className="text-gray-800">₹{Math.round(cost).toLocaleString()}</strong></span>
                      <span>₹/Litre: <strong className="text-gray-800">{perL.toFixed(4)}</strong></span>
                      <span>Utilisation: <strong className={util>=80?'text-green-600':'text-amber-600'}>{Math.round(util)}%</strong></span>
                      <span>KM: <strong className="text-gray-800">{km}</strong>{trip.km_is_estimated ? ' ⚠ (partial est.)' : ' ✓ (real dist.)'}</span>
                    </div>

                    {/* BMCU sequence table */}
                    <div className="rounded-lg border overflow-hidden">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="table-th py-1.5 w-8">#</th>
                            <th className="table-th py-1.5">Code</th>
                            <th className="table-th py-1.5">BMCU Name</th>
                            <th className="table-th py-1.5">District</th>
                            <th className="table-th py-1.5 text-right">Qty (L)</th>
                            <th className="table-th py-1.5 text-right">Leg KM</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trip.bmcus?.map(bm => (
                            <tr key={bm.bmcu_id} className="hover:bg-gray-50">
                              <td className="table-td py-1.5 font-bold text-[#0078d4]">{bm.seq_no}</td>
                              <td className="table-td py-1.5 font-mono">{bm.bmcu_code}</td>
                              <td className="table-td py-1.5">{bm.bmcu_name}</td>
                              <td className="table-td py-1.5 text-gray-400">{bm.district||'—'}</td>
                              <td className="table-td py-1.5 text-right font-medium">{bm.expected_qty_litres?.toLocaleString()}</td>
                              <td className={`table-td py-1.5 text-right ${bm.leg_is_estimated ? 'text-amber-500' : 'text-gray-700'}`}>
                                {bm.leg_km ? `${bm.leg_km}` : '—'}
                                {bm.leg_is_estimated && ' ⚠'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot className="bg-gray-50 font-semibold">
                          <tr>
                            <td colSpan={4} className="table-td py-1.5 text-right text-gray-500">Total</td>
                            <td className="table-td py-1.5 text-right text-[#005ba3]">{trip.total_qty_litres?.toLocaleString()} L</td>
                            <td className="table-td py-1.5 text-right text-gray-700">{trip.estimated_km} km</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between pt-2 border-t">
          <button onClick={() => setStep(2)} className="btn-secondary flex items-center gap-2">
            <ChevronLeft size={16}/> Back
          </button>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{acceptedCount} / {trips.length} trips accepted</span>
            <button onClick={() => saveMut.mutate()}
              disabled={acceptedCount === 0 || saveMut.isPending}
              className="btn-primary flex items-center gap-2">
              {saveMut.isPending
                ? <><RefreshCw size={14} className="animate-spin"/> Saving…</>
                : <><Save size={14}/> Save {acceptedCount} Trip{acceptedCount!==1?'s':''} as Draft Plans</>}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ─── STEP 4: Done ─────────────────────────────────────────────────────────
  const renderStep4 = () => (
    <div className="flex flex-col items-center py-14 gap-5 text-center">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
        <Check size={32} className="text-green-600"/>
      </div>
      <div>
        <h3 className="text-lg font-semibold">Plans Created!</h3>
        <p className="text-sm text-gray-500 mt-1 max-w-md">
          Optimized trips saved as <strong>Draft</strong> plans. Review in Trip Planning, edit if needed, then publish for executors.
        </p>
      </div>
      <div className="flex gap-3">
        <button onClick={() => navigate('/planning')} className="btn-primary flex items-center gap-2">
          <Eye size={14}/> Go to Trip Plans
        </button>
        <button onClick={() => { setStep(1); setResult(null); setOverrides({}); setBmcuSel({}); }}
          className="btn-secondary">New Optimization</button>
      </div>
    </div>
  );

  // ─── Layout ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <Zap size={20} className="text-[#0078d4]"/> Route Optimizer
          </h2>
          <p className="text-sm text-gray-500">
            Distance-matrix based trip planning · Uses real road KM from Distance Master
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate('/masters/distances')}
            className="btn-secondary text-sm flex items-center gap-1.5">
            <Route size={13}/> Distance Master
          </button>
          <button onClick={() => navigate('/planning')}
            className="btn-secondary text-sm flex items-center gap-1.5">
            <ChevronLeft size={13}/> Plans
          </button>
        </div>
      </div>

      {step < 4 && (
        <div className="card px-5 py-3">
          <div className="flex items-center gap-3">
            <StepDot num={1} label="Configure"    active={step===1} done={step>1}/>
            <div className="flex-1 h-px bg-gray-200"/>
            <StepDot num={2} label="Select BMCUs" active={step===2} done={step>2}/>
            <div className="flex-1 h-px bg-gray-200"/>
            <StepDot num={3} label="Review Trips" active={step===3} done={step>3}/>
          </div>
        </div>
      )}

      <div className="card p-5">
        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
        {step === 4 && renderStep4()}
      </div>
    </div>
  );
}
