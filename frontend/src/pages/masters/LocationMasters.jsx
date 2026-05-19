import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getStartingPoints, createStartingPoint, updateStartingPoint, deleteStartingPoint,
  getTestingPoints, createTestingPoint, updateTestingPoint, deleteTestingPoint,
  getDeliveryPoints, createDeliveryPoint, updateDeliveryPoint, deleteDeliveryPoint,
} from '../../api';
import toast from 'react-hot-toast';
import { Plus, Pencil, Trash2, X, Check } from 'lucide-react';

function SimpleModal({ title, fields, data, onClose, onSave }) {
  const [form, setForm] = useState(data || {});
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold">{data?.id ? `Edit ${title}` : `Add ${title}`}</h3>
          <button onClick={onClose}><X size={18} className="text-gray-500" /></button>
        </div>
        <div className="p-5 space-y-3">
          {fields.map(f => (
            <div key={f.key}>
              <label className="label">{f.label} {f.required && '*'}</label>
              <input className="input" value={form[f.key] || ''} placeholder={f.placeholder || ''} onChange={e => set(f.key, e.target.value)} />
            </div>
          ))}
          {data?.id && (
            <div className="flex items-center gap-2">
              <input type="checkbox" id="act" checked={form.is_active !== false} onChange={e => set('is_active', e.target.checked)} />
              <label htmlFor="act" className="text-sm">Active</label>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => onSave(form)} className="btn-primary"><Check size={14} /> Save</button>
        </div>
      </div>
    </div>
  );
}

function LocationTable({ title, description, queryKey, fetchFn, createFn, updateFn, deleteFn, fields }) {
  const qc = useQueryClient();
  const [modal, setModal] = useState(null);
  const { data: items = [] } = useQuery({ queryKey: [queryKey], queryFn: () => fetchFn().then(r => r.data) });
  const saveMut = useMutation({
    mutationFn: (form) => modal?.id ? updateFn(modal.id, form) : createFn(form),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries([queryKey]); setModal(null); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed')
  });
  const delMut = useMutation({
    mutationFn: deleteFn,
    onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries([queryKey]); }
  });

  return (
    <div className="card">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-gray-800">{title}</h3>
          <p className="text-xs text-gray-500">{description}</p>
        </div>
        <button onClick={() => setModal({})} className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            {fields.map(f => <th key={f.key} className="table-th">{f.label}</th>)}
            <th className="table-th">Status</th>
            <th className="table-th">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr><td colSpan={fields.length + 2} className="table-td text-center text-gray-400 py-4">No records</td></tr>
          ) : items.map(item => (
            <tr key={item.id} className="hover:bg-gray-50">
              {fields.map(f => <td key={f.key} className="table-td">{item[f.key] || '—'}</td>)}
              <td className="table-td"><span className={item.is_active !== false ? 'badge-green' : 'badge-red'}>{item.is_active !== false ? 'Active' : 'Inactive'}</span></td>
              <td className="table-td">
                <div className="flex gap-1">
                  <button onClick={() => setModal(item)} className="btn-secondary btn-sm"><Pencil size={12} /></button>
                  <button onClick={() => { if (confirm('Delete?')) delMut.mutate(item.id); }} className="btn-danger btn-sm"><Trash2 size={12} /></button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {modal !== null && (
        <SimpleModal title={title} fields={fields} data={modal?.id ? modal : null}
          onClose={() => setModal(null)} onSave={saveMut.mutate} />
      )}
    </div>
  );
}

export default function LocationMasters() {
  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold">Location Masters</h2>
        <p className="text-xs text-gray-500">Manage starting points, testing points and delivery points</p>
      </div>

      <LocationTable title="Starting Points" description="Where tankers originate from (processing plants, dairies)"
        queryKey="starting-points" fetchFn={getStartingPoints} createFn={createStartingPoint}
        updateFn={updateStartingPoint} deleteFn={deleteStartingPoint}
        fields={[{ key: 'name', label: 'Name', required: true }, { key: 'location', label: 'Location' }, { key: 'description', label: 'Description' }]} />

      <LocationTable title="Testing Points" description="Quality testing checkpoints before delivery"
        queryKey="testing-points" fetchFn={getTestingPoints} createFn={createTestingPoint}
        updateFn={updateTestingPoint} deleteFn={deleteTestingPoint}
        fields={[{ key: 'name', label: 'Name', required: true }, { key: 'location', label: 'Location' }]} />

      <LocationTable title="Delivery Points (Processing Plants)" description="Plants where milk is delivered and acknowledged"
        queryKey="delivery-points" fetchFn={getDeliveryPoints} createFn={createDeliveryPoint}
        updateFn={updateDeliveryPoint} deleteFn={deleteDeliveryPoint}
        fields={[{ key: 'name', label: 'Plant Name', required: true }, { key: 'receiver_name', label: 'Receiver' }, { key: 'location', label: 'Location' }]} />
    </div>
  );
}
