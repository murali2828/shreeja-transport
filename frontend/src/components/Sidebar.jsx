// frontend/src/components/Sidebar.jsx
// Shreeja Platform Theme: translucent blue sidebar, white text nav items
import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  Truck, LayoutDashboard, MapPin, Route, Users, Settings,
  ClipboardList, Play, CheckSquare, BarChart2, Mail,
  ChevronDown, ChevronRight, Zap, Navigation, Trash2, Building2, FileText
} from 'lucide-react';

function NavItem({ to, icon, label, end = false, collapsed = false }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
      title={collapsed ? label : undefined}>
      <span className="shrink-0 opacity-80">{icon}</span>
      {!collapsed && <span>{label}</span>}
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

export default function Sidebar({ collapsed = false }) {
  const { user } = useAuth();
  const isAdmin   = user?.role === 'admin';
  const isPlanner = user?.role === 'planner' || isAdmin;
  const isViewer  = user?.role === 'viewer';

  const ni = (to, icon, label, end) =>
    <NavItem to={to} end={end} icon={icon} label={label} collapsed={collapsed}/>;

  return (
    <nav className="flex-1 overflow-y-auto py-3 space-y-3">
      {/* Dashboard always visible */}
      <div className="mb-1">
        {ni('/', <LayoutDashboard size={15}/>, 'Dashboard', true)}
      </div>

      {isPlanner && (
        <NavSection label={collapsed ? '' : 'Masters'}>
          {ni('/masters/tankers',    <Truck size={15}/>,       'Tankers')}
          {ni('/masters/vendors',    <Building2 size={15}/>,   'Vendors')}
          {ni('/masters/documents',  <FileText size={15}/>,    'Tanker Documents')}
          {ni('/masters/bmcus',      <MapPin size={15}/>,      'BMCUs')}
          {ni('/masters/routes',     <Route size={15}/>,       'Routes')}
          {ni('/masters/locations',  <Navigation size={15}/>,  'Locations')}
          {ni('/masters/distances',  <Route size={15}/>,       'Distance Master')}
          {isAdmin && (
            <>
              {ni('/masters/users',        <Users size={15}/>, 'Users')}
              {ni('/masters/email-config', <Mail size={15}/>,  'Email Config')}
              {ni('/masters/plan-emails',  <Mail size={15}/>,  'Plan Email List')}
            </>
          )}
        </NavSection>
      )}

      {isPlanner && (
        <NavSection label={collapsed ? '' : 'Planning'}>
          {ni('/planning',          <ClipboardList size={15}/>, 'Trip Plans')}
          {ni('/planning/optimize', <Zap size={15}/>,           'Route Optimizer')}
          {ni('/planning/deleted',  <Trash2 size={15}/>,        'Deleted Plans')}
        </NavSection>
      )}

      {(isPlanner || isViewer) && (
        <NavSection label={collapsed ? '' : 'Execution'}>
          {ni('/execution',        <Play size={15}/>,        'Active Trips')}
          {ni('/execution/closed', <CheckSquare size={15}/>, 'Closed Trips')}
        </NavSection>
      )}

      {(isPlanner || isViewer) && (
        <NavSection label={collapsed ? '' : 'Reports'}>
          {ni('/reports', <BarChart2 size={15}/>, 'Daily TS Report')}
          {isAdmin && ni('/reports/audit', <Users size={15}/>, 'User Activity')}
        </NavSection>
      )}

      {/* User info at bottom */}
      {!collapsed && (
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
      )}

      {/* Credit footer */}
      {!collapsed && (
        <div className="text-center px-3 pt-2 pb-1">
          <p className="text-xs leading-tight" style={{ color:'rgba(255,255,255,0.45)' }}>
            Developed &amp; maintained by
          </p>
          <p className="text-xs font-semibold" style={{ color:'rgba(255,255,255,0.7)' }}>
            Shreeja IT Team
          </p>
        </div>
      )}
    </nav>
  );
}
