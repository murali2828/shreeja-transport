// frontend/src/pages/auth/ForgotPassword.jsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { forgotPassword } from '../../api/index';

export default function ForgotPassword() {
  const [email, setEmail]     = useState('');
  const [submitted, setSubmitted] = useState(false);

  const mut = useMutation({
    mutationFn: () => forgotPassword(email),
    onSuccess: () => setSubmitted(true),
    onError: (e) => toast.error(e.response?.data?.error || 'Something went wrong'),
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!email) { toast.error('Enter your email address'); return; }
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
          <p className="text-sm text-gray-500 mt-1">Password Reset</p>
        </div>

        {submitted ? (
          <div className="text-center space-y-4">
            <div className="text-green-600 text-sm font-medium bg-green-50 border border-green-200 rounded-lg p-4">
              Check your email for a reset link. It expires in 1 hour.
            </div>
            <Link to="/login" className="block text-sm text-[#0078d4] hover:underline mt-2">
              Back to Sign In
            </Link>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-5 text-center">
              Enter your email address and we'll send you a link to reset your password.
            </p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="label">Email Address</label>
                <input
                  autoFocus
                  type="email"
                  className="input w-full"
                  placeholder="Enter your email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}/>
              </div>

              <button
                type="submit"
                disabled={mut.isPending}
                className="btn-primary w-full py-2.5 text-base mt-2">
                {mut.isPending ? 'Sending…' : 'Send Reset Link'}
              </button>
            </form>

            <div className="text-center mt-4">
              <Link to="/login" className="text-sm text-[#0078d4] hover:underline">
                Back to Sign In
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
