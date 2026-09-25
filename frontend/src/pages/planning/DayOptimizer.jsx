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
  getDayOptimizerPreview, runDayOptimizer, prefetchOptimizerDistances, saveOptimizerAsPlans,
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

  const { data: preview, isLoading: loadingPreview, isError: previewError, error: previewErr, refetch } = useQuery({
    queryKey: ['day-optimizer-preview', planDate, shift],
    queryFn: () => getDayOptimizerPreview({ plan_for_date: planDate, shift }).then(r => r.data),
    enabled: !!planDate,
    retry: false,
  });

  useEffect(() => {
    if (preview?.constraints && !Object.keys(constraints).length) setConstraints(preview.constraints);
  }, [preview]); // eslint-disable-line react-hooks/exhaustive-deps

  const setC = (k, v) => setConstraints(p => ({ ...p, [k]: v }));

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
  const fleetCapacity = availableFleet.reduce((s, f) => s + f.capacity_litres * (constraints.max_trips_per_tanker_per_day || 2), 0);

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
    mutationFn: () => runDayOptimizer({
      plan_for_date: planDate, shift, constraints,
      demand_overrides: Object.entries(demandEdits)
        .filter(([, v]) => v !== '' && v !== undefined)
        .map(([k, v]) => { const [bmcu_id, sh] = k.split('|'); return { bmcu_id: Number(bmcu_id), shift: sh, litres: parseFloat(v) || 0 }; }),
      exclude_tanker_ids: Object.keys(excludedTankers).filter(k => excludedTankers[k]).map(Number),
    }).then(r => r.data),
    onSuccess: (d) => {
      setResult(d);
      setAccepted(Object.fromEntries(d.trips.map(t => [t.opt_trip_id, true])));
      setStep(2);
      toast.success(`${d.totals.trips} trips planned — ${inr(d.totals.cost)}`);
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
        </div>
        <div className="text-xs text-gray-400 mt-2">Defaults: fill floor 85 %, 6 BMCUs, 450 km, 2 trips per tanker per day. Cost = km × Tanker Rate Master rate (Point to Point for one BMCU, else BMCU/CC to Dairy/CC).</div>
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
                    <td className="table-td"><span className={`badge ${d.method === 'none' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}>{d.method}</span></td>
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
                      <td className="table-td">{f.available ? <span className="badge bg-green-50 text-green-700">available</span> : <span className="text-red-600" title={f.reason}>{f.reason}</span>}</td>
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

      <div className="flex justify-end">
        <button className="btn-primary flex items-center gap-2" disabled={runMut.isPending || !preview}
          onClick={() => runMut.mutate()}>
          {runMut.isPending ? <><RefreshCw size={14} className="animate-spin"/> Optimising… (up to {Math.round((constraints.time_budget_ms || 8000) / 1000)} s)</> : <><Zap size={14}/> Run Day Optimizer</>}
        </button>
      </div>
    </div>
  );

  // ─── Step 2: Results ──────────────────────────────────────────────────────
  const renderResults = () => {
    const { totals, trips, comparison, warnings, unserved, excluded_tankers } = result;
    const byPlant = {};
    for (const t of trips) (byPlant[t.plant_name] ||= []).push(t);
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <StatCard icon={Route} label="Trips" value={nf(totals.trips)} sub={`${nf(totals.litres)} L`}/>
          <StatCard icon={MapPin} label="Total km" value={nf(totals.km, 1)} color="purple"/>
          <StatCard icon={IndianRupee} label="Total cost" value={inr(totals.cost)} color="green"/>
          <StatCard icon={IndianRupee} label="Cost / litre" value={inr(totals.cost_per_litre, 3)} color="green"/>
          <StatCard icon={Truck} label="Avg fill" value={`${nf(totals.avg_fill_pct, 1)} %`} sub={`${totals.below_fill_floor_trips} below floor`} color={totals.avg_fill_pct >= 85 ? 'green' : 'amber'}/>
          <StatCard icon={Info} label="Estimated legs" value={nf(totals.estimated_legs)} color={totals.estimated_legs ? 'amber' : 'blue'}/>
        </div>

        {comparison && (
          <div className="card p-4">
            <div className="text-sm font-semibold mb-2 flex items-center gap-2">
              Comparison — {comparison.source === 'actual_plans' ? `actual plans for ${fmtDate(comparison.date)}` : `same weekday last week (${fmtDate(comparison.date)})`}
            </div>
            <table className="text-sm">
              <thead><tr className="text-xs text-gray-500"><th className="text-left pr-6"></th><th className="text-right pr-6">Optimizer</th><th className="text-right pr-6">Actual</th><th className="text-right">Δ</th></tr></thead>
              <tbody>
                {[
                  ['Trips', nf(totals.trips), nf(comparison.trips), comparison.delta.trips, '', 0],
                  ['Km', nf(totals.km, 1), nf(comparison.km, 1), comparison.delta.km, ' km', 1],
                  ['Litres', nf(totals.litres), nf(comparison.litres), comparison.delta.litres, ' L', 0, false],
                  ['Cost', inr(totals.cost), inr(comparison.cost), comparison.delta.cost, ' ₹', 0],
                  ['Cost / litre', inr(totals.cost_per_litre, 3), inr(comparison.cost_per_litre, 3), comparison.delta.cost_per_litre, ' ₹', 3],
                  ['Avg fill %', nf(totals.avg_fill_pct, 1), nf(comparison.avg_fill_pct, 1), comparison.delta.avg_fill_pct, ' %', 1, false],
                ].map(([l, a, b, d, u, dg, lower]) => (
                  <tr key={l}><td className="pr-6 py-0.5 text-gray-600">{l}</td><td className="text-right pr-6 font-semibold">{a}</td><td className="text-right pr-6">{b}</td>
                    <td className="text-right"><Delta value={d} unit={u} digits={dg} lowerIsBetter={lower !== false}/></td></tr>
                ))}
              </tbody>
            </table>
            {comparison.note && <div className="text-xs text-gray-500 mt-2">{comparison.note}</div>}
          </div>
        )}

        {warnings?.length > 0 && (
          <div className="card p-3 border-amber-200 bg-amber-50 text-xs text-amber-800 space-y-1">
            {warnings.map((w, i) => <div key={i} className="flex items-center gap-2"><AlertTriangle size={12}/> {w}</div>)}
          </div>
        )}

        {Object.entries(byPlant).map(([plant, list]) => (
          <div key={plant} className="card">
            <div className="card-header text-sm font-semibold flex items-center gap-2"><Factory size={14}/> {plant}
              <span className="text-xs text-gray-500 font-normal">{list.length} trips · {nf(list.reduce((s, t) => s + t.total_qty_litres, 0))} L · {inr(list.reduce((s, t) => s + t.cost, 0))}</span></div>
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
                      <td className="table-td"><span className="font-mono font-semibold">{t.tanker_number}</span><div className="text-gray-400">{nf(t.capacity_litres)} L · {t.transport_type}</div></td>
                      <td className="table-td" title={t.tanker_reason}>{t.bmcus.map(b => `${b.bmcu_code} (${nf(b.expected_qty_litres)} L, ${nf(b.leg_km, 1)} km${b.leg_is_estimated ? '~' : ''})`).join(' → ')}
                        <span className="text-gray-400"> → plant {nf(t.return_leg.leg_km, 1)} km{t.return_leg.leg_is_estimated ? '~' : ''}</span></td>
                      <td className="table-td text-right font-semibold">{nf(t.total_qty_litres)}</td>
                      <td className="table-td"><FillBar pct={t.fill_pct}/></td>
                      <td className="table-td text-right">{nf(t.km, 1)}</td>
                      <td className="table-td text-right">{nf(t.rate_per_km, 2)}</td>
                      <td className="table-td text-right font-semibold">{inr(t.cost)}</td>
                      <td className="table-td text-right">{nf(t.cost_per_litre, 3)}</td>
                      <td className="table-td">
                        {t.flags.below_fill_floor && <span className="badge bg-amber-50 text-amber-700 mr-1">below floor</span>}
                        {t.flags.estimated_legs > 0 && <span className="badge bg-gray-100 text-gray-600">{t.flags.estimated_legs} est. leg{t.flags.estimated_legs > 1 ? 's' : ''}</span>}
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
