// Analytics dashboard (Phase 1+2): date-range KPIs, daily TS gain/loss trend,
// route / tanker / BMCU leaderboards and delivery-point performance — every
// figure drills down to the trips behind it, and each trip links to its
// execution screen.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import api, { getAnalyticsSummary, getDeliveryPoints, getRoutes, getTankers } from '../../api';
import { X, ArrowUpDown, ExternalLink, Download, RefreshCw } from 'lucide-react';
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
const AMBER = '#b45309';
// Spec thresholds: TS% green >= 0, amber 0..-0.15%, red < -0.15%;
// qty green >= 0, amber within -0.1% of RMRD kgs, red beyond.
const tsStatusColor = pct => pct == null ? C.neutral : pct >= 0 ? C.gain : pct >= -0.15 ? AMBER : C.loss;
const qtyStatusColor = (kgs, rmrdKgs) => {
  if (kgs == null) return C.neutral;
  if (kgs >= 0) return C.gain;
  return rmrdKgs > 0 && Math.abs(kgs) / rmrdKgs * 100 <= 0.1 ? AMBER : C.loss;
};
// "vs previous period" delta line for a KPI sub-label
const delta = (cur, prev, unit = 'Kg', d = 0) => {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '•';
  return `${arrow} ${nf(Math.abs(diff), d)} ${unit} vs prev period`;
};
const tint = hex => hex + '14'; // ~8% alpha wash for card backgrounds
// Capacity-fill bands: >=80% green, 60-80 amber, <60 red
const fillColor = pct => pct == null ? C.neutral : pct >= 80 ? C.gain : pct >= 60 ? AMBER : C.loss;
// Freshness bands (avg shifts lifted per collection): <=1.5 green, <=2.5 amber, worse red
const shiftsColor = v => v == null ? C.neutral : v <= 1.5 ? C.gain : v <= 2.5 ? AMBER : C.loss;

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
function DrillPanel({ drill, from, to, dp, route, tanker, onClose }) {
  const navigate = useNavigate();
  const isBmcu = drill.type === 'bmcu';
  const { data, isLoading } = useQuery({
    queryKey: ['analytics-drill', drill, from, to, dp, route, tanker],
    queryFn: () => {
      const base = { from, to, delivery_point_id: dp || undefined,
        route_name: route || undefined, tanker_number: tanker || undefined };
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

// Exceptions bar: pending acks / over-capacity loads / big single-trip TS
// losses. Each card expands into the offending trips (click → execution).
function AlertsRow({ from, to, dp, route, tanker }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(null); // 'pending' | 'overcap' | 'loss'
  const { data } = useQuery({
    queryKey: ['analytics-alerts', from, to, dp, route, tanker],
    queryFn: () => api.get('/analytics/alerts', { params: { from, to, delivery_point_id: dp || undefined,
      route_name: route || undefined, tanker_number: tanker || undefined } }).then(r => r.data),
    enabled: !!from && !!to,
  });
  if (!data) return null;
  const overdue = data.pending_acks.filter(p => p.overdue);
  const cards = [
    { key: 'pending', n: data.pending_acks.length, rows: data.pending_acks,
      label: 'Pending Acknowledgements', sub: overdue.length ? `${overdue.length} overdue > 24h` : 'none overdue',
      severe: overdue.length > 0,
      detail: r => `${r.hours} h waiting${r.overdue ? ' · OVERDUE' : ''}` },
    { key: 'overcap', n: data.over_capacity.length, rows: data.over_capacity,
      label: 'Loads Over 110% Capacity', sub: 'dispatch vs registered capacity',
      severe: data.over_capacity.length > 0,
      detail: r => `${nf(r.disp_litres)} L on ${nf(r.capacity_litres)} L tanker (+${r.over_pct}%)` },
    { key: 'loss', n: data.big_ts_loss.length, rows: data.big_ts_loss,
      label: 'Big TS Losses (> 25 Kg / trip)', sub: 'Ack Vs RMRD',
      severe: data.big_ts_loss.length > 0,
      detail: r => `${nf(r.ts_gain, 1)} Kg TS` },
  ];
  if (cards.every(c => c.n === 0)) return (
    <div className="rounded-xl p-3 text-xs font-semibold border"
         style={{ background: tint(C.gain), borderColor: C.gain + '55', color: C.gain }}>
      ✓ No exceptions in this period — no pending acks, over-capacity loads or big TS losses.
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cards.map(c => (
          <button key={c.key} onClick={() => setOpen(o => o === c.key ? null : c.key)}
            className="rounded-xl p-3 text-left border transition-shadow hover:shadow-md"
            style={{ background: c.n === 0 ? tint(C.gain) : tint(C.loss),
                     borderColor: (c.n === 0 ? C.gain : C.loss) + '55' }}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold" style={{ color: c.n === 0 ? C.gain : C.loss }}>{c.label}</span>
              <span className="text-lg font-bold" style={{ color: c.n === 0 ? C.gain : C.loss }}>{c.n}</span>
            </div>
            <div className="text-[11px]" style={{ color: '#78716c' }}>{c.sub}{c.n > 0 && ' · click to view'}</div>
          </button>
        ))}
      </div>
      {open && (() => {
        const c = cards.find(x => x.key === open);
        if (!c || !c.rows.length) return null;
        return (
          <div className="bg-white rounded-xl border p-3" style={{ borderColor: C.loss + '40' }}>
            <table className="w-full text-xs">
              <tbody>
                {c.rows.map((r, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-red-50 cursor-pointer"
                      onClick={() => navigate(`/execution/${r.execution_id}`)}>
                    <td className="py-1.5 pr-3">{r.date}</td>
                    <td className="py-1.5 pr-3 font-semibold" style={{ color: C.violet }}>{r.tanker_number || '—'}</td>
                    <td className="py-1.5 pr-3">{r.route_name || '—'}</td>
                    <td className="py-1.5 pr-3">{r.delivery_point}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold" style={{ color: C.loss }}>{c.detail(r)}</td>
                    <td className="py-1.5"><ExternalLink size={11} className="text-gray-300"/></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })()}
    </div>
  );
}

const GAIN_COLS = [
  { key: 'trips', label: 'Trips', right: true },
  { key: 'ack_kgs', label: 'Delivered (Kg)', right: true, fmt: (_, r) => nf(r.ack?.kgs), sortVal: r => r.ack?.kgs },
  { key: 'qty_gain_kgs', label: 'Qty Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v) },
  { key: 'ts_gain', label: 'TS Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v, 1) },
  { key: 'ts_gain_pct', label: 'TS %', right: true, gain: true, fmt: v => v == null ? '—' : nf(v, 3) + ' %' },
  { key: 'stage_transit_kgs', label: 'Transit +/− (Kg)', right: true, gain: true, fmt: v => nf(v) },
  { key: 'stage_unload_kgs', label: 'Unload +/− (Kg)', right: true, gain: true, fmt: v => nf(v) },
  { key: 'avg_fat', label: 'Fat %', right: true, fmt: v => v == null ? '—' : nf(v, 2) },
  { key: 'avg_snf', label: 'SNF %', right: true, fmt: v => v == null ? '—' : nf(v, 2) },
];

export default function Analytics() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo]     = useState(today());
  const [dp, setDp]     = useState('');
  const [route, setRoute]   = useState('');
  const [tanker, setTanker] = useState('');
  const [drill, setDrill] = useState(null); // {type, value, label}
  const [trendMode, setTrendMode] = useState('kg'); // 'kg' | 'pct'

  const { data: dps } = useQuery({
    queryKey: ['delivery-points'],
    queryFn: () => getDeliveryPoints().then(r => r.data),
  });
  const { data: routesList } = useQuery({
    queryKey: ['routes-list'],
    queryFn: () => getRoutes().then(r => r.data),
  });
  const { data: tankersList } = useQuery({
    queryKey: ['tankers-list'],
    queryFn: () => getTankers().then(r => r.data),
  });
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['analytics', from, to, dp, route, tanker],
    queryFn: () => getAnalyticsSummary({ from, to, delivery_point_id: dp || undefined,
      route_name: route || undefined, tanker_number: tanker || undefined }).then(r => r.data),
    enabled: !!from && !!to,
  });

  const { data: util } = useQuery({
    queryKey: ['analytics-util', from, to, dp, route, tanker],
    queryFn: () => api.get('/analytics/utilisation', { params: { from, to, delivery_point_id: dp || undefined,
      route_name: route || undefined, tanker_number: tanker || undefined } }).then(r => r.data),
    enabled: !!from && !!to,
  });

  const { data: fresh2 } = useQuery({
    queryKey: ['analytics-freshness', from, to, dp, route, tanker],
    queryFn: () => api.get('/analytics/freshness', { params: { from, to, delivery_point_id: dp || undefined,
      route_name: route || undefined, tanker_number: tanker || undefined } }).then(r => r.data),
    enabled: !!from && !!to,
  });

  const exportExcel = () => {
    api.get('/analytics/export', {
      params: { from, to, delivery_point_id: dp || undefined,
        route_name: route || undefined, tanker_number: tanker || undefined },
      responseType: 'blob',
    }).then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `analytics_${from}_${to}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    });
  };

  const k = data?.kpis;
  const pk = data?.prev_period?.kpis;
  const daily = (data?.daily || []).map(d => ({ ...d, label: d.date.slice(8, 10) + '/' + d.date.slice(5, 7) }));
  const showTrend = daily.length >= 3; // never present <3 points as a trend
  const freshness = data?.freshness?.last_ack_entry
    ? new Date(data.freshness.last_ack_entry).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

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
          {freshness && (
            <p className="text-[11px]" style={{ color: C.teal }}>
              Data as of {freshness} (last acknowledgement entry)
            </p>
          )}
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
        <select className="input text-xs" value={route} onChange={e => setRoute(e.target.value)}>
          <option value="">All routes</option>
          {(routesList || []).map(r => <option key={r.id} value={r.route_name}>{r.route_name}</option>)}
        </select>
        <select className="input text-xs" value={tanker} onChange={e => setTanker(e.target.value)}>
          <option value="">All tankers</option>
          {(tankersList || []).map(t2 => <option key={t2.id} value={t2.tanker_number}>{t2.tanker_number}</option>)}
        </select>
        <button className="text-xs px-2.5 py-1.5 rounded-lg text-white flex items-center gap-1.5"
                style={{ background: C.teal }} onClick={exportExcel}>
          <Download size={12}/> Excel
        </button>
      </div>

      {isError && (
        <div className="rounded-xl p-3 text-xs font-semibold border flex items-center justify-between"
             style={{ background: tint(C.loss), borderColor: C.loss + '55', color: C.loss }}>
          <span>Could not load analytics — the server may be busy or unreachable.</span>
          <button className="px-2.5 py-1 rounded-lg text-white flex items-center gap-1.5"
                  style={{ background: C.loss }} onClick={() => refetch()}>
            <RefreshCw size={11}/> Retry
          </button>
        </div>
      )}

      {/* Alerts / exceptions — never buried */}
      <AlertsRow from={from} to={to} dp={dp} route={route} tanker={tanker} />

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Trips" value={nf(k?.trips)} accent={C.violet}
             sub={`${nf(k?.acked_trips)} acknowledged${pk?.trips != null ? ` · ${nf(pk.trips)} prev period` : ''}`} />
        <Kpi label="Milk Handled (Dispatch)" value={`${nf(k?.disp?.kgs)} Kg`} accent={C.amber}
             sub={delta(k?.disp?.kgs, pk?.disp?.kgs) || `${nf(k?.disp?.litres)} L`} />
        <Kpi label="Delivered (Ack)" value={`${nf(k?.ack?.kgs)} Kg`} accent={C.teal}
             sub={delta(k?.ack?.kgs, pk?.ack?.kgs) || `${nf(k?.ack?.litres)} L`} />
        <Kpi label="Qty Gain / Loss" value={`${nf(k?.qty_gain_kgs)} Kg`}
             color={qtyStatusColor(k?.qty_gain_kgs, k?.rmrd?.kgs)} accent={qtyStatusColor(k?.qty_gain_kgs, k?.rmrd?.kgs)}
             sub={delta(k?.qty_gain_kgs, pk?.qty_gain_kgs) || `${nf(k?.qty_gain_litres)} L · Ack − RMRD`} />
        <Kpi label="TS Gain / Loss" value={`${nf(k?.ts_gain, 1)} Kg`}
             color={tsStatusColor(k?.ts_gain_pct)} accent={tsStatusColor(k?.ts_gain_pct)}
             sub={`${k?.ts_gain_pct != null ? nf(k.ts_gain_pct, 3) + ' %' : ''}${delta(k?.ts_gain, pk?.ts_gain, 'Kg', 1) ? ' · ' + delta(k?.ts_gain, pk?.ts_gain, 'Kg', 1) : ''}`} />
        <Kpi label="Stage Split (Kg)" value={`${nf(k?.stage_transit_kgs)} transit`} color={gainColor(k?.stage_transit_kgs)}
             accent={C.berry} sub={`${nf(k?.stage_unload_kgs)} at unloading`} />
      </div>

      {/* Cost & operations row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="BMCU Collection" accent={data?.compliance?.pct == null ? C.teal
               : data.compliance.pct > 95 ? C.gain : data.compliance.pct >= 85 ? AMBER : C.loss}
             color={data?.compliance?.pct == null ? C.ink
               : data.compliance.pct > 95 ? C.gain : data.compliance.pct >= 85 ? AMBER : C.loss}
             value={data?.compliance?.pct != null ? `${nf(data.compliance.pct, 1)} %` : '—'}
             sub={data?.compliance ? `${nf(data.compliance.collected)} of ${nf(data.compliance.planned)} planned BMCU visits` : ''} />
        <Kpi label="Fat / SNF Drift" accent={C.violet}
             color={(Math.abs(k?.fat_drift ?? 0) > 0.05 || Math.abs(k?.snf_drift ?? 0) > 0.05) ? C.loss : C.gain}
             value={k?.fat_drift != null ? `${k.fat_drift > 0 ? '+' : ''}${nf(k.fat_drift, 3)} F` : '—'}
             sub={k?.snf_drift != null ? `${k.snf_drift > 0 ? '+' : ''}${nf(k.snf_drift, 3)} SNF · Ack% − RMRD%` : 'weighted Ack% − RMRD%'} />
        <Kpi label="Transport Cost" accent={C.amber}
             value={`₹ ${nf(k?.trip_cost)}`}
             sub={k?.cost_per_1000l != null ? `₹ ${nf(k.cost_per_1000l)} / 1000 L dispatched` : 'per-km rate × trip km'} />
        <Kpi label="Tanker Maintenance" accent={C.violet}
             value={`${nf(data?.ops?.maintenance_days, 1)} days`}
             sub={data?.ops?.open_maintenance ? `${data.ops.open_maintenance} tanker(s) still out` : 'all returned'} />
        <Kpi label="Change Requests" accent={C.berry}
             value={nf(data?.ops?.change_requests)}
             sub={data?.ops?.change_requests_pending ? `${data.ops.change_requests_pending} pending approval` : 'none pending'} />
        <Kpi label="Top Requester" accent={C.teal}
             value={data?.ops?.top_requesters?.[0]?.name || '—'}
             sub={data?.ops?.top_requesters?.slice(0, 3).map(t2 => `${t2.name} (${t2.n})`).join(' · ') || 'no change requests'} />
      </div>

      {/* Distance & collection efficiency */}
      {(() => {
        const tk = (data?.tankers || []).filter(t2 => (t2.km ?? 0) > 0);
        const hi = tk.length ? tk.reduce((a, b) => (b.km > a.km ? b : a)) : null;
        const lo = tk.length ? tk.reduce((a, b) => (b.km < a.km ? b : a)) : null;
        const avgKm = tk.length ? tk.reduce((s2, t2) => s2 + t2.km, 0) / tk.length : null;
        return (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <Kpi label="Total KM Travelled" accent={C.teal}
                 value={`${nf(k?.km)} km`}
                 sub={k?.km_per_trip != null ? `${nf(k.km_per_trip, 1)} km avg / trip` : ''} />
            <Kpi label="Milk Collected / KM" accent={C.gain}
                 value={k?.l_per_km != null ? `${nf(k.l_per_km, 1)} L/km` : '—'}
                 sub={`${nf(k?.disp?.litres)} L over ${nf(k?.km)} km`} />
            <Kpi label="Highest KM Tanker" accent={C.violet}
                 value={hi ? hi.tanker_number : '—'}
                 sub={hi ? `${nf(hi.km)} km · ${nf(hi.trips)} trips` : 'no km recorded'} />
            <Kpi label="Lowest KM Tanker" accent={C.amber}
                 value={lo ? lo.tanker_number : '—'}
                 sub={lo ? `${nf(lo.km)} km · ${nf(lo.trips)} trips` : 'no km recorded'} />
            <Kpi label="Average KM / Tanker" accent={C.berry}
                 value={avgKm != null ? `${nf(avgKm)} km` : '—'}
                 sub={`across ${nf(tk.length)} tankers with km data`} />
          </div>
        );
      })()}

      {/* Tanker distance & efficiency leaderboard */}
      <LeaderTable
        title="Tanker KM & Collection Efficiency"
        accent={C.teal}
        note="KM = actual km (calculated when not entered) · Milk = dispatch quantity · click a tanker for its trips"
        rows={(data?.tankers || []).filter(t2 => (t2.km ?? 0) > 0)}
        defaultSort={{ key: 'km', dir: 'desc' }}
        onRowClick={r => setDrill({ type: 'tanker', value: r.tanker_number, label: `Trips of tanker ${r.tanker_number}` })}
        cols={[
          { key: 'tanker_number', label: 'Tanker' },
          { key: 'trips', label: 'Trips', right: true },
          { key: 'km', label: 'Total KM', right: true, fmt: v => nf(v) },
          { key: 'km_per_trip', label: 'KM / Trip', right: true, fmt: v => nf(v, 1) },
          { key: 'disp_litres_show', label: 'Milk Collected (L)', right: true,
            sortVal: r => r.disp?.litres, fmt: (_, r) => nf(r.disp?.litres) },
          { key: 'l_per_km', label: 'L / KM', right: true, fmt: v => nf(v, 1) },
          { key: 'trip_cost', label: 'Cost (₹)', right: true, fmt: v => v ? nf(v) : '—' },
        ]}
      />

      {/* Tanker utilisation — fill % on ACK quantity */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Fleet Capacity Utilisation" accent={fillColor(util?.fleet?.avg_fill_pct)}
             color={fillColor(util?.fleet?.avg_fill_pct)}
             value={util?.fleet?.avg_fill_pct != null ? `${nf(util.fleet.avg_fill_pct, 1)} %` : '—'}
             sub="Ack qty vs capacity, trip-weighted" />
        <Kpi label="Most Utilised Tanker" accent={C.gain}
             value={util?.fleet?.most_utilised?.tanker_number || '—'}
             sub={util?.fleet?.most_utilised ? `${nf(util.fleet.most_utilised.fill_pct, 1)} % avg fill` : ''} />
        <Kpi label="Least Utilised Tanker" accent={C.amber}
             value={util?.fleet?.least_utilised?.tanker_number || '—'}
             sub={util?.fleet?.least_utilised ? `${nf(util.fleet.least_utilised.fill_pct, 1)} % avg fill` : ''} />
        <Kpi label="Unused Tankers" accent={util?.fleet?.zero_trip ? C.loss : C.gain}
             color={util?.fleet?.zero_trip ? C.loss : C.gain}
             value={nf(util?.fleet?.zero_trip)}
             sub={`of ${nf(util?.fleet?.tankers)} tankers — zero trips this period`} />
        <Kpi label="Highest Utilised Route" accent={C.gain}
             value={util?.route_extremes?.highest?.route_name || '—'}
             sub={util?.route_extremes?.highest ? `${nf(util.route_extremes.highest.fill_pct, 1)} % fill · ${nf(util.route_extremes.highest.trips)} trips` : ''} />
        <Kpi label="Lowest Utilised Route" accent={C.loss}
             color={util?.route_extremes?.lowest ? fillColor(util.route_extremes.lowest.fill_pct) : C.ink}
             value={util?.route_extremes?.lowest?.route_name || '—'}
             sub={util?.route_extremes?.lowest ? `${nf(util.route_extremes.lowest.fill_pct, 1)} % fill · ${nf(util.route_extremes.lowest.trips)} trips` : ''} />
      </div>

      <LeaderTable
        title="Route Utilisation (fill % of tanker capacity · lowest first)"
        accent={C.amber}
        note="Fill % = acknowledged qty (dispatch for unacked trips) ÷ tanker capacity across the route's trips · low fill = oversized tankers or thin routes · click a route for its trips"
        rows={util?.routes || []}
        defaultSort={{ key: 'fill_pct', dir: 'asc' }}
        onRowClick={r => setDrill({ type: 'route', value: r.route_name, label: `Trips on route ${r.route_name}` })}
        cols={[
          { key: 'route_name', label: 'Route' },
          { key: 'trips', label: 'Trips', right: true },
          { key: 'tankers', label: 'Tankers Used', right: true },
          { key: 'capacity_litres', label: 'Capacity Offered (L)', right: true, fmt: v => nf(v) },
          { key: 'filled_litres', label: 'Milk Carried (L)', right: true, fmt: v => nf(v) },
          { key: 'km', label: 'KM', right: true, fmt: v => nf(v) },
          { key: 'fill_pct', label: 'Fill %', right: true,
            fmt: v => <span style={{ color: fillColor(v), fontWeight: 700 }}>{v == null ? '—' : nf(v, 1) + ' %'}</span> },
        ]}
      />

      <LeaderTable
        title="Tanker Utilisation"
        accent={C.violet}
        note={`Fill % = acknowledged qty ÷ capacity per trip (dispatch stands in for unacked trips) · ${nf(util?.period_days)} day period · click a tanker for its trips`}
        rows={util?.tankers || []}
        defaultSort={{ key: 'avg_fill_pct', dir: 'asc' }}
        onRowClick={r => r.trips > 0 && setDrill({ type: 'tanker', value: r.tanker_number, label: `Trips of tanker ${r.tanker_number}` })}
        cols={[
          { key: 'tanker_number', label: 'Tanker' },
          { key: 'capacity_litres', label: 'Capacity (L)', right: true, fmt: v => nf(v) },
          { key: 'trips', label: 'Trips', right: true },
          { key: 'active_days', label: 'Active Days', right: true },
          { key: 'idle_days', label: 'Idle Days', right: true,
            fmt: (v, r) => <span style={{ color: v > 0 && r.trips === 0 ? C.loss : undefined }}>{nf(v)}</span> },
          { key: 'maintenance_days', label: 'Maint. Days', right: true, fmt: v => nf(v, 1) },
          { key: 'trips_per_active_day', label: 'Trips / Active Day', right: true, fmt: v => nf(v, 2) },
          { key: 'ack_litres', label: 'Ack Qty (L)', right: true, fmt: v => nf(v) },
          { key: 'avg_fill_pct', label: 'Avg Fill %', right: true,
            fmt: v => <span style={{ color: fillColor(v), fontWeight: 700 }}>{v == null ? '—' : nf(v, 1) + ' %'}</span> },
        ]}
      />

      {/* Milk freshness — shifts of milk lifted per BMCU collection */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Avg Shifts / Collection" accent={shiftsColor(fresh2?.kpi?.avg_shifts)}
             color={shiftsColor(fresh2?.kpi?.avg_shifts)}
             value={fresh2?.kpi?.avg_shifts != null ? nf(fresh2.kpi.avg_shifts, 2) : '—'}
             sub={`ideal 1.00 · ${nf(fresh2?.kpi?.collections)} BMCU collections`} />
        <Kpi label="Fresh Collections" accent={C.gain}
             color={fresh2?.kpi?.fresh_pct != null && fresh2.kpi.fresh_pct < 50 ? C.loss : C.gain}
             value={fresh2?.kpi?.fresh_pct != null ? `${nf(fresh2.kpi.fresh_pct, 1)} %` : '—'}
             sub="single-shift lifts (no mixing)" />
        <Kpi label="3+ Shift Lifts" accent={fresh2?.kpi?.three_plus ? C.loss : C.gain}
             color={fresh2?.kpi?.three_plus ? C.loss : C.gain}
             value={nf(fresh2?.kpi?.three_plus)}
             sub="collections mixing 3 or more shifts" />
        <Kpi label="Avg Milk Age at Lifting" accent={C.violet}
             color={fresh2?.kpi?.avg_age_days != null && fresh2.kpi.avg_age_days > 1 ? C.loss : C.ink}
             value={fresh2?.kpi?.avg_age_days != null ? `${nf(fresh2.kpi.avg_age_days, 1)} days` : '—'}
             sub="lifting date − oldest shift in the load" />
      </div>

      <LeaderTable
        title="BMCU Milk Freshness (worst first — most shifts held per lift)"
        accent={C.berry}
        note="Shifts / collection = RMRD shift rows lifted together · age = days between oldest shift and lifting · click a BMCU for its trips"
        rows={fresh2?.bmcus || []}
        defaultSort={{ key: 'avg_shifts', dir: 'desc' }}
        onRowClick={r => setDrill({ type: 'bmcu', value: r.bmcu_code, label: `${r.bmcu_code} — ${r.bmcu_name}` })}
        cols={[
          { key: 'bmcu_code', label: 'Code' },
          { key: 'bmcu_name', label: 'BMCU' },
          { key: 'collections', label: 'Collections', right: true },
          { key: 'avg_shifts', label: 'Avg Shifts / Lift', right: true,
            fmt: v => <span style={{ color: shiftsColor(v), fontWeight: 700 }}>{nf(v, 2)}</span> },
          { key: 'max_shifts', label: 'Max Shifts', right: true },
          { key: 'single_shift_pct', label: 'Fresh Lifts %', right: true,
            fmt: v => <span style={{ color: v >= 50 ? C.gain : C.loss, fontWeight: 600 }}>{nf(v, 1)} %</span> },
          { key: 'three_plus', label: '3+ Shift Lifts', right: true,
            fmt: v => <span style={{ color: v > 0 ? C.loss : undefined }}>{nf(v)}</span> },
          { key: 'avg_age_days', label: 'Avg Age (days)', right: true, fmt: v => nf(v, 1) },
          { key: 'max_age_days', label: 'Max Age (days)', right: true },
          { key: 'rmrd_litres', label: 'RMRD (L)', right: true, fmt: v => nf(v) },
        ]}
      />

      {/* Daily trend — click a bar to open that day's trips */}
      <div className="bg-white rounded-xl shadow-sm p-4 border"
           style={{ borderColor: C.violet + '2e', borderLeft: `4px solid ${C.violet}` }}>
        <div className="font-semibold text-sm mb-2 flex items-center gap-2" style={{ color: C.ink }}>
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: C.violet }} />
          Daily TS Gain / Loss ({trendMode === 'kg' ? 'Kg' : '%'}) — click a day to drill down
          <span className="ml-2 inline-flex rounded-lg overflow-hidden border" style={{ borderColor: C.violet + '55' }}>
            {['kg', 'pct'].map(m => (
              <button key={m} onClick={e => { e.stopPropagation(); setTrendMode(m); }}
                className="px-2 py-0.5 text-[11px] font-semibold"
                style={trendMode === m ? { background: C.violet, color: '#fff' } : { background: '#fff', color: C.violet }}>
                {m === 'kg' ? 'Kg' : '%'}
              </button>
            ))}
          </span>
          {!showTrend && daily.length > 0 && (
            <span className="text-[11px] font-normal" style={{ color: '#78716c' }}>
              · {daily.length} day{daily.length === 1 ? '' : 's'} only — widen the range for a trend
            </span>
          )}
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v, n) => [nf(v, 1), n]} />
            <ReferenceLine y={0} stroke={C.neutral} />
            <Bar dataKey={trendMode === 'kg' ? 'ts_gain' : 'ts_gain_pct'}
                 name={trendMode === 'kg' ? 'TS gain/loss (Kg)' : 'TS gain/loss (%)'} cursor="pointer"
                 onClick={d => d?.date && setDrill({ type: 'date', value: d.date, label: `Trips on ${d.date}` })}>
              {daily.map((d, i) => <Cell key={i} fill={gainColor(trendMode === 'kg' ? d.ts_gain : d.ts_gain_pct)} />)}
            </Bar>
            {showTrend && trendMode === 'kg' &&
              <Line dataKey="qty_gain_kgs" name="Qty gain/loss (Kg)" stroke={C.line} dot={false} strokeWidth={2} />}
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
          title="Shift Wise (milk shifts lifted: AM / PM / Mixed)"
          accent={C.violet}
          note="A trip is Mixed when it lifted both AM and PM shift milk"
          rows={data?.shifts || []}
          maxRows={5}
          cols={[{ key: 'shift_kind', label: 'Shift' }, ...GAIN_COLS.slice(0, 5)]}
        />
        <LeaderTable
          title="Day of Week Pattern"
          accent={C.teal}
          note="Recurring weekday losses point to staffing / handling patterns"
          rows={data?.day_of_week || []}
          maxRows={7}
          cols={[{ key: 'dow', label: 'Day' }, ...GAIN_COLS.slice(0, 5)]}
        />
      </div>

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

      {drill && <DrillPanel drill={drill} from={from} to={to} dp={dp} route={route} tanker={tanker} onClose={() => setDrill(null)} />}
    </div>
  );
}
