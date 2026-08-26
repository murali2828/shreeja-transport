// frontend/src/pages/masters/UserManagement.jsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, User, Settings, KeyRound, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { getUsers, createUser, updateUser, getRoles } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';
import { useAuth } from '../../hooks/useAuth';

const ROLE_COLORS = {
  admin:    'bg-red-100 text-red-700',
  planner:  'bg-blue-100 text-blue-700',
  executor: 'bg-green-100 text-green-700',
  viewer:   'bg-purple-100 text-purple-700',
};
const ROLE_ICONS = { admin: Shield, planner: Settings, executor: User, viewer: User };

const EMPTY = { user_id: '', email: '', full_name: '', role: 'executor', password: '', is_active: true };

// A User ID may be an email address or an alphanumeric handle — no spaces.
const USER_ID_RE = /^[A-Za-z0-9._@+-]+$/;

export default function UserManagement() {
  const qc = useQueryClient();
  const { user: currentUser } = useAuth();
  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY);
  const [showPw, setShowPw] = useState(false);

  const [resetModal,  setResetModal]  = useState(null); // user object or null
  const [resetPwd,    setResetPwd]    = useState('');
  const [resetPwdCfm, setResetPwdCfm] = useState('');
  const [showResetPw, setShowResetPw] = useState(false);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn:  () => getUsers().then(r => r.data),
  });

  // Role options are DB-backed and admin-manageable (see Roles screen). Fall
  // back to the original 5 while loading so the dropdown is never empty.
  const FALLBACK_ROLES = [
    { name: 'executor', label: 'Executor' },
    { name: 'planner',  label: 'Planner' },
    { name: 'admin',    label: 'Admin' },
    { name: 'biller',   label: 'Biller' },
    { name: 'viewer',   label: 'Viewer' },
  ];
  const { data: roles = FALLBACK_ROLES } = useQuery({
    queryKey: ['roles'],
    queryFn:  () => getRoles().then(r => r.data),
  });

  const openAdd  = () => { setForm(EMPTY); setShowPw(true); setModal('add'); };
  const openEdit = (row) => {
    setForm({ ...row, password: '', is_active: row.is_active });
    setShowPw(false);
    setModal(row);
  };
  const openReset = (row) => {
    setResetPwd('');
    setResetPwdCfm('');
    setShowResetPw(false);
    setResetModal(row);
  };
  const closeReset = () => setResetModal(null);
  const close = () => setModal(null);
  const set   = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.full_name || !form.email || !form.role) throw new Error('All fields required');
      if (modal === 'add' && !form.password) throw new Error('Password required for new users');
      if (modal === 'add' && !form.user_id)  throw new Error('User ID required');
      if (form.user_id && !USER_ID_RE.test(form.user_id))
        throw new Error('User ID may contain only letters, numbers, and . _ @ + - (no spaces)');
      const payload = { ...form };
      if (!payload.password) delete payload.password;
      return modal === 'add' ? createUser(payload) : updateUser(modal.id, payload);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'User created' : 'User updated');
      qc.invalidateQueries(['users']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const resetMut = useMutation({
    mutationFn: () => {
      if (!resetPwd) throw new Error('Password is required');
      if (resetPwd.length < 6) throw new Error('Password must be at least 6 characters');
      if (resetPwd !== resetPwdCfm) throw new Error('Passwords do not match');
      return updateUser(resetModal.id, { password: resetPwd });
    },
    onSuccess: () => {
      toast.success(`Password reset for ${resetModal.full_name}`);
      closeReset();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  return (
    <div className="space-y-4 w-full">
      <PageHeader
        title="User Management"
        subtitle="Manage user accounts and role-based access"
        onAdd={openAdd}
        addLabel="Add User"
      />

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">Full Name</th>
              <th className="table-th">User ID</th>
              <th className="table-th">Email</th>
              <th className="table-th">Role</th>
              <th className="table-th">Status</th>
              <th className="table-th w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && users.length === 0 && <EmptyState message="No users found."/>}
            {users.map(u => {
              const RoleIcon = ROLE_ICONS[u.role] || User;
              return (
                <tr key={u.id} className="hover:bg-gray-50 border-b border-gray-50">
                  <td className="table-td font-medium">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-[#e6f3fb] text-[#005ba3] flex items-center justify-center text-xs font-bold shrink-0">
                        {u.full_name?.[0]?.toUpperCase()}
                      </div>
                      {u.full_name}
                      {u.id === currentUser?.id && (
                        <span className="text-xs text-[#0078d4] font-medium">(you)</span>
                      )}
                    </div>
                  </td>
                  <td className="table-td font-mono text-xs text-gray-600">{u.user_id || u.username}</td>
                  <td className="table-td text-xs text-gray-600">{u.email}</td>
                  <td className="table-td">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${ROLE_COLORS[u.role]}`}>
                      <RoleIcon size={10}/> {u.role}
                    </span>
                  </td>
                  <td className="table-td"><ActiveBadge active={u.is_active}/></td>
                  <td className="table-td">
                    <div className="flex items-center gap-1">
                      <button onClick={() => openEdit(u)} className="btn-secondary btn-sm p-1.5" title="Edit user">✏</button>
                      <button onClick={() => openReset(u)} className="btn-secondary btn-sm p-1.5" title="Reset password">
                        <KeyRound size={13}/>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Create User' : `Edit — ${modal.full_name}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Full Name" required>
                <input className="input w-full" value={form.full_name}
                  onChange={e => set('full_name', e.target.value)}/>
              </Field>
              <Field label="Role" required>
                <select className="input w-full" value={form.role}
                  onChange={e => set('role', e.target.value)}>
                  {roles.map(r => (
                    <option key={r.name} value={r.name}>{r.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="User ID" required>
                <input className="input w-full" placeholder="email or alphanumeric, no spaces"
                  value={form.user_id || ''}
                  onChange={e => set('user_id', e.target.value.replace(/\s/g,''))}/>
              </Field>
              <Field label="Email" required>
                <input type="email" className="input w-full" value={form.email}
                  onChange={e => set('email', e.target.value)}/>
              </Field>
            </div>

            <Field label={modal === 'add' ? 'Password' : 'New Password (leave blank to keep)'}>
              <div className="relative">
                <input
                  type={showPw ? 'text' : 'password'}
                  className="input w-full pr-16"
                  value={form.password}
                  onChange={e => set('password', e.target.value)}
                  placeholder={modal === 'add' ? 'Min 6 characters' : 'Leave blank to keep current'}/>
                <button type="button" onClick={() => setShowPw(!showPw)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600">
                  {showPw ? 'Hide' : 'Show'}
                </button>
              </div>
            </Field>

            {modal !== 'add' && (
              <Field label="Account Status">
                <select className="input w-full" value={form.is_active}
                  onChange={e => set('is_active', e.target.value === 'true')}>
                  <option value="true">Active</option>
                  <option value="false">Inactive (cannot login)</option>
                </select>
              </Field>
            )}

            <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600 space-y-1">
              <div className="font-medium text-gray-700 mb-1">Role Permissions</div>
              <div><span className="font-medium text-red-600">Admin:</span> Full access to all modules</div>
              <div><span className="font-medium text-blue-600">Planner:</span> Masters, Trip Planning, Reports</div>
              <div><span className="font-medium text-green-600">Executor:</span> Execution data entry, Reports</div>
            </div>
          </div>
        </Modal>
      )}
      {resetModal && (
        <Modal
          title={`Reset Password — ${resetModal.full_name}`}
          onClose={closeReset}
          footer={
            <>
              <button onClick={closeReset} className="btn-secondary">Cancel</button>
              <button
                onClick={() => resetMut.mutate()}
                disabled={resetMut.isPending}
                className="btn-primary flex items-center gap-2">
                {resetMut.isPending
                  ? <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"/>
                  : <KeyRound size={14}/>}
                {resetMut.isPending ? 'Saving…' : 'Reset Password'}
              </button>
            </>
          }>
          <div className="space-y-3">
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              The user will be required to change this password on next login.
            </p>
            <Field label="New Password" required>
              <div className="relative">
                <input
                  type={showResetPw ? 'text' : 'password'}
                  className="input w-full pr-16"
                  value={resetPwd}
                  onChange={e => setResetPwd(e.target.value)}
                  placeholder="Min 6 characters"
                  autoFocus
                />
                <button type="button" onClick={() => setShowResetPw(!showResetPw)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showResetPw ? <EyeOff size={14}/> : <Eye size={14}/>}
                </button>
              </div>
            </Field>
            <Field label="Confirm New Password" required>
              <input
                type="password"
                className="input w-full"
                value={resetPwdCfm}
                onChange={e => setResetPwdCfm(e.target.value)}
                placeholder="Repeat new password"
              />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
