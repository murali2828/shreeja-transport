// frontend/src/pages/masters/MaterialMaster.jsx
// Materials carried on material (pasteurised milk) trips — SAP material code
// mirrored from finance (migration 049).
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import toast from 'react-hot-toast';
import { getMaterials, createMaterial, updateMaterial } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY = { sap_code: '', name: '', unit: 'Ltrs', is_active: true };

export default function MaterialMaster() {
  const qc = useQueryClient();
  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY);
  const [search, setSearch] = useState('');

  const { data: materials = [], isLoading } = useQuery({
    queryKey: ['materials', 'all'],
    queryFn:  () => getMaterials({ all: 'true' }).then(r => r.data),
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return materials.filter(m => !q || m.sap_code?.toLowerCase().includes(q) || m.name?.toLowerCase().includes(q));
  }, [materials, search]);

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (row) => { setForm({ ...EMPTY, ...row }); setModal(row); };
  const close = () => setModal(null);
  const set   = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.sap_code || !form.name) throw new Error('SAP material code and name required');
      return modal === 'add' ? createMaterial(form) : updateMaterial(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Material added' : 'Material updated');
      qc.invalidateQueries(['materials']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  return (
    <div className="space-y-4 w-full">
      <PageHeader title="Material Master" subtitle="Materials carried on purchase & delivery trips (e.g. pasteurised milk bought from Balaji Dairy for HUL) — SAP material codes" onAdd={openAdd} addLabel="Add Material"/>

      <div className="card p-3 flex flex-wrap gap-3 items-center">
        <div className="relative w-64">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input className="input pl-8 py-1.5 text-sm w-full" placeholder="Search SAP code or name…"
            value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <span className="ml-auto text-xs text-gray-400">{filtered.length} of {materials.length}</span>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">SAP Material Code</th>
                <th className="table-th">Material Name</th>
                <th className="table-th">Unit</th>
                <th className="table-th text-center">Trips</th>
                <th className="table-th">Status</th>
                <th className="table-th w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <LoadingState/>}
              {!isLoading && filtered.length === 0 && <EmptyState message="No materials yet — add the pasteurised milk material with its SAP code."/>}
              {filtered.map(m => (
                <tr key={m.id} className={`hover:bg-gray-50 border-b border-gray-50 ${!m.is_active ? 'opacity-60' : ''}`}>
                  <td className="table-td font-mono font-semibold text-[#005ba3]">{m.sap_code}</td>
                  <td className="table-td font-medium">{m.name}</td>
                  <td className="table-td text-gray-600">{m.unit}</td>
                  <td className="table-td text-center">{m.trip_count || 0}</td>
                  <td className="table-td"><ActiveBadge active={m.is_active}/></td>
                  <td className="table-td">
                    <button onClick={() => openEdit(m)} className="btn-secondary btn-sm p-1.5">✏</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Material' : `Edit — ${modal.sap_code}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SAP Material Code" required>
              <input className="input w-full" placeholder="as in SAP" value={form.sap_code}
                onChange={e => set('sap_code', e.target.value.toUpperCase())}/>
            </Field>
            <Field label="Unit">
              <select className="input w-full" value={form.unit} onChange={e => set('unit', e.target.value)}>
                <option>Ltrs</option><option>Kgs</option>
              </select>
            </Field>
            <div className="col-span-2">
              <Field label="Material Name" required>
                <input className="input w-full" placeholder="e.g. Pasteurised Milk" value={form.name}
                  onChange={e => set('name', e.target.value)}/>
              </Field>
            </div>
            {modal !== 'add' && (
              <label className="flex items-center gap-2 text-sm col-span-2">
                <input type="checkbox" checked={!!form.is_active} onChange={e => set('is_active', e.target.checked)}/> Active
              </label>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
