// frontend/src/pages/planning/DayOptimizer.jsx
// Day Optimizer (fleet v2) — plans one date for ALL BMCUs across ALL plants
// with the whole available fleet, minimising Σ km × tanker rate.
// Steps: 1 Inputs (date, shift, constraints, demand, fleet) → 2 Results
// (trips by plant, totals, comparison, warnings) → 3 Adopt (draft plans).
// Visible only when the login response carries optimizer_v2_enabled=true.
import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap, Check, AlertTriangle, Truck, Save, RefreshCw, Route, IndianRupee,
  Layers, MapPin, ChevronLeft, Info, Download, Factory,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getDayOptimizerPreview, runDayOptimizer, prefetchOptimizerDistances, saveOptimizerAsPlans, downloadDayOptimizerReport,
} from '../../api/index';
import { fmtDate } from '../../utils/date';

const nf  = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const inr = (v, d = 0) => v == null ? '—' : '₹' + nf(v, d);

const CONSTRAINT_FIELDS = [
  { key: 'fill_floor',                   label: 'Fill floor (%)',            step: 1,   toUi: v => Math.round(v * 100), fromUi: v => Number(v) / 100 },
  { key: 'max_bmcus_per_trip',           label: 'Max BMCUs per trip',        step: 1 },
  { key: 'max_trip_km',                  label: 'Max km per trip',           step: 10 },
  { key: 'max_trips_per_tanker_per_day', label: 'Max trips per tanker/day',  step: 1 },
  { key: 'time_budget_ms',               label: 'Search time (ms)',          step: 1000 },
  { key: 'restarts',                     label: 'Random restarts',           step: 1 },
  { key: 'seed',                         label: 'Seed',                      step: 1 },
];

function StepDot({ num, label, active, done }) {
  return (
    <div className={`flex items-center gap-2 ${active ? 'text-[#0078d4]' : done ? 'text-green-600' : 'text-gray-400'}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border-2
        ${active ? 'border-[#0078d4] bg-[#e6f3fb] text-[#005ba3]' : done ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-400'}`}>
        {done ? <Check size={13}/> : num}
      </div>
      <span className="text-sm font-medium hidden sm:block">{label}</span>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, sub, color = 'blue' }) {
  const colors = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200', green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200', purple: 'bg-purple-50 text-purple-700 border-purple-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${colors[color]}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium opacity-70 mb-1">{Icon && <Icon size={11}/>} {label}</div>
      <div className="text-xl font-bold">{value}</div>
      {sub && <div className="text-xs opacity-60 mt-0.5">{sub}</div>}
    </div>
  );
}

function FillBar({ pct }) {
  const color = pct >= 90 ? 'bg-green-500' : pct >= 70 ? 'bg-blue-500' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400';
  return (
    <div className="flex items-center gap-2 min-w-[90px]">
      <div className="flex-1 bg-gray-100 rounded-full h-2"><div className={`h-2 rounded-full ${color}`} style={{ width: `${Math.min(pct, 100)}%` }}/></div>
      <span className="text-xs font-semibold w-10 text-right">{Math.round(pct)}%</span>
    </div>
  );
}

// Delta cell: green when the optimiser is lower (cheaper / fewer), red when higher.
function Delta({ value, unit = '', lowerIsBetter = true, digits = 0 }) {
  if (value == null) return <span className="text-gray-400">—</span>;
  const good = lowerIsBetter ? value <= 0 : value >= 0;
  const cls = value === 0 ? 'text-gray-500' : good ? 'text-green-700 bg-green-50' : 'text-red-700 bg-red-50';
  return <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${cls}`}>{value > 0 ? '+' : ''}{nf(value, digits)}{unit}</span>;
}

// Forecast vs actual RMRD of an executed date: totals line coloured by error
// band (green ≤5 %, amber ≤10 %, red beyond) and a collapsible per-BMCU table.
function ForecastAccuracyPanel({ fa }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  if (!fa) return null;
  const ap = Math.abs(fa.error_pct ?? 0);
  const band = fa.error_pct == null ? 'text-gray-600 bg-gray-50 border-gray-200'
    : ap <= 5 ? 'text-green-700 bg-green-50 border-green-200' : ap <= 10 ? 'text-amber-700 bg-amber-50 border-amber-200' : 'text-red-700 bg-red-50 border-red-200';
  const sign = v => (v > 0 ? '+' : '') + nf(v);
  const ql = q.toLowerCase();
  const rows = ql ? fa.per_bmcu.filter(b => b.bmcu_code?.toLowerCase().includes(ql) || b.bmcu_name?.toLowerCase().includes(ql) || b.plant_name?.toLowerCase().includes(ql)) : fa.per_bmcu;
  return (
    <div className="card p-4">
      <div className="text-sm font-semibold mb-1 flex items-center gap-2"><Info size={14}/> Forecast vs actual RMRD — {fmtDate(fa.date)}{fa.shift !== 'BOTH' && ` (${fa.shift})`}</div>
      <div className={`inline-block rounded-lg border px-3 py-1.5 text-sm font-medium ${band}`}>
        Forecast {nf(fa.forecast_litres)} L · Actual RMRD vendor {nf(fa.actual_rmrd_vendor)} L · sale {nf(fa.actual_rmrd_sale)} L · all {nf(fa.actual_rmrd_all)} L
        · error {sign(fa.error_litres)} L{fa.error_pct != null && ` (${fa.error_pct > 0 ? '+' : ''}${nf(fa.error_pct, 1)} %)`}
      </div>
      <div className="text-xs text-gray-500 mt-2">
        {fa.basis_label}. Error = (forecast − {fa.basis} RMRD) / {fa.basis} RMRD; green within ±5 %, amber within ±10 %.
        {' '}{nf(fa.bmcus_forecast)} BMCUs forecast, {nf(fa.bmcus_lifted)} lifted · {nf(fa.bmcus_forecast_not_lifted)} forecast but not lifted · {nf(fa.bmcus_lifted_not_forecast)} lifted but not forecast.
      </div>
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <button className="btn-secondary btn-sm" onClick={() => setOpen(o => !o)}>{open ? 'Hide BMCUs' : `Show ${nf(fa.per_bmcu.length)} BMCUs`}</button>
        {open && <input className="input py-1 text-xs w-52" placeholder="Search BMCU / plant…" value={q} onChange={e => setQ(e.target.value)}/>}
        {open && <span className="text-xs text-gray-400">BMCUs forecast but not lifted and lifted but not forecast are listed first, then by largest difference.</span>}
      </div>
      {open && (
        <div className="overflow-auto max-h-[420px] mt-2">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b"><tr>
              <th className="table-th">BMCU</th><th className="table-th">Plant</th><th className="table-th text-right">Forecast L</th>
              <th className="table-th text-right">Actual RMRD L</th><th className="table-th text-right">Diff L</th><th className="table-th">Lifted by</th></tr></thead>
            <tbody>
              {rows.map(b => (
                <tr key={b.bmcu_id} className={`border-b border-gray-50 ${b.flag ? 'bg-amber-50/40' : ''}`}>
                  <td className="table-td"><span className="font-mono text-[#005ba3] font-semibold">{b.bmcu_code}</span> <span className="text-gray-600">{b.bmcu_name}</span></td>
                  <td className="table-td text-gray-600">{b.plant_name || '—'}</td>
                  <td className="table-td text-right">{nf(b.forecast)}</td>
                  <td className="table-td text-right">{nf(b.actual)}</td>
                  <td className="table-td text-right"><span className={`px-1.5 py-0.5 rounded font-semibold ${b.diff === 0 ? 'text-gray-500' : b.diff > 0 ? 'text-red-700 bg-red-50' : 'text-sky-800 bg-sky-50'}`}
                    title={b.diff > 0 ? 'over-forecast' : b.diff < 0 ? 'under-forecast' : ''}>{sign(b.diff)}</span></td>
                  <td className="table-td">{b.lifted_by || <span className="text-gray-400">not lifted</span>}
                    {b.flag === 'forecast_not_lifted' && <span className="badge bg-amber-50 text-amber-700 ml-1">forecast, not lifted</span>}
                    {b.flag === 'lifted_not_forecast' && <span className="badge bg-amber-50 text-amber-700 ml-1">lifted, not forecast</span>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={6} className="table-td text-center text-gray-400 py-4">No BMCUs match</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DayOptimizer() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [planDate, setPlanDate] = useState(() => {
    const t = new Date(); t.setDate(t.getDate() + 1); return t.toISOString().slice(0, 10);
  });
  const [shift, setShift] = useState('BOTH');
  const [constraints, setConstraints] = useState({});
  const [demandEdits, setDemandEdits] = useState({});   // { 'bmcu|shift': litres }
  const [excludedTankers, setExcludedTankers] = useState({}); // { tanker_id: true }
  const [demandSearch, setDemandSearch] = useState('');
  const [result, setResult] = useState(null);
  const [accepted, setAccepted] = useState({});
  // "Plan to plant requirements" mode: litres each plant needs; the portal
  // decides which BMCUs supply which plant (services/plantAllocation.js).
  const [mode, setMode] = useState('catchment');               // 'catchment' | 'plant_requirements'
  const [reqEdits, setReqEdits] = useState({});                 // { plant_id: { required, priority, locked } }
  const [allocOpts, setAllocOpts] = useState({});               // { max_extra_km_per_bmcu, shortfall_rule }
  const [pinned, setPinned] = useState({});                     // { bmcu_id: true } keep usual plant

  const { data: preview, isLoading: loadingPreview, isError: previewError, error: previewErr, refetch } = useQuery({
    queryKey: ['day-optimizer-preview', planDate, shift, !!constraints.include_sale],
    queryFn: () => getDayOptimizerPreview({ plan_for_date: planDate, shift, include_sale: !!constraints.include_sale }).then(r => r.data),
    enabled: !!planDate,
    retry: false,
  });

  useEffect(() => {
    if (preview?.constraints && !Object.keys(constraints).length) setConstraints(preview.constraints);
    if (preview?.allocation_defaults && !Object.keys(allocOpts).length) setAllocOpts(preview.allocation_defaults);
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const setC = (k, v) => setConstraints(p => ({ ...p, [k]: v }));
  const isReqMode = mode === 'plant_requirements';

  // Requirement rows: one per plant, required defaults to the catchment forecast
  const reqRows = useMemo(() => (preview?.plants || []).map(p => {
    const e = reqEdits[p.id] || {};
    const required = e.required !== undefined && e.required !== '' ? parseFloat(e.required) || 0 : (p.catchment_forecast_litres || 0);
    return { ...p, required, priority: e.priority ?? 99, locked: !!e.locked, edited: e.required !== undefined && e.required !== '' };
  }), [preview, reqEdits]);
  const reqTotals = useMemo(() => ({
    supply: reqRows.reduce((s, p) => s + (p.catchment_forecast_litres || 0), 0),
    required: reqRows.reduce((s, p) => s + p.required, 0),
  }), [reqRows]);
  const setReq = (id, k, v) => setReqEdits(p => ({ ...p, [id]: { ...(p[id] || {}), [k]: v } }));

  const demandRows = useMemo(() => {
    const rows = preview?.demand || [];
    const q = demandSearch.toLowerCase();
    return q ? rows.filter(d => d.bmcu_code?.toLowerCase().includes(q) || d.bmcu_name?.toLowerCase().includes(q) || d.plant_name?.toLowerCase().includes(q)) : rows;
  }, [preview, demandSearch]);

  const litresOf = d => {
    const e = demandEdits[`${d.bmcu_id}|${d.shift}`];
    return e !== undefined && e !== '' ? parseFloat(e) || 0 : d.forecast_litres;
  };
  const totalDemand = useMemo(() => (preview?.demand || []).reduce((s, d) => s + litresOf(d), 0), [preview, demandEdits]); // eslint-disable-line react-hooks/exhaustive-deps
  const availableFleet = (preview?.fleet || []).filter(f => f.available && !excludedTankers[f.id]);
  const fleetCapacity = availableFleet.reduce((s, f) => s + f.capacity_litres * (constraints.max_trips_per_tanker_per_day || 1), 0);

  const prefetchMut = useMutation({
    mutationFn: () => prefetchOptimizerDistances().then(r => r.data),
    onSuccess: (d) => {
      if (d.error) toast.error(d.error);
      else toast.success(`Prefetch: ${nf(d.fetched)} fetched, ${nf(d.failed)} failed, ${nf(d.remaining)} still missing within ${d.radius_km} km`, { duration: 8000 });
      refetch();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const runMut = useMutation({
    // extra = { pinned_bmcu_ids } when a planner vetoes a move from the results
    mutationFn: (extra = {}) => runDayOptimizer({
      plan_for_date: planDate, shift, constraints, include_sale: !!constraints.include_sale,
      demand_overrides: Object.entries(demandEdits)
        .filter(([, v]) => v !== '' && v !== undefined)
        .map(([k, v]) => { const [bmcu_id, sh] = k.split('|'); return { bmcu_id: Number(bmcu_id), shift: sh, litres: parseFloat(v) || 0 }; }),
      exclude_tanker_ids: Object.keys(excludedTankers).filter(k => excludedTankers[k]).map(Number),
      mode,
      ...(isReqMode ? {
        plant_requirements: reqRows.map(p => ({ delivery_point_id: p.id, required_litres: p.required, priority: Number(p.priority) || 99, locked: p.locked })),
        allocation: allocOpts,
        pinned_bmcu_ids: Object.keys(pinned).filter(k => pinned[k]).map(Number),
      } : {}),
      ...extra,
    }).then(r => r.data),
    onSuccess: (d) => {
      setResult(d);
      setAccepted(Object.fromEntries(d.trips.map(t => [t.opt_trip_id, true])));
      setStep(2);
      toast.success(`${d.totals.trips} trips planned — ${inr(d.totals.cost)}${d.allocation ? ` · ${d.allocation.moves.length} BMCU(s) reassigned` : ''}`);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Day Optimizer run failed'),
  });

  const saveMut = useMutation({
    mutationFn: () => saveOptimizerAsPlans(result.session_id,
      result.trips.map(t => ({ opt_trip_id: t.opt_trip_id, accepted: accepted[t.opt_trip_id] !== false }))),
    onSuccess: (r) => { toast.success(r.data.message); qc.invalidateQueries(['plans']); setStep(3); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed'),
  });

  const acceptedCount = result ? result.trips.filter(t => accepted[t.opt_trip_id] !== false).length : 0;

  // ─── Step 1: Inputs ───────────────────────────────────────────────────────
  const renderInputs = () => (
    <div className="space-y-4">
      <div className="card p-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div>
          <label className="text-xs font-medium text-gray-600">Plan for date</label>
          <input type="date" className="input w-full" value={planDate} onChange={e => setPlanDate(e.target.value)}/>
          <div className="text-xs text-gray-400 mt-1">{fmtDate(planDate)}</div>
        </div>
        <div>
          <label className="text-xs font-medium text-gray-600">Shift</label>
          <select className="input w-full" value={shift} onChange={e => setShift(e.target.value)}>
            <option value="BOTH">Both (AM + PM lifted together)</option>
            <option value="AM">AM only</option>
            <option value="PM">PM only</option>
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="text-xs font-medium text-gray-600">Distance coverage (pairs that matter)</label>
          {preview?.distance_coverage ? (
            <div className="flex items-center gap-3 mt-1">
              <FillBar pct={preview.distance_coverage.coverage_pct}/>
              <span className="text-xs text-gray-500">{nf(preview.distance_coverage.covered)} / {nf(preview.distance_coverage.pairs)} pairs in Distance Master
                {preview.distance_coverage.missing_without_coords > 0 && ` · ${nf(preview.distance_coverage.missing_without_coords)} need coordinates`}</span>
              <button className="btn-secondary btn-sm flex items-center gap-1" disabled={prefetchMut.isPending}
                onClick={() => { if (window.confirm('Fetch every missing nearby pair from Google Routes and cache it into Distance Master? This can take several minutes.')) prefetchMut.mutate(); }}>
                <Download size={12}/> {prefetchMut.isPending ? 'Fetching…' : 'Prefetch missing distances'}
              </button>
            </div>
          ) : <div className="text-xs text-gray-400 mt-2">—</div>}
        </div>
      </div>

      {previewError && (
        <div className="card p-4 border-red-200 bg-red-50 text-sm text-red-700 flex items-center gap-2">
          <AlertTriangle size={14}/> {previewErr?.response?.data?.error || previewErr?.message}
        </div>
      )}

      {/* Constraints */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-gray-700"><Layers size={14}/> Constraints</div>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
          {CONSTRAINT_FIELDS.map(f => (
            <div key={f.key}>
              <label className="text-xs text-gray-500">{f.label}</label>
              <input type="number" step={f.step} className="input w-full py-1 text-sm"
                value={constraints[f.key] === undefined ? '' : (f.toUi ? f.toUi(constraints[f.key]) : constraints[f.key])}
                onChange={e => setC(f.key, f.fromUi ? f.fromUi(e.target.value) : Number(e.target.value))}/>
            </div>
          ))}
          <label className="flex items-center gap-2 text-xs text-gray-600 mt-5">
            <input type="checkbox" checked={!!constraints.allow_plant_switch} onChange={e => setC('allow_plant_switch', e.target.checked)}/>
            Allow plant switch
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-600 mt-5"
            title="Off (default): the forecast is built only from lifts by vendor tankers, so milk that Milma / sale tankers collect is not planned. On: forecast all milk.">
            <input type="checkbox" checked={!!constraints.include_sale} onChange={e => setC('include_sale', e.target.checked)}/>
            Include sale-tanker milk
          </label>
        </div>
        <div className="text-xs text-gray-400 mt-2">Defaults: fill floor 85 %, 8 BMCUs, 550 km, 1 trip per tanker per day (a second trip is not feasible after loading, unloading and cleaning); sale-tanker milk excluded from the forecast. Cost = km × Tanker Rate Master rate (Point to Point for one BMCU, else BMCU/CC to Dairy/CC).</div>
      </div>

      {/* Mode: usual catchments vs plant requirements */}
      <div className="card p-4">
        <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-gray-700"><Factory size={14}/> Where the milk goes</div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={!isReqMode} onChange={() => setMode('catchment')}/> Plan by usual catchments
            <span className="text-xs text-gray-400">(each BMCU to the plant it usually goes to)</span></label>
          <label className="flex items-center gap-2"><input type="radio" name="mode" checked={isReqMode} onChange={() => setMode('plant_requirements')}/> Plan to plant requirements
            <span className="text-xs text-gray-400">(enter litres per plant; the portal decides which BMCUs supply which plant)</span></label>
        </div>
        {isReqMode && (
          <div className="mt-3 space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b"><tr>
                  <th className="table-th">Plant</th><th className="table-th text-right">Catchment forecast L</th><th className="table-th text-right w-36">Required L</th>
                  <th className="table-th text-right w-24">Priority</th><th className="table-th">Locked</th><th className="table-th">Notes</th></tr></thead>
                <tbody>
                  {reqRows.map(p => (
                    <tr key={p.id} className="border-b border-gray-50">
                      <td className="table-td font-medium">{p.name}{p.start_point && <span className="text-gray-400 font-normal"> · from {p.start_point}</span>}</td>
                      <td className="table-td text-right text-gray-600">{nf(p.catchment_forecast_litres)}<span className="text-gray-400"> · {p.bmcu_count} BMCUs</span></td>
                      <td className="table-td text-right"><input type="number" min="0" step="500" className={`input py-0.5 text-xs w-32 text-right ${p.edited ? 'border-[#0078d4]' : ''}`}
                        value={reqEdits[p.id]?.required ?? p.catchment_forecast_litres ?? 0} onChange={e => setReq(p.id, 'required', e.target.value)}/></td>
                      <td className="table-td text-right"><input type="number" min="1" step="1" className="input py-0.5 text-xs w-20 text-right" title="1 = highest; when the day's milk cannot cover every plant, the lowest priority is left short first"
                        value={reqEdits[p.id]?.priority ?? 99} onChange={e => setReq(p.id, 'priority', e.target.value)}/></td>
                      <td className="table-td"><input type="checkbox" checked={p.locked} onChange={e => setReq(p.id, 'locked', e.target.checked)} title="Keep this plant's usual BMCUs; only add to it"/></td>
                      <td className="table-td text-xs">
                        {!p.has_coords && <span className="text-red-600">no coordinates — cannot take a requirement</span>}
                        {p.has_coords && p.required === 0 && <span className="text-amber-700">requires nothing — its usual BMCUs go elsewhere</span>}
                      </td>
                    </tr>
                  ))}
                  <tr className={`font-semibold ${reqTotals.required > reqTotals.supply + 0.5 ? 'bg-red-50 text-red-700' : 'bg-gray-50'}`}>
                    <td className="table-td">Total</td>
                    <td className="table-td text-right">{nf(reqTotals.supply)}</td>
                    <td className="table-td text-right">{nf(reqTotals.required)}
                      {reqTotals.required > reqTotals.supply + 0.5 && <div className="text-[11px] font-normal">required exceeds forecast supply by {nf(reqTotals.required - reqTotals.supply)} L — shortfall rule applies</div>}
                      {reqTotals.required < reqTotals.supply - 0.5 && <div className="text-[11px] font-normal text-gray-500">{nf(reqTotals.supply - reqTotals.required)} L above requirements will still be placed (oversupply)</div>}</td>
                    <td className="table-td" colSpan={3}>
                      <button className="btn-secondary btn-sm" onClick={() => setReqEdits({})}>Reset to catchment forecast</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-gray-500">Max extra km per BMCU</label>
                <input type="number" min="0" step="10" className="input w-full py-1 text-sm" value={allocOpts.max_extra_km_per_bmcu ?? ''}
                  onChange={e => setAllocOpts(o => ({ ...o, max_extra_km_per_bmcu: Number(e.target.value) }))}/>
              </div>
              <div>
                <label className="text-xs text-gray-500">Shortfall rule</label>
                <select className="input w-full py-1 text-sm" value={allocOpts.shortfall_rule || 'priority'} onChange={e => setAllocOpts(o => ({ ...o, shortfall_rule: e.target.value }))}>
                  <option value="priority">Priority — lowest priority plants go short first</option>
                  <option value="proportional">Proportional — every plant scaled down</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500">Keep-history bonus (%)</label>
                <input type="number" min="0" step="1" className="input w-full py-1 text-sm" value={allocOpts.keep_history_bonus_pct ?? ''}
                  onChange={e => setAllocOpts(o => ({ ...o, keep_history_bonus_pct: Number(e.target.value) }))}/>
              </div>
              <div className="text-xs text-gray-400 md:col-span-1 self-end">A BMCU only leaves its usual plant when the new plant's delivery leg is within the extra-km limit; moves are ranked by extra km × ₹/km per litre moved. Plants not requiring anything send their BMCUs to the nearest plant with room.</div>
            </div>
            {Object.keys(pinned).filter(k => pinned[k]).length > 0 && (
              <div className="text-xs text-gray-600">Pinned to usual plant: {Object.keys(pinned).filter(k => pinned[k]).length} BMCU(s) <button className="text-[#0078d4] underline ml-1" onClick={() => setPinned({})}>clear</button></div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Demand */}
        <div className="card xl:col-span-2">
          <div className="card-header flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm font-semibold flex items-center gap-2"><MapPin size={14}/> Demand forecast
              <span className="text-xs font-normal text-gray-500">{nf(totalDemand)} L across {nf(preview?.demand?.length || 0)} BMCU-shifts</span></div>
            <input className="input py-1 text-xs w-52" placeholder="Search BMCU / plant…" value={demandSearch} onChange={e => setDemandSearch(e.target.value)}/>
          </div>
          <div className="overflow-auto max-h-[420px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 border-b">
                <tr>
                  <th className="table-th">BMCU</th><th className="table-th">Shift</th><th className="table-th">Plant</th>
                  <th className="table-th text-right">Forecast L</th><th className="table-th">Method</th>
                  <th className="table-th">Last 7 days</th><th className="table-th text-right w-28">Override L</th>
                </tr>
              </thead>
              <tbody>
                {loadingPreview && <tr><td colSpan={7} className="table-td text-center text-gray-400 py-6">Loading…</td></tr>}
                {demandRows.map(d => (
                  <tr key={`${d.bmcu_id}|${d.shift}`} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="table-td"><span className="font-mono text-[#005ba3] font-semibold">{d.bmcu_code}</span> <span className="text-gray-600">{d.bmcu_name}</span></td>
                    <td className="table-td">{d.shift}</td>
                    <td className="table-td text-gray-600">{d.plant_name || <span className="text-red-500">none</span>}
                      {d.catchment_method === 'nearest' && <span className="text-gray-400"> (nearest)</span>}</td>
                    <td className="table-td text-right font-semibold">{nf(d.forecast_litres)}</td>
                    <td className="table-td"><span className={`badge ${d.method === 'none' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}
                      title={d.method === 'median_x_p14' ? `median of the last 14 days' lifts × lift probability ${d.lift_probability} (${d.lifts_last_14d} lifts in 14 days)` : d.method}>
                      {d.method === 'median_x_p14' ? `median × p ${d.lift_probability}` : d.method}</span></td>
                    <td className="table-td text-gray-500">{d.last_7_days.map(x => nf(x.litres)).join(', ') || '—'}</td>
                    <td className="table-td"><input type="number" className="input py-0.5 text-xs w-24 text-right" placeholder={nf(d.forecast_litres)}
                      value={demandEdits[`${d.bmcu_id}|${d.shift}`] ?? ''}
                      onChange={e => setDemandEdits(p => ({ ...p, [`${d.bmcu_id}|${d.shift}`]: e.target.value }))}/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Fleet + plants */}
        <div className="space-y-4">
          <div className="card">
            <div className="card-header text-sm font-semibold flex items-center gap-2"><Truck size={14}/> Fleet
              <span className="text-xs font-normal text-gray-500">{availableFleet.length} available · capacity {nf(fleetCapacity)} L/day</span></div>
            <div className="overflow-auto max-h-[300px]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 border-b"><tr>
                  <th className="table-th">Use</th><th className="table-th">Tanker</th><th className="table-th text-right">Cap L</th>
                  <th className="table-th">State</th><th className="table-th text-right">₹/km P2P</th><th className="table-th text-right">₹/km BMCU</th><th className="table-th">Status</th></tr></thead>
                <tbody>
                  {(preview?.fleet || []).map(f => (
                    <tr key={f.id} className={`border-b border-gray-50 ${!f.available ? 'opacity-60' : ''}`}>
                      <td className="table-td"><input type="checkbox" disabled={!f.available} checked={f.available && !excludedTankers[f.id]}
                        onChange={e => setExcludedTankers(p => ({ ...p, [f.id]: !e.target.checked }))}/></td>
                      <td className="table-td font-mono">{f.tanker_number}<div className="text-gray-400 font-sans">{f.vendor_name}</div></td>
                      <td className="table-td text-right">{nf(f.capacity_litres)}</td>
                      <td className="table-td">{f.state || '—'}{f.state_source === 'registration' && <span className="text-gray-400" title="from registration prefix">*</span>}</td>
                      <td className="table-td text-right">{f.rates['Point to Point'] ?? '—'}</td>
                      <td className="table-td text-right">{f.rates['BMCU/CC to Dairy/CC'] ?? '—'}</td>
                      <td className="table-td">{f.available ? <span className="badge bg-green-50 text-green-700">available</span> : <span className="text-red-600" title={f.reason}>{f.reason}</span>}
                        {f.note && <div className="text-amber-700" title={f.note}><AlertTriangle size={10} className="inline mr-1"/>{f.note}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card p-3">
            <div className="text-sm font-semibold flex items-center gap-2 mb-2"><Factory size={14}/> Plants (catchments)</div>
            <ul className="text-xs space-y-1">
              {(preview?.plants || []).map(p => (
                <li key={p.id} className="flex justify-between">
                  <span>{p.name}{!p.has_coords && <span className="text-red-500"> · no coordinates</span>}{p.start_point && <span className="text-gray-400"> · from {p.start_point}</span>}</span>
                  <span className="text-gray-500">{p.bmcu_count} BMCUs</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {preview?.forecast_accuracy && <ForecastAccuracyPanel fa={preview.forecast_accuracy}/>}

      <div className="flex justify-end">
        <button className="btn-primary flex items-center gap-2" disabled={runMut.isPending || !preview}
          onClick={() => runMut.mutate()}>
          {runMut.isPending ? <><RefreshCw size={14} className="animate-spin"/> Optimising… (up to {Math.round((constraints.time_budget_ms || 8000) / 1000)} s)</> : <><Zap size={14}/> {isReqMode ? 'Plan to requirements' : 'Run Day Optimizer'}</>}
        </button>
      </div>
    </div>
  );

  // ─── Step 2: Results ──────────────────────────────────────────────────────
  const renderResults = () => {
    const { totals, trips, comparison, warnings, unserved, excluded_tankers, stats, allocation } = result;
    const byPlant = {};
    for (const t of trips) (byPlant[t.plant_name] ||= []).push(t);
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard icon={Route} label="Trips" value={nf(totals.trips)} sub={`Forecast ${nf(totals.litres)} L · ${new Set(trips.map(t => t.tanker_id)).size} tankers`}/>
          <StatCard icon={MapPin} label="Total km" value={nf(totals.km, 1)} color="purple"/>
          <StatCard icon={IndianRupee} label="Total cost" value={inr(totals.cost)} color="green"/>
          <StatCard icon={IndianRupee} label="Cost / litre" value={inr(totals.cost_per_litre, 3)} color="green"/>
          <StatCard icon={Truck} label="Avg fill" value={`${nf(totals.avg_fill_pct, 1)} %`} sub={`${totals.below_fill_floor_trips} below floor`} color={totals.avg_fill_pct >= 85 ? 'green' : 'amber'}/>
          <StatCard icon={Info} label="Estimated legs" value={nf(totals.estimated_legs)} color={totals.estimated_legs ? 'amber' : 'blue'}/>
        </div>

        {comparison && (() => {
          // Sessions before 2026-09-25 stored one flat block: treat it as the executed column.
          const ex = comparison.actual_executed || (comparison.actual_planned ? null : comparison);
          const pl = comparison.actual_planned || null;
          const exDelta = ex?.delta || comparison.delta || {};
          const optTankers = new Set(trips.map(t => t.tanker_id)).size;
          const rows = [
            ['Trips', nf(totals.trips), ex && nf(ex.trips), pl && nf(pl.trips), exDelta.trips, '', 0],
            ['Tankers used', nf(optTankers), ex && nf(ex.tankers_used), pl && nf(pl.tankers_used), exDelta.tankers_used, '', 0],
            ['Km', nf(totals.km, 1), ex && nf(ex.km, 1), pl && nf(pl.km, 1), exDelta.km, ' km', 1],
            ['Litres (forecast vs RMRD)', nf(totals.litres), ex && nf(ex.litres), pl && nf(pl.litres), exDelta.litres, ' L', 0, false],
            ['Cost', inr(totals.cost), ex && inr(ex.cost), pl && inr(pl.cost), exDelta.cost, ' ₹', 0],
            ['Cost / litre', inr(totals.cost_per_litre, 3), ex && inr(ex.cost_per_litre, 3), pl && inr(pl.cost_per_litre, 3), exDelta.cost_per_litre, ' ₹', 3],
            ['Avg fill %', nf(totals.avg_fill_pct, 1), ex && nf(ex.avg_fill_pct, 1), pl && nf(pl.avg_fill_pct, 1), exDelta.avg_fill_pct, ' %', 1, false],
          ];
          return (
            <div className="card p-4">
              <div className="text-sm font-semibold mb-1 flex items-center gap-2">
                Comparison — {comparison.source === 'actual_plans' ? `actual trips of ${fmtDate(comparison.date)}` : `same weekday last week (${fmtDate(comparison.date)})`}
              </div>
              <div className="text-xs text-gray-500 mb-2">
                Optimizer litres are a forecast. Actual (executed) = {ex?.basis || 'RMRD litres · billed km/amount where billed, else execution km × rate'}.
                {pl && ' Planned = the planner\'s expected litres, km and cost (plans under-state lifted milk, so ₹/L and fill there are not comparable).'}
              </div>
              <table className="text-sm">
                <thead><tr className="text-xs text-gray-500"><th className="text-left pr-6"></th><th className="text-right pr-6">Optimizer</th><th className="text-right pr-6">Actual (executed)</th><th className="text-right pr-6">Δ</th><th className="text-right text-gray-400">Planned</th></tr></thead>
                <tbody>
                  {rows.map(([l, a, b, c, d, u, dg, lower]) => (
                    <tr key={l}><td className="pr-6 py-0.5 text-gray-600">{l}</td><td className="text-right pr-6 font-semibold">{a}</td><td className="text-right pr-6">{b ?? '—'}</td>
                      <td className="text-right pr-6"><Delta value={ex ? d : null} unit={u} digits={dg} lowerIsBetter={lower !== false}/></td>
                      <td className="text-right text-gray-400">{c ?? '—'}</td></tr>
                  ))}
                </tbody>
              </table>
              {ex?.ack_litres > 0 && <div className="text-xs text-gray-500 mt-2">Acknowledged at plant: {nf(ex.ack_litres)} L{ex.billed_trips != null && ` · ${ex.billed_trips} of ${ex.trips} trips billed`}</div>}
              {ex?.sale_litres > 0 && <div className="text-xs text-violet-700 mt-1">Sale tankers that day: {ex.sale_trips} trip(s), {nf(ex.sale_litres)} L — not transported by Shreeja, not in the forecast unless "Include sale-tanker milk" is ticked</div>}
              {comparison.note && <div className="text-xs text-gray-500 mt-1">{comparison.note}</div>}
            </div>
          );
        })()}
        <ForecastAccuracyPanel fa={result.forecast_accuracy || comparison?.forecast_accuracy}/>

        {unserved?.length > 0 && (
          <div className="card p-3 border-red-300 bg-red-50 text-sm text-red-800 flex items-center gap-2">
            <AlertTriangle size={16}/> <span><b>{unserved.length} BMCU pickup(s) are not served</b> — see the Unserved list below. Raise max trips per tanker, add BMCUs per trip or km per trip, or check the excluded tankers and the Use column in the fleet.</span>
          </div>
        )}
        {warnings?.length > 0 && (
          <div className="card p-3 border-amber-200 bg-amber-50 text-xs text-amber-800 space-y-1">
            {warnings.map((w, i) => <div key={i} className="flex items-center gap-2"><AlertTriangle size={12}/> {w}</div>)}
          </div>
        )}
        {stats && (
          <div className="text-xs text-gray-500 px-1">
            Search: seed {inr(stats.seed_cost)} → {inr(stats.search_cost)} in {nf(stats.iterations)} iterations, {nf(stats.accepted)} accepted, {stats.restarts} restarts{stats.kicks != null ? `, ${stats.kicks} kicks` : ''}, {nf(stats.elapsed_ms)} ms
            {stats.moves && <> · moves (accepted/tried): {Object.entries(stats.moves).map(([k, v]) => `${k.replace('_', ' ')} ${v.accepted}/${v.tried}`).join(', ')}</>}
            {stats.seed_candidates?.length > 0 && <> · seeds: {stats.seed_candidates.map(s => `${nf(s.capacity / 1000)} KL ${inr(s.cost)}${s.chosen ? ' ✓' : ''}`).join(', ')}</>}
          </div>
        )}

        {allocation && (() => {
          const pinnedIds = Object.keys(pinned).filter(k => pinned[k]).map(Number);
          const rerunWith = (ids) => { setPinned(Object.fromEntries(ids.map(id => [id, true]))); runMut.mutate({ pinned_bmcu_ids: ids }); };
          const togglePin = (id, on) => rerunWith(on ? [...new Set([...pinnedIds, id])] : pinnedIds.filter(x => x !== id));
          const pinnedRows = pinnedIds.map(id => (result.trips.flatMap(t => t.bmcus).find(b => b.bmcu_id === id) || { bmcu_id: id, bmcu_code: `#${id}` }));
          return (
            <div className="card">
              <div className="card-header text-sm font-semibold flex items-center gap-2 flex-wrap"><Factory size={14}/> Plant allocation
                <span className="text-xs text-gray-500 font-normal">required {nf(allocation.totals.required)} L · forecast supply {nf(allocation.totals.supply)} L · {allocation.moves.length} BMCU(s) reassigned ({nf(allocation.totals.moved_litres)} L)
                  {allocation.totals.unmet > 0 && <span className="text-red-600"> · unmet {nf(allocation.totals.unmet)} L</span>} · max extra {allocation.options.max_extra_km_per_bmcu} km · {allocation.options.shortfall_rule} rule</span></div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 border-b"><tr>
                    <th className="table-th">Plant</th><th className="table-th text-right">Required L</th><th className="table-th text-right">Allocated L</th><th className="table-th text-right">Delivered by plan L</th>
                    <th className="table-th text-right">Unmet L</th><th className="table-th text-right">Oversupplied L</th><th className="table-th text-right">Moved in / out L</th><th className="table-th">Note</th></tr></thead>
                  <tbody>
                    {allocation.plants.map(pl => (
                      <tr key={pl.id} className="border-b border-gray-50">
                        <td className="table-td font-medium">{pl.name} <span className="text-gray-400 font-normal">· priority {pl.priority}{pl.locked ? ' · locked' : ''} · {pl.bmcu_count} BMCUs</span></td>
                        <td className="table-td text-right">{nf(pl.required)}{pl.shortfall > 0 && <div className="text-[11px] text-red-600">target {nf(pl.effective_required)} after shortfall</div>}</td>
                        <td className="table-td text-right font-semibold">{nf(pl.allocated)}</td>
                        <td className="table-td text-right">{nf(pl.delivered_by_plan)}{pl.delivered_by_plan < pl.allocated - 0.5 && <span className="text-red-600" title="Some pickups allocated here are unserved by the plan"> ▼</span>}</td>
                        <td className="table-td text-right">{pl.unmet > 0 ? <span className="px-1.5 py-0.5 rounded font-semibold text-red-700 bg-red-50">{nf(pl.unmet)}</span> : <span className="text-gray-400">0</span>}</td>
                        <td className="table-td text-right">{pl.oversupplied > 0 ? <span className="px-1.5 py-0.5 rounded font-semibold text-amber-700 bg-amber-50">+{nf(pl.oversupplied)}</span> : <span className="text-gray-400">0</span>}</td>
                        <td className="table-td text-right text-gray-600">{nf(pl.moved_in)} / {nf(pl.moved_out)}</td>
                        <td className="table-td text-gray-500">{pl.unmet_reason || ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {allocation.notes?.length > 0 && <div className="px-4 py-2 text-xs text-gray-500 space-y-0.5 border-t">{allocation.notes.map((n, i) => <div key={i}>{n}</div>)}</div>}
              <div className="px-4 py-2 text-sm font-semibold border-t flex items-center gap-2 flex-wrap">BMCUs reassigned from their usual plant ({allocation.moves.length})
                <span className="text-xs text-gray-500 font-normal">tick "keep usual plant" to veto a move — the plan re-runs with that BMCU pinned</span></div>
              {allocation.moves.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 border-b"><tr>
                      <th className="table-th">Keep usual plant</th><th className="table-th">BMCU</th><th className="table-th">From → To</th><th className="table-th text-right">Litres</th>
                      <th className="table-th text-right">Extra km</th><th className="table-th text-right">Marginal cost</th><th className="table-th">Reason</th></tr></thead>
                    <tbody>
                      {allocation.moves.map(m => (
                        <tr key={m.bmcu_id} className={`border-b border-gray-50 ${m.flag ? 'bg-amber-50/40' : ''}`}>
                          <td className="table-td"><input type="checkbox" disabled={runMut.isPending} checked={!!pinned[m.bmcu_id]} onChange={e => togglePin(m.bmcu_id, e.target.checked)}/></td>
                          <td className="table-td"><span className="font-mono text-[#005ba3] font-semibold">{m.bmcu_code}</span> <span className="text-gray-600">{m.bmcu_name}</span></td>
                          <td className="table-td">{m.from_plant_name} <span className="text-gray-400">→</span> <b>{m.to_plant_name}</b></td>
                          <td className="table-td text-right">{nf(m.litres)}</td>
                          <td className="table-td text-right">{m.extra_km > 0 ? '+' : ''}{nf(m.extra_km, 1)}</td>
                          <td className="table-td text-right">{inr(m.marginal_cost)}</td>
                          <td className="table-td text-gray-600">{m.reason}
                            {m.flag === 'beyond_max_extra_km' && <span className="badge bg-red-50 text-red-700 ml-1">beyond km limit</span>}
                            {m.flag === 'oversupplied' && <span className="badge bg-amber-50 text-amber-700 ml-1">oversupplies</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {pinnedRows.length > 0 && (
                <div className="px-4 py-2 text-xs text-gray-600 border-t flex items-center gap-2 flex-wrap">Pinned to usual plant:
                  {pinnedRows.map(b => <span key={b.bmcu_id} className="badge bg-gray-100 text-gray-700">{b.bmcu_code}
                    <button className="ml-1 text-[#0078d4]" disabled={runMut.isPending} title="Unpin and re-run" onClick={() => togglePin(b.bmcu_id, false)}>×</button></span>)}
                  {runMut.isPending && <span className="text-gray-400 flex items-center gap-1"><RefreshCw size={11} className="animate-spin"/> re-planning…</span>}
                </div>
              )}
            </div>
          );
        })()}

        {Object.entries(byPlant).map(([plant, list]) => (
          <div key={plant} className="card">
            <div className="card-header text-sm font-semibold flex items-center gap-2 flex-wrap"><Factory size={14}/> {plant}
              {(() => {
                const litres = list.reduce((s, t) => s + t.total_qty_litres, 0), cost = list.reduce((s, t) => s + t.cost, 0);
                const km = list.reduce((s, t) => s + t.km, 0), cap = list.reduce((s, t) => s + t.capacity_litres, 0);
                const tankers = new Set(list.map(t => t.tanker_id)).size;
                return <span className="text-xs text-gray-500 font-normal">{list.length} trips · {tankers} tankers · {nf(litres)} L · {nf(km, 1)} km · {inr(cost)} · {inr(litres ? cost / litres : 0, 3)}/L · fill {nf(cap ? litres / cap * 100 : 0, 1)} %</span>;
              })()}</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b"><tr>
                  <th className="table-th">Adopt</th><th className="table-th">#</th><th className="table-th">Tanker</th><th className="table-th">BMCU chain</th>
                  <th className="table-th text-right">Litres</th><th className="table-th">Fill</th><th className="table-th text-right">Km</th>
                  <th className="table-th text-right">₹/km</th><th className="table-th text-right">Cost</th><th className="table-th text-right">₹/L</th><th className="table-th">Flags</th></tr></thead>
                <tbody>
                  {list.map(t => (
                    <tr key={t.opt_trip_id} className={`border-b border-gray-50 ${accepted[t.opt_trip_id] === false ? 'opacity-50' : ''}`}>
                      <td className="table-td"><input type="checkbox" checked={accepted[t.opt_trip_id] !== false} onChange={e => setAccepted(p => ({ ...p, [t.opt_trip_id]: e.target.checked }))}/></td>
                      <td className="table-td">{t.trip_seq}</td>
                      <td className="table-td"><span className="font-mono font-semibold">{t.tanker_number}</span>
                        <div className="text-gray-600">{t.vendor_name || <span className="text-red-500">no vendor</span>}</div>
                        <div className="text-gray-400">{nf(t.capacity_litres)} L · {t.rate_state || '—'} · {t.transport_type} · ₹{nf(t.rate_per_km, 2)}/km</div></td>
                      <td className="table-td" title={t.tanker_reason}>
                        <div className={`font-semibold ${t.route_name === 'New combination' ? 'text-amber-700' : 'text-sky-800'}`}>Route: {t.route_name || '—'}{t.route_overlap_pct != null && t.route_name !== 'New combination' && <span className="text-gray-400 font-normal"> ({t.route_overlap_pct} % of BMCUs on this route)</span>}</div>
                        {t.bmcus.map(b => `${b.bmcu_code} (${nf(b.expected_qty_litres)} L, ${nf(b.leg_km, 1)} km${b.leg_is_estimated ? '~' : ''})`).join(' → ')}
                        <span className="text-gray-400"> → plant {nf(t.return_leg.leg_km, 1)} km{t.return_leg.leg_is_estimated ? '~' : ''}</span></td>
                      <td className="table-td text-right font-semibold">{nf(t.total_qty_litres)}</td>
                      <td className="table-td"><FillBar pct={t.fill_pct}/></td>
                      <td className="table-td text-right">{nf(t.km, 1)}</td>
                      <td className="table-td text-right">{nf(t.rate_per_km, 2)}</td>
                      <td className="table-td text-right font-semibold">{inr(t.cost)}</td>
                      <td className="table-td text-right">{nf(t.cost_per_litre, 3)}</td>
                      <td className="table-td">
                        {t.flags.below_fill_floor && <span className="badge bg-amber-50 text-amber-700 mr-1">below floor</span>}
                        {t.flags.estimated_legs > 0 && <span className="badge bg-gray-100 text-gray-600 mr-1">{t.flags.estimated_legs} est. leg{t.flags.estimated_legs > 1 ? 's' : ''}</span>}
                        {t.flags.over_max_km && <span className="badge bg-red-50 text-red-700" title="Single BMCU whose round trip alone exceeds the km limit">over km limit</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {unserved?.length > 0 && (
          <div className="card p-4">
            <div className="text-sm font-semibold text-red-700 mb-2">Unserved BMCUs ({unserved.length})</div>
            <ul className="text-xs space-y-0.5">{unserved.map((u, i) => <li key={i}><span className="font-mono">{u.bmcu_code}</span> {u.bmcu_name} — {nf(u.litres)} L — {u.reason}</li>)}</ul>
          </div>
        )}
        {excluded_tankers?.length > 0 && (
          <div className="card p-4">
            <div className="text-sm font-semibold text-gray-700 mb-2">Excluded tankers ({excluded_tankers.length})</div>
            <ul className="text-xs space-y-0.5">{excluded_tankers.map((u, i) => <li key={i}><span className="font-mono">{u.tanker_number}</span> — {u.reason}</li>)}</ul>
          </div>
        )}

        <div className="flex justify-between">
          <button className="btn-secondary flex items-center gap-2" onClick={() => setStep(1)}><ChevronLeft size={14}/> Back to inputs</button>
          <button className="btn-secondary flex items-center gap-2" disabled={!result.session_id}
            onClick={() => downloadDayOptimizerReport(result.session_id, planDate).catch(e => toast.error(e.response?.data?.error || e.message))}>
            <Download size={14}/> Download Excel
          </button>
          <button className="btn-primary flex items-center gap-2" disabled={saveMut.isPending || acceptedCount === 0}
            onClick={() => { if (window.confirm(`Create ${acceptedCount} draft trip plan(s) for ${fmtDate(planDate)}?`)) saveMut.mutate(); }}>
            <Save size={14}/> {saveMut.isPending ? 'Saving…' : `Save ${acceptedCount} trips as draft plans`}
          </button>
        </div>
      </div>
    );
  };

  const renderDone = () => (
    <div className="card p-8 text-center space-y-3">
      <Check size={36} className="mx-auto text-green-600"/>
      <div className="text-lg font-semibold">Draft plans created for {fmtDate(planDate)}</div>
      <div className="text-sm text-gray-500">Review them in Trip Plans, edit if needed, then publish for executors.</div>
      <div className="flex justify-center gap-3">
        <button className="btn-secondary" onClick={() => { setResult(null); setStep(1); }}>Plan another day</button>
        <button className="btn-primary" onClick={() => navigate('/planning')}>Go to Trip Plans</button>
      </div>
    </div>
  );

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2 text-gray-800"><Zap size={20} className="text-[#0078d4]"/> Day Optimizer</h1>
          <p className="text-sm text-gray-500">Whole-day, whole-fleet plan across all plants — minimises km × tanker rate. Draft only; nothing is published.</p>
        </div>
        <div className="flex items-center gap-4">
          <StepDot num={1} label="Inputs" active={step === 1} done={step > 1}/>
          <StepDot num={2} label="Results" active={step === 2} done={step > 2}/>
          <StepDot num={3} label="Adopt" active={step === 3} done={false}/>
        </div>
      </div>
      {step === 1 && renderInputs()}
      {step === 2 && result && renderResults()}
      {step === 3 && renderDone()}
    </div>
  );
}
