// frontend/src/pages/reports/TripDurations.jsx
// Trip Durations — derived from Gate Pass / COA first-print timestamps:
//   1. Round Trip Duration: gate pass print (trip start) → COA print (arrived).
//   2. Delivery Point Turnaround: COA print → same tanker's next trip gate pass
//      (time spent inside the delivery point unloading/cleaning).
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { getTripDurations, downloadTripDurationsExcel } from '../../api/index';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const fmtTs = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const StatusPill = ({ s }) => (
  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
    s === 'Completed' || s === 'Departed' ? 'bg-green-100 text-green-700'
    : s === 'On trip' || s === 'In plant' ? 'bg-amber-100 text-amber-700'
    : 'bg-gray-100 text-gray-500'}`}>{s}</span>
);

const Dur = ({ d }) => d?.label
  ? <span className="font-semibold text-[#003a6b]">{d.label}</span>
  : <span className="text-gray-300">—</span>;

export default function TripDurations() {
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo]     = useState(today());

  const { data, isFetching } = useQuery({
    queryKey: ['trip-durations', from, to],
    queryFn:  () => getTripDurations({ from_date: from, to_date: to }).then(r => r.data),
    enabled:  !!from && !!to,
  });
  const rt = data?.round_trips || [];
  const ta = data?.turnarounds || [];

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title">Trip Durations</div>
          <div className="page-sub">Round trip &amp; delivery-point turnaround — from Gate Pass / COA print times</div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input type="date" className="input py-1.5 text-sm" value={from} onChange={e => setFrom(e.target.value)}/>
          <span className="text-gray-400 text-sm">to</span>
          <input type="date" className="input py-1.5 text-sm" value={to} onChange={e => setTo(e.target.value)}/>
          <button onClick={() => downloadTripDurationsExcel(from, to)} className="btn-secondary flex items-center gap-1.5 text-sm">
            <Download size={14}/> Export Excel
          </button>
          {isFetching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
        </div>
      </div>

      {/* Report 1 — Round trip duration */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 bg-gray-50 border-b text-sm font-semibold text-gray-700">
          Round Trip Duration — trip start (Gate Pass) to arrival at delivery point (COA)
        </div>
        <div className="overflow-x-auto max-h-[45vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Trip</th>
                <th className="table-th">Plan Date</th>
                <th className="table-th">Tanker</th>
                <th className="table-th">Route</th>
                <th className="table-th">Starting Point</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Trip Start (Gate Pass)</th>
                <th className="table-th">Arrived (COA)</th>
                <th className="table-th text-right">Round Trip</th>
                <th className="table-th text-right">Days</th>
                <th className="table-th">Status</th>
              </tr>
            </thead>
            <tbody>
              {rt.length === 0 && (
                <tr><td colSpan={11}><div className="empty-state">No trips in this date range.</div></td></tr>
              )}
              {rt.map((x, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td font-bold text-[#0078d4]">#{x.trip_no}</td>
                  <td className="table-td whitespace-nowrap">{x.plan_for_date}</td>
                  <td className="table-td font-mono">{x.tanker_number || '—'}</td>
                  <td className="table-td">{x.route_name || '—'}</td>
                  <td className="table-td">{x.starting_point || '—'}</td>
                  <td className="table-td">{x.delivery_point || '—'}</td>
                  <td className="table-td whitespace-nowrap">{fmtTs(x.trip_start_at)}</td>
                  <td className="table-td whitespace-nowrap">{fmtTs(x.arrived_at)}</td>
                  <td className="table-td text-right whitespace-nowrap"><Dur d={x.duration}/></td>
                  <td className="table-td text-right">{x.duration?.days ?? '—'}</td>
                  <td className="table-td"><StatusPill s={x.status}/></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Report 2 — Delivery point turnaround */}
      <div className="card overflow-hidden">
        <div className="px-4 py-2.5 bg-gray-50 border-b text-sm font-semibold text-gray-700">
          Delivery Point Turnaround — arrival (COA) to next trip's Gate Pass, per tanker
        </div>
        <div className="overflow-x-auto max-h-[45vh]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Tanker</th>
                <th className="table-th">Arrived Trip</th>
                <th className="table-th">Plan Date</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Arrived (COA)</th>
                <th className="table-th">Next Trip</th>
                <th className="table-th">Next Gate Pass</th>
                <th className="table-th text-right">In-Plant Time</th>
                <th className="table-th text-right">Days</th>
                <th className="table-th">Status</th>
              </tr>
            </thead>
            <tbody>
              {ta.length === 0 && (
                <tr><td colSpan={10}><div className="empty-state">No arrivals (COA prints) in this date range.</div></td></tr>
              )}
              {ta.map((x, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td font-mono font-semibold text-[#005ba3]">{x.tanker_number || '—'}</td>
                  <td className="table-td font-bold text-[#0078d4]">#{x.arrived_trip_no}</td>
                  <td className="table-td whitespace-nowrap">{x.plan_for_date}</td>
                  <td className="table-td">{x.delivery_point || '—'}</td>
                  <td className="table-td whitespace-nowrap">{fmtTs(x.arrived_at)}</td>
                  <td className="table-td">{x.next_trip_no ? `#${x.next_trip_no}` : '—'}</td>
                  <td className="table-td whitespace-nowrap">{fmtTs(x.next_gate_pass_at)}</td>
                  <td className="table-td text-right whitespace-nowrap"><Dur d={x.duration}/></td>
                  <td className="table-td text-right">{x.duration?.days ?? '—'}</td>
                  <td className="table-td"><StatusPill s={x.status}/></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
