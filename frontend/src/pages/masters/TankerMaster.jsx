// frontend/src/pages/masters/TankerMaster.jsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import toast from 'react-hot-toast';
import { getTankers, createTanker, updateTanker, deleteTanker, getVendors } from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

const EMPTY = { tanker_number: '', compartments: '', capacity_litres: '', per_km_rate: '', vendor_id: '', vendor_code: '', vendor_name: '', rate_per_km_bmcu: '', rate_per_km_p2p: '', induction_type: '', validity_start: '', validity_end: '', is_active: true };

function SortIcon({ col, sortCol, sortDir }) {
  if (sortCol !== col) return <span className="text-gray-300 ml-0.5">⇅</span>;
  return <span className="ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>;
}

export default function TankerMaster() {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState(EMPTY);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [sortCol, setSortCol] = useState('tanker_number');
  const [sortDir, setSortDir] = useState('asc');

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('asc'); }
  };

  const { data: tankers = [], isLoading } = useQuery({
    queryKey: ['tankers', 'all'],
    queryFn:  () => getTankers({ all: 'true' }).then(r => r.data),
  });
  const { data: vendors = [] } = useQuery({
    queryKey: ['vendors'],
    queryFn:  () => getVendors().then(r => r.data),
  });

  const openAdd  = () => { setForm(EMPTY); setModal('add'); };
  const openEdit = (row) => {
    setForm({ ...row,
      validity_start: row.validity_start ? String(row.validity_start).slice(0, 10) : '',
      validity_end:   row.validity_end   ? String(row.validity_end).slice(0, 10)   : '',
      induction_type: row.induction_type || '' });
    setModal(row);
  };
  const close    = () => setModal(null);
  const set      = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      if (!form.tanker_number || !form.capacity_litres)
        throw new Error('Tanker number and capacity required');
      if (form.induction_type && (!form.validity_start || !form.validity_end))
        throw new Error(`Validity start and end dates are required for a ${form.induction_type} tanker`);
      return modal === 'add'
        ? createTanker(form)
        : updateTanker(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? 'Tanker added' : 'Tanker updated');
      qc.invalidateQueries(['tankers']);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteTanker,
    onSuccess: () => { toast.success('Tanker deactivated'); qc.invalidateQueries(['tankers']); },
    onError:   (e) => toast.error(e.response?.data?.error || 'Delete failed'),
  });

  const activeCount   = tankers.filter(t => t.is_active).length;
  const inactiveCount = tankers.filter(t => !t.is_active).length;
  // Capacity-wise availability of ACTIVE tankers, largest first
  const capacityCounts = Object.entries(
    tankers.filter(t => t.is_active).reduce((acc, t) => {
      const cap = parseInt(t.capacity_litres, 10) || 0;
      acc[cap] = (acc[cap] || 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[0] - a[0]);

  const filtered = tankers.filter(t => {
    if (statusFilter === 'active' && !t.is_active) return false;
    if (statusFilter === 'inactive' && t.is_active) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return t.tanker_number?.toLowerCase().includes(q) || t.vendor_name?.toLowerCase().includes(q);
  }).sort((a, b) => {
    let av = a[sortCol], bv = b[sortCol];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av == null) av = '';
    if (bv == null) bv = '';
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  return (
    <div className="space-y-4 w-full">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tanker Master</h2>
          <p className="text-xs" style={{ color: 'rgba(255,255,255,0.75)' }}>Manage tankers, capacities and per-km rates</p>
          <div className="flex gap-2 mt-1">
            <span className="px-2.5 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-medium">{activeCount} Active</span>
            <span className="px-2.5 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs font-medium">{inactiveCount} Inactive</span>
            {(search || statusFilter !== 'active') && (
              <span className="px-2.5 py-0.5 rounded-full bg-blue-50 text-blue-600 text-xs font-medium">{filtered.length} shown</span>
            )}
          </div>
          {/* Capacity-wise availability of active tankers */}
          <div className="flex gap-1.5 mt-1.5 flex-wrap">
            {capacityCounts.map(([cap, n]) => (
              <span key={cap} className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[11px] font-medium">
                {parseInt(cap, 10).toLocaleString('en-IN')} L × {n}
              </span>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="input py-1.5 text-sm w-28"
            value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="all">All</option>
          </select>
          <input
            type="text" placeholder="Search tanker no or transporter…"
            className="input py-1.5 text-sm w-56"
            value={search} onChange={e => setSearch(e.target.value)}/>
          <button onClick={openAdd} className="btn-primary flex items-center gap-1.5 whitespace-nowrap">
            <Truck size={14}/> Add Tanker
          </button>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="table-th w-8 text-center">#</th>
              <th className="table-th cursor-pointer select-none" onClick={() => toggleSort('tanker_number')}>
                Tanker No <SortIcon col="tanker_number" sortCol={sortCol} sortDir={sortDir}/>
              </th>
              <th className="table-th cursor-pointer select-none" onClick={() => toggleSort('vendor_name')}>
                Vendor <SortIcon col="vendor_name" sortCol={sortCol} sortDir={sortDir}/>
              </th>
              <th className="table-th text-center">Compartments</th>
              <th className="table-th text-right cursor-pointer select-none" onClick={() => toggleSort('capacity_litres')}>
                Capacity (L) <SortIcon col="capacity_litres" sortCol={sortCol} sortDir={sortDir}/>
              </th>
              <th className="table-th text-right cursor-pointer select-none" onClick={() => toggleSort('rate_per_km_bmcu')}>
                ₹/km BMCU <SortIcon col="rate_per_km_bmcu" sortCol={sortCol} sortDir={sortDir}/>
              </th>
              <th className="table-th text-right cursor-pointer select-none" onClick={() => toggleSort('rate_per_km_p2p')}>
                ₹/km P2P <SortIcon col="rate_per_km_p2p" sortCol={sortCol} sortDir={sortDir}/>
              </th>
              <th className="table-th">Status</th>
              <th className="table-th w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && filtered.length === 0 && <EmptyState message={search ? 'No tankers match your search.' : "No tankers yet. Click 'Add Tanker' to create one."}/>}
            {filtered.map((t, idx) => (
              <tr key={t.id} className={`hover:bg-gray-50 border-b border-gray-50 ${!t.is_active ? 'opacity-60' : ''}`}>
                <td className="table-td text-center text-xs text-gray-400">{idx + 1}</td>
                <td className="table-td font-mono font-semibold text-[#005ba3]">{t.tanker_number}</td>
                <td className="table-td text-xs">
                  {t.vendor_name ? <span title={t.vendor_code}>{t.vendor_name}</span> : <span className="text-gray-400">—</span>}
                </td>
                <td className="table-td text-center">
                  <span className="inline-block bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded">
                    {t.compartments || '—'}
                  </span>
                </td>
                <td className="table-td text-right font-medium">{parseInt(t.capacity_litres).toLocaleString()}</td>
                <td className="table-td text-right">{t.rate_per_km_bmcu ? `₹${parseFloat(t.rate_per_km_bmcu).toFixed(2)}` : '—'}</td>
                <td className="table-td text-right">{t.rate_per_km_p2p ? `₹${parseFloat(t.rate_per_km_p2p).toFixed(2)}` : '—'}</td>
                <td className="table-td"><ActiveBadge active={t.is_active}/></td>
                <td className="table-td">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(t)} className="btn-secondary btn-sm p-1.5" title="Edit">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Deactivate ${t.tanker_number}?`)) deleteMut.mutate(t.id); }}
                      className="btn-danger btn-sm p-1.5" title="Deactivate">
                      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? 'Add Tanker' : `Edit — ${modal.tanker_number}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'}
                onClick={() => saveMut.mutate()}/>
            </>
          }>
          <form onSubmit={e => { e.preventDefault(); saveMut.mutate(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tanker Number" required>
                <input className="input w-full" placeholder="e.g. TN01AB1234"
                  value={form.tanker_number} onChange={e => set('tanker_number', e.target.value.toUpperCase())}/>
              </Field>
              <Field label="Compartments">
                <input className="input w-full" placeholder="e.g. 2C, 3C"
                  value={form.compartments} onChange={e => set('compartments', e.target.value)}/>
              </Field>
              <Field label="Capacity (Litres)" required>
                <input type="number" min="1" className="input w-full" placeholder="e.g. 18000"
                  value={form.capacity_litres} onChange={e => set('capacity_litres', e.target.value)}/>
              </Field>
              <Field label="Rate per KM (₹)">
                <input type="number" min="0" step="0.01" className="input w-full" placeholder="e.g. 45.00"
                  value={form.per_km_rate} onChange={e => set('per_km_rate', e.target.value)}/>
              </Field>
              <Field label="Vendor (Master)">
                <select className="input w-full" value={form.vendor_id || ''}
                  onChange={e => {
                    const vid = e.target.value;
                    const v = vendors.find(x => String(x.id) === String(vid));
                    setForm(p => ({ ...p, vendor_id: vid,
                      vendor_code: v ? v.vendor_code : p.vendor_code,
                      vendor_name: v ? v.vendor_name : p.vendor_name }));
                  }}>
                  <option value="">— Select vendor —</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.vendor_code} — {v.vendor_name}</option>)}
                </select>
              </Field>
              <Field label="Vendor Name (free text)">
                <input className="input w-full" placeholder="Used if no vendor master selected"
                  value={form.vendor_name} onChange={e => set('vendor_name', e.target.value)}/>
              </Field>
              <Field label="Rate/KM BMCU (₹)">
                <input type="number" min="0" step="0.01" className="input w-full" placeholder="e.g. 42.00"
                  value={form.rate_per_km_bmcu} onChange={e => set('rate_per_km_bmcu', e.target.value)}/>
              </Field>
              <Field label="Rate/KM P2P (₹)">
                <input type="number" min="0" step="0.01" className="input w-full" placeholder="e.g. 38.00"
                  value={form.rate_per_km_p2p} onChange={e => set('rate_per_km_p2p', e.target.value)}/>
              </Field>
              <Field label="Induction Type">
                <select className="input w-full" value={form.induction_type || ''}
                  onChange={e => set('induction_type', e.target.value)}>
                  <option value="">— select —</option>
                  <option value="Temporary">Temporary</option>
                  <option value="Permanent">Permanent</option>
                </select>
              </Field>
              <div/>
              {form.induction_type && (
                <>
                  <Field label="Validity Start Date" required>
                    <input type="date" className="input w-full" value={form.validity_start}
                      onChange={e => set('validity_start', e.target.value)}/>
                  </Field>
                  <Field label="Validity End Date" required>
                    <input type="date" className="input w-full" value={form.validity_end}
                      onChange={e => set('validity_end', e.target.value)}/>
                  </Field>
                </>
              )}
            </div>
            {modal !== 'add' && (
              <Field label="Status">
                <select className="input w-full" value={form.is_active}
                  onChange={e => set('is_active', e.target.value === 'true')}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </Field>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
