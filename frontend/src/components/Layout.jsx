// frontend/src/components/Layout.jsx
// Shreeja Platform Theme: fixed topnav + translucent sidebar + sky-gradient content
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import { useAuth } from '../hooks/useAuth';
import { Bell, Search, User, Menu, X, ChevronLeft, ChevronRight } from 'lucide-react';

export default function Layout() {
  const { user, logoutUser } = useAuth();
  const [mobileOpen,   setMobileOpen]   = useState(false);
  const [userMenu,     setUserMenu]     = useState(false);
  const [pinned,       setPinned]       = useState(false); // when true, sidebar stays expanded and reserves width
  const [hovered,      setHovered]      = useState(false); // transient hover-to-expand
  const expanded = pinned || hovered;

  return (
    <div style={{ height:'100vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* ── Top Navigation Bar ──────────────────────────────────────── */}
      <header className="topnav">
        <button className="sm:hidden mr-1 p-1 rounded hover:bg-white/10" onClick={() => setMobileOpen(true)}>
          <Menu size={18}/>
        </button>

        {/* Shreeja wordmark */}
        <div className="flex items-center mr-4 select-none flex-1">
          <span className="font-bold text-white text-[17px] italic tracking-tight" style={{fontFamily:"'Segoe UI',sans-serif"}}>
            Shreeja
          </span>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-1 ml-auto">
          <button className="w-8 h-8 flex items-center justify-center rounded text-white/70 hover:bg-white/15 hover:text-white transition-colors">
            <Search size={14}/>
          </button>
          <button className="w-8 h-8 flex items-center justify-center rounded text-white/70 hover:bg-white/15 hover:text-white transition-colors relative">
            <Bell size={14}/>
            <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-red-400 rounded-full"/>
          </button>
          <button className="w-8 h-8 flex items-center justify-center rounded text-white/70 hover:bg-white/15 hover:text-white transition-colors">
            <User size={14}/>
          </button>
          {/* Avatar */}
          <div className="relative ml-1">
            <button onClick={() => setUserMenu(v => !v)}
              className="w-8 h-8 rounded-full bg-brand-700 border-2 border-white/40 hover:border-white/70 transition-colors flex items-center justify-center text-white text-xs font-bold">
              {user?.full_name?.[0]?.toUpperCase() || 'U'}
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-400 rounded-full border border-white"/>
            </button>
            {userMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenu(false)}/>
                <div className="absolute top-10 right-0 z-50 w-52 rounded-2xl shadow-xl overflow-hidden"
                  style={{ background:'rgba(255,255,255,0.96)', border:'1px solid rgba(0,120,212,.15)' }}>
                  <div className="px-4 py-3" style={{ borderBottom:'1px solid rgba(0,120,212,.1)' }}>
                    <div className="font-semibold text-gray-800 text-sm">{user?.full_name}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{user?.email}</div>
                    <span className={`badge badge-${user?.role} mt-1.5`}>{user?.role}</span>
                  </div>
                  <button onClick={() => { setUserMenu(false); logoutUser(); }}
                    className="w-full text-left px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors">
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden" style={{ paddingTop: '48px' }}>

        {/* Desktop sidebar — auto-collapses to icons; expands as an overlay on hover.
            Reserves only the collapsed width unless pinned, so content gets the space. */}
        <div className="hidden sm:block relative"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{ width: pinned ? 220 : 48, minWidth: pinned ? 220 : 48 }}>
          <div className="sidebar flex flex-col absolute top-0 bottom-0 left-0 overflow-hidden transition-all duration-200"
            style={{ width: expanded ? 220 : 48, zIndex: 40,
                     boxShadow: (!pinned && hovered) ? '4px 0 20px rgba(0,40,90,0.28)' : 'none' }}>
            <div style={{ overflow: 'hidden', flex: 1, display: 'flex', flexDirection: 'column' }}>
              <Sidebar collapsed={!expanded}/>
            </div>
            <button
              onClick={() => setPinned(v => !v)}
              className="flex items-center justify-center p-2 text-white/60 hover:text-white hover:bg-white/10 transition-colors"
              title={pinned ? 'Unpin (auto-hide)' : 'Pin sidebar open'}>
              {pinned ? <ChevronLeft size={16}/> : <ChevronRight size={16}/>}
            </button>
          </div>
        </div>

        {/* Mobile sidebar */}
        {mobileOpen && (
          <div className="sm:hidden fixed inset-0 z-50 flex">
            <div className="flex flex-col sidebar" style={{ width:220 }}>
              <div className="flex justify-end p-2">
                <button onClick={() => setMobileOpen(false)} className="text-white/70 hover:text-white p-1"><X size={17}/></button>
              </div>
              <Sidebar/>
            </div>
            <div className="flex-1 bg-black/40" onClick={() => setMobileOpen(false)}/>
          </div>
        )}

        {/* Content */}
        <main className="main-content">
          <div className="max-w-screen-2xl mx-auto">
            <Outlet/>
          </div>
        </main>
      </div>
    </div>
  );
}
