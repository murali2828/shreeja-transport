// Transport cost drivers — why did ₹ per litre (and ₹ per km) move between two
// periods: diesel price, kilometres, BMCUs added or closed, or mix. Periods
// can be a fortnight, month, quarter, year or custom range; the comparison
// defaults to the period just before (GET /api/analytics/cost-drivers).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Download, RefreshCw } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, ReferenceLine } from 'recharts';
import { getCostDrivers, downloadCostDriversExcel } from '../../api';
import { fmtDate } from '../../utils/date';

const pad = n => String(n).padStart(2, '0');
const monthEnd = (y, m) => new Date(y, m, 0).getDate();
const nf = (v, d = 0) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (v, d = 0) => v == null ? '—' : (v > 0 ? '+' : '') + nf(v, d);
const inr = v => v == null ? '—' : '₹' + nf(v);
const C = { diesel: '#c98500', km: '#2a78d6', new_bmcu: '#4a3aa7', closed_bmcu: '#8a8577', mix: '#cc785c', volume: '#008300' };
const LABELS = { diesel: 'Diesel price', km: 'Kilometres', new_bmcu: 'New BMCUs', closed_bmcu: 'Closed BMCUs', mix: 'Mix / other', volume: 'Volume (litres)' };

// Period presets → { from, to }
function presetDates(kind, year, month, part) {
  const y = Number(year), m = Number(month);
  if (kind === 'fortnight') return part === '1' ? { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-15` } : { from: `${y}-${pad(m)}-16`, to: `${y}-${pad(m)}-${pad(monthEnd(y, m))}` };
  if (kind === 'month') return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(monthEnd(y, m))}` };
  if (kind === 'quarter') { // Indian FY quarters: Q1 Apr–Jun … Q4 Jan–Mar (of y+1)
    const q = Number(part); const sm = [4, 7, 10, 1][q - 1]; const sy = q === 4 ? y + 1 : y; const em = sm + 2;
    return { from: `${sy}-${pad(sm)}-01`, to: `${sy}-${pad(em)}-${pad(monthEnd(sy, em))}` };
  }
  if (kind === 'fy') return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
  return null;
}

export default function CostDrivers() {
  const now = new Date();
  const [kind, setKind]   = useState('month');
  const [year, setYear]   = useState(String(now.getMonth() + 1 >= 4 ? now.getFullYear() : now.getFullYear() - 1));
  const [month, setMonth] = useState(String(now.getMonth() === 0 ? 12 : now.getMonth())); // last full month
  const [part, setPart]   = useState('1');
  const [custom, setCustom] = useState({ from: '', to: '', prev_from: '', prev_to: '' });
  const [compare, setCompare] = useState('previous'); // previous | last_year | custom
  const [view, setView] = useState('litre'); // litre | amount

  const period = kind === 'custom' ? (custom.from && custom.to ? { from: custom.from, to: custom.to } : null)
    : presetDates(kind, kind === 'month' || kind === 'fortnight' ? (Number(month) >= 4 ? year : Number(year) + 1) : year, month, part);
  const shiftYear = iso => iso ? `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}` : '';
  const prev = compare === 'last_year' && period ? { prev_from: shiftYear(period.from), prev_to: shiftYear(period.to) }
    : compare === 'custom' && custom.prev_from && custom.prev_to ? { prev_from: custom.prev_from, prev_to: custom.prev_to } : {};
  const params = period ? { from: period.from, to: period.to, ...prev } : null;

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['cost-drivers', params],
    queryFn: () => getCostDrivers(params).then(r => r.data),
    enabled: !!params,
  });

  const o = data?.overall;
  const eff = o ? (view === 'litre' ? o.effects_per_litre : o.effects) : null;
  const keys = view === 'litre' ? ['diesel', 'km', 'new_bmcu', 'closed_bmcu', 'mix', 'volume'] : ['diesel', 'km', 'new_bmcu', 'closed_bmcu', 'mix'];
  const dec = view === 'litre' ? 3 : 0;
  const unit = view === 'litre' ? '₹/L' : '₹';
  const chart = eff ? keys.map(k => ({ key: k, name: LABELS[k], value: eff[k] ?? 0 })) : [];
  const total = o ? (view === 'litre' ? o.delta_per_litre : o.delta_cost) : null;

  const years = []; for (let y = now.getFullYear(); y >= 2025; y--) years.push(String(y));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="page-title">Transport Cost Drivers</h2>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.92)' }}>
            Why ₹ per litre moved — diesel price · kilometres · BMCUs added or closed · mix {isFetching && '· loading…'}
          </p>
        </div>
        <div className="flex-1"/>
        <select className="input text-xs" value={kind} onChange={e => setKind(e.target.value)}>
          <option value="fortnight">Fortnight</option><option value="month">Month</option>
          <option value="quarter">Quarter (FY)</option><option value="fy">Financial year</option><option value="custom">Custom range</option>
        </select>
        {kind !== 'custom' && (
          <select className="input text-xs" value={year} onChange={e => setYear(e.target.value)} title="Financial year (April to March)">
            {years.map(y => <option key={y} value={y}>FY {y}-{String(Number(y) + 1).slice(2)}</option>)}
          </select>
        )}
        {(kind === 'month' || kind === 'fortnight') && (
          <select className="input text-xs" value={month} onChange={e => setMonth(e.target.value)}>
            {[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map(m => <option key={m} value={m}>{MONTHS[m - 1]}</option>)}
          </select>
        )}
        {kind === 'fortnight' && (
          <select className="input text-xs" value={part} onChange={e => setPart(e.target.value)}>
            <option value="1">1 – 15</option><option value="2">16 – month end</option>
          </select>
        )}
        {kind === 'quarter' && (
          <select className="input text-xs" value={part} onChange={e => setPart(e.target.value)}>
            <option value="1">Q1 Apr–Jun</option><option value="2">Q2 Jul–Sep</option><option value="3">Q3 Oct–Dec</option><option value="4">Q4 Jan–Mar</option>
          </select>
        )}
        {kind === 'custom' && (
          <>
            <input type="date" className="input text-xs" value={custom.from} onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}/>
            <input type="date" className="input text-xs" value={custom.to} onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}/>
          </>
        )}
        <select className="input text-xs" value={compare} onChange={e => setCompare(e.target.value)} title="Comparison period">
          <option value="previous">vs previous period</option>
          <option value="last_year">vs same period last year</option>
          <option value="custom">vs custom period…</option>
        </select>
        {compare === 'custom' && (
          <>
            <input type="date" className="input text-xs" value={custom.prev_from} onChange={e => setCustom(c => ({ ...c, prev_from: e.target.value }))}/>
            <input type="date" className="input text-xs" value={custom.prev_to} onChange={e => setCustom(c => ({ ...c, prev_to: e.target.value }))}/>
          </>
        )}
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => refetch()}><RefreshCw size={12}/></button>
        <button className="btn-primary text-xs flex items-center gap-1.5" disabled={!params}
                onClick={() => downloadCostDriversExcel(params).catch(e => toast.error(e.response?.data?.error || e.message))}>
          <Download size={12}/> Excel
        </button>
      </div>

      {isError && <div className="card p-4 text-sm text-red-600">{error?.response?.data?.error || error?.message}</div>}
      {!params && <div className="card p-4 text-sm text-gray-500">Pick a period.</div>}

      {o && (
        <>
          <div className="text-xs text-white/90">
            <b>{fmtDate(data.period.from)} → {fmtDate(data.period.to)}</b> compared with <b>{fmtDate(data.previous.from)} → {fmtDate(data.previous.to)}</b>
            {(o.curr.unpriced > 0 || o.prev.unpriced > 0) && <span className="ml-2 text-amber-200">· {o.curr.unpriced + o.prev.unpriced} trip(s) have no rate (Tanker Rate Master gap) and count ₹0</span>}
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
            {[
              ['₹ / litre', nf(o.curr.per_litre, 3), `was ${nf(o.prev.per_litre, 3)} (${sg(o.delta_per_litre, 3)})`, o.delta_per_litre],
              ['₹ / km', nf(o.curr.per_km, 2), `was ${nf(o.prev.per_km, 2)} (${sg(o.delta_per_km, 2)})`, o.delta_per_km],
              ['Transport cost', inr(o.curr.cost), `was ${inr(o.prev.cost)} (${sg(o.delta_cost)})`, o.delta_cost],
              ['Litres', nf(o.curr.litres), `was ${nf(o.prev.litres)}`, null],
              ['Kilometres', nf(o.curr.km), `was ${nf(o.prev.km)}`, null],
              ['Km / litre', nf(o.curr.km_per_litre, 4), `was ${nf(o.prev.km_per_litre, 4)}`, null],
              ['Trips', nf(o.curr.trips), `was ${nf(o.prev.trips)} · ${nf(o.curr.litres_per_trip)} L/trip`, null],
              ['BMCUs served', nf(o.curr.bmcus), `was ${nf(o.prev.bmcus)} · +${o.new_bmcus} new / −${o.closed_bmcus} closed`, null],
            ].map(([l, v, s, d]) => (
              <div key={l} className="card p-3">
                <div className="text-[11px] text-gray-500">{l}</div>
                <div className="text-lg font-semibold" style={{ color: d == null ? '#191919' : d > 0 ? '#e34948' : d < 0 ? '#008300' : '#191919' }}>{v}</div>
                <div className="text-[11px] text-gray-500">{s}</div>
              </div>
            ))}
          </div>

          {/* Waterfall of effects */}
          <div className="card p-4">
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <div className="font-semibold text-sm">Change in {view === 'litre' ? '₹ per litre' : 'transport cost'}: <span style={{ color: total > 0 ? '#e34948' : '#008300' }}>{sg(total, dec)} {unit}</span> — what drove it</div>
              <div className="flex-1"/>
              <div className="flex rounded-lg border overflow-hidden text-xs">
                {['litre', 'amount'].map(v => <button key={v} className={`px-3 py-1 ${view === v ? 'bg-[#005ba3] text-white' : 'bg-white text-gray-600'}`} onClick={() => setView(v)}>{v === 'litre' ? 'per litre' : 'amount'}</button>)}
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div style={{ height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eee"/>
                    <XAxis dataKey="name" tick={{ fontSize: 11 }}/>
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={v => nf(v, dec)}/>
                    <Tooltip formatter={v => [`${sg(v, dec)} ${unit}`, '']}/>
                    <ReferenceLine y={0} stroke="#999"/>
                    <Bar dataKey="value">{chart.map(c => <Cell key={c.key} fill={C[c.key]}/>)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <table className="text-xs w-full self-start">
                <tbody>
                  {chart.map(c => (
                    <tr key={c.key} className="border-t border-gray-100">
                      <td className="py-1.5 pr-2"><span className="inline-block w-2.5 h-2.5 rounded-sm mr-2" style={{ background: C[c.key] }}/>{c.name}</td>
                      <td className="py-1.5 text-right font-semibold" style={{ color: c.value > 0 ? '#e34948' : c.value < 0 ? '#008300' : '#555' }}>{sg(c.value, dec)} {unit}</td>
                      <td className="py-1.5 pl-3 text-gray-500">
                        {c.key === 'diesel' && `diesel ${nf(o.diesel_prev, 2)} → ${nf(o.diesel_curr, 2)} ₹/L (km-weighted)`}
                        {c.key === 'km' && `${sg(o.curr.km - o.prev.km)} km at the earlier ₹/km`}
                        {c.key === 'new_bmcu' && `${o.new_bmcus} BMCU(s), ${o.new_bmcu_trips} trips, ${nf(o.new_bmcu_km)} km`}
                        {c.key === 'closed_bmcu' && `${o.closed_bmcus} BMCU(s) no longer served, ${o.closed_bmcu_trips} earlier trips`}
                        {c.key === 'mix' && 'route / capacity mix, keyed km, other rate changes'}
                        {c.key === 'volume' && `${sg(o.curr.litres - o.prev.litres)} L spreads the earlier cost`}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-gray-300 font-semibold"><td className="py-1.5">Total change</td><td className="py-1.5 text-right">{sg(total, dec)} {unit}</td><td/></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* By state */}
          <div className="card overflow-hidden">
            <div className="px-4 py-2 font-semibold text-sm border-b border-gray-100">By state</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-blue-50 text-gray-600"><tr>
                  {['State', 'Diesel ₹/L', 'Trips', 'Litres', 'Km', 'Cost ₹', '₹/km', '₹/L', `Δ ${unit}`, ...keys.map(k => LABELS[k])].map(h => <th key={h} className="px-2 py-2 text-right first:text-left whitespace-nowrap">{h}</th>)}
                </tr></thead>
                <tbody>
                  {[o, ...data.by_state].map((b, i) => {
                    const e = view === 'litre' ? b.effects_per_litre : b.effects;
                    const d = view === 'litre' ? b.delta_per_litre : b.delta_cost;
                    return (
                      <tr key={b.state + i} className={`border-t border-gray-100 ${i === 0 ? 'font-semibold bg-gray-50' : ''}`}>
                        <td className="px-2 py-1.5">{b.state}</td>
                        <td className="px-2 py-1.5 text-right whitespace-nowrap">{nf(b.diesel_prev, 2)} → {nf(b.diesel_curr, 2)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(b.prev.trips)} → {nf(b.curr.trips)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(b.prev.litres)} → {nf(b.curr.litres)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(b.prev.km)} → {nf(b.curr.km)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(b.prev.cost)} → {nf(b.curr.cost)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(b.prev.per_km, 2)} → {nf(b.curr.per_km, 2)}</td>
                        <td className="px-2 py-1.5 text-right">{nf(b.prev.per_litre, 3)} → {nf(b.curr.per_litre, 3)}</td>
                        <td className="px-2 py-1.5 text-right font-semibold" style={{ color: d > 0 ? '#e34948' : d < 0 ? '#008300' : '#555' }}>{sg(d, dec)}</td>
                        {keys.map(k => <td key={k} className="px-2 py-1.5 text-right" style={{ color: e[k] > 0 ? '#e34948' : e[k] < 0 ? '#008300' : '#555' }}>{sg(e[k], dec)}</td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* BMCU changes */}
          {(data.new_bmcus.length > 0 || data.closed_bmcus.length > 0) && (
            <div className="grid md:grid-cols-2 gap-4">
              {[['New BMCUs (first trip in this period)', data.new_bmcus], ['BMCUs not served this period (served before)', data.closed_bmcus]].map(([title, rows]) => (
                <div key={title} className="card overflow-hidden">
                  <div className="px-4 py-2 font-semibold text-sm border-b border-gray-100">{title} — {rows.length}</div>
                  <div className="overflow-auto max-h-72">
                    <table className="w-full text-xs">
                      <thead className="bg-blue-50 text-gray-600 sticky top-0"><tr>{['BMCU', 'First trip', 'Last trip', 'Trips', 'Litres', 'Km', 'Cost ₹'].map(h => <th key={h} className="px-2 py-1.5 text-right first:text-left">{h}</th>)}</tr></thead>
                      <tbody>
                        {rows.map(b => (
                          <tr key={b.bmcu_id} className="border-t border-gray-100">
                            <td className="px-2 py-1">{b.bmcu_code} {b.bmcu_name}</td>
                            <td className="px-2 py-1 text-right whitespace-nowrap">{fmtDate(b.first_date)}</td>
                            <td className="px-2 py-1 text-right whitespace-nowrap">{fmtDate(b.last_date)}</td>
                            <td className="px-2 py-1 text-right">{nf(b.trips)}</td>
                            <td className="px-2 py-1 text-right">{nf(b.litres)}</td>
                            <td className="px-2 py-1 text-right">{nf(b.km)}</td>
                            <td className="px-2 py-1 text-right">{nf(b.cost)}</td>
                          </tr>
                        ))}
                        {!rows.length && <tr><td className="px-2 py-2 text-gray-400" colSpan={7}>None</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="card p-3 text-[11px] text-gray-500 space-y-1">
            {data.notes.map((n, i) => <div key={i}>• {n}</div>)}
          </div>
        </>
      )}
    </div>
  );
}
