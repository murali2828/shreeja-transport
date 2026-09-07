// frontend/src/pages/execution/TankerPosition.jsx
// Live tanker status/position dashboard (3-level drill-down):
//   Level 2 — dairy-location cards; Level 3 — status blocks per location;
//   then the detailed tanker list. Statuses derive from the trip cycle
//   (gate pass → running, COA → unloading, unload click → cleaning) and
//   non-trip gate passes (maintenance / without driver), else idle.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ChevronLeft, Truck, Download } from 'lucide-react';
import toast from 'react-hot-toast';
import { getTankerPosition, getTankerPositionReport } from '../../api/index';

const STATUS_META = {
  running:        { label: 'Running Tankers',         color: '#3b82f6', bg: 'bg-blue-50',    text: 'text-blue-700' },
  maintenance:    { label: 'Maintenance Tankers',     color: '#f59e0b', bg: 'bg-amber-50',   text: 'text-amber-700' },
  without_driver: { label: 'Without Driver Tankers',  color: '#ef4444', bg: 'bg-red-50',     text: 'text-red-600' },
  idle:           { label: 'Idle / Available',        color: '#6b7280', bg: 'bg-gray-50',    text: 'text-gray-600' },
};
const fmtTs = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export default function TankerPosition() {
  const [loc, setLoc]       = useState(null);   // selected location name
  const [status, setStatus] = useState(null);   // selected status key

  const { data, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['tanker-position'],
    queryFn:  () => getTankerPosition().then(r => r.data),
    refetchInterval: 60_000,
  });

  const downloadReport = () =>
    getTankerPositionReport().then(r => {
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = `tanker_position_${new Date().toISOString().slice(0,10)}.xlsx`; a.click();
      URL.revokeObjectURL(url);
    }).catch(e => toast.error(e.response?.data?.error || e.message || 'Report download failed'));

  const locations = data?.locations || [];
  const selected  = locations.find(l => l.name === loc) || null;
  const listRows  = selected
    ? selected.tankers.filter(t => !status || t.status === status)
    : [];

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div className="flex items-center gap-2">
          {loc && (
            <button onClick={() => (status ? setStatus(null) : setLoc(null))}
              className="btn-secondary flex items-center gap-1 text-xs py-1.5">
              <ChevronLeft size={13}/> Back
            </button>
          )}
          <div>
            <div className="page-title">
              Tanker Position{selected ? ` — ${selected.name}` : ''}
              {status ? ` — ${STATUS_META[status].label}` : ''}
            </div>
            <div className="page-sub">
              Live tanker status from Gate Pass / COA / Unloading events · updated {fmtTs(data?.last_updated || dataUpdatedAt)}
              {isFetching && <RefreshCw size={11} className="animate-spin inline ml-2"/>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">
            {data?.total_tankers ?? '—'} total tankers
          </span>
          <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">
            {data?.active_tankers ?? '—'} active
          </span>
          <button onClick={downloadReport} className="btn-secondary flex items-center gap-1.5 py-1.5">
            <Download size={13}/> Report
          </button>
        </div>
      </div>

      {/* Level 2 — location cards */}
      {!selected && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {locations.length === 0 && (
            <div className="card"><div className="empty-state">No tanker activity yet — statuses appear once Gate Pass / COA / Unloading are used.</div></div>
          )}
          {locations.map(l => (
            <div key={l.name} onClick={() => setLoc(l.name)}
              className="card card-body cursor-pointer hover:scale-[1.01] transition-transform">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
                    <Truck size={17} className="text-[#0078d4]"/>
                  </div>
                  <div className="text-sm font-bold text-gray-800">{l.name}</div>
                </div>
                <div className="text-2xl font-bold text-[#0078d4]">{l.total}</div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(STATUS_META).map(([k, m]) => l[k] > 0 && (
                  <span key={k} className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${m.bg} ${m.text}`}>
                    {m.label.replace(' Tankers','')}: {l[k]}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Level 3 — status blocks for the selected location */}
      {selected && !status && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          {Object.entries(STATUS_META).map(([k, m]) => (
            <div key={k} onClick={() => selected[k] > 0 && setStatus(k)}
              className={`card p-4 text-center border-2 ${selected[k] > 0 ? 'cursor-pointer hover:scale-[1.02] transition-transform' : 'opacity-50'}`}
              style={{ borderColor: m.color }}>
              <div className="text-3xl font-bold" style={{ color: m.color }}>{selected[k]}</div>
              <div className="text-xs font-medium text-gray-700 mt-1">{m.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Detailed tanker list */}
      {selected && (
        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 bg-gray-50 border-b text-sm font-semibold text-gray-700">
            {status ? STATUS_META[status].label : 'All tankers'} — {selected.name}
          </div>
          <div className="overflow-x-auto max-h-[55vh]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-gray-50 border-b">
                <tr>
                  <th className="table-th">Tanker</th>
                  <th className="table-th">Status</th>
                  <th className="table-th">Since</th>
                  <th className="table-th">Detail</th>
                </tr>
              </thead>
              <tbody>
                {listRows.map((t, i) => {
                  const m = STATUS_META[t.status];
                  return (
                    <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="table-td font-mono font-semibold text-[#005ba3]">{t.tanker_number}</td>
                      <td className="table-td">
                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${m.bg} ${m.text}`}>
                          {m.label.replace(' Tankers','')}
                        </span>
                      </td>
                      <td className="table-td whitespace-nowrap">{fmtTs(t.since)}</td>
                      <td className="table-td text-gray-600">{t.detail || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
