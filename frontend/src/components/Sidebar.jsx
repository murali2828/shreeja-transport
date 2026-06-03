// frontend/src/components/Sidebar.jsx
// Shreeja Platform Theme: translucent blue sidebar, white text nav items
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  Truck, LayoutDashboard, MapPin, Route, Users, Settings,
  ClipboardList, Play, CheckSquare, BarChart2, Mail,
  ChevronDown, ChevronRight, Zap, Navigation
} from 'lucide-react';

function NavItem({ to, icon, label, end = false }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
      <span className="shrink-0 opacity-80">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

function NavSection({ label, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-1.5 text-xs font-semibold uppercase tracking-widest transition-colors"
        style={{ color:'rgba(255,255,255,0.5)', letterSpacing:'0.07em' }}>
        {label}
        {open ? <ChevronDown size={11}/> : <ChevronRight size={11}/>}
      </button>
      {open && <div className="space-y-0.5 mt-0.5">{children}</div>}
    </div>
  );
}

export default function Sidebar() {
  const { user } = useAuth();
  const isAdmin   = user?.role === 'admin';
  const isPlanner = user?.role === 'planner' || isAdmin;
  const isViewer  = user?.role === 'viewer';

  return (
    <nav className="flex-1 overflow-y-auto py-3 space-y-3">
      {/* Dashboard always visible */}
      <div className="mb-1">
        <NavItem to="/" end icon={<LayoutDashboard size={15}/>} label="Dashboard"/>
      </div>

      {isPlanner && (
        <NavSection label="Masters">
          <NavItem to="/masters/tankers"    icon={<Truck size={15}/>}       label="Tankers"/>
          <NavItem to="/masters/bmcus"      icon={<MapPin size={15}/>}      label="BMCUs"/>
          <NavItem to="/masters/routes"     icon={<Route size={15}/>}       label="Routes"/>
          <NavItem to="/masters/locations"  icon={<Navigation size={15}/>}  label="Locations"/>
          <NavItem to="/masters/distances"  icon={<Route size={15}/>}       label="Distance Master"/>
          {isAdmin && (
            <>
              <NavItem to="/masters/users"        icon={<Users size={15}/>} label="Users"/>
              <NavItem to="/masters/email-config" icon={<Mail size={15}/>}  label="Email Config"/>
            </>
          )}
        </NavSection>
      )}

      {isPlanner && (
        <NavSection label="Planning">
          <NavItem to="/planning"          icon={<ClipboardList size={15}/>} label="Trip Plans"/>
          <NavItem to="/planning/optimize" icon={<Zap size={15}/>}          label="Route Optimizer"/>
        </NavSection>
      )}

      {(isPlanner || isViewer) && (
        <NavSection label="Execution">
          <NavItem to="/execution"        icon={<Play size={15}/>}        label="Active Trips"/>
          <NavItem to="/execution/closed" icon={<CheckSquare size={15}/>} label="Closed Trips"/>
        </NavSection>
      )}

      {(isPlanner || isViewer) && (
        <NavSection label="Reports">
          <NavItem to="/reports" icon={<BarChart2 size={15}/>} label="Daily TS Report"/>
        </NavSection>
      )}

      {/* User info at bottom */}
      <div className="mx-2 mt-4 px-3 py-2.5 rounded-xl" style={{ background:'rgba(255,255,255,0.1)', marginTop:'auto' }}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {user?.full_name?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="min-w-0">
            <div className="text-xs font-semibold text-white truncate">{user?.full_name}</div>
            <div className="text-xs capitalize" style={{ color:'rgba(255,255,255,0.55)' }}>{user?.role}</div>
          </div>
        </div>
      </div>
    </nav>
  );
}
