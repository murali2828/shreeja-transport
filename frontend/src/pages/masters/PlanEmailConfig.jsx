// frontend/src/pages/masters/PlanEmailConfig.jsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, Send } from 'lucide-react';
import toast from 'react-hot-toast';
import { getPlanEmailConfigs, createPlanEmailConfig, updatePlanEmailConfig, deletePlanEmailConfig } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY = { name: '', email: '', is_active: true };

export default function PlanEmailConfig() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY);

  const { data: config = [], isLoading } = useQuery({
    queryKey: ['plan-email-config'],
    queryFn:  () => getPlanEmailConfigs().then(r => r.data),
  });

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (row) => { setForm({ ...row }); setModal(row); };
  const close    = () => setModal(null);
  const set      = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.email) throw new Error('Email required');
      return modal === 'add' ? createPlanEmailConfig(form) : updatePlanEmailConfig(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Recipient added' : 'Recipient updated');
      qc.invalidateQueries(['plan-email-config']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deletePlanEmailConfig,
    onSuccess: () => { toast.success('Recipient removed'); qc.invalidateQueries(['plan-email-config']); },
    onError:   (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  const activeCount = config.filter(c => c.is_active).length;

  return (
    <div className="space-y-4 max-w-2xl">
      <PageHeader
        title="Plan Email List"
        subtitle="Recipients for Trip Plan published notifications"
        onAdd={openAdd}
        addLabel="Add Recipient"
      />

      {activeCount > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3 flex items-center gap-2 text-sm text-green-800">
          <Send size={14} className="shrink-0"/>
          <span><strong>{activeCount}</strong> active recipient(s) will receive an email when trip plans are published.</span>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">Name</th>
              <th className="table-th">Email Address</th>
              <th className="table-th">Status</th>
              <th className="table-th w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && config.length === 0 && (
              <EmptyState message="No email recipients configured. Add recipients to receive plan notifications."/>
            )}
            {config.map(c => (
              <tr key={c.id} className="hover:bg-gray-50 border-b border-gray-50">
                <td className="table-td font-medium">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-[#e6f3fb] text-[#005ba3] flex items-center justify-center text-xs font-bold">
                      {(c.name || c.email)?.[0]?.toUpperCase()}
                    </div>
                    {c.name || '—'}
                  </div>
                </td>
                <td className="table-td text-gray-600 flex items-center gap-1.5">
                  <Mail size={13} className="text-gray-400"/>
                  {c.email}
                </td>
                <td className="table-td"><ActiveBadge active={c.is_active}/></td>
                <td className="table-td">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(c)} className="btn-secondary btn-sm p-1.5">✏</button>
                    <button onClick={() => { if (window.confirm(`Remove ${c.email}?`)) deleteMut.mutate(c.id); }}
                      className="btn-danger btn-sm p-1.5">🗑</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Email Recipient' : `Edit — ${modal.name || modal.email}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="space-y-3">
            <Field label="Name">
              <input className="input w-full" placeholder="Recipient's name"
                value={form.name} onChange={e => set('name', e.target.value)}/>
            </Field>
            <Field label="Email Address" required>
              <input type="email" className="input w-full" placeholder="email@company.com"
                value={form.email} onChange={e => set('email', e.target.value)}/>
            </Field>
            <Field label="Status">
              <select className="input w-full" value={form.is_active}
                onChange={e => set('is_active', e.target.value === 'true')}>
                <option value="true">Active (receives emails)</option>
                <option value="false">Inactive (skipped)</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
