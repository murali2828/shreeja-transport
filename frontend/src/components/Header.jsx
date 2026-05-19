import { Menu, LogOut, Bell, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

export default function Header({ onToggleSidebar }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <header style={{ background: 'linear-gradient(90deg,#1565c0 0%,#1976d2 100%)' }}
      className="px-4 py-2 flex items-center justify-between shrink-0 shadow-lg z-10">
      {/* Left: Logo + toggle */}
      <div className="flex items-center gap-3">
        <button onClick={onToggleSidebar} className="p-1.5 rounded-lg hover:bg-white/20 text-white transition-colors">
          <Menu size={18} />
        </button>
        {/* Shreeja Logo */}
        <div className="flex items-center gap-2 select-none">
          <div className="grid grid-cols-2 gap-0.5 w-5 h-5">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-white rounded-sm w-2 h-2 opacity-90" />
            ))}
          </div>
          <span className="text-white font-bold text-lg tracking-wide">Shreeja</span>
        </div>
        <div className="h-5 w-px bg-white/30 mx-1" />
        <span className="text-blue-100 text-sm font-medium hidden sm:block">Secondary Transport</span>
      </div>

      {/* Right: search, bell, user */}
      <div className="flex items-center gap-2">
        <button className="p-1.5 rounded-lg hover:bg-white/20 text-white transition-colors">
          <Search size={16} />
        </button>
        <button className="p-1.5 rounded-lg hover:bg-white/20 text-white transition-colors relative">
          <Bell size={16} />
        </button>
        <div className="h-5 w-px bg-white/30 mx-1" />
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-white/20 border border-white/40 flex items-center justify-center text-white font-bold text-xs">
            {user?.full_name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="hidden sm:block">
            <div className="text-white text-xs font-semibold leading-tight">{user?.full_name}</div>
            <div className="text-blue-200 text-[10px] capitalize">{user?.role}</div>
          </div>
        </div>
        <button onClick={handleLogout} title="Logout"
          className="p-1.5 rounded-lg hover:bg-white/20 text-blue-100 hover:text-white transition-colors ml-1">
          <LogOut size={15} />
        </button>
      </div>
    </header>
  );
}
