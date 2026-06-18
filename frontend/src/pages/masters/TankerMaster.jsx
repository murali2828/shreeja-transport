// frontend/src/pages/masters/TankerMaster.jsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { getTankers, createTanker, updateTanker, deleteTanker } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY = { tanker_number: '', compartments: '', capacity_litres: '', per_km_rate: '', vendor_code: '', vendor_name: '', rate_per_km_bmcu: '', rate_per_km_p2p: '', is_active: true };

export default function TankerMaster() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY);
  const [search, setSearch] = useState('');

  const { data: tankers = [], isLoading } = useQuery({
    queryKey: ['tankers'],
    queryFn:  () => getTankers().then(r => r.data),
  });

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (row) => { setForm({ ...row }); setModal(row); };
  const close    = () => setModal(null);
  const set      = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.tanker_number || !form.capacity_litres)
        throw new Error('Tanker number and capacity required');
      return modal === 'add'
        ? createTanker(form)
        : updateTanker(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Tanker added' : 'Tanker updated');
      qc.invalidateQueries(['tankers']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteTanker,
    onSuccess: () => { toast.success('Tanker deactivated'); qc.invalidateQueries(['tankers']); },
    onError:   (e) => toast.error(e.response?.data?.error || 'Delete failed'),
  });

  const filtered = tankers.filter(t => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.tanker_number?.toLowerCase().includes(q) || t.vendor_name?.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tanker Master</h2>
          <p className="text-xs text-gray-500">Manage tankers, capacities and per-km rates</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text" placeholder="Search tanker no or transporter…"
            className="input py-1.5 text-sm w-56"
            value={search} onChange={e => setSearch(e.target.value)}/>
          <button onClick={openAdd} className="btn-primary flex items-center gap-1.5 whitespace-nowrap">
            <Truck size={14}/> Add Tanker
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">Tanker No</th>
              <th className="table-th">Vendor</th>
              <th className="table-th text-center">Compartments</th>
              <th className="table-th text-right">Capacity (L)</th>
              <th className="table-th text-right">₹/km BMCU</th>
              <th className="table-th text-right">₹/km P2P</th>
              <th className="table-th">Status</th>
              <th className="table-th w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && filtered.length === 0 && <EmptyState message={search ? 'No tankers match your search.' : "No tankers yet. Click 'Add Tanker' to create one."}/>}
            {filtered.map(t => (
              <tr key={t.id} className="hover:bg-gray-50 border-b border-gray-50">
                <td className="table-td font-mono font-semibold text-[#005ba3]">{t.tanker_number}</td>
                <td className="table-td text-xs">
                  {t.vendor_name ? <span title={t.vendor_code}>{t.vendor_name}</span> : <span className="text-gray-400">—</span>}
                </td>
                <td className="table-td text-center">
                  <span className="inline-block bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded">
                    {t.compartments || '—'}
                  </span>
                </td>
                <td className="table-td text-right font-medium">{parseInt(t.capacity_litres).toLocaleString()}</td>
                <td className="table-td text-right">{t.rate_per_km_bmcu ? `₹${parseFloat(t.rate_per_km_bmcu).toFixed(2)}` : '—'}</td>
                <td className="table-td text-right">{t.rate_per_km_p2p ? `₹${parseFloat(t.rate_per_km_p2p).toFixed(2)}` : '—'}</td>
                <td className="table-td"><ActiveBadge active={t.is_active}/></td>
                <td className="table-td">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(t)} className="btn-secondary btn-sm p-1.5" title="Edit">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Deactivate ${t.tanker_number}?`)) deleteMut.mutate(t.id); }}
                      className="btn-danger btn-sm p-1.5" title="Deactivate">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Tanker' : `Edit — ${modal.tanker_number}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'}
                onClick={() => saveMut.mutate()}/>
            </>
          }>
          <form onSubmit={e => { e.preventDefault(); saveMut.mutate(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tanker Number" required>
                <input className="input w-full" placeholder="e.g. TN01AB1234"
                  value={form.tanker_number} onChange={e => set('tanker_number', e.target.value.toUpperCase())}/>
              </Field>
              <Field label="Compartments">
                <input className="input w-full" placeholder="e.g. 2C, 3C"
                  value={form.compartments} onChange={e => set('compartments', e.target.value)}/>
              </Field>
              <Field label="Capacity (Litres)" required>
                <input type="number" min="1" className="input w-full" placeholder="e.g. 18000"
                  value={form.capacity_litres} onChange={e => set('capacity_litres', e.target.value)}/>
              </Field>
              <Field label="Rate per KM (₹)">
                <input type="number" min="0" step="0.01" className="input w-full" placeholder="e.g. 45.00"
                  value={form.per_km_rate} onChange={e => set('per_km_rate', e.target.value)}/>
              </Field>
              <Field label="Vendor Code">
                <input className="input w-full" placeholder="e.g. V001"
                  value={form.vendor_code} onChange={e => set('vendor_code', e.target.value)}/>
              </Field>
              <Field label="Vendor Name">
                <input className="input w-full" placeholder="Vendor / owner name"
                  value={form.vendor_name} onChange={e => set('vendor_name', e.target.value)}/>
              </Field>
              <Field label="Rate/KM BMCU (₹)">
                <input type="number" min="0" step="0.01" className="input w-full" placeholder="e.g. 42.00"
                  value={form.rate_per_km_bmcu} onChange={e => set('rate_per_km_bmcu', e.target.value)}/>
              </Field>
              <Field label="Rate/KM P2P (₹)">
                <input type="number" min="0" step="0.01" className="input w-full" placeholder="e.g. 38.00"
                  value={form.rate_per_km_p2p} onChange={e => set('rate_per_km_p2p', e.target.value)}/>
              </Field>
            </div>
            {modal !== 'add' && (
              <Field label="Status">
                <select className="input w-full" value={form.is_active}
                  onChange={e => set('is_active', e.target.value === 'true')}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </Field>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
