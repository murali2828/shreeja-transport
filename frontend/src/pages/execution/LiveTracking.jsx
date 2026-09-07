// frontend/src/pages/execution/LiveTracking.jsx
// Live tanker map from WheelsEye GPS (backend poller → /api/tracking).
// Left panel lists tankers with search + state filters; the map shows a
// colour-coded marker per matched tanker (green moving, grey stopped, amber
// stale). Selecting a tanker centres the map, opens its popup and draws its
// last-24 h trail. WheelsEye vehicles whose registration number matches no
// tanker are listed under "Not in tanker master" so admin can fix the master.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RefreshCw, Search, PanelLeftClose, PanelLeftOpen, Navigation, Truck, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { getTrackingPositions, getTrackingHistory, pollTrackingNow } from '../../api/index';

const fmtTs = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtClock = ts => ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
const ago = ts => {
  if (!ts) return '—';
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};

// Marker state: 'stale' (amber ring) · 'moving' (green) · 'stopped' (grey)
const stateOf = p => p.is_stale ? 'stale' : p.is_moving ? 'moving' : 'stopped';
const STATE_META = {
  moving:  { label: 'Moving',  color: '#16a34a', bg: 'bg-green-50', text: 'text-green-700' },
  stopped: { label: 'Stopped', color: '#6b7280', bg: 'bg-gray-100', text: 'text-gray-600' },
  stale:   { label: 'Stale',   color: '#d97706', bg: 'bg-amber-50', text: 'text-amber-700' },
};
const FILTERS = [['all', 'All'], ['moving', 'Moving'], ['stopped', 'Stopped'], ['stale', 'Stale'], ['nogps', 'No GPS']];

// Default Leaflet marker images don't resolve under Vite; use a divIcon with
// an inline SVG dot instead (colour encodes state, arrow shows heading).
const iconCache = {};
function iconFor(state, selected, angle) {
  const key = `${state}-${selected ? 1 : 0}-${Math.round((angle || 0) / 15) * 15}`;
  if (iconCache[key]) return iconCache[key];
  const c = STATE_META[state].color;
  const size = selected ? 26 : 20;
  const ring = state === 'stale' ? `<circle cx="12" cy="12" r="10.5" fill="none" stroke="${c}" stroke-width="2" stroke-dasharray="3 2"/>` : '';
  const arrow = state === 'moving' && angle != null
    ? `<polygon points="12,1 15,7 9,7" fill="${c}" transform="rotate(${Math.round(angle)} 12 12)"/>` : '';
  const html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">
    ${ring}${arrow}
    <circle cx="12" cy="12" r="6.5" fill="${c}" stroke="#fff" stroke-width="${selected ? 3 : 2}"/>
  </svg>`;
  iconCache[key] = L.divIcon({ html, className: 'tracking-marker', iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  return iconCache[key];
}

// Fit to all tankers on first load, then fly to the selected tanker.
function MapController({ positions, selected, fitKey }) {
  const map = useMap();
  const fitted = useRef(null);
  useEffect(() => {
    if (fitted.current === fitKey) return;
    const pts = positions.filter(p => p.latitude != null && p.longitude != null).map(p => [p.latitude, p.longitude]);
    if (!pts.length) return;
    map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 13 });
    fitted.current = fitKey;
  }, [map, positions, fitKey]);
  useEffect(() => {
    if (selected?.latitude != null && selected?.longitude != null)
      map.flyTo([selected.latitude, selected.longitude], Math.max(map.getZoom(), 14), { duration: 0.6 });
  }, [map, selected?.tanker_id, selected?.latitude, selected?.longitude]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function tripLine(p) {
  if (!p.trip_no) return null;
  const route = [p.route_name, p.delivery_point].filter(Boolean).join(' → ');
  return `Trip #${p.trip_no}${route ? ' · ' + route : ''}`;
}

export default function LiveTracking() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [panelOpen, setPanelOpen] = useState(true);
  const [search, setSearch]       = useState('');
  const [filter, setFilter]       = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [polling, setPolling]     = useState(false);
  const markerRefs = useRef({});

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['tracking-positions'],
    queryFn:  () => getTrackingPositions().then(r => r.data),
    refetchInterval: 60_000,
  });
  const positions = data?.positions || [];
  const unmatched = data?.unmatched || [];
  const selected  = positions.find(p => p.tanker_id === selectedId) || null;

  const { data: trail = [] } = useQuery({
    queryKey: ['tracking-history', selected?.tanker_number],
    queryFn:  () => getTrackingHistory(selected.tanker_number).then(r => r.data),
    enabled:  !!selected,
    refetchInterval: 60_000,
  });

  const counts = useMemo(() => {
    const c = { all: positions.length, moving: 0, stopped: 0, stale: 0, nogps: 0 };
    for (const p of positions) {
      if (p.latitude == null || p.longitude == null) { c.nogps++; continue; }
      c[stateOf(p)]++;
    }
    return c;
  }, [positions]);

  const listRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return positions.filter(p => {
      const hasFix = p.latitude != null && p.longitude != null;
      if (filter === 'nogps' && hasFix) return false;
      if (filter !== 'all' && filter !== 'nogps' && (!hasFix || stateOf(p) !== filter)) return false;
      if (!q) return true;
      return [p.tanker_number, p.vendor_name, p.trip_no && `trip #${p.trip_no}`, p.route_name, p.delivery_point, p.location]
        .some(v => v && String(v).toLowerCase().includes(q));
    });
  }, [positions, search, filter]);

  const select = p => {
    setSelectedId(p.tanker_id);
    setTimeout(() => markerRefs.current[p.tanker_id]?.openPopup(), 700);
  };

  const pollNow = () => {
    setPolling(true);
    pollTrackingNow().then(r => {
      toast.success(`Polled: ${r.data.received} vehicles, ${r.data.matched} matched, ${r.data.unmatched?.length || 0} unmatched`);
      refetch();
    }).catch(e => toast.error(e.response?.data?.error || e.message || 'Poll failed'))
      .finally(() => setPolling(false));
  };

  const mapped = positions.filter(p => p.latitude != null && p.longitude != null);
  const trailPts = trail.map(t => [t.latitude, t.longitude]);
  const pollStatus = data?.poll_status;

  return (
    <div className="space-y-4 w-full">
      <style>{`
        .leaflet-container { z-index: 0; font: inherit; }
        .tracking-marker { background: transparent; border: 0; }
        .leaflet-popup-content { margin: 10px 12px; font-size: 12px; line-height: 1.45; }
        .leaflet-popup-content-wrapper { border-radius: 12px; }
      `}</style>

      <div className="page-header">
        <div>
          <div className="page-title">Live Tracking</div>
          <div className="page-sub">
            WheelsEye GPS · {positions.length} tankers · {counts.moving} moving · {counts.stopped} stopped · {counts.stale} stale
            {' · '}last poll {fmtClock(data?.polled_at)}
            {isFetching && <RefreshCw size={11} className="animate-spin inline ml-2"/>}
            {pollStatus && !pollStatus.enabled && <span className="ml-2 text-amber-200">(poller not configured on this server)</span>}
            {pollStatus?.last_error && <span className="ml-2 text-amber-200">(last poll error: {pollStatus.last_error})</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button onClick={() => setPanelOpen(o => !o)} className="btn-secondary flex items-center gap-1.5 py-1.5">
            {panelOpen ? <PanelLeftClose size={13}/> : <PanelLeftOpen size={13}/>} {panelOpen ? 'Hide list' : 'Show list'}
          </button>
          {isAdmin && (
            <button onClick={pollNow} disabled={polling} className="btn-secondary flex items-center gap-1.5 py-1.5">
              <RefreshCw size={13} className={polling ? 'animate-spin' : ''}/> Poll now
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 190px)', minHeight: 420 }}>
        {/* Left panel */}
        {panelOpen && (
          <div className="card w-80 shrink-0 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-blue-100 space-y-2">
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-2.5 text-gray-400"/>
                <input className="input pl-8 py-1.5 text-xs" placeholder="Tanker / vendor / trip…"
                  value={search} onChange={e => setSearch(e.target.value)}/>
              </div>
              <div className="flex flex-wrap gap-1">
                {FILTERS.map(([k, label]) => (
                  <button key={k} onClick={() => setFilter(k)}
                    className={`text-[11px] px-2 py-0.5 rounded-full font-semibold border transition-colors ${
                      filter === k ? 'bg-[#0078d4] text-white border-[#0078d4]' : 'bg-white text-gray-600 border-gray-200 hover:border-[#0078d4]'}`}>
                    {label} {counts[k]}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {listRows.length === 0 && (
                <div className="empty-state text-xs p-4">
                  {positions.length ? 'No tankers match.' : 'No GPS positions yet — the poller fills this in once WheelsEye is configured.'}
                </div>
              )}
              {listRows.map(p => {
                const hasFix = p.latitude != null && p.longitude != null;
                const st = hasFix ? stateOf(p) : null;
                const m = st ? STATE_META[st] : null;
                return (
                  <button key={p.tanker_id} onClick={() => hasFix && select(p)}
                    className={`w-full text-left px-3 py-2 border-b border-gray-50 hover:bg-blue-50/60 transition-colors ${
                      selectedId === p.tanker_id ? 'bg-blue-50' : ''} ${hasFix ? '' : 'opacity-60 cursor-default'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold text-[#005ba3] text-xs">{p.tanker_number}</span>
                      {m ? (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${m.bg} ${m.text}`}>
                          {m.label}{st === 'moving' ? ` · ${Math.round(p.speed || 0)} km/h` : ''}
                        </span>
                      ) : <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-gray-100 text-gray-500">No GPS</span>}
                    </div>
                    <div className="text-[11px] text-gray-500 truncate">{p.vendor_name || '—'} · {ago(p.gps_time)}</div>
                    {tripLine(p) && <div className="text-[11px] text-gray-700 truncate">{tripLine(p)}</div>}
                  </button>
                );
              })}
            </div>

            <div className="border-t border-blue-100">
              <button onClick={() => setShowUnmatched(o => !o)}
                className="w-full flex items-center gap-1 px-3 py-2 text-[11px] font-semibold text-gray-600 hover:bg-gray-50">
                {showUnmatched ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}
                Not in tanker master ({unmatched.length})
              </button>
              {showUnmatched && (
                <div className="max-h-40 overflow-y-auto px-3 pb-2 text-[11px] text-gray-600">
                  {unmatched.length === 0 && <div className="text-gray-400">All WheelsEye vehicles match a tanker.</div>}
                  {unmatched.map(u => (
                    <div key={u.vehicle_number} className="flex justify-between py-0.5">
                      <span className="font-mono">{u.vehicle_number_raw}</span>
                      <span className="text-gray-400">{fmtTs(u.gps_time)}</span>
                    </div>
                  ))}
                  {unmatched.length > 0 && (
                    <div className="text-gray-400 mt-1">Fix the registration number in Tanker Master to match WheelsEye.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Map */}
        <div className="card flex-1 overflow-hidden">
          <MapContainer center={[13.63, 79.42]} zoom={8} className="w-full h-full" scrollWheelZoom>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>
            <MapController positions={mapped} selected={selected} fitKey={mapped.length ? 'loaded' : null}/>
            {selected && trailPts.length > 1 && (
              <Polyline positions={trailPts} pathOptions={{ color: '#0078d4', weight: 3, opacity: 0.75 }}/>
            )}
            {mapped.map(p => (
              <Marker key={p.tanker_id} position={[p.latitude, p.longitude]}
                icon={iconFor(stateOf(p), selectedId === p.tanker_id, p.angle)}
                ref={el => { markerRefs.current[p.tanker_id] = el; }}
                eventHandlers={{ click: () => setSelectedId(p.tanker_id) }}>
                <Popup>
                  <div className="font-mono font-bold text-[#005ba3] text-sm">{p.tanker_number}</div>
                  <div className="text-gray-600">{p.vendor_name || '—'}{p.capacity_litres ? ` · ${p.capacity_litres} L` : ''}</div>
                  <div className="mt-1">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${STATE_META[stateOf(p)].bg} ${STATE_META[stateOf(p)].text}`}>
                      {STATE_META[stateOf(p)].label}
                    </span>
                    {' '}{Math.round(p.speed || 0)} km/h · ignition {p.ignition ? 'ON' : 'OFF'}
                  </div>
                  <div className="text-gray-500">Last update {fmtTs(p.gps_time)} ({ago(p.gps_time)})</div>
                  {p.location && <div className="text-gray-600 mt-1">{p.location}</div>}
                  {tripLine(p) && (
                    <div className="mt-1 text-gray-800">{tripLine(p)}{p.gp_at ? ` · out ${fmtTs(p.gp_at)}` : ''}</div>
                  )}
                  <Link to="/tanker-position" className="btn-secondary inline-flex items-center gap-1 mt-2 py-1 text-[11px]">
                    <Truck size={11}/> Tanker Position
                  </Link>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      </div>

      <div className="text-[11px] text-white/70 flex items-center gap-3">
        <Navigation size={11}/>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-green-600 mr-1"/>Moving (ignition on, &gt;2 km/h)</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500 mr-1"/>Stopped</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-dashed border-amber-500 mr-1"/>Stale (no fix for {pollStatus?.stale_minutes ?? 30} min)</span>
        {selected && <span>· Trail: last 24 h for {selected.tanker_number}</span>}
      </div>
    </div>
  );
}
