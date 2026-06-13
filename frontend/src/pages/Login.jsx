// frontend/src/pages/Login.jsx
// Shreeja Platform Theme: sky-blue gradient background, frosted white card
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Truck, Eye, EyeOff } from 'lucide-react';
import toast from 'react-hot-toast';
import { login } from '../api/index';
import { useAuth } from '../hooks/useAuth';

export default function Login() {
  const navigate     = useNavigate();
  const { loginUser } = useAuth();
  const [form, setForm]   = useState({ username: '', password: '' });
  const [showPw, setShowPw] = useState(false);

  const mut = useMutation({
    mutationFn: () => login(form),
    onSuccess: (res) => {
      loginUser(res.data.user, res.data.token);
      navigate('/', { replace: true });
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Login failed'),
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.username || !form.password) { toast.error('Enter username and password'); return; }
    mut.mutate();
  };

  return (
    // Full-page sky gradient — identical to Shreeja platform screenshot
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'linear-gradient(145deg,#0060b0 0%,#0078d4 25%,#1a9dd9 55%,#55c2ea 80%,#a8ddf5 100%)' }}>

      {/* Floating blobs in background (decorative, matches screenshot) */}
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

      {/* Login card — frosted glass */}
      <div className="relative w-full max-w-sm"
        style={{ background:'rgba(255,255,255,0.90)', backdropFilter:'blur(16px)',
                 borderRadius:20, border:'1px solid rgba(255,255,255,0.7)',
                 boxShadow:'0 20px 60px rgba(0,50,120,0.25), 0 4px 16px rgba(0,0,0,0.10)',
                 padding:'36px 32px' }}>

        {/* Logo area */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
            style={{ background:'linear-gradient(135deg,#0078d4,#1a9dd9)',
                     boxShadow:'0 6px 20px rgba(0,120,212,0.40)' }}>
            <Truck size={30} className="text-white"/>
          </div>
          <div className="text-2xl font-bold text-gray-800" style={{ fontFamily:"'Segoe UI',sans-serif" }}>
            <span className="italic text-[#0078d4]">Shreeja</span> Transport
          </div>
          <p className="text-sm text-gray-500 mt-1">Secondary Transport Management</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Username</label>
            <input
              autoFocus
              className="input w-full"
              placeholder="Enter your username"
              value={form.username}
              onChange={e => setForm(p => ({ ...p, username: e.target.value }))}/>
          </div>

          <div>
            <label className="label">Password</label>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'}
                className="input w-full pr-10"
                placeholder="Enter your password"
                value={form.password}
                onChange={e => setForm(p => ({ ...p, password: e.target.value }))}/>
              <button
                type="button"
                onClick={() => setShowPw(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff size={15}/> : <Eye size={15}/>}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={mut.isPending}
            className="btn-primary w-full py-2.5 text-base mt-2">
            {mut.isPending ? 'Signing in…' : 'Sign In'}
          </button>

          <div className="text-center mt-3">
            <Link to="/forgot-password" className="text-sm text-[#0078d4] hover:underline">
              Forgot password?
            </Link>
          </div>
        </form>

        <p className="text-center text-xs text-gray-400 mt-6">
          Shreeja Secondary Transport Management System
        </p>
        <p className="text-center text-xs text-gray-400 mt-1">
          Developed &amp; maintained by <span className="font-semibold text-gray-500">Shreeja IT Team</span>
        </p>
      </div>
    </div>
  );
}
