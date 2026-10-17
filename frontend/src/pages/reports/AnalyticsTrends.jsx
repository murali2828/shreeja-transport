// Analytics → Trends (owner, 2026-10-17): month on month, this FY vs last FY
// and YTD for higher management. Data from GET /api/analytics/trends (built on
// services/transportCumulative.js — the same figures as Reports → Tanker
// Utilisation — plus TS gain / loss per month for portal trips). Independent of
// the page's date filter. Also exports the small period charts the page's
// sections show above their tables (same data already loaded, no extra calls).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, BarChart, LineChart, Bar, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, Cell, ReferenceLine, Legend,
} from 'recharts';
import { getAnalyticsTrends } from '../../api';

export const TC = {
  cur: '#005ba3', prev: '#94a3b8', cost: '#d97706', toll: '#f59e0b', fixed: '#fcd34d',
  loss: '#dc2626', gain: '#16a34a', ink: '#1f2937', grid: '#e5e7eb',
};
const nf = (v, d = 0) => v == null || Number.isNaN(Number(v)) ? '—'
  : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
// Compact Indian axis ticks: 1.2 Cr, 35.4 L, 12 K
export const short = v => {
  if (v == null) return '';
  const a = Math.abs(v);
  if (a >= 1e7) return `${nf(v / 1e7, 1)} Cr`;
  if (a >= 1e5) return `${nf(v / 1e5, 1)} L`;
  if (a >= 1e3) return `${nf(v / 1e3, 0)} K`;
  return nf(v, a < 10 ? 2 : 0);
};
const fyNow = () => { const d = new Date(); return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; };
const hasAny = (rows, ...keys) => (rows || []).some(r => keys.some(k => r[k] != null && r[k] !== 0));

// Tooltip with en-IN numbers and a per-series unit / decimals.
export function NiceTip({ active, payload, label, fmt = {} }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border rounded-lg shadow px-3 py-2 text-xs">
      <div className="font-semibold mb-1">{label}</div>
      {payload.map(p => {
        const f = fmt[p.dataKey] || {};
        return (
          <div key={p.dataKey} className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: p.color || p.fill }} />
            <span className="text-gray-600">{p.name}:</span>
            <span className="font-semibold">{p.value == null ? 'no data' : `${f.pre || ''}${nf(p.value, f.d ?? 0)}${f.unit || ''}`}</span>
          </div>
        );
      })}
    </div>
  );
}

function ChartCard({ title, note, children, empty }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border p-4" style={{ borderLeft: `4px solid ${TC.cur}` }}>
      <div className="font-semibold text-sm" style={{ color: TC.ink }}>{title}</div>
      {note && <div className="text-[11px] text-gray-500 mb-2">{note}</div>}
      {empty ? <div className="h-56 flex items-center justify-center text-sm text-gray-400">No data for this period</div>
        : <div className="h-64">{children}</div>}
    </div>
  );
}

// Δ tile: goodUp = true when an increase is good (milk), false when bad (cost).
function YtdTile({ label, cur, prev, d = 0, unit = '', pre = '', goodUp = true, neutral = false }) {
  const diff = cur != null && prev != null ? cur - prev : null;
  const pct = diff != null && prev ? diff / Math.abs(prev) * 100 : null;
  const good = diff == null || diff === 0 || neutral ? null : (diff > 0) === goodUp;
  const col = good == null ? '#6b7280' : good ? TC.gain : TC.loss;
  return (
    <div className="bg-white rounded-xl border shadow-sm p-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-lg font-bold" style={{ color: TC.cur }}>{cur == null ? '—' : `${pre}${nf(cur, d)}${unit}`}</div>
      <div className="text-[11px] text-gray-500">last FY {prev == null ? '—' : `${pre}${nf(prev, d)}${unit}`}</div>
      <div className="text-xs font-semibold" style={{ color: col }}>
        {diff == null ? 'no comparison' : `${diff > 0 ? '▲' : diff < 0 ? '▼' : '•'} ${pre}${nf(Math.abs(diff), d)}${unit}${pct != null ? ` (${pct > 0 ? '+' : ''}${nf(pct, 1)} %)` : ''}`}
      </div>
    </div>
  );
}

export default function AnalyticsTrends() {
  const [open, setOpen] = useState(true);
  const [fy, setFy] = useState(fyNow());
  const [status, setStatus] = useState('all');
  const { data, isFetching, error } = useQuery({
    queryKey: ['analytics-trends', fy, status],
    queryFn: () => getAnalyticsTrends({ fy, status }).then(r => r.data),
    enabled: open, staleTime: 5 * 60 * 1000,
  });
  const fys = Array.from({ length: 5 }, (_, i) => fyNow() - i);
  const fl = y => `${y}-${String(y + 1).slice(2)}`;
  const cur = `FY ${fl(fy)}`, prv = `FY ${fl(fy - 1)}`;
  // One row per month with this FY and last FY side by side.
  const rows = (data?.months || []).map((m, i) => {
    const p = data.prev_months[i] || {};
    return {
      label: m.label.slice(0, 3), full: m.label,
      milk: m.milk_litres, milk_p: p.milk_litres,
      cpl: m.cost_per_litre_all_in, cpl_p: p.cost_per_litre_all_in,
      util: m.utilisation_pct, util_p: p.utilisation_pct,
      amount: m.amount, toll: m.toll_amount, fixed: m.fixed_cost,
      trips: m.trips, km: m.total_km, avg_km: m.avg_km,
      ts: m.ts_gain_kg, src: m.source,
    };
  });
  const y = data?.ytd || {}, py = data?.prev_ytd || {};
  const tsNoData = rows.filter(r => r.trips && r.ts == null).map(r => r.label);
  const axis = { tick: { fontSize: 11 }, stroke: '#9ca3af' };

  return (
    <div className="bg-sky-50 rounded-xl border border-sky-200 p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="flex items-center gap-1 font-semibold" style={{ color: TC.cur }} onClick={() => setOpen(o => !o)}>
          {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />} Trends · month on month, this year vs last year, YTD
        </button>
        <div className="flex-1" />
        {open && <>
          <label className="text-xs text-gray-600">FY
            <select className="ml-1 border rounded px-2 py-1 text-xs" value={fy} onChange={e => setFy(parseInt(e.target.value))}>
              {fys.map(v => <option key={v} value={v}>{fl(v)}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-600">Billing runs
            <select className="ml-1 border rounded px-2 py-1 text-xs" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="all">All runs</option><option value="approved">Approved only</option>
            </select>
          </label>
          {isFetching && <span className="text-xs text-gray-500">loading…</span>}
        </>}
      </div>
      {open && error && <div className="text-sm text-red-600">{error.response?.data?.error || error.message}</div>}
      {open && data && <>
        <div className="text-[11px] text-gray-600">
          YTD = April to {data.ytd_months ? rows[data.ytd_months - 1]?.full : '—'} of {cur} vs the same months of {prv}.
          Milk, trips, km and cost as on Tanker Utilisation (FY workbook up to Aug-26, billing-run lines after; the current month fills as runs are executed).
          Cost all-in = trip amount + toll + 9,000-km fixed cost.
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
          <YtdTile label="Milk received (L)" cur={y.milk_litres} prev={py.milk_litres} goodUp />
          <YtdTile label="Trips" cur={y.trips} prev={py.trips} neutral />
          <YtdTile label="Km" cur={y.total_km} prev={py.total_km} goodUp={false} />
          <YtdTile label="Transport cost all-in" cur={y.total_cost} prev={py.total_cost} pre="₹" goodUp={false} />
          <YtdTile label="Cost / L all-in" cur={y.cost_per_litre_all_in} prev={py.cost_per_litre_all_in} pre="₹" d={3} goodUp={false} />
          <YtdTile label="Utilisation %" cur={y.utilisation_pct} prev={py.utilisation_pct} d={1} unit=" %" goodUp />
          <YtdTile label={`TS gain/loss (kg${y.ts_months ? `, ${y.ts_months} portal mo.` : ''})`} cur={y.ts_gain_kg} prev={py.ts_gain_kg} d={0} goodUp />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title={`Milk received & cost per litre (all-in) · ${cur}`} note="Bars: milk received (L, plant acknowledgement) · line: ₹/L all-in (right axis)"
            empty={!hasAny(rows, 'milk', 'cpl')}>
            <ResponsiveContainer>
              <ComposedChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis yAxisId="l" tickFormatter={short} {...axis} label={{ value: 'Litres', angle: -90, position: 'insideLeft', fontSize: 11 }} />
                <YAxis yAxisId="r" orientation="right" tickFormatter={v => `₹${nf(v, 2)}`} {...axis} />
                <Tooltip content={<NiceTip fmt={{ milk: { unit: ' L' }, cpl: { pre: '₹', d: 3 } }} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="l" dataKey="milk" name="Milk received (L)" fill={TC.cur} radius={[3, 3, 0, 0]} />
                <Line yAxisId="r" dataKey="cpl" name="₹/L all-in" stroke={TC.cost} strokeWidth={2} dot connectNulls={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Milk received · ${cur} vs ${prv}`} note="Litres per month" empty={!hasAny(rows, 'milk', 'milk_p')}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis tickFormatter={short} {...axis} />
                <Tooltip content={<NiceTip fmt={{ milk: { unit: ' L' }, milk_p: { unit: ' L' } }} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line dataKey="milk" name={cur} stroke={TC.cur} strokeWidth={2.5} dot />
                <Line dataKey="milk_p" name={prv} stroke={TC.prev} strokeWidth={2} strokeDasharray="5 4" dot />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Cost per litre (all-in) · ${cur} vs ${prv}`} note="₹ per litre received" empty={!hasAny(rows, 'cpl', 'cpl_p')}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis tickFormatter={v => `₹${nf(v, 2)}`} domain={['auto', 'auto']} {...axis} />
                <Tooltip content={<NiceTip fmt={{ cpl: { pre: '₹', d: 3 }, cpl_p: { pre: '₹', d: 3 } }} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line dataKey="cpl" name={cur} stroke={TC.cur} strokeWidth={2.5} dot />
                <Line dataKey="cpl_p" name={prv} stroke={TC.prev} strokeWidth={2} strokeDasharray="5 4" dot />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Tanker utilisation % · ${cur} vs ${prv}`} note="Milk received ÷ tanker capacity of the trips · dashed red = 95 % target" empty={!hasAny(rows, 'util', 'util_p')}>
            <ResponsiveContainer>
              <LineChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis domain={[dataMin => Math.max(0, Math.floor(Math.min(dataMin, 95) - 5)), 100]} tickFormatter={v => `${v}%`} {...axis} />
                <Tooltip content={<NiceTip fmt={{ util: { d: 1, unit: ' %' }, util_p: { d: 1, unit: ' %' } }} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={95} stroke={TC.loss} strokeDasharray="4 4" label={{ value: '95 %', fontSize: 10, fill: TC.loss, position: 'right' }} />
                <Line dataKey="util" name={cur} stroke={TC.cur} strokeWidth={2.5} dot />
                <Line dataKey="util_p" name={prv} stroke={TC.prev} strokeWidth={2} strokeDasharray="5 4" dot />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Transport cost per month · ${cur}`} note="Trip amount + toll + 9,000-km fixed cost (₹) · toll / fixed cost appear once uploaded for the month"
            empty={!hasAny(rows, 'amount', 'toll', 'fixed')}>
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis tickFormatter={v => `₹${short(v)}`} {...axis} />
                <Tooltip content={<NiceTip fmt={{ amount: { pre: '₹' }, toll: { pre: '₹' }, fixed: { pre: '₹' } }} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="amount" stackId="c" name="Trip amount" fill={TC.cur} />
                <Bar dataKey="toll" stackId="c" name="Toll" fill={TC.cost} />
                <Bar dataKey="fixed" stackId="c" name="Fixed cost (9,000 km)" fill={TC.fixed} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`Trips & km per month · ${cur}`} note="Bars: trips (left) and km (right) · line: average km per trip (right)" empty={!hasAny(rows, 'trips', 'km')}>
            <ResponsiveContainer>
              <ComposedChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis yAxisId="t" tickFormatter={short} {...axis} />
                <YAxis yAxisId="k" orientation="right" tickFormatter={short} {...axis} />
                <Tooltip content={<NiceTip fmt={{ trips: {}, km: { unit: ' km' }, avg_km: { d: 1, unit: ' km' } }} />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="t" dataKey="trips" name="Trips" fill={TC.cur} radius={[3, 3, 0, 0]} />
                <Bar yAxisId="k" dataKey="km" name="Km" fill={TC.prev} radius={[3, 3, 0, 0]} />
                <Line yAxisId="k" dataKey="avg_km" name="Avg km / trip" stroke={TC.cost} strokeWidth={2} dot />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={`TS gain / loss per month (kg) · ${cur}`}
            note={`Ack − RMRD, Kg Fat + Kg SNF, acknowledged portal trips · green = gain, red = loss${tsNoData.length ? ` · no TS for ${tsNoData.join(', ')} (FY workbook months carry no RMRD / ack detail)` : ''}`}
            empty={!hasAny(rows, 'ts')}>
            <ResponsiveContainer>
              <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={TC.grid} vertical={false} />
                <XAxis dataKey="label" {...axis} />
                <YAxis tickFormatter={short} {...axis} />
                <ReferenceLine y={0} stroke="#6b7280" />
                <Tooltip content={<NiceTip fmt={{ ts: { unit: ' kg' } }} />} />
                <Bar dataKey="ts" name="TS gain/loss (kg)">
                  {rows.map((r, i) => <Cell key={i} fill={r.ts == null ? TC.prev : r.ts < 0 ? TC.loss : TC.gain} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </>}
    </div>
  );
}

// ── Compact period charts for the page's sections ──────────────────────────
// Horizontal bars of one metric per row; red / green by sign when signed.
export function HBarChart({ title, rows, labelKey, valueKey, valueName, unit = '', signed = false, color = TC.cur, max = 10 }) {
  const data = (rows || []).filter(r => r[valueKey] != null).slice(0, max)
    .map(r => ({ name: String(r[labelKey] ?? '—'), v: r[valueKey] }));
  return (
    <div className="bg-white rounded-xl shadow-sm border p-3">
      <div className="text-xs font-semibold mb-1" style={{ color: TC.ink }}>{title}</div>
      {!data.length ? <div className="h-24 flex items-center justify-center text-xs text-gray-400">No data for this period</div> : (
        <div style={{ height: Math.max(120, data.length * 26 + 30) }}>
          <ResponsiveContainer>
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 20, left: 10, bottom: 0 }}>
              <CartesianGrid stroke={TC.grid} horizontal={false} />
              <XAxis type="number" tickFormatter={short} tick={{ fontSize: 10 }} />
              <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10 }} tickFormatter={s => s.length > 22 ? s.slice(0, 21) + '…' : s} />
              {signed && <ReferenceLine x={0} stroke="#6b7280" />}
              <Tooltip content={<NiceTip fmt={{ v: { unit } }} />} />
              <Bar dataKey="v" name={valueName}>
                {data.map((d, i) => <Cell key={i} fill={signed ? (d.v < 0 ? TC.loss : TC.gain) : color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Vertical bars (categories in their given order).
export function VBarChart({ title, rows, labelKey, valueKey, valueName, unit = '', signed = false, color = TC.cur, colors }) {
  const data = (rows || []).map(r => ({ name: String(r[labelKey] ?? '—'), v: r[valueKey] }));
  const any = data.some(d => d.v != null && d.v !== 0);
  return (
    <div className="bg-white rounded-xl shadow-sm border p-3">
      <div className="text-xs font-semibold mb-1" style={{ color: TC.ink }}>{title}</div>
      {!any ? <div className="h-24 flex items-center justify-center text-xs text-gray-400">No data for this period</div> : (
        <div className="h-44">
          <ResponsiveContainer>
            <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={TC.grid} vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tickFormatter={short} tick={{ fontSize: 10 }} />
              {signed && <ReferenceLine y={0} stroke="#6b7280" />}
              <Tooltip content={<NiceTip fmt={{ v: { unit } }} />} />
              <Bar dataKey="v" name={valueName} radius={[3, 3, 0, 0]}>
                {data.map((d, i) => <Cell key={i} fill={colors ? colors[i] : signed ? (d.v < 0 ? TC.loss : TC.gain) : color} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Tankers per average-fill band (< 80, 80–90, 90–95, ≥ 95 %).
export function fillBands(tankers) {
  const b = [['< 80 %', 0, 80, TC.loss], ['80–90 %', 80, 90, TC.cost], ['90–95 %', 90, 95, TC.fixed], ['≥ 95 %', 95, Infinity, TC.gain]];
  const rows = b.map(([band, lo, hi, color]) => ({ band, color,
    n: (tankers || []).filter(t => t.avg_fill_pct != null && t.trips > 0 && t.avg_fill_pct >= lo && t.avg_fill_pct < hi).length }));
  return rows;
}
