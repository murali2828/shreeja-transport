// frontend/src/pages/masters/BmcuMaster.jsx
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { getBmcus, createBmcu, updateBmcu, deleteBmcu } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY = { bmcu_code: '', bmcu_name: '', address: '', district: '', state: '', contact: '', latitude: '', longitude: '', is_active: true };

export default function BmcuMaster() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');

  const { data: bmcus = [], isLoading } = useQuery({
    queryKey: ['bmcus', 'all'],
    queryFn:  () => getBmcus({ all: 'true' }).then(r => r.data),
  });

  const activeCount   = bmcus.filter(b => b.is_active).length;
  const inactiveCount = bmcus.filter(b => !b.is_active).length;

  const states = useMemo(() => [...new Set(bmcus.map(b => b.state).filter(Boolean))].sort(), [bmcus]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return bmcus.filter(b => {
      if (statusFilter === 'active'   && !b.is_active) return false;
      if (statusFilter === 'inactive' &&  b.is_active) return false;
      if (stateFilter && b.state !== stateFilter) return false;
      if (!q) return true;
      return b.bmcu_code?.toLowerCase().includes(q) ||
             b.bmcu_name?.toLowerCase().includes(q) ||
             b.district?.toLowerCase().includes(q);
    });
  }, [bmcus, search, stateFilter, statusFilter]);

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (row) => { setForm({ ...row, address: row.address||'', district: row.district||'', state: row.state||'', contact: row.contact||'', latitude: row.latitude||'', longitude: row.longitude||'' }); setModal(row); };
  const close    = () => setModal(null);
  const set      = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.bmcu_code || !form.bmcu_name) throw new Error('BMCU code and name required');
      return modal === 'add' ? createBmcu(form) : updateBmcu(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'BMCU added' : 'BMCU updated');
      qc.invalidateQueries(['bmcus']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteBmcu,
    onSuccess: () => { toast.success('BMCU deactivated'); qc.invalidateQueries(['bmcus']); },
    onError:   (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  return (
    <div className="space-y-4 w-full">
      <PageHeader
        title="BMCU Master"
        subtitle="Bulk Milk Cooling Units — collection points"
        onAdd={openAdd}
        addLabel="Add BMCU"
      />

      {/* Count badges */}
      <div className="flex gap-3 text-xs">
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{activeCount} Active</span>
        <span className="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">{inactiveCount} Inactive</span>
        {(search || stateFilter || statusFilter !== 'active') && (
          <span className="px-3 py-1 rounded-full bg-blue-50 text-blue-600 font-medium">{filtered.length} shown</span>
        )}
      </div>

      {/* Filters */}
      <div className="card p-3 flex flex-wrap gap-3 items-center">
        <select className="input py-1.5 text-sm w-28" value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
        <div className="relative w-56">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input className="input pl-8 py-1.5 text-sm w-full" placeholder="Search code, name, district…"
            value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <select className="input py-1.5 text-sm w-36" value={stateFilter}
          onChange={e => setStateFilter(e.target.value)}>
          <option value="">All States</option>
          {states.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="ml-auto text-xs text-gray-400">{filtered.length} of {bmcus.length}</span>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Code</th>
                <th className="table-th">BMCU Name</th>
                <th className="table-th">District</th>
                <th className="table-th">State</th>
                <th className="table-th">Contact</th>
                <th className="table-th">Status</th>
                <th className="table-th w-24">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <LoadingState/>}
              {!isLoading && filtered.length === 0 && <EmptyState message="No BMCUs found."/>}
              {filtered.map(b => (
                <tr key={b.id} className={`hover:bg-gray-50 border-b border-gray-50 ${!b.is_active ? 'opacity-60' : ''}`}>
                  <td className="table-td font-mono font-semibold text-[#005ba3]">{b.bmcu_code}</td>
                  <td className="table-td font-medium">{b.bmcu_name}</td>
                  <td className="table-td text-gray-600">{b.district || '—'}</td>
                  <td className="table-td text-gray-600">{b.state || '—'}</td>
                  <td className="table-td text-gray-600">{b.contact || '—'}</td>
                  <td className="table-td"><ActiveBadge active={b.is_active}/></td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      <button onClick={() => openEdit(b)} className="btn-secondary btn-sm p-1.5">✏</button>
                      <button onClick={() => { if (window.confirm(`Deactivate ${b.bmcu_code}?`)) deleteMut.mutate(b.id); }}
                        className="btn-danger btn-sm p-1.5">🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add BMCU' : `Edit — ${modal.bmcu_code}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'}
                onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="BMCU Code" required>
                <input className="input w-full" placeholder="e.g. AP001"
                  value={form.bmcu_code}
                  disabled={modal !== 'add'}
                  onChange={e => set('bmcu_code', e.target.value.toUpperCase())}/>
              </Field>
              <Field label="BMCU Name" required>
                <input className="input w-full" placeholder="Village / Society name"
                  value={form.bmcu_name} onChange={e => set('bmcu_name', e.target.value)}/>
              </Field>
              <Field label="District">
                <input className="input w-full" placeholder="e.g. Chittoor"
                  value={form.district} onChange={e => set('district', e.target.value)}/>
              </Field>
              <Field label="State">
                <input className="input w-full" placeholder="e.g. Andhra Pradesh"
                  value={form.state} onChange={e => set('state', e.target.value)}/>
              </Field>
              <Field label="Contact">
                <input className="input w-full" placeholder="Phone number"
                  value={form.contact} onChange={e => set('contact', e.target.value)}/>
              </Field>
              <Field label="Latitude">
                <input type="number" step="0.00000001" className="input w-full" placeholder="e.g. 13.08268"
                  value={form.latitude} onChange={e => set('latitude', e.target.value)}/>
              </Field>
              <Field label="Longitude">
                <input type="number" step="0.00000001" className="input w-full" placeholder="e.g. 80.27071"
                  value={form.longitude} onChange={e => set('longitude', e.target.value)}/>
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
            <Field label="Address">
              <textarea className="input w-full" rows={2} placeholder="Full address"
                value={form.address} onChange={e => set('address', e.target.value)}/>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
