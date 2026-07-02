// frontend/src/pages/masters/LocationMasters.jsx
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  getStartingPoints, createStartingPoint, updateStartingPoint, deleteStartingPoint,
  getTestingPoints,  createTestingPoint,  updateTestingPoint,  deleteTestingPoint,
  getDeliveryPoints, createDeliveryPoint, updateDeliveryPoint, deleteDeliveryPoint,
} from '../../api/index';
import { Modal, Field, SaveButton, ActiveBadge, EmptyState, LoadingState, PageHeader } from '../../components/MasterTable';

// ─── Generic location CRUD section ───────────────────────────────────────────
function LocationSection({ title, items, isLoading, columns, formFields, createFn, updateFn, deleteFn, queryKey }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const [form, setForm]   = useState({});

  const openAdd  = () => { setForm(formFields.reduce((a,f) => ({ ...a, [f.key]: '' }), { is_active: true })); setModal('add'); };
  const openEdit = (row) => { setForm({ ...row }); setModal(row); };
  const close    = () => setModal(null);
  const set      = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const saveMut = useMutation({
    mutationFn: () => {
      const required = formFields.filter(f => f.required);
      for (const f of required) { if (!form[f.key]) throw new Error(`${f.label} is required`); }
      return modal === 'add' ? createFn(form) : updateFn(modal.id, form);
    },
    onSuccess: () => {
      toast.success(modal === 'add' ? `${title} added` : `${title} updated`);
      qc.invalidateQueries([queryKey]);
      close();
    },
    onError: (e) => toast.error(e.response?.data?.error || e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteFn,
    onSuccess: () => { toast.success(`${title} deactivated`); qc.invalidateQueries([queryKey]); },
    onError:   (e) => toast.error(e.response?.data?.error || 'Failed'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">{title}s</h3>
        <button onClick={openAdd} className="btn-primary text-xs flex items-center gap-1 py-1.5 px-3">
          + Add {title}
        </button>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              {columns.map(c => <th key={c.key} className="table-th">{c.label}</th>)}
              <th className="table-th">Status</th>
              <th className="table-th w-20">Actions</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <LoadingState/>}
            {!isLoading && items.length === 0 && <EmptyState message={`No ${title.toLowerCase()}s yet.`}/>}
            {items.map(row => (
              <tr key={row.id} className="hover:bg-gray-50 border-b border-gray-50">
                {columns.map(c => (
                  <td key={c.key} className={`table-td ${c.bold ? 'font-semibold' : ''} ${c.small ? 'text-xs text-gray-600' : ''}`}>
                    {row[c.key] || '—'}
                  </td>
                ))}
                <td className="table-td"><ActiveBadge active={row.is_active}/></td>
                <td className="table-td">
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(row)} className="btn-secondary btn-sm p-1.5">✏</button>
                    <button onClick={() => { if (window.confirm(`Deactivate "${row.name}"?`)) deleteMut.mutate(row.id); }}
                      className="btn-danger btn-sm p-1.5">🗑</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <Modal
          title={modal === 'add' ? `Add ${title}` : `Edit — ${modal.name}`}
          onClose={close}
          footer={
            <>
              <button onClick={close} className="btn-secondary">Cancel</button>
              <SaveButton pending={saveMut.isPending} isEdit={modal !== 'add'} onClick={() => saveMut.mutate()}/>
            </>
          }>
          <div className="space-y-3">
            {formFields.map(f => (
              <Field key={f.key} label={f.label} required={f.required}>
                {f.type === 'textarea' ? (
                  <textarea className="input w-full" rows={2} value={form[f.key]||''}
                    onChange={e => set(f.key, e.target.value)} placeholder={f.placeholder}/>
                ) : (
                  <input className="input w-full" type={f.type||'text'} placeholder={f.placeholder}
                    value={form[f.key]||''} onChange={e => set(f.key, e.target.value)}/>
                )}
              </Field>
            ))}
            {modal !== 'add' && (
              <Field label="Status">
                <select className="input w-full" value={form.is_active}
                  onChange={e => set('is_active', e.target.value === 'true')}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function LocationMasters() {
  const { data: startPts = [], isLoading: l1 } = useQuery({ queryKey: ['start-pts'], queryFn: () => getStartingPoints().then(r=>r.data) });
  const { data: testPts  = [], isLoading: l2 } = useQuery({ queryKey: ['test-pts'],  queryFn: () => getTestingPoints().then(r=>r.data) });
  const { data: delivPts = [], isLoading: l3 } = useQuery({ queryKey: ['deliv-pts'], queryFn: () => getDeliveryPoints().then(r=>r.data) });

  return (
    <div className="space-y-8 w-full">
      <div>
        <h2 className="page-title">Location Masters</h2>
        <p className="page-sub">Starting depots, testing labs, and delivery plants</p>
      </div>

      <LocationSection
        title="Starting Point"
        queryKey="start-pts"
        items={startPts}
        isLoading={l1}
        createFn={createStartingPoint} updateFn={updateStartingPoint} deleteFn={deleteStartingPoint}
        columns={[
          { key: 'name', label: 'Name', bold: true },
          { key: 'location', label: 'Location', small: true },
          { key: 'description', label: 'Description', small: true },
        ]}
        formFields={[
          { key: 'name',        label: 'Name',        required: true,  placeholder: 'e.g. Balaji Dairy Depot' },
          { key: 'location',    label: 'Location',    placeholder: 'Town, District' },
          { key: 'latitude',    label: 'Latitude',    type: 'number',  placeholder: 'e.g. 13.2172' },
          { key: 'longitude',   label: 'Longitude',   type: 'number',  placeholder: 'e.g. 79.1003' },
          { key: 'description', label: 'Description', type: 'textarea', placeholder: 'Optional notes' },
        ]}
      />

      <LocationSection
        title="Testing Point"
        queryKey="test-pts"
        items={testPts}
        isLoading={l2}
        createFn={createTestingPoint} updateFn={updateTestingPoint} deleteFn={deleteTestingPoint}
        columns={[
          { key: 'name',     label: 'Name',     bold: true },
          { key: 'location', label: 'Location', small: true },
        ]}
        formFields={[
          { key: 'name',     label: 'Name',     required: true, placeholder: 'e.g. Balaji Lab' },
          { key: 'location', label: 'Location', placeholder: 'Town, District' },
          { key: 'latitude',  label: 'Latitude',  type: 'number', placeholder: 'e.g. 13.2172' },
          { key: 'longitude', label: 'Longitude', type: 'number', placeholder: 'e.g. 79.1003' },
        ]}
      />

      <LocationSection
        title="Delivery Point"
        queryKey="deliv-pts"
        items={delivPts}
        isLoading={l3}
        createFn={createDeliveryPoint} updateFn={updateDeliveryPoint} deleteFn={deleteDeliveryPoint}
        columns={[
          { key: 'name',          label: 'Plant Name',   bold: true },
          { key: 'receiver_name', label: 'Receiver',     small: true },
          { key: 'location',      label: 'Location',     small: true },
        ]}
        formFields={[
          { key: 'name',          label: 'Plant Name',   required: true, placeholder: 'e.g. Balaji Plant' },
          { key: 'receiver_name', label: 'Receiver Name', placeholder: 'e.g. MDFVPL' },
          { key: 'location',      label: 'Location',     placeholder: 'Town, District' },
          { key: 'latitude',      label: 'Latitude',     type: 'number', placeholder: 'e.g. 13.2172' },
          { key: 'longitude',     label: 'Longitude',    type: 'number', placeholder: 'e.g. 79.1003' },
        ]}
      />
    </div>
  );
}
