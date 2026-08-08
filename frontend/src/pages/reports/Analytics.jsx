// Analytics dashboard (Phase 1): date-range KPIs, daily TS gain/loss trend,
// BMCU / tanker leaderboards and delivery-point performance.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAnalyticsSummary, getDeliveryPoints } from '../../api';
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
const gainColor = v => v == null ? '#94a3b8' : v < 0 ? '#dc2626' : '#15803d';

function Kpi({ label, value, sub, color }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold" style={{ color: color || '#0f172a' }}>{value}</div>
      {sub && <div className="text-[11px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function LeaderTable({ title, rows, cols, note }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 overflow-x-auto">
      <div className="font-semibold text-sm text-gray-700 mb-2">{title}</div>
      {note && <div className="text-[11px] text-gray-400 mb-2">{note}</div>}
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 border-b">
            {cols.map(c => <th key={c.key} className={`py-1.5 pr-3 ${c.right ? 'text-right' : ''}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} className="py-3 text-gray-400">No data</td></tr>}
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-gray-50">
              {cols.map(c => (
                <td key={c.key} className={`py-1.5 pr-3 ${c.right ? 'text-right tabular-nums' : ''}`}
                    style={c.gain ? { color: gainColor(r[c.key]), fontWeight: 600 } : {}}>
                  {c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Analytics() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo]     = useState(today());
  const [dp, setDp]     = useState('');

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
  const worstBmcus = (data?.bmcus || []).filter(b => (b.ts_gain ?? 0) < 0).slice(0, 10);
  const bestBmcus  = [...(data?.bmcus || [])].filter(b => (b.ts_gain ?? 0) > 0).reverse().slice(0, 10);
  const tankers    = data?.tankers || [];
  const worstTankers = tankers.filter(t => (t.ts_gain ?? 0) < 0).slice(0, 10);

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
          <p className="text-xs text-gray-500">Gain / loss analytics · Ack Vs RMRD basis {isFetching && '· loading…'}</p>
        </div>
        <div className="flex-1" />
        {presets.map(p => (
          <button key={p.label}
            className={`text-xs px-2.5 py-1.5 rounded-lg border ${from === p.from && to === p.to ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
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
        <Kpi label="Trips" value={nf(k?.trips)} sub={`${nf(k?.acked_trips)} acknowledged`} />
        <Kpi label="Milk Handled (Dispatch)" value={`${nf(k?.disp?.kgs)} Kg`} sub={`${nf(k?.disp?.litres)} L`} />
        <Kpi label="Delivered (Ack)" value={`${nf(k?.ack?.kgs)} Kg`} sub={`${nf(k?.ack?.litres)} L`} />
        <Kpi label="Qty Gain / Loss" value={`${nf(k?.qty_gain_kgs)} Kg`} color={gainColor(k?.qty_gain_kgs)}
             sub={`${nf(k?.qty_gain_litres)} L · Ack − RMRD`} />
        <Kpi label="TS Gain / Loss" value={`${nf(k?.ts_gain, 1)} Kg`} color={gainColor(k?.ts_gain)}
             sub={k?.ts_gain_pct != null ? `${nf(k.ts_gain_pct, 3)} %` : ''} />
        <Kpi label="Stage Split (Kg)" value={`${nf(k?.stage_transit_kgs)} transit`} color={gainColor(k?.stage_transit_kgs)}
             sub={`${nf(k?.stage_unload_kgs)} at unloading`} />
      </div>

      {/* Daily trend */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
        <div className="font-semibold text-sm text-gray-700 mb-2">Daily TS Gain / Loss (Kg)</div>
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={daily}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v, n) => [nf(v, 1), n]} />
            <ReferenceLine y={0} stroke="#94a3b8" />
            <Bar dataKey="ts_gain" name="TS gain/loss">
              {daily.map((d, i) => <Cell key={i} fill={gainColor(d.ts_gain)} />)}
            </Bar>
            <Line dataKey="qty_gain_kgs" name="Qty gain/loss (Kg)" stroke="#2563eb" dot={false} strokeWidth={2} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Delivery point performance */}
      <LeaderTable
        title="Delivery Point Performance"
        note="Delivered = acknowledged quantity at the plant · Gain/Loss = Ack − RMRD (acknowledged trips)"
        rows={data?.delivery_points || []}
        cols={[
          { key: 'delivery_point', label: 'Delivery Point' },
          { key: 'trips', label: 'Trips', right: true },
          { key: 'ack_litres_show', label: 'Delivered (L)', right: true, fmt: (_, r) => nf(r.ack?.litres) },
          { key: 'ack_kgs_show', label: 'Delivered (Kg)', right: true, fmt: (_, r) => nf(r.ack?.kgs) },
          { key: 'qty_gain_kgs', label: 'Qty Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v) },
          { key: 'ts_gain', label: 'TS Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v, 1) },
          { key: 'ts_gain_pct', label: 'TS %', right: true, gain: true, fmt: v => v == null ? '—' : nf(v, 3) + ' %' },
        ]}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LeaderTable
          title="Worst BMCUs (TS loss · Dispatch Vs RMRD)"
          rows={worstBmcus}
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
          rows={bestBmcus}
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
        rows={worstTankers.length ? worstTankers : tankers.slice(0, 10)}
        cols={[
          { key: 'tanker_number', label: 'Tanker' },
          { key: 'trips', label: 'Trips', right: true },
          { key: 'ack_kgs_show', label: 'Delivered (Kg)', right: true, fmt: (_, r) => nf(r.ack?.kgs) },
          { key: 'qty_gain_kgs', label: 'Qty Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v) },
          { key: 'ts_gain', label: 'TS Gain/Loss (Kg)', right: true, gain: true, fmt: v => nf(v, 1) },
          { key: 'ts_gain_pct', label: 'TS %', right: true, gain: true, fmt: v => v == null ? '—' : nf(v, 3) + ' %' },
          { key: 'per_1000', label: 'TS loss / 1000 L', right: true, gain: true,
            fmt: (_, r) => r.ack?.litres > 0 && r.ts_gain != null ? nf(r.ts_gain / r.ack.litres * 1000, 2) : '—' },
        ]}
      />
    </div>
  );
}
