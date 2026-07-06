// frontend/src/pages/reports/AuditLog.jsx
// User Activity report — every transaction with user + timestamp. Admin only.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, ChevronLeft, ChevronRight, Search, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { getAuditLogs, getAuditFilters, exportAuditLogs, getChangeLogs, exportChangeLogs } from '../../api/index';

const ACTION_STYLE = {
  create:       'bg-green-100 text-green-700',
  update:       'bg-blue-100 text-blue-700',
  delete:       'bg-red-100 text-red-700',
  login:        'bg-emerald-100 text-emerald-700',
  login_failed: 'bg-red-100 text-red-700',
  publish:      'bg-purple-100 text-purple-700',
  cancel:       'bg-orange-100 text-orange-700',
  upload:       'bg-cyan-100 text-cyan-700',
  acknowledge:  'bg-indigo-100 text-indigo-700',
  password:     'bg-amber-100 text-amber-700',
  other:        'bg-gray-100 text-gray-600',
};

const daysAgo = n => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

function DetailsCell({ details }) {
  const [open, setOpen] = useState(false);
  if (!details) return <span className="text-gray-300">—</span>;
  const text = typeof details === 'string' ? details : JSON.stringify(details);
  if (text.length <= 60) return <span className="font-mono text-[11px] text-gray-600">{text}</span>;
  return (
    <span className="font-mono text-[11px] text-gray-600 cursor-pointer" onClick={() => setOpen(o => !o)}
      title={open ? 'Click to collapse' : 'Click to expand'}>
      {open ? text : text.slice(0, 60) + '…'}
    </span>
  );
}

// ── Tab 2: field-level Change History (old value → new value per row) ─────────
function ChangeHistory({ filters }) {
  const [fromDate, setFromDate] = useState(daysAgo(7));
  const [toDate,   setToDate]   = useState(daysAgo(0));
  const [userId,   setUserId]   = useState('');
  const [module,   setModule]   = useState('');
  const [q,        setQ]        = useState('');
  const [page,     setPage]     = useState(1);

  const params = {
    from_date: fromDate || undefined, to_date: toDate || undefined,
    user_id: userId || undefined, module: module || undefined,
    q: q || undefined, page,
  };
  const { data, isFetching } = useQuery({
    queryKey: ['change-logs', params],
    queryFn:  () => getChangeLogs(params).then(r => r.data),
    keepPreviousData: true,
  });
  const rows  = data?.rows || [];
  const pages = data?.pages || 1;
  const setF  = setter => e => { setter(e.target.value); setPage(1); };

  return (
    <>
      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div><label className="label text-xs">From</label>
          <input type="date" className="input py-1.5 text-sm" value={fromDate} onChange={setF(setFromDate)}/></div>
        <div><label className="label text-xs">To</label>
          <input type="date" className="input py-1.5 text-sm" value={toDate} onChange={setF(setToDate)}/></div>
        <div><label className="label text-xs">User</label>
          <select className="input py-1.5 text-sm w-44" value={userId} onChange={setF(setUserId)}>
            <option value="">All users</option>
            {(filters?.users || []).map(u => <option key={u.user_id} value={u.user_id}>{u.user_name}</option>)}
          </select></div>
        <div><label className="label text-xs">Module</label>
          <select className="input py-1.5 text-sm w-40" value={module} onChange={setF(setModule)}>
            <option value="">All modules</option>
            {(filters?.modules || []).map(m => <option key={m} value={m}>{m}</option>)}
          </select></div>
        <div><label className="label text-xs">Search</label>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
            <input className="input pl-8 py-1.5 text-sm w-56" placeholder="Field, value, record…"
              value={q} onChange={setF(setQ)}/>
          </div></div>
        <button onClick={() => exportChangeLogs({ ...params, page: undefined })
            .then(() => toast.success('Report downloaded')).catch(() => toast.error('Export failed'))}
          className="btn-secondary flex items-center gap-1.5 text-sm ml-auto">
          <Download size={14}/> Export Excel
        </button>
        <span className="text-xs text-gray-400 pb-2">
          {isFetching ? <RefreshCw size={12} className="inline animate-spin"/> : `${(data?.total || 0).toLocaleString()} changes`}
        </span>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Timestamp</th>
                <th className="table-th">User</th>
                <th className="table-th">Module</th>
                <th className="table-th">Record #</th>
                <th className="table-th">Row</th>
                <th className="table-th">Field</th>
                <th className="table-th">Old Value</th>
                <th className="table-th">New Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8}><div className="empty-state">No changes in this range.</div></td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50 border-b border-gray-50 align-top">
                  <td className="table-td whitespace-nowrap text-xs text-gray-600">
                    {new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                  </td>
                  <td className="table-td font-medium whitespace-nowrap">
                    {r.user_name || '—'}
                    {r.user_login && <span className="text-xs text-gray-400 block">{r.user_login}</span>}
                  </td>
                  <td className="table-td text-gray-700 whitespace-nowrap">{r.module}</td>
                  <td className="table-td font-mono text-xs">{r.entity_id || '—'}</td>
                  <td className="table-td text-xs text-gray-600">{r.row_label}</td>
                  <td className="table-td text-xs font-medium">{r.field}</td>
                  <td className="table-td text-xs">
                    <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700">{r.old_value ?? '—'}</span>
                  </td>
                  <td className="table-td text-xs">
                    <span className="px-1.5 py-0.5 rounded bg-green-50 text-green-700">{r.new_value ?? '—'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-3 py-2 border-t text-sm">
          <span className="text-xs text-gray-500">Page {page} of {pages}</span>
          <div className="flex gap-1">
            <button className="btn-secondary btn-sm p-1.5" disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}><ChevronLeft size={14}/></button>
            <button className="btn-secondary btn-sm p-1.5" disabled={page >= pages}
              onClick={() => setPage(p => p + 1)}><ChevronRight size={14}/></button>
          </div>
        </div>
      </div>
    </>
  );
}

export default function AuditLog() {
  const [tab, setTab] = useState('changes'); // 'changes' (business) | 'requests' (IT)
  const [fromDate, setFromDate] = useState(daysAgo(7));
  const [toDate,   setToDate]   = useState(daysAgo(0));
  const [userId,   setUserId]   = useState('');
  const [module,   setModule]   = useState('');
  const [action,   setAction]   = useState('');
  const [q,        setQ]        = useState('');
  const [page,     setPage]     = useState(1);

  const params = {
    from_date: fromDate || undefined, to_date: toDate || undefined,
    user_id: userId || undefined, module: module || undefined,
    action: action || undefined, q: q || undefined, page,
  };

  const { data, isFetching } = useQuery({
    queryKey: ['audit', params],
    queryFn:  () => getAuditLogs(params).then(r => r.data),
    keepPreviousData: true,
    enabled: tab === 'requests',
  });
  const { data: filters } = useQuery({
    queryKey: ['audit-filters'],
    queryFn:  () => getAuditFilters().then(r => r.data),
  });

  const rows  = data?.rows || [];
  const pages = data?.pages || 1;
  const total = data?.total || 0;
  const setF  = setter => e => { setter(e.target.value); setPage(1); };

  const doExport = () => exportAuditLogs({ ...params, page: undefined })
    .then(() => toast.success('Report downloaded'))
    .catch(() => toast.error('Export failed'));

  const tabBtn = (key, label) => (
    <button onClick={() => setTab(key)}
      className={`px-4 py-1.5 text-sm rounded-full font-medium transition-colors
        ${tab === key ? 'bg-[#0078d4] text-white' : 'bg-white/60 text-gray-600 hover:bg-white'}`}>
      {label}
    </button>
  );

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title">User Activity</div>
          <div className="page-sub">
            {tab === 'changes'
              ? 'Change history — every field changed: old value, new value, user, timestamp'
              : 'Request log — every API transaction (IT support view)'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tabBtn('changes', 'Change History')}
          {tabBtn('requests', 'Requests (IT)')}
          {tab === 'requests' && (
            <button onClick={doExport} className="btn-primary flex items-center gap-1.5 text-sm">
              <Download size={14}/> Export Excel
            </button>
          )}
        </div>
      </div>

      {tab === 'changes' && <ChangeHistory filters={filters}/>}

      {tab === 'requests' && (<>

      {/* Filters */}
      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label text-xs">From</label>
          <input type="date" className="input py-1.5 text-sm" value={fromDate} onChange={setF(setFromDate)}/>
        </div>
        <div>
          <label className="label text-xs">To</label>
          <input type="date" className="input py-1.5 text-sm" value={toDate} onChange={setF(setToDate)}/>
        </div>
        <div>
          <label className="label text-xs">User</label>
          <select className="input py-1.5 text-sm w-44" value={userId} onChange={setF(setUserId)}>
            <option value="">All users</option>
            {(filters?.users || []).map(u => <option key={u.user_id} value={u.user_id}>{u.user_name}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">Module</label>
          <select className="input py-1.5 text-sm w-40" value={module} onChange={setF(setModule)}>
            <option value="">All modules</option>
            {(filters?.modules || []).map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">Action</label>
          <select className="input py-1.5 text-sm w-36" value={action} onChange={setF(setAction)}>
            <option value="">All actions</option>
            {(filters?.actions || []).map(a => <option key={a} value={a}>{a.replace('_',' ')}</option>)}
          </select>
        </div>
        <div className="relative">
          <label className="label text-xs">Search</label>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
            <input className="input pl-8 py-1.5 text-sm w-56" placeholder="Path, record, details…"
              value={q} onChange={setF(setQ)}/>
          </div>
        </div>
        <span className="ml-auto text-xs text-gray-400 pb-2">
          {isFetching ? <RefreshCw size={12} className="inline animate-spin"/> : `${total.toLocaleString()} events`}
        </span>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[62vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Timestamp</th>
                <th className="table-th">User</th>
                <th className="table-th">Action</th>
                <th className="table-th">Module</th>
                <th className="table-th">Record #</th>
                <th className="table-th">Details</th>
                <th className="table-th">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7}><div className="empty-state">No activity in this range.</div></td></tr>
              )}
              {rows.map(r => (
                <tr key={r.id} className="hover:bg-gray-50 border-b border-gray-50 align-top">
                  <td className="table-td whitespace-nowrap text-xs text-gray-600">
                    {new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
                  </td>
                  <td className="table-td font-medium">
                    {r.user_name || <span className="text-gray-400">{r.user_login || 'unknown'}</span>}
                  </td>
                  <td className="table-td">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ACTION_STYLE[r.action] || ACTION_STYLE.other}`}>
                      {(r.action || 'other').replace('_', ' ')}
                    </span>
                  </td>
                  <td className="table-td text-gray-700">{r.module}</td>
                  <td className="table-td font-mono text-xs">{r.entity_id || '—'}</td>
                  <td className="table-td max-w-md"><DetailsCell details={r.details}/></td>
                  <td className="table-td">
                    <span className={`text-xs font-semibold ${r.success ? 'text-green-600' : 'text-red-600'}`}>
                      {r.status_code}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* Pagination */}
        <div className="flex items-center justify-between px-3 py-2 border-t text-sm">
          <span className="text-xs text-gray-500">Page {page} of {pages}</span>
          <div className="flex gap-1">
            <button className="btn-secondary btn-sm p-1.5" disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}><ChevronLeft size={14}/></button>
            <button className="btn-secondary btn-sm p-1.5" disabled={page >= pages}
              onClick={() => setPage(p => p + 1)}><ChevronRight size={14}/></button>
          </div>
        </div>
      </div>
      </>)}
    </div>
  );
}
