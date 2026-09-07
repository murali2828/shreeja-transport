// frontend/src/pages/execution/LiveTracking.jsx
// Tanker map from WheelsEye GPS (backend poller → /api/tracking).
//
// Live mode: left panel lists tankers with search + state filters; the map
// shows a colour-coded marker per matched tanker (green moving, grey stopped,
// amber stale). Selecting a tanker centres the map, opens its popup and draws
// its last-24 h trail. WheelsEye vehicles whose registration number matches no
// tanker are listed under "Not in tanker master" so admin can fix the master.
//
// Trip playback mode: pick date / tanker / trip → planned route (dashed blue,
// numbered BMCUs) vs the actual GPS trail (green), detected stops (BMCU waits
// blue, unplanned red), missed BMCUs (red ring) and the analysis totals from
// /api/tracking/trip/:id. Deep links: /tracking?execution=<id> and
// /tracking?date=YYYY-MM-DD&tanker=<number>.
//
// Both modes: "BMCUs" / "Plants" layer toggles draw the masters as light
// CircleMarkers with a permanent name label at zoom ≥ 12.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { MapContainer, TileLayer, Marker, Popup, Polyline, CircleMarker, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { RefreshCw, Search, PanelLeftClose, PanelLeftOpen, Navigation, Truck, ChevronDown, ChevronRight, Download, Route, Radio } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../hooks/useAuth';
import { fmtDate } from '../../utils/date';
import { getTrackingPositions, getTrackingHistory, pollTrackingNow, getTrackingBmcus, getTrackingTrips, getTrackingTrip,
         getTrackingTripReport, getTrackingFleetReport } from '../../api/index';

const fmtTs = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtClock = ts => ts ? new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtMin = m => m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.round(m)} min`;
const ago = ts => {
  if (!ts) return '—';
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};
const todayIso = () => new Date().toISOString().slice(0, 10);
const monthStartIso = () => todayIso().slice(0, 8) + '01';
const download = (promise, filename) => promise.then(r => {
  const url = URL.createObjectURL(r.data);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}).catch(e => toast.error(e.response?.data?.error || e.message || 'Report download failed'));

// Marker state: 'stale' (amber ring) · 'moving' (green) · 'stopped' (grey)
const stateOf = p => p.is_stale ? 'stale' : p.is_moving ? 'moving' : 'stopped';
const STATE_META = {
  moving:  { label: 'Moving',  color: '#16a34a', bg: 'bg-green-50', text: 'text-green-700' },
  stopped: { label: 'Stopped', color: '#6b7280', bg: 'bg-gray-100', text: 'text-gray-600' },
  stale:   { label: 'Stale',   color: '#d97706', bg: 'bg-amber-50', text: 'text-amber-700' },
};
const FILTERS = [['all', 'All'], ['moving', 'Moving'], ['stopped', 'Stopped'], ['stale', 'Stale'], ['nogps', 'No GPS']];
const STOP_COLOR = { start: '#6b7280', delivery: '#6b7280', bmcu: '#0078d4', unplanned: '#dc2626' };
const TRACKING_SINCE = '07-09-2026'; // first poller run — no history before this

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
// Trip-mode icons: numbered planned BMCU, start (S) / delivery (D) squares, trail ▶ / ■.
function labelIcon(text, { bg = '#0078d4', ring = false, square = false, size = 22 } = {}) {
  const key = `lbl-${text}-${bg}-${ring}-${square}-${size}`;
  if (iconCache[key]) return iconCache[key];
  const shape = square
    ? `<rect x="2" y="2" width="20" height="20" rx="4" fill="${bg}" stroke="#fff" stroke-width="2"/>`
    : `<circle cx="12" cy="12" r="9.5" fill="${bg}" stroke="#fff" stroke-width="2"/>`;
  const ringSvg = ring ? `<circle cx="12" cy="12" r="11.5" fill="none" stroke="#dc2626" stroke-width="2.5"/>` : '';
  const html = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">${ringSvg}${shape}
    <text x="12" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="system-ui,sans-serif">${text}</text></svg>`;
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

// Fit the map to a set of [lat,lng] points whenever `fitKey` changes.
function FitBounds({ points, fitKey }) {
  const map = useMap();
  const fitted = useRef(null);
  useEffect(() => {
    if (!fitKey || fitted.current === fitKey || !points.length) return;
    map.fitBounds(L.latLngBounds(points).pad(0.12), { maxZoom: 14 });
    fitted.current = fitKey;
  }, [map, points, fitKey]);
  return null;
}

// Master layer: BMCUs (small blue-grey dots) and plants (start = teal, delivery = purple).
// Names are permanent labels at zoom ≥ 12, hover tooltips below that.
function MasterLayer({ bmcus, plants, showBmcus, showPlants }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  const permanent = zoom >= 12;
  return (
    <>
      {showBmcus && bmcus.map(b => (
        <CircleMarker key={`b${b.id}`} center={[b.lat, b.lng]} radius={4}
          pathOptions={{ color: '#475569', fillColor: '#94a3b8', fillOpacity: 0.85, weight: 1 }}>
          <Tooltip key={permanent ? 'p' : 'h'} permanent={permanent} direction="top" offset={[0, -4]} className="bmcu-label">
            {b.code} {b.name}
          </Tooltip>
        </CircleMarker>
      ))}
      {showPlants && plants.map(p => (
        <CircleMarker key={`${p.kind}${p.id}`} center={[p.lat, p.lng]} radius={6}
          pathOptions={{ color: '#fff', fillColor: p.kind === 'start' ? '#0d9488' : '#7c3aed', fillOpacity: 0.95, weight: 1.5 }}>
          <Tooltip key={permanent ? 'p' : 'h'} permanent={permanent} direction="top" offset={[0, -6]} className="bmcu-label">
            {p.kind === 'start' ? 'Start' : 'Plant'}: {p.name}
          </Tooltip>
        </CircleMarker>
      ))}
    </>
  );
}

function tripLine(p) {
  if (!p.trip_no) return null;
  const route = [p.route_name, p.delivery_point].filter(Boolean).join(' → ');
  return `Trip #${p.trip_no}${route ? ' · ' + route : ''}`;
}
const stopLabel = s => {
  if (s.type === 'unplanned') {
    const near = s.nearest_bmcu ? ` · ${(s.nearest_bmcu.distance_m / 1000).toFixed(1)} km from ${s.nearest_bmcu.code} ${s.nearest_bmcu.name}` : ' · no BMCU within 5 km';
    return `Unplanned stop · ${fmtMin(s.minutes)}${near}`;
  }
  const where = s.node ? `${s.node.code ? s.node.code + ' ' : ''}${s.node.name}` : s.type;
  return `${s.type === 'bmcu' ? 'Waited' : 'Stopped'} ${fmtMin(s.minutes)} at ${where}`;
};

export default function LiveTracking() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const urlExec = parseInt(searchParams.get('execution') || '', 10) || null;
  const urlDate = /^\d{4}-\d{2}-\d{2}$/.test(searchParams.get('date') || '') ? searchParams.get('date') : null;
  const urlTanker = searchParams.get('tanker') || '';

  const [mode, setMode]           = useState(urlExec || urlDate || urlTanker ? 'trip' : 'live');
  const [panelOpen, setPanelOpen] = useState(true);
  const [search, setSearch]       = useState('');
  const [filter, setFilter]       = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [showUnmatched, setShowUnmatched] = useState(false);
  const [polling, setPolling]     = useState(false);
  const [showBmcus, setShowBmcus] = useState(mode === 'trip');
  const [showPlants, setShowPlants] = useState(mode === 'trip');
  const [fleetFrom, setFleetFrom] = useState(monthStartIso());
  const [fleetTo, setFleetTo]     = useState(todayIso());
  const [fleetBusy, setFleetBusy] = useState(false);
  // Trip mode pickers
  const [tripDate, setTripDate]   = useState(urlDate || todayIso());
  const [tripTanker, setTripTanker] = useState(urlTanker);
  const [execId, setExecId]       = useState(urlExec);
  const markerRefs = useRef({});

  const switchMode = m => { setMode(m); setShowBmcus(m === 'trip'); setShowPlants(m === 'trip'); };

  // ── Live data ──────────────────────────────────────────────────────────────
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['tracking-positions'],
    queryFn:  () => getTrackingPositions().then(r => r.data),
    refetchInterval: 60_000,
  });
  const positions = data?.positions || [];
  const unmatched = data?.unmatched || [];
  const selected  = mode === 'live' ? (positions.find(p => p.tanker_id === selectedId) || null) : null;

  const { data: trail = [] } = useQuery({
    queryKey: ['tracking-history', selected?.tanker_number],
    queryFn:  () => getTrackingHistory(selected.tanker_number).then(r => r.data),
    enabled:  !!selected,
    refetchInterval: 60_000,
  });

  // ── Masters (BMCU / plant layer) ───────────────────────────────────────────
  const { data: masters } = useQuery({
    queryKey: ['tracking-bmcus'],
    queryFn:  () => getTrackingBmcus().then(r => r.data),
    staleTime: 10 * 60_000,
    enabled: showBmcus || showPlants,
  });
  const masterBmcus = masters?.bmcus || [];
  const plants = useMemo(() => [
    ...(masters?.starting_points || []).map(p => ({ ...p, kind: 'start' })),
    ...(masters?.delivery_points || []).map(p => ({ ...p, kind: 'delivery' })),
  ], [masters]);

  // ── Trip mode data ─────────────────────────────────────────────────────────
  const { data: trips = [], isFetching: tripsLoading } = useQuery({
    queryKey: ['tracking-trips', tripDate],
    queryFn:  () => getTrackingTrips({ date: tripDate }).then(r => r.data),
    enabled:  mode === 'trip' && !!tripDate,
  });
  const tankerOptions = useMemo(() => [...new Set(trips.map(t => t.tanker_number).filter(Boolean))].sort(), [trips]);
  const tripOptions = useMemo(() => trips.filter(t => !tripTanker || t.tanker_number === tripTanker), [trips, tripTanker]);

  const { data: analysis, isFetching: analysisLoading, error: analysisError } = useQuery({
    queryKey: ['tracking-trip', execId],
    queryFn:  () => getTrackingTrip(execId).then(r => r.data),
    enabled:  mode === 'trip' && !!execId,
  });

  // Deep-linked execution: once loaded, align the date/tanker pickers to it.
  useEffect(() => {
    if (!analysis || analysis.execution.execution_id !== execId) return;
    if (analysis.execution.plan_for_date && analysis.execution.plan_for_date !== tripDate) setTripDate(analysis.execution.plan_for_date);
    if (analysis.execution.tanker_number && analysis.execution.tanker_number !== tripTanker) setTripTanker(analysis.execution.tanker_number);
  }, [analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the URL in step so the view is shareable.
  useEffect(() => {
    if (mode !== 'trip') { if (searchParams.toString()) setSearchParams({}, { replace: true }); return; }
    const next = {};
    if (execId) next.execution = String(execId);
    else { if (tripDate) next.date = tripDate; if (tripTanker) next.tanker = tripTanker; }
    if (new URLSearchParams(next).toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [mode, execId, tripDate, tripTanker]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const fleetReport = () => {
    if (!fleetFrom || !fleetTo || fleetTo < fleetFrom) return toast.error('Pick a valid from/to range');
    setFleetBusy(true);
    download(getTrackingFleetReport({ from: fleetFrom, to: fleetTo }), `trip_analysis_${fleetFrom}_${fleetTo}.xlsx`).finally(() => setFleetBusy(false));
  };
  const tripReport = () => analysis &&
    download(getTrackingTripReport(execId), `trip_${analysis.execution.trip_no}_${analysis.execution.tanker_number || ''}_${analysis.execution.plan_for_date}.xlsx`);

  const mapped = positions.filter(p => p.latitude != null && p.longitude != null);
  const trailPts = trail.map(t => [t.latitude, t.longitude]);
  const pollStatus = data?.poll_status;

  // ── Trip-mode geometry ─────────────────────────────────────────────────────
  const plan = analysis?.plan;
  const plannedPts = useMemo(() => {
    if (!plan) return [];
    const nodes = [plan.start, ...plan.bmcus, plan.delivery].filter(n => n && n.lat != null && n.lng != null);
    return nodes.map(n => [n.lat, n.lng]);
  }, [plan]);
  const actualPts = useMemo(() => (analysis?.trail || []).map(p => [p.lat, p.lng]), [analysis]);
  const fitPts = useMemo(() => [...plannedPts, ...actualPts], [plannedPts, actualPts]);
  const missedIds = useMemo(() => new Set((analysis?.bmcu_visits || []).filter(v => v.missed).map(v => v.id)), [analysis]);
  const totals = analysis?.totals;
  const unplanned = (analysis?.stops || []).filter(s => s.type === 'unplanned');

  return (
    <div className="space-y-4 w-full">
      <style>{`
        .leaflet-container { z-index: 0; font: inherit; }
        .tracking-marker { background: transparent; border: 0; }
        .leaflet-popup-content { margin: 10px 12px; font-size: 12px; line-height: 1.45; }
        .leaflet-popup-content-wrapper { border-radius: 12px; }
        .bmcu-label { font-size: 10px; padding: 1px 4px; background: rgba(255,255,255,0.85); border: 1px solid #cbd5e1; box-shadow: none; }
        .bmcu-label::before { display: none; }
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
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Mode toggle */}
          <div className="inline-flex rounded-lg overflow-hidden border border-white/40">
            {[['live', 'Live', Radio], ['trip', 'Trip playback', Route]].map(([k, label, Icon]) => (
              <button key={k} onClick={() => switchMode(k)}
                className={`flex items-center gap-1 px-2.5 py-1.5 font-semibold ${mode === k ? 'bg-white text-[#005ba3]' : 'bg-white/10 text-white hover:bg-white/20'}`}>
                <Icon size={12}/> {label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1 text-white/90 cursor-pointer">
            <input type="checkbox" checked={showBmcus} onChange={e => setShowBmcus(e.target.checked)}/> BMCUs
          </label>
          <label className="flex items-center gap-1 text-white/90 cursor-pointer">
            <input type="checkbox" checked={showPlants} onChange={e => setShowPlants(e.target.checked)}/> Plants
          </label>
          <button onClick={() => setPanelOpen(o => !o)} className="btn-secondary flex items-center gap-1.5 py-1.5">
            {panelOpen ? <PanelLeftClose size={13}/> : <PanelLeftOpen size={13}/>} {panelOpen ? 'Hide panel' : 'Show panel'}
          </button>
          {isAdmin && mode === 'live' && (
            <button onClick={pollNow} disabled={polling} className="btn-secondary flex items-center gap-1.5 py-1.5">
              <RefreshCw size={13} className={polling ? 'animate-spin' : ''}/> Poll now
            </button>
          )}
          {/* Fleet report */}
          <span className="flex items-center gap-1 text-white/90" title="Fleet trip-analysis Excel — one row per trip in the range (max 31 days)">
            <input type="date" className="input py-0.5 px-1 text-[11px]" value={fleetFrom} max={fleetTo} onChange={e => setFleetFrom(e.target.value)}/>
            <span>–</span>
            <input type="date" className="input py-0.5 px-1 text-[11px]" value={fleetTo} min={fleetFrom} onChange={e => setFleetTo(e.target.value)}/>
            <button onClick={fleetReport} disabled={fleetBusy} className="btn-secondary flex items-center gap-1.5 py-1.5">
              {fleetBusy ? <RefreshCw size={13} className="animate-spin"/> : <Download size={13}/>} Fleet report
            </button>
          </span>
        </div>
      </div>

      <div className="flex gap-4" style={{ height: 'calc(100vh - 190px)', minHeight: 420 }}>
        {/* Left panel — Live */}
        {panelOpen && mode === 'live' && (
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

        {/* Left panel — Trip playback */}
        {panelOpen && mode === 'trip' && (
          <div className="card w-96 shrink-0 flex flex-col overflow-hidden">
            <div className="p-3 border-b border-blue-100 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11px] text-gray-600">Date
                  <input type="date" className="input py-1 text-xs" value={tripDate}
                    onChange={e => { setTripDate(e.target.value); setExecId(null); }}/>
                </label>
                <label className="text-[11px] text-gray-600">Tanker
                  <select className="input py-1 text-xs" value={tripTanker} onChange={e => { setTripTanker(e.target.value); setExecId(null); }}>
                    <option value="">All tankers</option>
                    {tankerOptions.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </label>
              </div>
              <label className="text-[11px] text-gray-600 block">Trip {tripsLoading && <RefreshCw size={10} className="animate-spin inline ml-1"/>}
                <select className="input py-1 text-xs" value={execId || ''} onChange={e => setExecId(parseInt(e.target.value, 10) || null)}>
                  <option value="">{tripOptions.length ? 'Select a trip…' : `No executions on ${fmtDate(tripDate)}`}</option>
                  {tripOptions.map(t => (
                    <option key={t.execution_id} value={t.execution_id}>
                      Trip #{t.trip_no} · {t.tanker_number} · {[t.route_name, t.delivery_point].filter(Boolean).join(' → ')}{t.has_trail ? '' : ' [no GPS]'}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex-1 overflow-y-auto p-3 text-xs space-y-3">
              {!execId && <div className="empty-state text-xs">Pick a trip to draw its planned route and GPS trail.</div>}
              {execId && analysisLoading && !analysis && <div className="text-gray-400"><RefreshCw size={12} className="animate-spin inline mr-1"/> Analysing…</div>}
              {analysisError && <div className="text-red-600">{analysisError.response?.data?.error || analysisError.message}</div>}
              {analysis && (
                <>
                  <div>
                    <div className="font-bold text-[#005ba3] text-sm">Trip #{analysis.execution.trip_no} · {analysis.execution.tanker_number}</div>
                    <div className="text-gray-600">{fmtDate(analysis.execution.plan_for_date)} · {analysis.execution.route_name || '—'} → {analysis.execution.delivery_point || '—'}</div>
                    <div className="text-gray-500">OUT {fmtTs(analysis.events.out_at)} · IN {fmtTs(analysis.events.in_at)}{analysis.events.unload_at ? ` · Unload ${fmtTs(analysis.events.unload_at)}` : ''}</div>
                  </div>

                  {!totals.has_trail && (
                    <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 p-2">
                      No GPS points were recorded in this trip's window (tracking started {TRACKING_SINCE}); planned route shown only.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <Stat label="Duration" value={fmtMin(totals.trip_duration_minutes)} sub={totals.duration_source ? `via ${totals.duration_source}` : ''}/>
                    <Stat label="Moving time" value={fmtMin(totals.moving_minutes)}/>
                    <Stat label="BMCU waiting" value={fmtMin(totals.bmcu_wait_minutes)}/>
                    <Stat label="Unplanned stops" value={`${totals.unplanned_stop_count} · ${fmtMin(totals.unplanned_stop_minutes)}`} warn={totals.unplanned_stop_count > 0}/>
                    <Stat label="Trail km" value={totals.has_trail ? `${totals.trail_km} km` : '—'} sub={totals.calculated_km != null ? `calc ${totals.calculated_km} km${totals.actual_km != null ? ` · actual ${totals.actual_km}` : ''}` : ''}/>
                    <Stat label="Sequence" value={!totals.has_trail ? '—' : analysis.sequence_deviation ? 'Deviated' : 'As planned'} warn={analysis.sequence_deviation}
                          sub={totals.has_trail && analysis.actual_sequence.length ? analysis.actual_sequence.join(' → ') : ''}/>
                  </div>

                  <div>
                    <div className="font-semibold text-gray-700 mb-1">BMCU visits ({analysis.bmcu_visits.length})</div>
                    <table className="w-full text-[11px]">
                      <thead><tr className="text-gray-500 text-left"><th className="pr-1">#</th><th>BMCU</th><th>Arr</th><th>Dep</th><th className="text-right">Wait</th><th className="text-center">✓</th></tr></thead>
                      <tbody>
                        {analysis.bmcu_visits.map(v => (
                          <tr key={v.planned_seq} className={`border-t border-gray-100 ${v.missed ? 'text-red-600' : ''}`}>
                            <td className="pr-1">{v.planned_seq}</td>
                            <td className="truncate max-w-[120px]" title={`${v.code} ${v.name}`}>{v.code} {v.name}</td>
                            <td>{fmtClock(v.arrived_at)}</td>
                            <td>{fmtClock(v.departed_at)}</td>
                            <td className="text-right">{v.visited ? fmtMin(v.wait_minutes) : '—'}</td>
                            <td className="text-center">{v.visited == null ? '·' : v.visited ? '✓' : 'missed'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {totals.has_trail && (
                    <div>
                      <div className="font-semibold text-gray-700 mb-1">Unplanned stops ({unplanned.length})</div>
                      {unplanned.length === 0 && <div className="text-gray-400">None detected.</div>}
                      {unplanned.map((s, i) => (
                        <div key={i} className="border-t border-gray-100 py-1">
                          <div className="text-red-700">{fmtMin(s.minutes)} · {fmtClock(s.from)}–{fmtClock(s.to)}</div>
                          <div className="text-gray-600">{s.nearest_bmcu ? `${(s.nearest_bmcu.distance_m / 1000).toFixed(1)} km from ${s.nearest_bmcu.code} ${s.nearest_bmcu.name}` : 'No BMCU within 5 km'}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 pt-1">
                    <button onClick={tripReport} className="btn-secondary flex items-center gap-1.5 py-1.5 text-xs"><Download size={12}/> Download trip report</button>
                    <Link to={`/execution/${execId}`} className="btn-secondary flex items-center gap-1.5 py-1.5 text-xs"><Truck size={12}/> Open execution</Link>
                  </div>
                  <div className="text-[10px] text-gray-400">
                    Stop = still for ≥ {analysis.params.min_stop_minutes} min within {analysis.params.radius_m} m · geofence {analysis.params.geofence_m} m
                    {totals.has_trail ? ` · ${totals.points} GPS points, ${fmtTs(totals.first_fix)} → ${fmtTs(totals.last_fix)}` : ''}
                    {totals.glitches ? ` · ${totals.glitches} glitch(es) skipped` : ''}
                  </div>
                </>
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
            {(showBmcus || showPlants) && <MasterLayer bmcus={masterBmcus} plants={plants} showBmcus={showBmcus} showPlants={showPlants}/>}

            {mode === 'live' && (
              <>
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
                      <div className="flex gap-1 mt-2">
                        <Link to="/tanker-position" className="btn-secondary inline-flex items-center gap-1 py-1 text-[11px]">
                          <Truck size={11}/> Tanker Position
                        </Link>
                        <button onClick={() => { switchMode('trip'); setTripDate(todayIso()); setTripTanker(p.tanker_number); setExecId(null); }}
                          className="btn-secondary inline-flex items-center gap-1 py-1 text-[11px]">
                          <Route size={11}/> Trips today
                        </button>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </>
            )}

            {mode === 'trip' && analysis && (
              <>
                <FitBounds points={fitPts} fitKey={`${execId}-${fitPts.length}`}/>
                {/* Planned route */}
                {plannedPts.length > 1 && (
                  <Polyline positions={plannedPts} pathOptions={{ color: '#0078d4', weight: 3, opacity: 0.8, dashArray: '8 6' }}/>
                )}
                {plan.start?.lat != null && (
                  <Marker position={[plan.start.lat, plan.start.lng]} icon={labelIcon('S', { bg: '#0d9488', square: true })}>
                    <Popup>Start: {plan.start.name}</Popup>
                  </Marker>
                )}
                {plan.delivery?.lat != null && (
                  <Marker position={[plan.delivery.lat, plan.delivery.lng]} icon={labelIcon('D', { bg: '#7c3aed', square: true })}>
                    <Popup>Delivery: {plan.delivery.name}</Popup>
                  </Marker>
                )}
                {plan.bmcus.filter(b => b.lat != null).map(b => (
                  <Marker key={b.id} position={[b.lat, b.lng]}
                    icon={labelIcon(b.planned_seq, { bg: missedIds.has(b.id) ? '#9ca3af' : '#0078d4', ring: missedIds.has(b.id), size: 24 })}>
                    <Popup>
                      <b>{b.planned_seq}. {b.code} {b.name}</b>
                      {missedIds.has(b.id) && <div className="text-red-600">Missed — never within {analysis.params.geofence_m} m</div>}
                      {b.planned_qty != null && <div className="text-gray-600">Planned {b.planned_qty} L</div>}
                    </Popup>
                  </Marker>
                ))}
                {/* Actual trail */}
                {actualPts.length > 1 && (
                  <Polyline positions={actualPts} pathOptions={{ color: '#16a34a', weight: 3, opacity: 0.85 }}/>
                )}
                {actualPts.length > 0 && (
                  <>
                    <Marker position={actualPts[0]} icon={labelIcon('▶', { bg: '#16a34a', size: 18 })}><Popup>Trail start {fmtTs(totals.first_fix)}</Popup></Marker>
                    <Marker position={actualPts[actualPts.length - 1]} icon={labelIcon('■', { bg: '#166534', size: 18 })}><Popup>Trail end {fmtTs(totals.last_fix)}</Popup></Marker>
                  </>
                )}
                {/* Stops */}
                {analysis.stops.map((s, i) => (
                  <CircleMarker key={i} center={[s.lat, s.lng]} radius={Math.min(22, 6 + Math.sqrt(s.minutes) * 1.6)}
                    pathOptions={{ color: STOP_COLOR[s.type], fillColor: STOP_COLOR[s.type], fillOpacity: 0.35, weight: 2 }}>
                    <Popup>
                      <div className="font-semibold">{stopLabel(s)}</div>
                      <div className="text-gray-500">{fmtTs(s.from)} → {fmtTs(s.to)}</div>
                    </Popup>
                  </CircleMarker>
                ))}
              </>
            )}
          </MapContainer>
        </div>
      </div>

      <div className="text-[11px] text-white/70 flex flex-wrap items-center gap-3">
        <Navigation size={11}/>
        {mode === 'live' ? (
          <>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-green-600 mr-1"/>Moving (ignition on, &gt;2 km/h)</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500 mr-1"/>Stopped</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-dashed border-amber-500 mr-1"/>Stale (no fix for {pollStatus?.stale_minutes ?? 30} min)</span>
            {selected && <span>· Trail: last 24 h for {selected.tanker_number}</span>}
          </>
        ) : (
          <>
            <span><span className="inline-block w-5 border-t-2 border-dashed border-[#0078d4] mr-1 align-middle"/>Planned route (1…n BMCUs)</span>
            <span><span className="inline-block w-5 border-t-2 border-[#16a34a] mr-1 align-middle"/>Actual GPS trail</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-[#0078d4] mr-1"/>BMCU wait</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-red-600 mr-1"/>Unplanned stop</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500 mr-1"/>Start / delivery stop</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-red-600 mr-1"/>Missed BMCU</span>
          </>
        )}
        {(showBmcus || showPlants) && <span>· {showBmcus ? `${masterBmcus.length} BMCUs` : ''}{showBmcus && showPlants ? ' + ' : ''}{showPlants ? 'plants' : ''} (names at zoom ≥ 12)</span>}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, warn }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className={`font-semibold ${warn ? 'text-red-600' : 'text-gray-800'}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 truncate" title={sub}>{sub}</div>}
    </div>
  );
}
