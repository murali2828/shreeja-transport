// frontend/src/pages/masters/TankerDocuments.jsx
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Bell, Trash2, Send, RefreshCw, Paperclip, Download, ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  getDocuments, createDocument, updateDocument, deleteDocument, getTankers,
  getDocAlertRecipients, createDocAlertRecipient, deleteDocAlertRecipient, runDocAlerts,
  uploadDocumentFile, downloadDocumentFile, deleteDocumentFile,
} from '../../api/index';
import { Modal, Field, SaveButton, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';
import { useAuth } from '../../hooks/useAuth';

const DOC_TYPES = ['RC', 'Fitness Certificate', 'Pollution (PUC)', 'FSSAI Number',
  'Milk Insurance', 'Tanker Insurance', 'State Permit', 'National Permit', 'Agreement', 'Other'];
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
  const [file, setFile]     = useState(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter]     = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [inductionFilter, setInductionFilter] = useState('');
  const [tankerSearch, setTankerSearch] = useState('');
  const [showRecipients, setShowRecipients] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set()); // collapsed by default
  const toggleExpand = (id) => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn:  () => getDocuments().then(r => r.data),
  });
  const { data: tankers = [] } = useQuery({
    queryKey: ['tankers', 'all'],
    queryFn:  () => getTankers({ all: 'true' }).then(r => r.data),
  });

  const counts = useMemo(() => ({
    expired:   docs.filter(d => d.status === 'expired').length,
    expiring:  docs.filter(d => d.status === 'expiring').length,
    valid:     docs.filter(d => d.status === 'valid').length,
    temporary: docs.filter(d => d.induction_type === 'Temporary').length,
    permanent: docs.filter(d => d.induction_type === 'Permanent').length,
  }), [docs]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return docs.filter(d => {
      if (typeFilter && d.doc_type !== typeFilter) return false;
      if (statusFilter && d.status !== statusFilter) return false;
      if (inductionFilter && d.induction_type !== inductionFilter) return false;
      if (!q) return true;
      return d.tanker_number?.toLowerCase().includes(q) ||
             d.doc_number?.toLowerCase().includes(q) ||
             d.vendor_name?.toLowerCase().includes(q) ||
             d.vendor_code?.toLowerCase().includes(q);
    });
  }, [docs, search, typeFilter, statusFilter, inductionFilter]);

  // One group per tanker — all its documents together
  const grouped = useMemo(() => {
    const map = new Map();
    for (const d of filtered) {
      const g = map.get(d.tanker_id) || {
        tanker_id: d.tanker_id, tanker_number: d.tanker_number,
        induction_type: d.induction_type, vendor_code: d.vendor_code,
        vendor_name: d.vendor_name, docs: [],
      };
      g.docs.push(d);
      map.set(d.tanker_id, g);
    }
    return [...map.values()].sort((a, b) => String(a.tanker_number).localeCompare(String(b.tanker_number)));
  }, [filtered]);

  const openAdd  = () => { setForm(EMPTY); setFile(null); setTankerSearch(''); setModal('add'); };
  const openEdit = (d) => {
    setForm({
      tanker_id: d.tanker_id, doc_type: d.doc_type, doc_name: d.doc_name || '',
      doc_number: d.doc_number || '', issue_date: d.issue_date ? d.issue_date.slice(0,10) : '',
      expiry_date: d.expiry_date ? d.expiry_date.slice(0,10) : '', remarks: d.remarks || '',
    });
    setFile(null);
    setTankerSearch(d.tanker_number || '');
    setModal(d);
  };
  const close = () => { setFile(null); setModal(null); };
  const set   = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const isAgreement = form.doc_type === 'Agreement';

  const saveMut = useMutation({
    mutationFn: async () => {
      if (!form.tanker_id) throw new Error('Select a tanker');
      if (!form.doc_type)  throw new Error('Select a document type');
      if (form.doc_type === 'Other' && !form.doc_name) throw new Error('Enter a name for the Other document');
      const res = modal === 'add' ? await createDocument(form) : await updateDocument(modal.id, form);
      const id  = modal === 'add' ? res.data.id : modal.id;
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await uploadDocumentFile(id, fd);
      }
      return res;
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Document added' : 'Document updated');
      qc.invalidateQueries(['documents']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const removeFileMut = useMutation({
    mutationFn: (id) => deleteDocumentFile(id),
    onSuccess: () => { toast.success('Attachment removed'); qc.invalidateQueries(['documents']); },
    onError: (e) => toast.error(e.response?.data?.error || 'Failed'),
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
        <span className="px-3 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{counts.temporary} Temporary</span>
        <span className="px-3 py-1 rounded-full bg-violet-100 text-violet-700 font-medium">{counts.permanent} Permanent</span>
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
        <select className="input py-1.5 text-sm w-36" value={inductionFilter} onChange={e => setInductionFilter(e.target.value)}>
          <option value="">All tanker types</option>
          <option value="Temporary">Temporary</option>
          <option value="Permanent">Permanent</option>
        </select>
        <span className="ml-auto text-xs text-gray-400">{filtered.length} of {docs.length}</span>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-50 border-b z-10">
              <tr>
                <th className="table-th">Document</th>
                <th className="table-th">Number</th>
                <th className="table-th">Issue / Start</th>
                <th className="table-th">Expiry / End</th>
                <th className="table-th">Status</th>
                <th className="table-th">File</th>
                <th className="table-th w-16">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <LoadingState/>}
              {!isLoading && grouped.length === 0 && <EmptyState message="No documents found."/>}
              {grouped.map(g => {
                const expired  = g.docs.filter(d => d.status === 'expired').length;
                const expiring = g.docs.filter(d => d.status === 'expiring').length;
                const isOpen   = expanded.has(g.tanker_id);
                return [
                  // Tanker header row — click to expand/collapse its documents
                  <tr key={`t-${g.tanker_id}`} onClick={() => toggleExpand(g.tanker_id)}
                    className="bg-blue-50/70 border-y border-blue-100 cursor-pointer select-none hover:bg-blue-100/70">
                    <td className="table-td" colSpan={7}>
                      <div className="flex flex-wrap items-center gap-2.5 py-0.5">
                        {isOpen ? <ChevronDown size={14} className="text-[#003a6b]"/> : <ChevronRight size={14} className="text-[#003a6b]"/>}
                        <span className="font-mono font-bold text-[#003a6b]">{g.tanker_number}</span>
                        {g.induction_type && (
                          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${g.induction_type === 'Temporary' ? 'bg-blue-100 text-blue-700' : 'bg-violet-100 text-violet-700'}`}>
                            {g.induction_type}
                          </span>
                        )}
                        <span className="text-xs text-gray-600">
                          {g.vendor_code || g.vendor_name
                            ? <>{g.vendor_code && <span className="font-mono">{g.vendor_code}</span>}{g.vendor_code && g.vendor_name ? ' — ' : ''}{g.vendor_name || ''}</>
                            : 'No vendor'}
                        </span>
                        <span className="ml-auto flex items-center gap-1.5 text-[11px]">
                          <span className="px-2 py-0.5 rounded-full bg-white text-gray-600 font-medium">{g.docs.length} document{g.docs.length > 1 ? 's' : ''}</span>
                          {expired > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">{expired} expired</span>}
                          {expiring > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">{expiring} expiring</span>}
                        </span>
                      </div>
                    </td>
                  </tr>,
                  ...(isOpen ? g.docs : []).map(d => (
                    <tr key={d.id} className="hover:bg-gray-50 border-b border-gray-50">
                      <td className="table-td font-medium pl-6">
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
                        {d.has_file ? (
                          <button onClick={() => downloadDocumentFile(d.id, d.file_name)}
                            className="inline-flex items-center gap-1 text-xs text-[#0078d4] hover:underline" title={d.file_name}>
                            <Download size={12}/> View
                          </button>
                        ) : <span className="text-xs text-gray-300">—</span>}
                      </td>
                      <td className="table-td">
                        <div className="flex gap-1">
                          <button onClick={() => openEdit(d)} className="btn-secondary btn-sm p-1.5">✏</button>
                          <button onClick={() => { if (window.confirm('Remove this document?')) deleteMut.mutate(d.id); }}
                            className="btn-danger btn-sm p-1.5"><Trash2 size={12}/></button>
                        </div>
                      </td>
                    </tr>
                  )),
                ];
              })}
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
              <input className="input w-full" list="doc-tankers" disabled={modal !== 'add'}
                placeholder="Type part of tanker number…"
                value={tankerSearch}
                onChange={e => {
                  const v = e.target.value;
                  setTankerSearch(v);
                  const t = tankers.find(x => x.tanker_number.toLowerCase() === v.trim().toLowerCase());
                  set('tanker_id', t ? t.id : '');
                }}/>
              <datalist id="doc-tankers">
                {tankers.map(t => <option key={t.id} value={t.tanker_number}/>)}
              </datalist>
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
            <div className="col-span-2">
              <Field label="Document File (PDF / image)">
                <div className="flex items-center gap-2 flex-wrap">
                  <label className="btn-secondary btn-sm flex items-center gap-1.5 cursor-pointer">
                    <Paperclip size={13}/> {file ? 'Change file' : 'Choose file'}
                    <input type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.webp"
                      onChange={e => setFile(e.target.files?.[0] || null)}/>
                  </label>
                  {file && <span className="text-xs text-gray-600">{file.name}</span>}
                  {!file && modal !== 'add' && modal.has_file && (
                    <>
                      <button type="button" onClick={() => downloadDocumentFile(modal.id, modal.file_name)}
                        className="inline-flex items-center gap-1 text-xs text-[#0078d4] hover:underline">
                        <Download size={12}/> {modal.file_name}
                      </button>
                      <button type="button" onClick={() => { if (window.confirm('Remove attachment?')) removeFileMut.mutate(modal.id); }}
                        className="text-xs text-red-500 hover:underline">remove</button>
                    </>
                  )}
                  {!file && modal !== 'add' && !modal.has_file && (
                    <span className="text-xs text-gray-400">No file attached</span>
                  )}
                </div>
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
