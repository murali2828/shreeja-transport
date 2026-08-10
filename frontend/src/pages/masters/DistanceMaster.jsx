// frontend/src/pages/masters/DistanceMaster.jsx
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Download, Upload, Trash2, Edit2, Search, Route,
  AlertTriangle, CheckCircle, Info, RefreshCw, X, Check
} from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api';

// ─── API — all calls go through the shared AUTHENTICATED client ──────────────
const blobDownload = (path, filename) =>
  client.get(path, { responseType: 'blob' }).then(r => {
    const url = URL.createObjectURL(r.data);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  });
const api = {
  getDistances:     (p) => client.get('/distances', { params: p }),
  getSummary:       ()  => client.get('/distances/summary'),
  createDistance:   (d) => client.post('/distances', d),
  updateDistance:   (id, d) => client.put(`/distances/${id}`, d),
  deleteDistance:   (id) => client.delete(`/distances/${id}`),
  downloadTemplate: ()  => blobDownload('/distances/template', 'distance_master_template.xlsx'),
  exportAll:        ()  => blobDownload('/distances/export', 'distance_master_export.xlsx'),
  uploadFile:       (formData) => client.post('/distances/upload', formData),
  getBmcus:         ()  => client.get('/masters/bmcus'),
  getStartPoints:   ()  => client.get('/masters/starting-points'),
  getDeliveryPts:   ()  => client.get('/masters/delivery-points'),
  getTestingPts:    ()  => client.get('/masters/testing-points'),
};

const NODE_TYPE_LABELS = {
  bmcu:            'BMCU',
  starting_point:  'Starting Point',
  delivery_point:  'Delivery Point',
  testing_point:   'Testing Point',
};
const NODE_TYPE_COLORS = {
  bmcu:            'bg-blue-100 text-blue-700',
  starting_point:  'bg-green-100 text-green-700',
  delivery_point:  'bg-purple-100 text-purple-700',
  testing_point:   'bg-amber-100 text-amber-700',
};

// ─── Node selector component ──────────────────────────────────────────────────
function NodeSelect({ label, value, onChange, bmcus, startPts, delivPts, testPts }) {
  const [type, setType] = useState(value?.type || 'bmcu');
  const [id,   setId]   = useState(value?.id || '');

  const options = useMemo(() => {
    switch (type) {
      case 'bmcu':           return bmcus.map(b => ({ id: b.id, label: `${b.bmcu_code} — ${b.bmcu_name}` }));
      case 'starting_point': return startPts.map(s => ({ id: s.id, label: s.name }));
      case 'delivery_point': return delivPts.map(d => ({ id: d.id, label: d.name }));
      case 'testing_point':  return testPts.map(t => ({ id: t.id, label: t.name }));
      default: return [];
    }
  }, [type, bmcus, startPts, delivPts, testPts]);

  const handleChange = (newType, newId) => {
    const t = newType ?? type;
    const i = newId   ?? id;
    setType(t); setId(i);
    if (t && i) onChange({ type: t, id: parseInt(i) });
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      <div className="flex gap-2">
        <select className="input w-36 text-xs"
          value={type} onChange={e => { setId(''); handleChange(e.target.value, ''); }}>
          {Object.entries(NODE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input flex-1 text-xs" value={id}
          onChange={e => handleChange(null, e.target.value)}>
          <option value="">Select…</option>
          {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );
}

// ─── Add/Edit Modal ───────────────────────────────────────────────────────────
function DistanceModal({ row, onClose, bmcus, startPts, delivPts, testPts }) {
  const qc = useQueryClient();
  const isEdit = !!row?.id;

  const [from, setFrom] = useState(row ? { type: row.from_type, id: row.from_id } : { type: 'bmcu', id: '' });
  const [to,   setTo]   = useState(row ? { type: row.to_type,   id: row.to_id }   : { type: 'bmcu', id: '' });
  const [km,   setKm]   = useState(row?.distance_km ?? '');
  const [notes, setNotes] = useState(row?.road_notes ?? '');

  const saveMut = useMutation({
    mutationFn: () => {
      if (!from.id || !to.id || !km) throw new Error('All fields required');
      if (from.type === to.type && from.id === to.id) throw new Error('From and To must be different');
      const payload = { from_type: from.type, from_id: from.id, to_type: to.type, to_id: to.id,
                        distance_km: parseFloat(km), road_notes: notes || null };
      return isEdit ? api.updateDistance(row.id, payload) : api.createDistance(payload);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Distance updated' : 'Distance saved');
      qc.invalidateQueries(['distances']);
      qc.invalidateQueries(['distance-summary']);
      onClose();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold">{isEdit ? 'Edit Distance' : 'Add Distance'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18}/></button>
        </div>
        <div className="p-5 space-y-4">
          {!isEdit && (
            <>
              <NodeSelect label="From Node *" value={from} onChange={setFrom}
                bmcus={bmcus} startPts={startPts} delivPts={delivPts} testPts={testPts}/>
              <NodeSelect label="To Node *"   value={to}   onChange={setTo}
                bmcus={bmcus} startPts={startPts} delivPts={delivPts} testPts={testPts}/>
            </>
          )}
          {isEdit && (
            <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm">
              <div className="text-gray-600">
                <span className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 ${NODE_TYPE_COLORS[row.from_type]}`}>
                  {NODE_TYPE_LABELS[row.from_type]}
                </span>
                {row.from_name}
              </div>
              <div className="text-gray-400 text-xs my-1 ml-1">↕</div>
              <div className="text-gray-600">
                <span className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 ${NODE_TYPE_COLORS[row.to_type]}`}>
                  {NODE_TYPE_LABELS[row.to_type]}
                </span>
                {row.to_name}
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Distance (KM) *</label>
              <input type="number" min="0" step="0.1" className="input w-full"
                placeholder="e.g. 45.5" value={km}
                onChange={e => setKm(e.target.value)}/>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Road Notes</label>
              <input className="input w-full" placeholder="e.g. via NH44"
                value={notes} onChange={e => setNotes(e.target.value)}/>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
            className="btn-primary flex items-center gap-1.5">
            {saveMut.isPending ? <RefreshCw size={13} className="animate-spin"/> : <Check size={13}/>}
            {isEdit ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Upload result banner ─────────────────────────────────────────────────────
function UploadResult({ result, onClose }) {
  if (!result) return null;
  return (
    <div className={`rounded-lg border p-3 text-sm flex gap-2 items-start
      ${result.errors?.length ? 'bg-amber-50 border-amber-200' : 'bg-green-50 border-green-200'}`}>
      {result.errors?.length ? <AlertTriangle size={15} className="text-amber-500 shrink-0 mt-0.5"/> : <CheckCircle size={15} className="text-green-500 shrink-0 mt-0.5"/>}
      <div className="flex-1">
        <div className="font-medium">
          {result.inserted} inserted · {result.updated} updated · {result.skipped} skipped
        </div>
        {result.errors?.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-amber-700">
            {result.errors.slice(0, 5).map((e, i) => <li key={i}>• {e}</li>)}
            {result.errors.length > 5 && <li>… and {result.errors.length - 5} more</li>}
          </ul>
        )}
      </div>
      <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={14}/></button>
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================
export default function DistanceMaster() {
  const qc = useQueryClient();
  const [modal, setModal]             = useState(null); // null | 'add' | row object
  const [uploadResult, setUploadResult] = useState(null);
  const [search, setSearch]           = useState('');
  const [typeFilter, setTypeFilter]   = useState('');

  // Data queries
  const { data: distances = [], isLoading } =
    useQuery({ queryKey: ['distances'], queryFn: () => api.getDistances().then(r => r.data) });
  const { data: summary } =
    useQuery({ queryKey: ['distance-summary'], queryFn: () => api.getSummary().then(r => r.data) });
  const { data: bmcus = [] }    = useQuery({ queryKey: ['bmcus'],    queryFn: () => api.getBmcus().then(r => r.data) });
  const { data: startPts = [] } = useQuery({ queryKey: ['start-pts'], queryFn: () => api.getStartPoints().then(r => r.data) });
  const { data: delivPts = [] } = useQuery({ queryKey: ['deliv-pts'], queryFn: () => api.getDeliveryPts().then(r => r.data) });
  const { data: testPts = [] }  = useQuery({ queryKey: ['test-pts'],  queryFn: () => api.getTestingPts().then(r => r.data) });

  const activeBmcus    = bmcus.filter(b => b.is_active);
  const activeStartPts = startPts.filter(s => s.is_active);
  const activeDelivPts = delivPts.filter(d => d.is_active);
  const activeTestPts  = testPts.filter(t => t.is_active);

  const deleteMut = useMutation({
    mutationFn: api.deleteDistance,
    onSuccess: () => {
      toast.success('Distance removed');
      qc.invalidateQueries(['distances']);
      qc.invalidateQueries(['distance-summary']);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Delete failed'),
  });

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api.uploadFile(fd);
      setUploadResult(r.data);
      qc.invalidateQueries(['distances']);
      qc.invalidateQueries(['distance-summary']);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    }
    e.target.value = '';
  };

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return distances.filter(d => {
      const matchSearch = !q || d.from_name?.toLowerCase().includes(q) || d.to_name?.toLowerCase().includes(q);
      const matchType   = !typeFilter || d.from_type === typeFilter || d.to_type === typeFilter;
      return matchSearch && matchType;
    });
  }, [distances, search, typeFilter]);

  const coverageColor = (pct) =>
    pct >= 80 ? 'text-green-600' : pct >= 50 ? 'text-amber-600' : 'text-red-500';

  return (
    <div className="space-y-4 w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Route size={18} className="text-[#0078d4]"/> Distance Master
          </h2>
          <p className="page-sub">
            Planner-entered road distances between BMCUs and depots — used by Route Optimizer
          </p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          <button onClick={() => api.downloadTemplate()} className="btn-secondary text-xs flex items-center gap-1.5">
            <Download size={13}/> Template
          </button>
          <label className="btn-secondary text-xs flex items-center gap-1.5 cursor-pointer">
            <Upload size={13}/> Upload Excel
            <input type="file" accept=".xlsx,.xls" className="sr-only" onChange={handleUpload}/>
          </label>
          <button onClick={() => api.exportAll()} className="btn-secondary text-xs flex items-center gap-1.5">
            <Download size={13}/> Export All
          </button>
          <button onClick={() => setModal('add')} className="btn-primary text-xs flex items-center gap-1.5">
            <Plus size={13}/> Add Distance
          </button>
        </div>
      </div>

      {/* Coverage summary */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Active BMCUs', value: summary.total_active_bmcus, color: 'text-gray-800' },
            { label: 'BMCU Pairs Possible', value: summary.max_bmcu_pairs.toLocaleString(), color: 'text-gray-800' },
            { label: 'BMCU Pairs Entered', value: summary.entered_bmcu_pairs.toLocaleString(), color: 'text-[#005ba3]' },
            {
              label: 'Coverage',
              value: `${summary.coverage_pct}%`,
              color: coverageColor(summary.coverage_pct),
              sub: `${summary.entered_depot_pairs} depot pairs`
            },
          ].map(s => (
            <div key={s.label} className="card p-3">
              <div className="text-xs text-gray-500">{s.label}</div>
              <div className={`text-xl font-bold mt-0.5 ${s.color}`}>{s.value}</div>
              {s.sub && <div className="text-xs text-gray-400">{s.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Info */}
      {summary && summary.coverage_pct < 100 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-2 text-sm text-blue-800">
          <Info size={15} className="shrink-0 mt-0.5 text-blue-500"/>
          <span>
            <strong>Tip:</strong> Download the Excel template — all BMCU pairs are pre-filled.
            Just enter the road distance (KM) for each pair and upload.
            The Route Optimizer uses these distances for accurate trip planning.
            Missing pairs fall back to district-based estimates (marked ⚠ in optimizer results).
          </span>
        </div>
      )}

      {uploadResult && <UploadResult result={uploadResult} onClose={() => setUploadResult(null)}/>}

      {/* Filters */}
      <div className="card">
        <div className="p-3 border-b flex flex-wrap gap-2 items-center">
          <div className="relative w-56">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
            <input className="input pl-8 text-sm py-1.5 w-full" placeholder="Search node name…"
              value={search} onChange={e => setSearch(e.target.value)}/>
          </div>
          <select className="input text-sm py-1.5 w-36" value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}>
            <option value="">All Types</option>
            {Object.entries(NODE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="text-xs text-gray-400 ml-auto">{filtered.length} of {distances.length} entries</span>
        </div>

        <div className="overflow-x-auto max-h-[55vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">From Node</th>
                <th className="table-th">To Node</th>
                <th className="table-th w-28 text-right">Distance (KM)</th>
                <th className="table-th">Road Notes</th>
                <th className="table-th w-24">Updated By</th>
                <th className="table-th w-20">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={6} className="table-td text-center py-10 text-gray-400">Loading…</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={6} className="table-td text-center py-10 text-gray-400">
                  No distances found. Download the template and upload distances.
                </td></tr>
              )}
              {filtered.map(d => (
                <tr key={d.id} className="hover:bg-gray-50">
                  <td className="table-td">
                    <span className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1.5 ${NODE_TYPE_COLORS[d.from_type]}`}>
                      {NODE_TYPE_LABELS[d.from_type]}
                    </span>
                    {d.from_name}
                  </td>
                  <td className="table-td">
                    <span className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1.5 ${NODE_TYPE_COLORS[d.to_type]}`}>
                      {NODE_TYPE_LABELS[d.to_type]}
                    </span>
                    {d.to_name}
                  </td>
                  <td className="table-td text-right font-bold text-[#005ba3]">
                    {parseFloat(d.distance_km).toFixed(1)} km
                  </td>
                  <td className="table-td text-gray-500 text-xs">{d.road_notes || '—'}</td>
                  <td className="table-td text-xs text-gray-400">{d.updated_by_name || '—'}</td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      <button onClick={() => setModal(d)} className="btn-secondary btn-sm p-1" title="Edit">
                        <Edit2 size={12}/>
                      </button>
                      <button
                        onClick={() => { if (confirm('Remove this distance entry?')) deleteMut.mutate(d.id); }}
                        className="btn-danger btn-sm p-1" title="Delete">
                        <Trash2 size={12}/>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal */}
      {modal && (
        <DistanceModal
          row={modal === 'add' ? null : modal}
          onClose={() => setModal(null)}
          bmcus={activeBmcus} startPts={activeStartPts}
          delivPts={activeDelivPts} testPts={activeTestPts}
        />
      )}
    </div>
  );
}
