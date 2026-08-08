// Analytics dashboard (Phase 1+2): date-range KPIs, daily TS gain/loss trend,
// route / tanker / BMCU leaderboards and delivery-point performance — every
// figure drills down to the trips behind it, and each trip links to its
// execution screen.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api, { getAnalyticsSummary, getDeliveryPoints } from '../../api';
import { X, ArrowUpDown, ExternalLink } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, Cell, ReferenceLine,
} from 'recharts';

const iso = d => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const monthStart = () => { const d = new Date(); d.setDate(1); return iso(d); };

const nf = (v, d = 0) => v == null ? '—'
  : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });

// Dashboard palette (validated: gain/loss/line pass CVD + contrast checks).
// Accents are decorative card/panel identities; gain & loss are semantic and
// reserved — never reused as accents.
const C = {
  gain: '#0e8a5f', loss: '#d92d20', line: '#7c3aed', neutral: '#8a8577',
  teal: '#0f766e', amber: '#b45309', violet: '#6d28d9', berry: '#a21caf',
  ink: '#1c1917', paper: '#fdfcfa',
};
const gainColor = v => v == null ? C.neutral : v < 0 ? C.loss : C.gain;
const tint = hex => hex + '14'; // ~8% alpha wash for card backgrounds

function Kpi({ label, value, sub, color, accent }) {
  const a = accent || C.teal;
  return (
    <div className="rounded-xl shadow-sm p-4 border"
         style={{ background: `linear-gradient(135deg, ${tint(a)}, #ffffff 65%)`,
                  borderColor: a + '33', borderTop: `3px solid ${a}` }}>
      <div className="text-xs font-medium" style={{ color: a }}>{label}</div>
      <div className="text-xl font-bold" style={{ color: color || C.ink }}>{value}</div>
      {sub && <div className="text-[11px] mt-0.5" style={{ color: '#78716c' }}>{sub}</div>}
    </div>
  );
}

// Sortable, clickable leaderboard table. Click a header to sort; click a row
// to drill down into the trips behind it.
function LeaderTable({ title, rows, cols, note, defaultSort, onRowClick, maxRows = 12, accent }) {
  const a = accent || C.teal;
  const [sort, setSort] = useState(defaultSort || null); // {key, dir}
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const val = r => {
      const c = cols.find(c2 => c2.key === sort.key);
      const v = c?.sortVal ? c.sortVal(r) : r[sort.key];
      return v == null ? (sort.dir === 'asc' ? Infinity : -Infinity) : v;
    };
    return [...rows].sort((a, b) => {
      const av = val(a), bv = val(b);
      if (typeof av === 'string' || typeof bv === 'string')
        return sort.dir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      return sort.dir === 'asc' ? av - bv : bv - av;
    });
  }, [rows, sort, cols]);

  const shown = showAll ? sorted : sorted.slice(0, maxRows);

  return (
    <div className="bg-white rounded-xl shadow-sm p-4 overflow-x-auto border"
         style={{ borderColor: a + '2e', borderLeft: `4px solid ${a}` }}>
      <div className="font-semibold text-sm flex items-center gap-2" style={{ color: C.ink }}>
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: a }} />
        {title}
      </div>
      {note && <div className="text-[11px] text-gray-400 mt-0.5 mb-1">{note}</div>}
      <table className="w-full text-xs mt-1.5">
        <thead>
          <tr className="text-left border-b select-none" style={{ color: '#78716c', background: tint(a) }}>
            {cols.map(c => (
              <th key={c.key}
                  className={`py-1.5 pr-3 cursor-pointer hover:text-gray-800 ${c.right ? 'text-right' : ''}`}
                  onClick={() => setSort(s => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
                {c.label}
                {sort?.key === c.key
                  ? <span className="ml-0.5 text-blue-600">{sort.dir === 'desc' ? '↓' : '↑'}</span>
                  : <ArrowUpDown size={9} className="inline ml-0.5 opacity-40" />}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 && <tr><td colSpan={cols.length} className="py-3 text-gray-400">No data</td></tr>}
          {shown.map((r, i) => (
            <tr key={i}
                className={`border-b border-gray-50 ${onRowClick ? 'cursor-pointer hover:bg-blue-50' : ''}`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {cols.map(c => (
                <td key={c.key} className={`py-1.5 pr-3 ${c.right ? 'text-right tabular-nums' : ''}`}
                    style={c.gain ? { color: gainColor(c.sortVal ? c.sortVal(r) : r[c.key]), fontWeight: 600 } : {}}>
                  {c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length > maxRows && (
        <button className="text-[11px] text-blue-600 mt-2 hover:underline" onClick={() => setShowAll(v => !v)}>
          {showAll ? 'Show less' : `Show all ${sorted.length}`}
        </button>
      )}
    </div>
  );
}

// Drill-down overlay: trips (or a BMCU's per-trip detail) behind a clicked figure.
function DrillPanel({ drill, from, to, dp, onClose }) {
  const navigate = useNavigate();
  const isBmcu = drill.type === 'bmcu';
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-drill', drill, from, to, dp],
    queryFn: () => {
      const base = { from, to, delivery_point_id: dp || undefined };
      if (isBmcu) return api.get('/analytics/bmcu-detail', { params: { ...base, bmcu_code: drill.value } }).then(r => r.data);
      const p = { ...base };
      if (drill.type === 'date')           p.date = drill.value;
      if (drill.type === 'route')          p.route_name = drill.value;
      if (drill.type === 'tanker')         p.tanker_number = drill.value;
      if (drill.type === 'delivery_point') p.delivery_point = drill.value;
      return api.get('/analytics/trips', { params: p }).then(r => r.data);
    },
  });

  const rows = data || [];
  const sum = k => rows.reduce((s, r) => s + (parseFloat(r[k]) || 0), 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center p-4 md:p-10" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-5xl max-h-[85vh] overflow-auto p-5"
           onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="font-bold text-gray-800">{drill.label}</div>
            <div className="text-[11px] text-gray-400">
              {from} → {to} · {rows.length} trip{rows.length === 1 ? '' : 's'}
              {isBmcu ? ' · Dispatch Vs RMRD for this BMCU' : ' · gains on acknowledged trips (Ack Vs RMRD)'}
            </div>
          </div>
          <button className="p-1.5 rounded-lg hover:bg-gray-100" onClick={onClose}><X size={16}/></button>
        </div>
        {isLoading ? <div className="py-8 text-gray-400 text-sm">Loading…</div> : (
          <table className="w-full text-xs mt-2">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="py-1.5 pr-3">Date</th>
                <th className="py-1.5 pr-3">Tanker</th>
                <th className="py-1.5 pr-3">Route</th>
                <th className="py-1.5 pr-3">Delivery Point</th>
                {!isBmcu && <th className="py-1.5 pr-3 text-right">Dispatch Kg</th>}
                {isBmcu  && <th className="py-1.5 pr-3 text-right">Dispatch Kg</th>}
                <th className="py-1.5 pr-3 text-right">RMRD Kg</th>
                {!isBmcu && <th className="py-1.5 pr-3 text-right">Ack Kg</th>}
                <th className="py-1.5 pr-3 text-right">Qty +/− Kg</th>
                <th className="py-1.5 pr-3 text-right">TS +/− Kg</th>
                <th className="py-1.5 pr-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-blue-50 cursor-pointer"
                    onClick={() => navigate(`/execution/${r.execution_id}`)}>
                  <td className="py-1.5 pr-3">{r.date}</td>
                  <td className="py-1.5 pr-3 font-semibold text-blue-700">{r.tanker_number || '—'}</td>
                  <td className="py-1.5 pr-3">{r.route_name || '—'}</td>
                  <td className="py-1.5 pr-3">{r.delivery_point}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{nf(r.disp_kgs)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{nf(r.rmrd_kgs)}</td>
                  {!isBmcu && <td className="py-1.5 pr-3 text-right tabular-nums">{r.has_ack ? nf(r.ack_kgs) : 'pending'}</td>}
                  <td className="py-1.5 pr-3 text-right tabular-nums font-semibold" style={{ color: gainColor(r.qty_gain_kgs) }}>{nf(r.qty_gain_kgs)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums font-semibold" style={{ color: gainColor(r.ts_gain) }}>{nf(r.ts_gain, 1)}</td>
                  <td className="py-1.5"><ExternalLink size={11} className="text-gray-300"/></td>
                </tr>
              ))}
              <tr className="font-bold bg-blue-50">
                <td className="py-1.5 pr-3" colSpan={4}>TOTAL</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{nf(sum('disp_kgs'))}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{nf(sum('rmrd_kgs'))}</td>
                {!isBmcu && <td className="py-1.5 pr-3 text-right tabular-nums">{nf(sum('ack_kgs'))}</td>}
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: gainColor(sum('qty_gain_kgs')) }}>{nf(sum('qty_gain_kgs'))}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums" style={{ color: gainColor(sum('ts_gain')) }}>{nf(sum('ts_gain'), 1)}</td>
                <td/>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const GAIN_COLS = [
  { key: 'trips', label: 'Trips', right: true },
  { key: 'ack_kgs', label: 'Delivered (Kg)', right: true, fmt: (_, r) => nf(r.ack?.kgs), sortVal: r => r.ack?.kgs },
  { key: 'qty_gain_kgs', label: 'Qty Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v) },
  { key: 'ts_gain', label: 'TS Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v, 1) },
  { key: 'ts_gain_pct', label: 'TS %', right: true, gain: true, fmt: v => v == null ? '—' : nf(v, 3) + ' %' },
];

export default function Analytics() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo]     = useState(today());
  const [dp, setDp]     = useState('');
  const [drill, setDrill] = useState(null); // {type, value, label}

  const { data: dps } = useQuery({
    queryKey: ['delivery-points'],
    queryFn: () => getDeliveryPoints().then(r => r.data),
  });
  const { data, isFetching } = useQuery({
    queryKey: ['analytics', from, to, dp],
    queryFn: () => getAnalyticsSummary({ from, to, delivery_point_id: dp || undefined }).then(r => r.data),
    enabled: !!from && !!to,
  });

  const k = data?.kpis;
  const daily = (data?.daily || []).map(d => ({ ...d, label: d.date.slice(8, 10) + '/' + d.date.slice(5, 7) }));

  const presets = [
    { label: 'Today', from: today(), to: today() },
    { label: 'Last 7 days', from: daysAgo(6), to: today() },
    { label: 'This month', from: monthStart(), to: today() },
    { label: 'Last 30 days', from: daysAgo(29), to: today() },
  ];

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="page-title">Analytics</h2>
          <p className="text-xs text-gray-500">
            Gain / loss analytics · Ack Vs RMRD basis · click any row or bar to drill down
            {isFetching && ' · loading…'}
          </p>
        </div>
        <div className="flex-1" />
        {presets.map(p => (
          <button key={p.label}
            className="text-xs px-2.5 py-1.5 rounded-lg border"
            style={from === p.from && to === p.to
              ? { background: C.teal, color: '#fff', borderColor: C.teal }
              : { background: '#fff', color: '#57534e', borderColor: '#e7e5e4' }}
            onClick={() => { setFrom(p.from); setTo(p.to); }}>
            {p.label}
          </button>
        ))}
        <input type="date" className="input text-xs" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        <input type="date" className="input text-xs" value={to} min={from} onChange={e => setTo(e.target.value)} />
        <select className="input text-xs" value={dp} onChange={e => setDp(e.target.value)}>
          <option value="">All delivery points</option>
          {(dps || []).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Trips" value={nf(k?.trips)} sub={`${nf(k?.acked_trips)} acknowledged`} accent={C.violet} />
        <Kpi label="Milk Handled (Dispatch)" value={`${nf(k?.disp?.kgs)} Kg`} sub={`${nf(k?.disp?.litres)} L`} accent={C.amber} />
        <Kpi label="Delivered (Ack)" value={`${nf(k?.ack?.kgs)} Kg`} sub={`${nf(k?.ack?.litres)} L`} accent={C.teal} />
        <Kpi label="Qty Gain / Loss" value={`${nf(k?.qty_gain_kgs)} Kg`} color={gainColor(k?.qty_gain_kgs)}
             accent={gainColor(k?.qty_gain_kgs)} sub={`${nf(k?.qty_gain_litres)} L · Ack − RMRD`} />
        <Kpi label="TS Gain / Loss" value={`${nf(k?.ts_gain, 1)} Kg`} color={gainColor(k?.ts_gain)}
             accent={gainColor(k?.ts_gain)} sub={k?.ts_gain_pct != null ? `${nf(k.ts_gain_pct, 3)} %` : ''} />
        <Kpi label="Stage Split (Kg)" value={`${nf(k?.stage_transit_kgs)} transit`} color={gainColor(k?.stage_transit_kgs)}
             accent={C.berry} sub={`${nf(k?.stage_unload_kgs)} at unloading`} />
      </div>

      {/* Daily trend — click a bar to open that day's trips */}
      <div className="bg-white rounded-xl shadow-sm p-4 border"
           style={{ borderColor: C.violet + '2e', borderLeft: `4px solid ${C.violet}` }}>
        <div className="font-semibold text-sm mb-2 flex items-center gap-2" style={{ color: C.ink }}>
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: C.violet }} />
          Daily TS Gain / Loss (Kg) — click a day to drill down
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v, n) => [nf(v, 1), n]} />
            <ReferenceLine y={0} stroke={C.neutral} />
            <Bar dataKey="ts_gain" name="TS gain/loss" cursor="pointer"
                 onClick={d => d?.date && setDrill({ type: 'date', value: d.date, label: `Trips on ${d.date}` })}>
              {daily.map((d, i) => <Cell key={i} fill={gainColor(d.ts_gain)} />)}
            </Bar>
            <Line dataKey="qty_gain_kgs" name="Qty gain/loss (Kg)" stroke={C.line} dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Delivery point performance */}
      <LeaderTable
        title="Delivery Point Performance"
        accent={C.teal}
        note="Delivered = acknowledged quantity at the plant · Gain/Loss = Ack − RMRD · click a row for its trips"
        rows={data?.delivery_points || []}
        defaultSort={{ key: 'ack_kgs', dir: 'desc' }}
        onRowClick={r => setDrill({ type: 'delivery_point', value: r.delivery_point, label: `Trips delivered to ${r.delivery_point}` })}
        cols={[{ key: 'delivery_point', label: 'Delivery Point' }, ...GAIN_COLS]}
      />

      {/* Routes */}
      <LeaderTable
        title="Route Performance (Ack Vs RMRD · worst first)"
        accent={C.amber}
        note="Click a route for its trips · sort any column"
        rows={data?.routes || []}
        defaultSort={{ key: 'ts_gain', dir: 'asc' }}
        onRowClick={r => setDrill({ type: 'route', value: r.route_name, label: `Trips on route ${r.route_name}` })}
        cols={[{ key: 'route_name', label: 'Route' }, ...GAIN_COLS]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LeaderTable
          title="Worst BMCUs (TS loss · Dispatch Vs RMRD)"
          accent={C.loss}
          rows={(data?.bmcus || []).filter(b => (b.ts_gain ?? 0) < 0)}
          defaultSort={{ key: 'ts_gain', dir: 'asc' }}
          onRowClick={r => setDrill({ type: 'bmcu', value: r.bmcu_code, label: `${r.bmcu_code} — ${r.bmcu_name}` })}
          cols={[
            { key: 'bmcu_code', label: 'Code' },
            { key: 'bmcu_name', label: 'BMCU' },
            { key: 'rmrd_kgs', label: 'RMRD (Kg)', right: true, fmt: v => nf(v) },
            { key: 'qty_gain_kgs', label: 'Qty +/− (Kg)', right: true, gain: true, fmt: v => nf(v) },
            { key: 'ts_gain', label: 'TS +/− (Kg)', right: true, gain: true, fmt: v => nf(v, 1) },
            { key: 'ts_gain_pct', label: 'TS %', right: true, gain: true, fmt: v => v == null ? '—' : nf(v, 3) + ' %' },
          ]}
        />
        <LeaderTable
          title="Best BMCUs (TS gain · Dispatch Vs RMRD)"
          accent={C.gain}
          rows={(data?.bmcus || []).filter(b => (b.ts_gain ?? 0) > 0)}
          defaultSort={{ key: 'ts_gain', dir: 'desc' }}
          onRowClick={r => setDrill({ type: 'bmcu', value: r.bmcu_code, label: `${r.bmcu_code} — ${r.bmcu_name}` })}
          cols={[
            { key: 'bmcu_code', label: 'Code' },
            { key: 'bmcu_name', label: 'BMCU' },
            { key: 'rmrd_kgs', label: 'RMRD (Kg)', right: true, fmt: v => nf(v) },
            { key: 'qty_gain_kgs', label: 'Qty +/− (Kg)', right: true, gain: true, fmt: v => nf(v) },
            { key: 'ts_gain', label: 'TS +/− (Kg)', right: true, gain: true, fmt: v => nf(v, 1) },
            { key: 'ts_gain_pct', label: 'TS %', right: true, gain: true, fmt: v => v == null ? '—' : nf(v, 3) + ' %' },
          ]}
        />
      </div>

      <LeaderTable
        title="Tanker Performance (Ack Vs RMRD · worst first)"
        accent={C.berry}
        note="TS loss / 1000 L normalizes small vs large tankers · click a tanker for its trips"
        rows={data?.tankers || []}
        defaultSort={{ key: 'ts_gain', dir: 'asc' }}
        onRowClick={r => setDrill({ type: 'tanker', value: r.tanker_number, label: `Trips of tanker ${r.tanker_number}` })}
        cols={[
          { key: 'tanker_number', label: 'Tanker' },
          ...GAIN_COLS,
          { key: 'per_1000', label: 'TS / 1000 L', right: true, gain: true,
            sortVal: r => r.ack?.litres > 0 && r.ts_gain != null ? r.ts_gain / r.ack.litres * 1000 : null,
            fmt: (_, r) => r.ack?.litres > 0 && r.ts_gain != null ? nf(r.ts_gain / r.ack.litres * 1000, 2) : '—' },
        ]}
      />

      {drill && <DrillPanel drill={drill} from={from} to={to} dp={dp} onClose={() => setDrill(null)} />}
    </div>
  );
}
