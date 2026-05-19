import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRoutes, getRoute, createRoute, updateRoute, getBmcus, getStartingPoints, getTestingPoints, getDeliveryPoints } from '../../api';
import toast from 'react-hot-toast';
import { Plus, Pencil, X, Check, GripVertical, Trash2 } from 'lucide-react';

const EMPTY_ROUTE = { route_name: '', start_point_id: '', testing_point_id: '', delivery_point_id: '', distance_km: '', is_active: true, bmcus: [] };

function RouteModal({ routeId, onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY_ROUTE);
  const [loaded, setLoaded] = useState(!routeId);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const { data: bmcuList = [] } = useQuery({ queryKey: ['bmcus'], queryFn: () => getBmcus().then(r => r.data.filter(b => b.is_active)) });
  const { data: startPts = [] } = useQuery({ queryKey: ['starting-points'], queryFn: () => getStartingPoints().then(r => r.data) });
  const { data: testPts = [] } = useQuery({ queryKey: ['testing-points'], queryFn: () => getTestingPoints().then(r => r.data) });
  const { data: delivPts = [] } = useQuery({ queryKey: ['delivery-points'], queryFn: () => getDeliveryPoints().then(r => r.data) });

  useQuery({
    queryKey: ['route', routeId],
    queryFn: () => getRoute(routeId).then(r => {
      const d = r.data;
      setForm({ ...d, bmcus: (d.bmcus || []).map(b => ({ seq_no: b.seq_no, bmcu_id: b.bmcu_id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name })) });
      setLoaded(true);
    }),
    enabled: !!routeId
  });

  const saveMut = useMutation({
    mutationFn: () => routeId ? updateRoute(routeId, form) : createRoute(form),
    onSuccess: () => { toast.success('Route saved'); qc.invalidateQueries(['routes']); onClose(); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });

  const addBmcu = (bmcuId) => {
    const b = bmcuList.find(x => x.id === parseInt(bmcuId));
    if (!b) return;
    if (form.bmcus.find(x => x.bmcu_id === b.id)) return toast.error('BMCU already added');
    setForm(f => ({ ...f, bmcus: [...f.bmcus, { seq_no: f.bmcus.length + 1, bmcu_id: b.id, bmcu_code: b.bmcu_code, bmcu_name: b.bmcu_name }] }));
  };
  const removeBmcu = (idx) => setForm(f => ({ ...f, bmcus: f.bmcus.filter((_, i) => i !== idx).map((b, i) => ({ ...b, seq_no: i + 1 })) }));
  const moveBmcu = (from, to) => {
    if (to < 0 || to >= form.bmcus.length) return;
    const arr = [...form.bmcus];
    [arr[from], arr[to]] = [arr[to], arr[from]];
    setForm(f => ({ ...f, bmcus: arr.map((b, i) => ({ ...b, seq_no: i + 1 })) }));
  };

  if (!loaded) return null;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <h3 className="font-semibold">{routeId ? 'Edit Route' : 'Add Route'}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-500" /></button>
        </div>
        <div className="overflow-y-auto flex-1 p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="label">Route Name *</label>
              <input className="input" value={form.route_name} onChange={e => set('route_name', e.target.value)} placeholder="e.g. Thambalapalli" />
            </div>
            <div>
              <label className="label">Starting Point</label>
              <select className="input" value={form.start_point_id || ''} onChange={e => set('start_point_id', e.target.value)}>
                <option value="">— Select —</option>
                {startPts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Testing Point</label>
              <select className="input" value={form.testing_point_id || ''} onChange={e => set('testing_point_id', e.target.value)}>
                <option value="">— Select —</option>
                {testPts.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Delivery Point</label>
              <select className="input" value={form.delivery_point_id || ''} onChange={e => set('delivery_point_id', e.target.value)}>
                <option value="">— Select —</option>
                {delivPts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Default Distance (KM)</label>
              <input className="input" type="number" value={form.distance_km || ''} onChange={e => set('distance_km', e.target.value)} placeholder="km" />
            </div>
          </div>

          <div>
            <label className="label">BMCU Sequence (order of visit) *</label>
            <div className="flex gap-2 mb-2">
              <select className="input flex-1" defaultValue="" onChange={e => { if (e.target.value) { addBmcu(e.target.value); e.target.value = ''; } }}>
                <option value="">— Add BMCU —</option>
                {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} — {b.bmcu_name}</option>)}
              </select>
            </div>
            <div className="border rounded-lg overflow-hidden">
              {form.bmcus.length === 0 ? (
                <div className="p-4 text-sm text-gray-400 text-center">No BMCUs added yet. Select from the dropdown above.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead><tr><th className="table-th w-8">Seq</th><th className="table-th">Code</th><th className="table-th">BMCU Name</th><th className="table-th w-20">Move</th><th className="table-th w-8"></th></tr></thead>
                  <tbody>
                    {form.bmcus.map((b, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="table-td text-center font-bold text-brand-600">{b.seq_no}</td>
                        <td className="table-td font-mono">{b.bmcu_code}</td>
                        <td className="table-td">{b.bmcu_name}</td>
                        <td className="table-td">
                          <div className="flex gap-1">
                            <button onClick={() => moveBmcu(i, i-1)} disabled={i === 0} className="btn-secondary btn-sm py-0.5 px-1">↑</button>
                            <button onClick={() => moveBmcu(i, i+1)} disabled={i === form.bmcus.length-1} className="btn-secondary btn-sm py-0.5 px-1">↓</button>
                          </div>
                        </td>
                        <td className="table-td">
                          <button onClick={() => removeBmcu(i)} className="btn-danger btn-sm"><Trash2 size={11} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 shrink-0">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => saveMut.mutate()} className="btn-primary" disabled={saveMut.isPending}>
            <Check size={14} /> {routeId ? 'Update Route' : 'Create Route'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RouteMaster() {
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState('');
  const { data: routes = [], isLoading } = useQuery({ queryKey: ['routes'], queryFn: () => getRoutes().then(r => r.data) });
  const filtered = routes.filter(r => !search || r.route_name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Route Master</h2>
          <p className="text-xs text-gray-500">Define routes with BMCU sequences, testing and delivery points</p>
        </div>
        <button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> Add Route</button>
      </div>
      <div className="card">
        <div className="p-3 border-b">
          <input className="input w-64" placeholder="Search routes…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-th">Route Name</th>
                <th className="table-th">Starting Point</th>
                <th className="table-th">Delivery Point</th>
                <th className="table-th">Distance</th>
                <th className="table-th">Status</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={6} className="table-td text-center py-8 text-gray-400">No routes found</td></tr>
              : filtered.map(r => (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="table-td font-semibold">{r.route_name}</td>
                  <td className="table-td">{r.start_point_name || '—'}</td>
                  <td className="table-td">{r.delivery_point_name || '—'}</td>
                  <td className="table-td">{r.distance_km ? `${r.distance_km} km` : '—'}</td>
                  <td className="table-td"><span className={r.is_active ? 'badge-green' : 'badge-red'}>{r.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="table-td">
                    <button onClick={() => setModal(r.id)} className="btn-secondary btn-sm"><Pencil size={12} /> Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {modal && <RouteModal routeId={modal === 'new' ? null : modal} onClose={() => setModal(null)} />}
    </div>
  );
}
