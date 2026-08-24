// frontend/src/pages/execution/Approvals.jsx
// Change requests on closed trips: approver (PP01) / admin can approve or reject;
// requesters can track the status of their own requests.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Check, X, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { getChangeRequests, getChangeRequest, decideChangeRequest } from '../../api/index';
import { fmtDate } from '../../utils/date';

const STATUS_STYLE = {
  pending:  'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-700',
};

// Field-level diff between snapshot and proposed changes (mirrors the email logic).
function buildDiff(snapshot, changes) {
  const sections = [];
  const sec = (title, oldRows, newRows, keyFn, labelFn, fields) => {
    const oldBy = new Map((oldRows || []).map(r => [keyFn(r), r]));
    const newBy = new Map((newRows || []).map(r => [keyFn(r), r]));
    const rows = [];
    for (const k of new Set([...oldBy.keys(), ...newBy.keys()])) {
      const o = oldBy.get(k), n = newBy.get(k);
      for (const f of fields) {
        const ov = o?.[f.key], nv = n?.[f.key];
        const oNum = parseFloat(ov), nNum = parseFloat(nv);
        const same = (ov ?? '') === (nv ?? '') ||
          (Number.isFinite(oNum) && Number.isFinite(nNum) && oNum === nNum);
        if (!same) rows.push({ row: labelFn(o || n), field: f.label, oldVal: ov, newVal: nv });
      }
    }
    if (rows.length) sections.push({ title, rows });
  };

  if ((parseFloat(snapshot?.actual_km) || 0) !== (parseFloat(changes?.actual_km) || 0)) {
    sections.push({ title: 'Trip', rows: [{ row: 'Trip', field: 'Actual KM', oldVal: snapshot?.actual_km, newVal: changes?.actual_km }] });
  }
  sec('BMCU Data Entry', snapshot?.bmcus, changes?.bmcus,
    r => `${r.seq_no}`, r => `#${r?.seq_no} ${r?.bmcu_code || r?.bmcu_id || ''}`,
    [{ key: 'milk_date', label: 'Date' }, { key: 'shift', label: 'Shift' },
     { key: 'qty_litres', label: 'Qty L' }, { key: 'fat_pct', label: 'Fat%' },
     { key: 'snf_pct', label: 'SNF%' }, { key: 'chamber', label: 'Chamber' },
     { key: 'description', label: 'Description' }]);
  sec('Shift Rows', snapshot?.shift_rows, changes?.shift_rows,
    r => `${r.bmcu_seq_no}|${r.milk_date || ''}|${r.shift || ''}`, r => `BMCU #${r?.bmcu_seq_no} ${r?.shift || ''}`,
    [{ key: 'rmrd_qty', label: 'RMRD Qty' }, { key: 'rmrd_fat_pct', label: 'RMRD Fat%' },
     { key: 'rmrd_snf_pct', label: 'RMRD SNF%' }]);
  sec('Balance / MPP / Shifting', snapshot?.entries, changes?.entries,
    r => `${r.bmcu_seq_no}|${r.kind}|${r.category || ''}`, r => `BMCU #${r?.bmcu_seq_no} ${r?.kind || ''}`,
    [{ key: 'category', label: 'Category' }, { key: 'qty_litres', label: 'Qty L' },
     { key: 'fat_pct', label: 'Fat%' }, { key: 'snf_pct', label: 'SNF%' },
     { key: 'remarks', label: 'Remarks' }]);
  sec('Acknowledgement', snapshot?.acknowledgements, changes?.acknowledgements,
    r => r.chamber, r => `Chamber ${r?.chamber}`,
    [{ key: 'qty_litres', label: 'Qty Litres' }, { key: 'fat_pct', label: 'Fat%' },
     { key: 'snf_pct', label: 'SNF%' }, { key: 'temperature', label: 'Temp' },
     { key: 'description', label: 'Description' }]);
  return sections;
}

function RequestCard({ cr, isApprover, onDecided }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const qc = useQueryClient();

  const { data: detail } = useQuery({
    queryKey: ['change-request', cr.id],
    queryFn:  () => getChangeRequest(cr.id).then(r => r.data),
    enabled:  open,
  });

  const decideMut = useMutation({
    mutationFn: (decision) => decideChangeRequest(cr.id, decision, note),
    onSuccess: (_r, decision) => {
      toast.success(`Request #${cr.id} ${decision}d`);
      qc.invalidateQueries(['change-requests']);
      qc.invalidateQueries(['change-request', cr.id]);
      onDecided();
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  const diff = detail ? buildDiff(detail.snapshot, detail.changes) : [];

  return (
    <div className="card p-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2 cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span className="font-semibold text-gray-800">#{cr.id}</span>
        <span className="text-sm text-gray-700">
          Trip #{cr.trip_no} — {cr.tanker_number} · {fmtDate(cr.execution_date)}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[cr.status]}`}>{cr.status}</span>
        <span className="text-xs text-gray-500 ml-auto">
          by {cr.requested_by_name} · {new Date(cr.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
        </span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`}/>
      </div>
      <div className="text-xs text-gray-600">Reason: <i>{cr.reason || '—'}</i></div>
      {cr.status !== 'pending' && (
        <div className="text-xs text-gray-500">
          {cr.status === 'approved' ? 'Approved' : 'Rejected'} by {cr.decided_by_name}
          {cr.decided_at && ` · ${new Date(cr.decided_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`}
          {cr.decision_note && ` · "${cr.decision_note}"`}
        </div>
      )}

      {open && (
        <div className="border-t pt-3 space-y-3">
          {!detail && <div className="text-xs text-gray-400">Loading changes…</div>}
          {detail && diff.length === 0 && (
            <div className="text-xs text-gray-400">No field-level differences detected.</div>
          )}
          {diff.map(section => (
            <div key={section.title}>
              <div className="text-xs font-semibold text-gray-700 mb-1">{section.title}</div>
              <table className="w-full text-xs border">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="table-th">Row</th><th className="table-th">Field</th>
                    <th className="table-th">Current</th><th className="table-th">Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((r, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="table-td">{r.row}</td>
                      <td className="table-td">{r.field}</td>
                      <td className="table-td text-gray-500">{r.oldVal ?? '—'}</td>
                      <td className="table-td font-semibold" style={{ background: '#fef3c7' }}>{r.newVal ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {cr.status === 'pending' && isApprover && (
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
              <input className="input py-1.5 text-sm flex-1 min-w-48" placeholder="Decision note (optional)"
                value={note} onChange={e => setNote(e.target.value)}/>
              <button onClick={() => decideMut.mutate('approve')} disabled={decideMut.isPending}
                className="btn-primary flex items-center gap-1.5 text-sm" style={{ background: '#16a34a' }}>
                <Check size={14}/> Approve
              </button>
              <button onClick={() => decideMut.mutate('reject')} disabled={decideMut.isPending}
                className="btn-danger flex items-center gap-1.5 text-sm">
                <X size={14}/> Reject
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Approvals() {
  const [statusFilter, setStatusFilter] = useState('');
  const { data, isFetching, refetch } = useQuery({
    queryKey: ['change-requests', 'list', statusFilter],
    queryFn:  () => getChangeRequests(statusFilter ? { status: statusFilter } : {}).then(r => r.data),
  });
  const rows = data?.rows || [];

  return (
    <div className="space-y-4 w-full">
      <div className="page-header">
        <div>
          <div className="page-title">Approvals</div>
          <div className="page-sub">
            Change requests on closed trips — approver: {data?.approver_name || 'PP01'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select className="input py-1.5 text-sm w-36" value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          {isFetching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
        </div>
      </div>

      {rows.length === 0 && (
        <div className="card p-8 text-center text-gray-400 text-sm">No change requests.</div>
      )}
      {rows.map(cr => (
        <RequestCard key={cr.id} cr={cr} isApprover={data?.is_approver} onDecided={refetch}/>
      ))}
    </div>
  );
}
