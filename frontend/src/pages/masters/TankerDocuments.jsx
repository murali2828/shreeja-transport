// frontend/src/pages/masters/TankerDocuments.jsx
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Bell, Trash2, Send, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getDocuments, createDocument, updateDocument, deleteDocument, getTankers,
  getDocAlertRecipients, createDocAlertRecipient, deleteDocAlertRecipient, runDocAlerts,
} from '../../api/index';
import { Modal, Field, SaveButton, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';
import { useAuth } from '../../hooks/useAuth';

const DOC_TYPES = ['RC', 'Fitness Certificate', 'Pollution (PUC)', 'Insurance', 'Permit', 'Agreement', 'Other'];
const EMPTY = { tanker_id: '', doc_type: 'RC', doc_name: '', doc_number: '', issue_date: '', expiry_date: '', remarks: '' };

const STATUS_STYLE = {
  valid:     'bg-green-100 text-green-700',
  expiring:  'bg-amber-100 text-amber-700',
  expired:   'bg-red-100 text-red-700',
  no_expiry: 'bg-gray-100 text-gray-500',
};
const STATUS_LABEL = { valid: 'Valid', expiring: 'Expiring', expired: 'Expired', no_expiry: 'No expiry' };

function daysText(d) {
  if (d == null || d.expiry_date == null) return '—';
  const n = d.days_left != null ? parseInt(d.days_left, 10) : null;
  if (n == null) return '—';
  if (n < 0)  return `${Math.abs(n)}d ago`;
  if (n === 0) return 'today';
  return `${n}d left`;
}

export default function TankerDocuments() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [modal, setModal]   = useState(null);
  const [form, setForm]     = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showRecipients, setShowRecipients] = useState(false);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn:  () => getDocuments().then(r => r.data),
  });
  const { data: tankers = [] } = useQuery({
    queryKey: ['tankers', 'all'],
    queryFn:  () => getTankers({ all: 'true' }).then(r => r.data),
  });

  const counts = useMemo(() => ({
    expired:  docs.filter(d => d.status === 'expired').length,
    expiring: docs.filter(d => d.status === 'expiring').length,
    valid:    docs.filter(d => d.status === 'valid').length,
  }), [docs]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return docs.filter(d => {
      if (typeFilter && d.doc_type !== typeFilter) return false;
      if (statusFilter && d.status !== statusFilter) return false;
      if (!q) return true;
      return d.tanker_number?.toLowerCase().includes(q) ||
             d.doc_number?.toLowerCase().includes(q) ||
             d.vendor_name?.toLowerCase().includes(q);
    });
  }, [docs, search, typeFilter, statusFilter]);

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (d) => {
    setForm({
      tanker_id: d.tanker_id, doc_type: d.doc_type, doc_name: d.doc_name || '',
      doc_number: d.doc_number || '', issue_date: d.issue_date ? d.issue_date.slice(0,10) : '',
      expiry_date: d.expiry_date ? d.expiry_date.slice(0,10) : '', remarks: d.remarks || '',
    });
    setModal(d);
  };
  const close = () => setModal(null);
  const set   = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const isAgreement = form.doc_type === 'Agreement';

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.tanker_id) throw new Error('Select a tanker');
      if (!form.doc_type)  throw new Error('Select a document type');
      if (form.doc_type === 'Other' && !form.doc_name) throw new Error('Enter a name for the Other document');
      return modal === 'add' ? createDocument(form) : updateDocument(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Document added' : 'Document updated');
      qc.invalidateQueries(['documents']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteDocument,
    onSuccess: () => { toast.success('Document removed'); qc.invalidateQueries(['documents']); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  const runMut = useMutation({
    mutationFn: () => runDocAlerts(false),
    onSuccess: (r) => {
      const n = r.data.triggered?.length || 0;
      if (n === 0) toast.success('No new alerts due right now');
      else toast.success(`${n} alert(s) processed${r.data.emailed ? ' and emailed' : ' (no email sent — check recipients)'}`);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  return (
    <div className="space-y-4 w-full">
      <PageHeader
        title="Tanker Documents"
        subtitle="Statutory documents & validity — RC, Fitness, PUC, Insurance, Permit, Agreements"
        onAdd={openAdd}
        addLabel="Add Document"
        extra={isAdmin && (
          <>
            <button onClick={() => runMut.mutate()} disabled={runMut.isPending}
              className="btn-secondary flex items-center gap-1.5 text-sm">
              {runMut.isPending ? <RefreshCw size={14} className="animate-spin"/> : <Send size={14}/>}
              Run Alert Check
            </button>
            <button onClick={() => setShowRecipients(true)}
              className="btn-secondary flex items-center gap-1.5 text-sm">
              <Bell size={14}/> Alert Recipients
            </button>
          </>
        )}
      />

      <div className="flex gap-3 text-xs">
        <span className="px-3 py-1 rounded-full bg-red-100 text-red-700 font-medium">{counts.expired} Expired</span>
        <span className="px-3 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">{counts.expiring} Expiring (≤30d)</span>
        <span className="px-3 py-1 rounded-full bg-green-100 text-green-700 font-medium">{counts.valid} Valid</span>
      </div>

      <div className="card p-3 flex flex-wrap gap-3 items-center">
        <div className="relative w-60">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
          <input className="input pl-8 py-1.5 text-sm w-full" placeholder="Search tanker, doc no, vendor…"
            value={search} onChange={e => setSearch(e.target.value)}/>
        </div>
        <select className="input py-1.5 text-sm w-44" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input py-1.5 text-sm w-36" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="expired">Expired</option>
          <option value="expiring">Expiring</option>
          <option value="valid">Valid</option>
          <option value="no_expiry">No expiry</option>
        </select>
        <span className="ml-auto text-xs text-gray-400">{filtered.length} of {docs.length}</span>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                <th className="table-th">Tanker</th>
                <th className="table-th">Vendor</th>
                <th className="table-th">Document</th>
                <th className="table-th">Number</th>
                <th className="table-th">Issue / Start</th>
                <th className="table-th">Expiry / End</th>
                <th className="table-th">Status</th>
                <th className="table-th w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <LoadingState/>}
              {!isLoading && filtered.length === 0 && <EmptyState message="No documents found."/>}
              {filtered.map(d => (
                <tr key={d.id} className="hover:bg-gray-50 border-b border-gray-50">
                  <td className="table-td font-mono font-semibold text-[#005ba3]">{d.tanker_number}</td>
                  <td className="table-td text-gray-600 text-xs">{d.vendor_name || '—'}</td>
                  <td className="table-td font-medium">
                    {d.doc_type}{d.doc_name ? <span className="text-gray-500"> — {d.doc_name}</span> : null}
                  </td>
                  <td className="table-td font-mono text-xs text-gray-600">{d.doc_number || '—'}</td>
                  <td className="table-td text-gray-600 text-xs">{d.issue_date ? d.issue_date.slice(0,10) : '—'}</td>
                  <td className="table-td text-gray-600 text-xs">{d.expiry_date ? d.expiry_date.slice(0,10) : '—'}</td>
                  <td className="table-td">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_STYLE[d.status]}`}>
                      {STATUS_LABEL[d.status]}
                    </span>
                    <span className="ml-1.5 text-[11px] text-gray-400">{daysText(d)}</span>
                  </td>
                  <td className="table-td">
                    <div className="flex gap-1">
                      <button onClick={() => openEdit(d)} className="btn-secondary btn-sm p-1.5">✏</button>
                      <button onClick={() => { if (window.confirm('Remove this document?')) deleteMut.mutate(d.id); }}
                        className="btn-danger btn-sm p-1.5"><Trash2 size={12}/></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Document' : `Edit Document — ${modal.tanker_number}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Tanker" required>
              <select className="input w-full" value={form.tanker_id}
                disabled={modal !== 'add'}
                onChange={e => set('tanker_id', e.target.value)}>
                <option value="">— Select tanker —</option>
                {tankers.map(t => <option key={t.id} value={t.id}>{t.tanker_number}</option>)}
              </select>
            </Field>
            <Field label="Document Type" required>
              <select className="input w-full" value={form.doc_type}
                onChange={e => set('doc_type', e.target.value)}>
                {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            {form.doc_type === 'Other' && (
              <div className="col-span-2">
                <Field label="Document Name" required>
                  <input className="input w-full" placeholder="e.g. Road Tax, Green Tax"
                    value={form.doc_name} onChange={e => set('doc_name', e.target.value)}/>
                </Field>
              </div>
            )}
            <Field label={isAgreement ? 'Agreement Number' : 'Document Number'}>
              <input className="input w-full" value={form.doc_number}
                onChange={e => set('doc_number', e.target.value)}/>
            </Field>
            <div/>
            <Field label={isAgreement ? 'Agreement Start' : 'Issue Date'}>
              <input type="date" className="input w-full" value={form.issue_date}
                onChange={e => set('issue_date', e.target.value)}/>
            </Field>
            <Field label={isAgreement ? 'Agreement End' : 'Expiry Date'}>
              <input type="date" className="input w-full" value={form.expiry_date}
                onChange={e => set('expiry_date', e.target.value)}/>
            </Field>
            <div className="col-span-2">
              <Field label="Remarks">
                <textarea className="input w-full" rows={2} value={form.remarks}
                  onChange={e => set('remarks', e.target.value)}/>
              </Field>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            Expiry alerts are sent 30 / 15 / 7 / 1 days before the expiry date, and once after it expires.
          </p>
        </Modal>
      )}

      {showRecipients && <RecipientsModal onClose={() => setShowRecipients(false)}/>}
    </div>
  );
}

function RecipientsModal({ onClose }) {
  const qc = useQueryClient();
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');

  const { data: recipients = [], isLoading } = useQuery({
    queryKey: ['doc-alert-recipients'],
    queryFn:  () => getDocAlertRecipients().then(r => r.data),
  });

  const addMut = useMutation({
    mutationFn: () => {
      if (!email) throw new Error('Email required');
      return createDocAlertRecipient({ name, email });
    },
    onSuccess: () => { toast.success('Recipient added'); setName(''); setEmail(''); qc.invalidateQueries(['doc-alert-recipients']); },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const delMut = useMutation({
    mutationFn: deleteDocAlertRecipient,
    onSuccess: () => { toast.success('Recipient removed'); qc.invalidateQueries(['doc-alert-recipients']); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  return (
    <Modal title="Document Alert Recipients" onClose={onClose}
      footer={<button onClick={onClose} className="btn-secondary">Close</button>}>
      <p className="text-xs text-gray-500 mb-3">
        These stakeholders receive tanker document expiry alert emails (30 / 15 / 7 / 1 days before expiry, and on expiry).
      </p>
      <div className="flex gap-2 mb-3">
        <input className="input flex-1" placeholder="Name (optional)" value={name} onChange={e => setName(e.target.value)}/>
        <input className="input flex-1" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}/>
        <button onClick={() => addMut.mutate()} disabled={addMut.isPending} className="btn-primary">Add</button>
      </div>
      <div className="border rounded-lg divide-y max-h-64 overflow-y-auto">
        {isLoading && <div className="p-3 text-sm text-gray-400">Loading…</div>}
        {!isLoading && recipients.length === 0 && <div className="p-3 text-sm text-gray-400">No recipients yet.</div>}
        {recipients.map(r => (
          <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
            <div>
              <span className="font-medium">{r.name || '—'}</span>
              <span className="text-gray-500 ml-2">{r.email}</span>
            </div>
            <button onClick={() => delMut.mutate(r.id)} className="btn-danger btn-sm p-1.5"><Trash2 size={12}/></button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
