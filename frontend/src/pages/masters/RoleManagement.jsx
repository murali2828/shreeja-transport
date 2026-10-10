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
  { key: 'quality',   label: 'Quality (QA dispatch entry)' },
];

// Per-module access level (migration 060): None / View / Edit.
const EMPTY_ACCESS = { masters: 'none', planning: 'none', execution: 'none', billing: 'none', reports: 'none', quality: 'none' };
const LEVELS = [['none', 'None'], ['view', 'View'], ['edit', 'Edit']];
const levelsOf = row => {
  const out = { ...EMPTY_ACCESS };
  const acc = row.access && Object.keys(row.access).length ? row.access : null;
  for (const m of Object.keys(out)) out[m] = acc ? (acc[m] || 'none') : (row.permissions?.[m] ? (row.read_only ? 'view' : 'edit') : 'none');
  return out;
};
const NAME_RE = /^[a-z0-9_]+$/;

export default function RoleManagement() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null); // 'add' | role row | null
  const [form, setForm] = useState({ name: '', label: '', access: { ...EMPTY_ACCESS } });

  const { data: roles = [], isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn:  () => getRoles().then(r => r.data),
  });

  const openAdd = () => { setForm({ name: '', label: '', access: { ...EMPTY_ACCESS } }); setModal('add'); };
  const openEdit = (row) => { setForm({ name: row.name, label: row.label, access: levelsOf(row) }); setModal(row); };
  const close = () => setModal(null);
  const setLevel = (key, v) => setForm(p => ({ ...p, access: { ...p.access, [key]: v } }));
  const setAll = v => setForm(p => ({ ...p, access: Object.fromEntries(Object.keys(p.access).map(k => [k, p.access[k] === 'none' ? 'none' : v])) }));
  const isViewerRole = modal && modal !== 'add' && modal.name === 'viewer';

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.label) throw new Error('Label is required');
      if (modal === 'add') {
        if (!form.name) throw new Error('Name is required');
        if (!NAME_RE.test(form.name)) throw new Error('Name may contain only lowercase letters, numbers, and underscore (no spaces)');
        return createRole({ name: form.name, label: form.label, access: form.access });
      }
      return updateRole(modal.id, { label: form.label, access: form.access });
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
        subtitle="Create roles and set, per module, whether the role has no access, can only view, or can view and edit"
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
              <th className="table-th text-center">Read-only</th>
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
                {MODULES.map(m => {
                  const lv = levelsOf(r)[m.key];
                  return (
                    <td key={m.key} className="table-td text-center">
                      {lv === 'edit' && <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800 text-[10px] font-semibold">EDIT</span>}
                      {lv === 'view' && <span className="px-1.5 py-0.5 rounded bg-sky-100 text-sky-800 text-[10px] font-semibold">VIEW</span>}
                      {lv === 'none' && <span className="text-gray-300">—</span>}
                    </td>
                  );
                })}
                  <td className="table-td text-center">{r.read_only ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold">VIEW ONLY</span> : '—'}</td>
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
              <div className="space-y-1.5">
                {MODULES.map(m => (
                  <div key={m.key} className="flex items-center justify-between gap-2 text-sm px-2 py-1.5 rounded-lg border border-gray-200">
                    <span>{m.label}</span>
                    <div className="flex rounded-lg overflow-hidden border border-gray-200 text-xs">
                      {LEVELS.map(([v, lbl]) => {
                        const disabled = isViewerRole && v === 'edit';
                        const on = form.access[m.key] === v;
                        return (
                          <button key={v} type="button" disabled={disabled} onClick={() => setLevel(m.key, v)}
                            className={`px-3 py-1 ${on ? (v === 'edit' ? 'bg-green-600 text-white' : v === 'view' ? 'bg-sky-600 text-white' : 'bg-gray-500 text-white') : 'bg-white text-gray-600'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                <button type="button" className="btn-secondary btn-sm" onClick={() => setAll('view')}>All granted → View</button>
                {!isViewerRole && <button type="button" className="btn-secondary btn-sm" onClick={() => setAll('edit')}>All granted → Edit</button>}
              </div>
              <p className="text-xs text-gray-500 mt-2">
                <b>View</b>: sees the module's screens and reports, cannot create, change, approve or delete. <b>Edit</b>: full use of the module.
                A user with several roles gets the highest level per module. {isViewerRole && 'The built-in Viewer role is limited to View.'}
              </p>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
