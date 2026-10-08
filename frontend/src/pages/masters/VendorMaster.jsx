// frontend/src/pages/masters/VendorMaster.jsx
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { getVendors, createVendor, updateVendor } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY = {
  vendor_code: '', vendor_name: '', contact_person: '', phone: '', email: '',
  gst_number: '', pan_number: '', address: '', is_active: true,
};

export default function VendorMaster() {
  const qc = useQueryClient();
  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');

  const { data: vendors = [], isLoading } = useQuery({
    queryKey: ['vendors', 'all'],
    queryFn:  () => getVendors({ all: 'true' }).then(r => r.data),
  });

  const activeCount   = vendors.filter(v => v.is_active).length;
  const inactiveCount = vendors.filter(v => !v.is_active).length;

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return vendors.filter(v => {
      if (statusFilter === 'active'   && !v.is_active) return false;
      if (statusFilter === 'inactive' &&  v.is_active) return false;
      if (!q) return true;
      return v.vendor_code?.toLowerCase().includes(q) ||
             v.vendor_name?.toLowerCase().includes(q) ||
             v.contact_person?.toLowerCase().includes(q) ||
             v.phone?.toLowerCase().includes(q);
    });
  }, [vendors, search, statusFilter]);

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (row) => {
    setForm({ ...EMPTY, ...row });
    setModal(row);
  };
  const close = () => setModal(null);
  const set   = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.vendor_code || !form.vendor_name) throw new Error('Vendor code and name required');
      return modal === 'add' ? createVendor(form) : updateVendor(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Vendor added' : 'Vendor updated');
      qc.invalidateQueries(['vendors']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  return (
    <div className="space-y-4 w-full">
      <PageHeader title="Vendor Master" subtitle="Tanker vendors / owners onboarding" onAdd={openAdd} addLabel="Add Vendor"/>

      <div className="flex gap-3 text-xs">
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{activeCount} Active</span>
        <span className="px-3 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">{inactiveCount} Inactive</span>
        {(search || statusFilter !== 'active') && (
          <span className="px-3 py-1 rounded-full bg-blue-50 text-blue-600 font-medium">{filtered.length} shown</span>
        )}
      </div>

      <div className="card p-3 flex flex-wrap gap-3 items-center">
        <select className="input py-1.5 text-sm w-28" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="all">All</option>
        </select>
        <div className="relative w-64">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input className="input pl-8 py-1.5 text-sm w-full" placeholder="Search code, name, contact, phone…"
            value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <span className="ml-auto text-xs text-gray-400">{filtered.length} of {vendors.length}</span>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Code</th>
                <th className="table-th">Vendor Name</th>
                <th className="table-th">Contact</th>
                <th className="table-th">Phone</th>
                <th className="table-th">GST</th>
                <th className="table-th text-center">Tankers</th>
                <th className="table-th">Status</th>
                <th className="table-th w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <LoadingState/>}
              {!isLoading && filtered.length === 0 && <EmptyState message="No vendors found."/>}
              {filtered.map(v => (
                <tr key={v.id} className={`hover:bg-gray-50 border-b border-gray-50 ${!v.is_active ? 'opacity-60' : ''}`}>
                  <td className="table-td font-mono font-semibold text-[#005ba3]">{v.vendor_code}</td>
                  <td className="table-td font-medium">{v.vendor_name}</td>
                  <td className="table-td text-gray-600">{v.contact_person || '—'}</td>
                  <td className="table-td text-gray-600">{v.phone || '—'}</td>
                  <td className="table-td text-gray-600 font-mono text-xs">{v.gst_number || '—'}</td>
                  <td className="table-td text-center">{v.tanker_count || 0}</td>
                  <td className="table-td"><ActiveBadge active={v.is_active}/></td>
                  <td className="table-td">
                    <button onClick={() => openEdit(v)} className="btn-secondary btn-sm p-1.5">✏</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Vendor' : `Edit — ${modal.vendor_code}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vendor Code" required>
              <input className="input w-full" placeholder="e.g. VEN001" value={form.vendor_code}
                disabled={modal !== 'add'}
                onChange={e => set('vendor_code', e.target.value.toUpperCase())}/>
            </Field>
            <Field label="Vendor Name" required>
              <input className="input w-full" value={form.vendor_name}
                onChange={e => set('vendor_name', e.target.value)}/>
            </Field>
            <Field label="Contact Person">
              <input className="input w-full" value={form.contact_person}
                onChange={e => set('contact_person', e.target.value)}/>
            </Field>
            <Field label="Phone">
              <input className="input w-full" value={form.phone}
                onChange={e => set('phone', e.target.value)}/>
            </Field>
            <Field label="Email">
              <input type="email" className="input w-full" value={form.email}
                onChange={e => set('email', e.target.value)}/>
            </Field>
            <Field label="GST Number">
              <input className="input w-full" value={form.gst_number}
                onChange={e => set('gst_number', e.target.value.toUpperCase())}/>
            </Field>
            <Field label="PAN Number">
              <input className="input w-full" value={form.pan_number}
                onChange={e => set('pan_number', e.target.value.toUpperCase())}/>
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
            <div className="col-span-2">
              <Field label="Address">
                <textarea className="input w-full" rows={2} value={form.address}
                  onChange={e => set('address', e.target.value)}/>
              </Field>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
