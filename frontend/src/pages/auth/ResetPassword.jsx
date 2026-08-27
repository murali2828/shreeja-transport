// frontend/src/pages/auth/ResetPassword.jsx
import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Truck, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { resetPassword } from '../../api/index';

export default function ResetPassword() {
  const navigate             = useNavigate();
  const [searchParams]       = useSearchParams();
  const token                = searchParams.get('token') || '';
  const [password, setPassword]   = useState('');
  const [confirm,  setConfirm]    = useState('');
  const [showPw,   setShowPw]     = useState(false);
  const [showCf,   setShowCf]     = useState(false);

  const mut = useMutation({
    mutationFn: () => resetPassword(token, password),
    onSuccess: () => {
      toast.success('Password reset successfully. Please sign in.');
      navigate('/login', { replace: true });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Reset failed'),
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!password) { toast.error('Enter a new password'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    if (!token) { toast.error('Missing reset token — use the link from your email'); return; }
    mut.mutate();
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(145deg,#0060b0 0%,#0078d4 25%,#1a9dd9 55%,#55c2ea 80%,#a8ddf5 100%)' }}>

      {/* Decorative blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none" aria-hidden>
        {[
          { w:320, h:320, top:'5%',  left:'5%',  op:0.12 },
          { w:400, h:400, top:'50%', left:'-5%', op:0.10 },
          { w:280, h:280, top:'15%', right:'3%', op:0.10 },
          { w:360, h:360, top:'55%', right:'-3%',op:0.08 },
        ].map((b, i) => (
          <div key={i} className="absolute rounded-full"
            style={{ width:b.w, height:b.h, top:b.top, left:b.left, right:b.right,
                     background:'rgba(255,255,255,0.22)', opacity:b.op, filter:'blur(40px)' }}/>
        ))}
      </div>

      {/* Card */}
      <div className="relative w-full max-w-sm"
        style={{ background:'rgba(255,255,255,0.90)', backdropFilter:'blur(16px)',
                 borderRadius:20, border:'1px solid rgba(255,255,255,0.7)',
                 boxShadow:'0 20px 60px rgba(0,50,120,0.25), 0 4px 16px rgba(0,0,0,0.10)',
                 padding:'36px 32px' }}>

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background:'linear-gradient(135deg,#0078d4,#1a9dd9)',
                     boxShadow:'0 6px 20px rgba(0,120,212,0.40)' }}>
            <Truck size={30} className="text-white"/>
          </div>
          <div className="text-2xl font-bold text-gray-800" style={{ fontFamily:"'Segoe UI',sans-serif" }}>
            <span className="italic text-[#0078d4]">Shreeja</span> Transport
          </div>
          <p className="text-sm text-gray-500 mt-1">Set New Password</p>
        </div>

        {!token ? (
          <div className="text-center space-y-4">
            <div className="text-red-600 text-sm bg-red-50 border border-red-200 rounded-lg p-4">
              Invalid reset link. Please use the link from your email.
            </div>
            <Link to="/forgot-password" className="block text-sm text-[#0078d4] hover:underline">
              Request a new link
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="label">New Password</label>
              <div className="relative">
                <input
                  autoFocus
                  type={showPw ? 'text' : 'password'}
                  className="input w-full pr-10"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={e => setPassword(e.target.value)}/>
                <button type="button" onClick={() => setShowPw(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPw ? <EyeOff size={15}/> : <Eye size={15}/>}
                </button>
              </div>
            </div>

            <div>
              <label className="label">Confirm Password</label>
              <div className="relative">
                <input
                  type={showCf ? 'text' : 'password'}
                  className="input w-full pr-10"
                  placeholder="Re-enter new password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}/>
                <button type="button" onClick={() => setShowCf(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showCf ? <EyeOff size={15}/> : <Eye size={15}/>}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={mut.isPending}
              className="btn-primary w-full py-2.5 text-base mt-2">
              {mut.isPending ? 'Resetting…' : 'Reset Password'}
            </button>

            <div className="text-center">
              <Link to="/login" className="text-sm text-[#0078d4] hover:underline">
                Back to Sign In
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
