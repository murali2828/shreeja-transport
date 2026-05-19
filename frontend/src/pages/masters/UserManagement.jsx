import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getUsers, createUser, updateUser } from '../../api';
import toast from 'react-hot-toast';
import { Plus, Pencil, X, Check } from 'lucide-react';

const EMPTY = { username: '', email: '', full_name: '', role: 'executor', password: '', is_active: true };

function UserModal({ user, onClose, onSave }) {
  const [form, setForm] = useState(user || EMPTY);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold">{user ? 'Edit User' : 'Add User'}</h3>
          <button onClick={onClose}><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Username *</label>
              <input className="input" value={form.username} onChange={e => set('username', e.target.value)} disabled={!!user} />
            </div>
            <div>
              <label className="label">Role *</label>
              <select className="input" value={form.role} onChange={e => set('role', e.target.value)}>
                <option value="admin">Admin</option>
                <option value="planner">Tanker Planner</option>
                <option value="executor">Trip Executor</option>
              </select>
            </div>
          </div>
          <div>
            <label className="label">Full Name *</label>
            <input className="input" value={form.full_name} onChange={e => set('full_name', e.target.value)} />
          </div>
          <div>
            <label className="label">Email *</label>
            <input className="input" type="email" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>
          <div>
            <label className="label">{user ? 'New Password (leave blank to keep)' : 'Password *'}</label>
            <input className="input" type="password" value={form.password} onChange={e => set('password', e.target.value)} />
          </div>
          {user && (
            <div className="flex items-center gap-2">
              <input type="checkbox" id="ua" checked={form.is_active !== false} onChange={e => set('is_active', e.target.checked)} />
              <label htmlFor="ua" className="text-sm">Active</label>
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

export default function UserManagement() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => getUsers().then(r => r.data) });
  const saveMut = useMutation({
    mutationFn: (form) => modal?.id ? updateUser(modal.id, form) : createUser(form),
    onSuccess: () => { toast.success('User saved'); qc.invalidateQueries(['users']); setModal(null); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed')
  });
  const roleLabel = { admin: 'Admin', planner: 'Tanker Planner', executor: 'Trip Executor' };
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">User Management</h2>
          <p className="text-xs text-gray-500">Manage admin, planner and executor accounts</p>
        </div>
        <button onClick={() => setModal({})} className="btn-primary"><Plus size={14} /> Add User</button>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr>
              <th className="table-th">Username</th>
              <th className="table-th">Full Name</th>
              <th className="table-th">Email</th>
              <th className="table-th">Role</th>
              <th className="table-th">Status</th>
              <th className="table-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="hover:bg-gray-50">
                <td className="table-td font-mono font-medium">{u.username}</td>
                <td className="table-td">{u.full_name}</td>
                <td className="table-td text-gray-500">{u.email}</td>
                <td className="table-td"><span className="badge badge-blue">{roleLabel[u.role] || u.role}</span></td>
                <td className="table-td"><span className={u.is_active ? 'badge-green' : 'badge-red'}>{u.is_active ? 'Active' : 'Inactive'}</span></td>
                <td className="table-td"><button onClick={() => setModal(u)} className="btn-secondary btn-sm"><Pencil size={12} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal !== null && <UserModal user={modal?.id ? modal : null} onClose={() => setModal(null)} onSave={saveMut.mutate} />}
    </div>
  );
}
