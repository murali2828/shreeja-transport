import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getEmailConfig, createEmailConfig, updateEmailConfig, deleteEmailConfig } from '../../api';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, Check, Mail } from 'lucide-react';

export default function EmailConfig() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ full_name: '', email: '', is_active: true });

  const { data: configs = [] } = useQuery({ queryKey: ['email-config'], queryFn: () => getEmailConfig().then(r => r.data) });
  const saveMut = useMutation({
    mutationFn: () => modal?.id ? updateEmailConfig(modal.id, form) : createEmailConfig(form),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries(['email-config']); setModal(null); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed')
  });
  const delMut = useMutation({
    mutationFn: deleteEmailConfig,
    onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries(['email-config']); }
  });

  const openAdd = () => { setForm({ full_name: '', email: '', is_active: true }); setModal({}); };
  const openEdit = (c) => { setForm(c); setModal(c); };

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Report Email Recipients</h2>
          <p className="text-xs text-gray-500">Configure who receives daily TS reports by email</p>
        </div>
        <button onClick={openAdd} className="btn-primary"><Plus size={14} /> Add Recipient</button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-700">
        <strong>Note:</strong> These email addresses will receive the daily TS report when you click "Send Report" from the Reports page.
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-th">Name</th>
              <th className="table-th">Email Address</th>
              <th className="table-th">Status</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {configs.length === 0 ? (
              <tr><td colSpan={4} className="table-td text-center py-8 text-gray-400">No recipients configured</td></tr>
            ) : configs.map(c => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="table-td font-medium">{c.full_name}</td>
                <td className="table-td flex items-center gap-1.5"><Mail size={13} className="text-gray-400" />{c.email}</td>
                <td className="table-td"><span className={c.is_active ? 'badge-green' : 'badge-red'}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
                <td className="table-td">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(c)} className="btn-secondary btn-sm"><Pencil size={12} /></button>
                    <button onClick={() => { if (confirm('Delete?')) delMut.mutate(c.id); }} className="btn-danger btn-sm"><Trash2 size={12} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 py-2 text-xs text-gray-400 border-t">
          Active recipients: {configs.filter(c => c.is_active).length}
        </div>
      </div>

      {modal !== null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between px-5 py-4 border-b">
              <h3 className="font-semibold">{modal?.id ? 'Edit Recipient' : 'Add Recipient'}</h3>
              <button onClick={() => setModal(null)}><X size={18} /></button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="label">Full Name *</label>
                <input className="input" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
              </div>
              <div>
                <label className="label">Email Address *</label>
                <input className="input" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="ec_active" checked={form.is_active !== false} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                <label htmlFor="ec_active" className="text-sm">Active</label>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={() => saveMut.mutate()} className="btn-primary"><Check size={14} /> Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
