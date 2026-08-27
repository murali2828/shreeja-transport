// frontend/src/pages/auth/ChangePassword.jsx
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';
import { changePassword } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';

export default function ChangePassword() {
  const navigate = useNavigate();
  const { user, clearMustChangePassword } = useAuth();

  const [currentPwd,  setCurrentPwd]  = useState('');
  const [newPwd,      setNewPwd]      = useState('');
  const [confirmPwd,  setConfirmPwd]  = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew,     setShowNew]     = useState(false);
  const [pending,     setPending]     = useState(false);

  // Block navigation away if must_change_password is true
  useEffect(() => {
    if (!user?.must_change_password) return;
    const handleBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = 'You must change your password before continuing.';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [user]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!currentPwd || !newPwd || !confirmPwd)
      return toast.error('All fields are required');
    if (newPwd.length < 6)
      return toast.error('New password must be at least 8 characters');
    if (newPwd !== confirmPwd)
      return toast.error('New passwords do not match');
    if (newPwd === currentPwd)
      return toast.error('New password must be different from current password');

    setPending(true);
    try {
      await changePassword(currentPwd, newPwd);
      clearMustChangePassword();
      toast.success('Password changed successfully');
      navigate('/', { replace: true });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to change password');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#e6f3fb] to-[#f0f4f8] flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-100 text-amber-600 mb-2">
            <ShieldAlert size={28}/>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Change Your Password</h1>
          {user?.must_change_password && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Your password was set by an administrator. You must create a new password before continuing.
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Current password */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">Current Password</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                className="input w-full pr-12"
                value={currentPwd}
                onChange={e => setCurrentPwd(e.target.value)}
                placeholder="Enter current password"
                autoFocus
              />
              <button type="button" onClick={() => setShowCurrent(!showCurrent)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showCurrent ? <EyeOff size={16}/> : <Eye size={16}/>}
              </button>
            </div>
          </div>

          {/* New password */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">New Password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                className="input w-full pr-12"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                placeholder="Min 8 characters"
              />
              <button type="button" onClick={() => setShowNew(!showNew)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showNew ? <EyeOff size={16}/> : <Eye size={16}/>}
              </button>
            </div>
          </div>

          {/* Confirm new password */}
          <div className="space-y-1">
            <label className="block text-sm font-medium text-gray-700">Confirm New Password</label>
            <input
              type="password"
              className="input w-full"
              value={confirmPwd}
              onChange={e => setConfirmPwd(e.target.value)}
              placeholder="Repeat new password"
            />
          </div>

          <button
            type="submit"
            disabled={pending}
            className="btn-primary w-full flex items-center justify-center gap-2 py-2.5">
            {pending ? (
              <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"/>
            ) : (
              <KeyRound size={16}/>
            )}
            {pending ? 'Saving…' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
