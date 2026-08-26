// frontend/src/pages/masters/RoleManagement.jsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { getRoles, createRole, updateRole, deleteRole } from '../../api/index';
import { Modal, Field, SaveButton, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const MODULES = [
  { key: 'masters',   label: 'Masters' },
  { key: 'planning',  label: 'Planning' },
  { key: 'execution', label: 'Execution' },
  { key: 'billing',   label: 'Billing' },
  { key: 'reports',   label: 'Reports' },
];

const EMPTY_PERMS = { masters: false, planning: false, execution: false, billing: false, reports: false };
const NAME_RE = /^[a-z0-9_]+$/;

export default function RoleManagement() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null); // 'add' | role row | null
  const [form, setForm] = useState({ name: '', label: '', permissions: { ...EMPTY_PERMS } });

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn:  () => getRoles().then(r => r.data),
  });

  const openAdd = () => { setForm({ name: '', label: '', permissions: { ...EMPTY_PERMS } }); setModal('add'); };
  const openEdit = (row) => { setForm({ name: row.name, label: row.label, permissions: { ...EMPTY_PERMS, ...row.permissions } }); setModal(row); };
  const close = () => setModal(null);
  const togglePerm = (key) => setForm(p => ({ ...p, permissions: { ...p.permissions, [key]: !p.permissions[key] } }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.label) throw new Error('Label is required');
      if (modal === 'add') {
        if (!form.name) throw new Error('Name is required');
        if (!NAME_RE.test(form.name)) throw new Error('Name may contain only lowercase letters, numbers, and underscore (no spaces)');
        return createRole({ name: form.name, label: form.label, permissions: form.permissions });
      }
      return updateRole(modal.id, { label: form.label, permissions: form.permissions });
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Role created' : 'Role updated');
      qc.invalidateQueries(['roles']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id) => deleteRole(id),
    onSuccess: () => {
      toast.success('Role deleted');
      qc.invalidateQueries(['roles']);
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const onDelete = (row) => {
    if (!window.confirm(`Delete role "${row.label}"? This cannot be undone.`)) return;
    deleteMut.mutate(row.id);
  };

  return (
    <div className="space-y-4 w-full">
      <PageHeader
        title="Role Management"
        subtitle="Create roles and control which modules each role can see"
        onAdd={openAdd}
        addLabel="New Role"
      />

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">Label</th>
              <th className="table-th">Name</th>
              {MODULES.map(m => <th key={m.key} className="table-th text-center">{m.label}</th>)}
              <th className="table-th w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && roles.length === 0 && <EmptyState message="No roles found."/>}
            {roles.map(r => (
              <tr key={r.id} className="hover:bg-gray-50 border-b border-gray-50">
                <td className="table-td font-medium">
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={14} className="text-[#005ba3]"/>
                    {r.label}
                    {r.is_system && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">system</span>
                    )}
                  </div>
                </td>
                <td className="table-td font-mono text-xs text-gray-600">{r.name}</td>
                {MODULES.map(m => (
                  <td key={m.key} className="table-td text-center">
                    {r.permissions?.[m.key] ? <span className="text-green-600 font-bold">✓</span> : <span className="text-gray-300">—</span>}
                  </td>
                ))}
                <td className="table-td">
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(r)} className="btn-secondary btn-sm p-1.5" title="Edit role">✏</button>
                    {!r.is_system && (
                      <button onClick={() => onDelete(r)} className="btn-secondary btn-sm p-1.5 text-red-600" title="Delete role">✕</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'New Role' : `Edit — ${modal.label}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="space-y-3">
            <Field label="Label" required>
              <input className="input w-full" value={form.label}
                onChange={e => setForm(p => ({ ...p, label: e.target.value }))}/>
            </Field>
            {modal === 'add' && (
              <Field label="Name (stored value, no spaces)" required>
                <input className="input w-full" placeholder="e.g. accounts_team"
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))}/>
              </Field>
            )}
            <Field label="Module Access">
              <div className="grid grid-cols-2 gap-2">
                {MODULES.map(m => (
                  <label key={m.key} className="flex items-center gap-2 text-sm px-2 py-1.5 rounded-lg border border-gray-200 cursor-pointer">
                    <input type="checkbox" checked={!!form.permissions[m.key]} onChange={() => togglePerm(m.key)}/>
                    {m.label}
                  </label>
                ))}
              </div>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
