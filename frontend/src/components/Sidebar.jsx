import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  LayoutDashboard, Truck, Building2, MapPin, Route, Users, Mail,
  ClipboardList, PlayCircle, Archive, BarChart3, ChevronDown, ChevronRight
} from 'lucide-react';
import { useState } from 'react';

function NavItem({ to, icon: Icon, label }) {
  return (
    <NavLink to={to} end={to === '/'}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
          isActive
            ? 'bg-brand-600 text-white shadow-sm'
            : 'text-gray-700 hover:bg-brand-50 hover:text-brand-700'
        }`
      }>
      <Icon size={15} />
      <span>{label}</span>
    </NavLink>
  );
}

function NavGroup({ label, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="space-y-0.5">
      <button onClick={() => setOpen(o => !o)}
        className="flex items-center justify-between w-full px-3 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-widest hover:text-gray-600 transition-colors">
        <span>{label}</span>
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {open && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

export default function Sidebar({ open }) {
  const { user } = useAuth();
  if (!open) return null;
  const isAdmin = user?.role === 'admin';
  const isPlanner = ['admin', 'planner'].includes(user?.role);

  return (
    <aside className="w-52 shrink-0 flex flex-col"
      style={{ background: 'rgba(255,255,255,0.88)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', borderRight: '1px solid rgba(255,255,255,0.6)' }}>

      {/* User info */}
      <div className="px-3 py-4 border-b border-blue-100/60">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm shadow"
            style={{ background: 'linear-gradient(135deg,#1565c0,#42a5f5)' }}>
            {user?.full_name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-gray-800 truncate">{user?.full_name}</div>
            <div className="text-[10px] text-brand-600 capitalize font-medium">{user?.role}</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        <NavItem to="/" icon={LayoutDashboard} label="Dashboard" />

        {isPlanner && (
          <NavGroup label="Masters">
            <NavItem to="/masters/tankers" icon={Truck} label="Tankers" />
            <NavItem to="/masters/bmcus" icon={Building2} label="BMCUs" />
            <NavItem to="/masters/routes" icon={Route} label="Routes" />
            <NavItem to="/masters/locations" icon={MapPin} label="Locations" />
            {isAdmin && <NavItem to="/masters/users" icon={Users} label="Users" />}
            {isAdmin && <NavItem to="/masters/email-config" icon={Mail} label="Email Config" />}
          </NavGroup>
        )}

        {isPlanner && (
          <NavGroup label="Planning">
            <NavItem to="/planning" icon={ClipboardList} label="Trip Plans" />
          </NavGroup>
        )}

        <NavGroup label="Execution">
          <NavItem to="/execution" icon={PlayCircle} label="Active Trips" />
          <NavItem to="/execution/closed" icon={Archive} label="Closed Trips" />
        </NavGroup>

        <NavGroup label="Reports">
          <NavItem to="/reports" icon={BarChart3} label="TS Report" />
        </NavGroup>
      </nav>

      {/* Bottom brand */}
      <div className="px-3 py-3 border-t border-blue-100/60">
        <div className="flex items-center gap-1.5">
          <div className="grid grid-cols-2 gap-0.5">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="w-1.5 h-1.5 rounded-sm bg-brand-500" />
            ))}
          </div>
          <span className="text-brand-600 font-bold text-sm">Shreeja</span>
        </div>
        <div className="text-[10px] text-gray-400 mt-0.5">Transport Management v1.0</div>
      </div>
    </aside>
  );
}
