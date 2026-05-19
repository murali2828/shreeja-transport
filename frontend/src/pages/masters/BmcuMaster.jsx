import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getBmcus, createBmcu, updateBmcu, deleteBmcu } from '../../api';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, Check, Upload, Download } from 'lucide-react';

const EMPTY = { bmcu_code: '', bmcu_name: '', address: '', district: '', state: '', contact: '' };

function BmcuModal({ bmcu, onClose, onSave }) {
  const [form, setForm] = useState(bmcu || EMPTY);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold">{bmcu ? 'Edit BMCU' : 'Add BMCU'}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-500" /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">BMCU Code *</label>
              <input className="input" value={form.bmcu_code} onChange={e => set('bmcu_code', e.target.value)} placeholder="e.g. 3001" />
            </div>
            <div>
              <label className="label">BMCU Name *</label>
              <input className="input" value={form.bmcu_name} onChange={e => set('bmcu_name', e.target.value)} placeholder="e.g. Penumuru" />
            </div>
          </div>
          <div>
            <label className="label">Address</label>
            <input className="input" value={form.address} onChange={e => set('address', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">District</label>
              <input className="input" value={form.district} onChange={e => set('district', e.target.value)} />
            </div>
            <div>
              <label className="label">State</label>
              <input className="input" value={form.state} onChange={e => set('state', e.target.value)} placeholder="AP / TN / KA / TG" />
            </div>
          </div>
          <div>
            <label className="label">Contact Number</label>
            <input className="input" value={form.contact} onChange={e => set('contact', e.target.value)} />
          </div>
          {bmcu && (
            <div className="flex items-center gap-2">
              <input type="checkbox" id="active" checked={form.is_active !== false} onChange={e => set('is_active', e.target.checked)} />
              <label htmlFor="active" className="text-sm">Active</label>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => onSave(form)} className="btn-primary"><Check size={14} /> Save</button>
        </div>
      </div>
    </div>
  );
}

export default function BmcuMaster() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');

  const { data: bmcus = [], isLoading } = useQuery({ queryKey: ['bmcus'], queryFn: () => getBmcus().then(r => r.data) });

  const saveMut = useMutation({
    mutationFn: (form) => modal?.id ? updateBmcu(modal.id, form) : createBmcu(form),
    onSuccess: () => { toast.success('BMCU saved'); qc.invalidateQueries(['bmcus']); setModal(null); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });

  const deleteMut = useMutation({
    mutationFn: deleteBmcu,
    onSuccess: () => { toast.success('BMCU deactivated'); qc.invalidateQueries(['bmcus']); },
  });

  const states = [...new Set(bmcus.map(b => b.state).filter(Boolean))].sort();
  const filtered = bmcus.filter(b => {
    const q = search.toLowerCase();
    const matchSearch = !search || b.bmcu_code?.includes(q) || b.bmcu_name?.toLowerCase().includes(q);
    const matchState = !stateFilter || b.state === stateFilter;
    return matchSearch && matchState;
  });

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">BMCU Master</h2>
          <p className="text-xs text-gray-500">Manage all 135 Bulk Milk Chilling Units</p>
        </div>
        <button onClick={() => setModal({})} className="btn-primary"><Plus size={14} /> Add BMCU</button>
      </div>

      <div className="card">
        <div className="p-3 border-b flex gap-2 flex-wrap">
          <input className="input w-56" placeholder="Search code or name…" value={search} onChange={e => setSearch(e.target.value)} />
          <select className="input w-32" value={stateFilter} onChange={e => setStateFilter(e.target.value)}>
            <option value="">All States</option>
            {states.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <span className="text-xs text-gray-400 self-center">{filtered.length} of {bmcus.length} BMCUs</span>
        </div>
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full">
            <thead className="sticky top-0">
              <tr>
                <th className="table-th">#</th>
                <th className="table-th">Code</th>
                <th className="table-th">BMCU Name</th>
                <th className="table-th">District</th>
                <th className="table-th">State</th>
                <th className="table-th">Contact</th>
                <th className="table-th">Status</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={8} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              ) : filtered.map((b, i) => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="table-td text-gray-400">{i + 1}</td>
                  <td className="table-td font-mono font-semibold">{b.bmcu_code}</td>
                  <td className="table-td font-medium">{b.bmcu_name}</td>
                  <td className="table-td text-gray-600">{b.district || '—'}</td>
                  <td className="table-td"><span className="badge badge-blue">{b.state || '—'}</span></td>
                  <td className="table-td">{b.contact || '—'}</td>
                  <td className="table-td">
                    <span className={b.is_active ? 'badge-green' : 'badge-red'}>{b.is_active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      <button onClick={() => setModal(b)} className="btn-secondary btn-sm"><Pencil size={12} /></button>
                      {b.is_active && (
                        <button onClick={() => { if (confirm(`Deactivate BMCU ${b.bmcu_code}?`)) deleteMut.mutate(b.id); }}
                          className="btn-danger btn-sm"><Trash2 size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal !== null && (
        <BmcuModal bmcu={modal?.id ? modal : null} onClose={() => setModal(null)} onSave={saveMut.mutate} />
      )}
    </div>
  );
}
