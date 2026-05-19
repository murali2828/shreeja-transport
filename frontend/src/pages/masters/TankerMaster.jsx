import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getTankers, createTanker, updateTanker, deleteTanker } from '../../api';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';

const EMPTY = { tanker_number: '', compartments: 2, capacity_litres: '', per_km_rate: '' };

function TankerModal({ tanker, onClose, onSave }) {
  const [form, setForm] = useState(tanker || EMPTY);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold text-gray-800">{tanker ? 'Edit Tanker' : 'Add New Tanker'}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-500" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="label">Tanker Number *</label>
            <input className="input" value={form.tanker_number} onChange={e => set('tanker_number', e.target.value.toUpperCase())} placeholder="e.g. AP03TE9069" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">No. of Compartments *</label>
              <select className="input" value={form.compartments} onChange={e => set('compartments', parseInt(e.target.value))}>
                <option value={2}>2 Compartments</option>
                <option value={3}>3 Compartments</option>
              </select>
            </div>
            <div>
              <label className="label">Capacity (Litres) *</label>
              <input className="input" type="number" value={form.capacity_litres} onChange={e => set('capacity_litres', e.target.value)} placeholder="e.g. 21000" />
            </div>
          </div>
          <div>
            <label className="label">Per KM Rate (₹) *</label>
            <input className="input" type="number" step="0.01" value={form.per_km_rate} onChange={e => set('per_km_rate', e.target.value)} placeholder="e.g. 45.00" />
          </div>
          {tanker && (
            <div className="flex items-center gap-2">
              <input type="checkbox" id="is_active" checked={form.is_active !== false} onChange={e => set('is_active', e.target.checked)} />
              <label htmlFor="is_active" className="text-sm text-gray-700">Active</label>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => onSave(form)} className="btn-primary">
            <Check size={14} /> {tanker ? 'Update' : 'Add Tanker'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TankerMaster() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState('');

  const { data: tankers = [], isLoading } = useQuery({ queryKey: ['tankers'], queryFn: () => getTankers().then(r => r.data) });

  const saveMut = useMutation({
    mutationFn: (form) => modal.id ? updateTanker(modal.id, form) : createTanker(form),
    onSuccess: () => { toast.success(modal.id ? 'Tanker updated' : 'Tanker added'); qc.invalidateQueries(['tankers']); setModal(null); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });

  const deleteMut = useMutation({
    mutationFn: deleteTanker,
    onSuccess: () => { toast.success('Tanker deactivated'); qc.invalidateQueries(['tankers']); },
    onError: (e) => toast.error(e.response?.data?.error || 'Delete failed')
  });

  const filtered = tankers.filter(t => !search || t.tanker_number.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-800">Tanker Master</h2>
          <p className="text-xs text-gray-500">Manage tanker fleet — numbers, compartments, capacity and per km rate</p>
        </div>
        <button onClick={() => setModal({})} className="btn-primary">
          <Plus size={14} /> Add Tanker
        </button>
      </div>

      <div className="card">
        <div className="p-3 border-b border-gray-100">
          <input className="input max-w-xs" placeholder="Search tanker number…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="table-th">#</th>
                <th className="table-th">Tanker Number</th>
                <th className="table-th">Compartments</th>
                <th className="table-th">Capacity (L)</th>
                <th className="table-th">Per KM Rate (₹)</th>
                <th className="table-th">Status</th>
                <th className="table-th">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={7} className="table-td text-center text-gray-400 py-8">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="table-td text-center text-gray-400 py-8">No tankers found</td></tr>
              ) : filtered.map((t, i) => (
                <tr key={t.id} className="hover:bg-gray-50">
                  <td className="table-td text-gray-400">{i + 1}</td>
                  <td className="table-td font-semibold">{t.tanker_number}</td>
                  <td className="table-td">{t.compartments} ({t.compartments === 2 ? 'FC, BC' : 'FC, MC, BC'})</td>
                  <td className="table-td">{parseInt(t.capacity_litres).toLocaleString()} L</td>
                  <td className="table-td">₹ {parseFloat(t.per_km_rate).toFixed(2)}</td>
                  <td className="table-td">
                    <span className={t.is_active ? 'badge-green' : 'badge-red'}>{t.is_active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      <button onClick={() => setModal(t)} className="btn-secondary btn-sm"><Pencil size={12} /></button>
                      {t.is_active && (
                        <button onClick={() => { if (confirm(`Deactivate ${t.tanker_number}?`)) deleteMut.mutate(t.id); }}
                          className="btn-danger btn-sm"><Trash2 size={12} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-2 text-xs text-gray-400 border-t">
          Total: {tankers.length} tankers · Active: {tankers.filter(t => t.is_active).length}
        </div>
      </div>

      {modal !== null && (
        <TankerModal tanker={modal.id ? modal : null} onClose={() => setModal(null)} onSave={saveMut.mutate} />
      )}
    </div>
  );
}
