import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';
import { Eye, EyeOff } from 'lucide-react';

export default function Login() {
  const [form, setForm] = useState({ username: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const { login, loading } = useAuth();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    try {
      await login(form.username, form.password);
      navigate('/');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Invalid credentials');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="grid grid-cols-2 gap-1">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="w-3 h-3 bg-white rounded-sm opacity-90" />
              ))}
            </div>
            <span className="text-white font-bold text-3xl tracking-wide drop-shadow">Shreeja</span>
          </div>
          <p className="text-blue-100 text-sm font-medium mt-1">Secondary Transport Management</p>
        </div>

        {/* Card */}
        <div className="rounded-2xl shadow-2xl overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', border: '1px solid rgba(255,255,255,0.6)' }}>
          <div className="px-8 pt-8 pb-2">
            <h2 className="text-xl font-bold text-gray-800 mb-1">Welcome back</h2>
            <p className="text-xs text-gray-500 mb-6">Sign in to your account</p>
          </div>
          <form onSubmit={submit} className="px-8 pb-8 space-y-4">
            <div>
              <label className="label">Username</label>
              <input className="input" type="text" placeholder="Enter username" required
                value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
            </div>
            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input className="input pr-10" type={showPw ? 'text' : 'password'} placeholder="Enter password" required
                  value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
                <button type="button" onClick={() => setShowPw(s => !s)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <button type="submit"
              className="w-full py-2.5 rounded-xl text-white font-semibold text-sm shadow transition-all hover:shadow-md disabled:opacity-50 mt-2"
              style={{ background: 'linear-gradient(90deg,#1565c0,#1e88e5)' }}
              disabled={loading}>
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
            <p className="text-center text-xs text-gray-400 pt-1">
              Default: <span className="font-mono">admin</span> / <span className="font-mono">Admin@1234</span>
            </p>
          </form>
        </div>

        <p className="text-center text-blue-200/70 text-[11px] mt-6">
          © 2026 Shreeja Dairy · Transport Management System
        </p>
      </div>
    </div>
  );
}
