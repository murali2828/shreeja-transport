// frontend/src/pages/masters/RouteMaster.jsx
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getRoutes, getRoute, createRoute, updateRoute,
  getBmcus, getStartingPoints, getTestingPoints, getDeliveryPoints
} from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY_ROUTE = {
  route_name: '', route_no: '', start_point_id: '', testing_point_id: '',
  delivery_point_id: '', distance_km: '', is_active: true, bmcus: []
};

function BmcuSequenceEditor({ bmcus, setBmcus, allBmcus }) {
  const add = (bmcuId) => {
    const bm = allBmcus.find(b => b.id === parseInt(bmcuId));
    if (!bm) return;
    setBmcus(prev => [...prev, { seq_no: prev.length + 1, bmcu_id: bm.id, bmcu_code: bm.bmcu_code, bmcu_name: bm.bmcu_name }]);
  };
  const remove = (idx) =>
    setBmcus(prev => prev.filter((_,i) => i !== idx).map((b,i) => ({ ...b, seq_no: i+1 })));
  const move = (idx, dir) => {
    const arr = [...bmcus];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= arr.length) return;
    [arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]];
    setBmcus(arr.map((b, i) => ({ ...b, seq_no: i+1 })));
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-600">BMCU Visit Sequence</span>
        <select className="input text-xs py-1 w-48" defaultValue=""
          onChange={e => { if (e.target.value) { add(e.target.value); e.target.value=''; } }}>
          <option value="">+ Add BMCU</option>
          {allBmcus.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} — {b.bmcu_name}</option>)}
        </select>
      </div>
      <div className="border rounded-lg overflow-hidden">
        {bmcus.length === 0 ? (
          <div className="text-xs text-gray-400 text-center py-4">No BMCUs added yet</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="table-th py-1.5 w-8">#</th>
                <th className="table-th py-1.5">Code</th>
                <th className="table-th py-1.5">Name</th>
                <th className="table-th py-1.5 w-20">Order</th>
                <th className="table-th py-1.5 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {bmcus.map((bm, i) => (
                <tr key={i} className="border-b border-gray-50">
                  <td className="table-td py-1 text-center font-bold text-[#0078d4]">{bm.seq_no}</td>
                  <td className="table-td py-1 font-mono">{bm.bmcu_code}</td>
                  <td className="table-td py-1">{bm.bmcu_name}</td>
                  <td className="table-td py-1">
                    <div className="flex gap-0.5">
                      <button onClick={() => move(i, -1)} disabled={i===0}
                        className="btn-secondary btn-sm p-0.5 disabled:opacity-30">
                        <ChevronUp size={10}/>
                      </button>
                      <button onClick={() => move(i, 1)} disabled={i===bmcus.length-1}
                        className="btn-secondary btn-sm p-0.5 disabled:opacity-30">
                        <ChevronDown size={10}/>
                      </button>
                    </div>
                  </td>
                  <td className="table-td py-1">
                    <button onClick={() => remove(i)} className="btn-danger btn-sm p-0.5">
                      <Trash2 size={10}/>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function RouteMaster() {
  const qc = useQueryClient();
  const [modal, setModal]     = useState(null);
  const [form, setForm]       = useState(EMPTY_ROUTE);
  const [formBmcus, setFormBmcus] = useState([]);

  const { data: routes   = [], isLoading } = useQuery({ queryKey: ['routes'],    queryFn: () => getRoutes().then(r=>r.data) });
  const { data: bmcuList = [] }            = useQuery({ queryKey: ['bmcus'],     queryFn: () => getBmcus().then(r=>r.data) });
  const { data: startPts = [] }            = useQuery({ queryKey: ['start-pts'], queryFn: () => getStartingPoints().then(r=>r.data) });
  const { data: testPts  = [] }            = useQuery({ queryKey: ['test-pts'],  queryFn: () => getTestingPoints().then(r=>r.data) });
  const { data: delivPts = [] }            = useQuery({ queryKey: ['deliv-pts'], queryFn: () => getDeliveryPoints().then(r=>r.data) });

  const openAdd = () => { setForm(EMPTY_ROUTE); setFormBmcus([]); setModal('add'); };
  const openEdit = async (row) => {
    setForm({ ...row });
    setModal(row);
    try {
      const { data } = await getRoute(row.id);
      setFormBmcus(data.bmcus || []);
    } catch { setFormBmcus([]); }
  };
  const close = () => setModal(null);
  const set   = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.route_name) throw new Error('Route name required');
      const payload = { ...form, bmcus: formBmcus };
      return modal === 'add' ? createRoute(payload) : updateRoute(modal.id, payload);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Route created' : 'Route updated');
      qc.invalidateQueries(['routes']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  return (
    <div className="space-y-4 max-w-5xl">
      <PageHeader title="Route Master" subtitle="Define standard collection routes" onAdd={openAdd} addLabel="Add Route"/>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">Route No</th>
              <th className="table-th">Route Name</th>
              <th className="table-th">Start Point</th>
              <th className="table-th">Delivery Point</th>
              <th className="table-th text-center">BMCUs</th>
              <th className="table-th text-right">Dist (km)</th>
              <th className="table-th">Status</th>
              <th className="table-th w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && routes.length === 0 && <EmptyState message="No routes yet."/>}
            {routes.map(r => (
              <tr key={r.id} className="hover:bg-gray-50 border-b border-gray-50">
                <td className="table-td font-mono text-[#005ba3]">{r.route_no || '—'}</td>
                <td className="table-td font-semibold">{r.route_name}</td>
                <td className="table-td text-gray-600 text-xs">{r.start_point_name || '—'}</td>
                <td className="table-td text-gray-600 text-xs">{r.delivery_point_name || '—'}</td>
                <td className="table-td text-center">
                  <span className="bg-[#e6f3fb] text-[#005ba3] text-xs px-2 py-0.5 rounded-full font-medium">
                    {r.bmcu_count}
                  </span>
                </td>
                <td className="table-td text-right">{r.distance_km || '—'}</td>
                <td className="table-td"><ActiveBadge active={r.is_active}/></td>
                <td className="table-td">
                  <button onClick={() => openEdit(r)} className="btn-secondary btn-sm p-1.5">✏</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
              <h3 className="font-semibold">{modal === 'add' ? 'Create Route' : `Edit — ${modal.route_name}`}</h3>
              <button onClick={close} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Route Name" required>
                  <input className="input w-full" value={form.route_name}
                    onChange={e => set('route_name', e.target.value)}/>
                </Field>
                <Field label="Route No">
                  <input className="input w-full" placeholder="e.g. 001"
                    value={form.route_no||''} onChange={e => set('route_no', e.target.value)}/>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Starting Point">
                  <select className="input w-full" value={form.start_point_id||''}
                    onChange={e => set('start_point_id', e.target.value)}>
                    <option value="">Select…</option>
                    {startPts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Testing Point">
                  <select className="input w-full" value={form.testing_point_id||''}
                    onChange={e => set('testing_point_id', e.target.value)}>
                    <option value="">Select…</option>
                    {testPts.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Delivery Point">
                  <select className="input w-full" value={form.delivery_point_id||''}
                    onChange={e => set('delivery_point_id', e.target.value)}>
                    <option value="">Select…</option>
                    {delivPts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </Field>
                <Field label="Total Distance (km)">
                  <input type="number" min="0" step="0.1" className="input w-full"
                    value={form.distance_km||''} onChange={e => set('distance_km', e.target.value)}/>
                </Field>
                {modal !== 'add' && (
                  <Field label="Status">
                    <select className="input w-full" value={form.is_active}
                      onChange={e => set('is_active', e.target.value === 'true')}>
                      <option value="true">Active</option>
                      <option value="false">Inactive</option>
                    </select>
                  </Field>
                )}
              </div>
              <BmcuSequenceEditor bmcus={formBmcus} setBmcus={setFormBmcus} allBmcus={bmcuList}/>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-2xl shrink-0">
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
