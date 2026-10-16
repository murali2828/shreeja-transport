// frontend/src/pages/reports/ScanStatus.jsx
// Reports → Scan Status (migration 071): per trip of the lifting-date range,
// BMCU dispatch challans scanned n / m and the acknowledgement slip ✓ / ✗, with
// a "pending only" filter and Excel; second tab lists scan change requests
// (replace / delete), decided here by the approver (CHANGE_APPROVER_ID) or an admin.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Download, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { getScanStatus, downloadScanStatusExcel, getTripScanChanges, approveTripScanChange, rejectTripScanChange } from '../../api/index';
import { fmtDate } from '../../utils/date';

const iso = d => d.toISOString().slice(0, 10);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return iso(d); };
const daysAgo = n => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); d.setDate(d.getDate() - n); return iso(d); };

export default function ScanStatus() {
  const [tab, setTab] = useState('status');
  return (
    <div className="w-full space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="page-title">Scan Status</h2>
        <div className="flex gap-1">
          {[['status', 'Trips'], ['changes', 'Scan changes']].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={tab === k ? 'btn-primary btn-sm' : 'btn-secondary btn-sm'}>{l}</button>
          ))}
        </div>
      </div>
      {tab === 'status' ? <StatusTab/> : <ChangesTab/>}
    </div>
  );
}

function StatusTab() {
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(today());
  const [pendingOnly, setPendingOnly] = useState(true);
  const params = { from, to, pending_only: pendingOnly ? 'true' : undefined };
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['scan-status', from, to, pendingOnly],
    queryFn: () => getScanStatus(params).then(r => r.data),
    enabled: !!from && !!to,
  });
  const dcPending = rows.reduce((s, r) => s + r.dc_pending, 0);
  const ackPending = rows.filter(r => r.ack_pending).length;
  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div><label className="label">Lifting date from</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)}/></div>
        <div><label className="label">To</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)}/></div>
        <label className="flex items-center gap-1.5 text-sm pb-2"><input type="checkbox" checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)}/> Pending only</label>
        <button className="btn-secondary flex items-center gap-1.5" onClick={() => downloadScanStatusExcel(params).catch(e => toast.error(e.response?.data?.error || e.message))}>
          <Download size={14}/> Excel
        </button>
        <div className="text-xs text-gray-600 pb-2 ml-auto">{rows.length} trip(s) · DC scans pending <b className="text-red-600">{dcPending}</b> · Ack slips pending <b className="text-red-600">{ackPending}</b></div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">Lifting Date</th><th className="table-th">Tanker</th><th className="table-th">Trip</th>
              <th className="table-th">Route</th><th className="table-th">Delivery Point</th><th className="table-th">Executor</th>
              <th className="table-th">Status</th><th className="table-th text-center">DC scanned</th><th className="table-th text-center">Ack slip</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? <tr><td colSpan={9} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              : !rows.length ? <tr><td colSpan={9} className="table-td text-center py-8 text-gray-400">Nothing pending in this range</td></tr>
              : rows.map(r => (
                <tr key={r.execution_id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="table-td">{fmtDate(r.plan_for_date)}</td>
                  <td className="table-td font-mono text-xs">{r.tanker_number}</td>
                  <td className="table-td"><Link className="text-[#0078d4] font-semibold" to={`/execution/${r.execution_id}`}>#{r.trip_no}</Link></td>
                  <td className="table-td text-xs">{r.route_name || '—'}</td>
                  <td className="table-td text-xs">{r.delivery_point_name || '—'}</td>
                  <td className="table-td text-xs">{r.executor_name || '—'}</td>
                  <td className="table-td text-xs">{String(r.status || '').replace('_', ' ')}</td>
                  <td className={`table-td text-center font-semibold ${r.dc_pending ? 'text-red-600' : 'text-green-700'}`}>{r.dc_done}/{r.dc_total}</td>
                  <td className={`table-td text-center font-semibold ${r.ack_pending ? 'text-red-600' : r.ack_scanned ? 'text-green-700' : 'text-gray-400'}`}>
                    {r.ack_scanned ? `✓ ${r.ack_scans}` : r.acknowledged ? '✗ pending' : 'not acked'}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChangesTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('pending');
  const { data, isLoading } = useQuery({
    queryKey: ['scan-changes', status],
    queryFn: () => getTripScanChanges({ status }).then(r => r.data),
  });
  const rows = data?.rows || [];
  const decide = async (id, approve) => {
    const remarks = window.prompt(approve ? 'Approve — note (optional):' : 'Reject — note (optional):');
    if (remarks === null) return;
    try {
      await (approve ? approveTripScanChange : rejectTripScanChange)(id, remarks);
      toast.success(approve ? 'Approved' : 'Rejected');
      qc.invalidateQueries({ queryKey: ['scan-changes'] });
      qc.invalidateQueries({ queryKey: ['trip-scans'] });
    } catch (e) { toast.error(e.response?.data?.error || e.message); }
  };
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <select className="input w-40" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option>
        </select>
        <span className="text-xs text-gray-500">Replacing or deleting an uploaded scan needs approval; open the trip to view the current and proposed files.</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th">#</th><th className="table-th">Trip</th><th className="table-th">Document</th><th className="table-th">Change</th>
              <th className="table-th">Reason</th><th className="table-th">Requested</th><th className="table-th">Status</th><th className="table-th">Action</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? <tr><td colSpan={8} className="table-td text-center py-8 text-gray-400">Loading…</td></tr>
              : !rows.length ? <tr><td colSpan={8} className="table-td text-center py-8 text-gray-400">No requests</td></tr>
              : rows.map(r => (
                <tr key={r.id} className="border-b border-gray-50">
                  <td className="table-td">{r.id}</td>
                  <td className="table-td text-xs"><Link className="text-[#0078d4]" to={`/execution/${r.execution_id}`}>#{r.trip_no}</Link> · {r.tanker_number} · {fmtDate(r.plan_for_date)}</td>
                  <td className="table-td text-xs">{r.kind === 'ack' ? 'Ack slip' : `DC ${r.bmcu_code || ''}`}</td>
                  <td className="table-td text-xs font-semibold">{r.action === 'replace' ? `Replace (${(r.proposed_scan_ids || []).length} file)` : 'Delete'}</td>
                  <td className="table-td text-xs italic">{r.reason}</td>
                  <td className="table-td text-xs">{r.requested_by_name}<div className="text-gray-400">{new Date(r.requested_at).toLocaleString('en-IN')}</div></td>
                  <td className="table-td text-xs">{r.status}{r.decided_by_name ? ` · ${r.decided_by_name}` : ''}</td>
                  <td className="table-td">
                    {r.status === 'pending' && data?.can_decide && (
                      <div className="flex gap-1">
                        <button className="btn-primary btn-sm p-1" title="Approve" onClick={() => decide(r.id, true)}><Check size={12}/></button>
                        <button className="btn-danger btn-sm p-1" title="Reject" onClick={() => decide(r.id, false)}><X size={12}/></button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
