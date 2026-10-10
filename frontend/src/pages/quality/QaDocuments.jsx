// frontend/src/pages/quality/QaDocuments.jsx
// Quality team: Milk Dispatch Voucher (delivery challan) + Certificate of
// Analysis per tanker × lifting date (migration 064). The server pre-fills
// from QA dispatch entries, the plan and the masters; every field stays
// editable, dropdowns wherever the value comes from a known list.
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, Printer } from 'lucide-react';
import toast from 'react-hot-toast';
import SearchableSelect from '../../components/SearchableSelect';
import { getQaDocTankers, getQaDocs, saveQaDocs, markQaDocPrinted } from '../../api/index';
import { printQaDispatch, printQaCoa, QA_COA_TESTS } from '../../utils/printDocs';
import { useAuth } from '../../hooks/useAuth';
import { canEdit } from '../../utils/roles';

const pad = v => String(v).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const MILK_TYPES = ['Cow', 'Buffalo', 'Mixed'];
const TAX_RATES = ['-', '0%', '2.5%', '5%', '6%', '9%', '12%', '18%'];
const STATES = [['ANDHRA PRADESH', '37'], ['TELANGANA', '36'], ['TAMIL NADU', '33'], ['KARNATAKA', '29'], ['Delhi', '07'], ['MAHARASHTRA', '27'], ['GUJARAT', '24']];
const DESCRIPTIONS = ['RAW COW MILK', 'RAW BUFFALO MILK', 'RAW MIXED MILK', 'CHILLED RAW COW MILK', 'CHILLED RAW BUFFALO MILK'];
// Observation choices per COA test; free text still allowed via "Other…".
const OBS = {
  seal: ['Ok', 'Not Ok'], cleanliness: ['Ok', 'Not Ok'], foreign_matter: ['Absent', 'Present'], taste: ['Normal', 'Abnormal'],
  temperature: ['2°C', '3°C', '4°C', '5°C', '6°C'],
  appearance: ['Cream to slight yellowish colour, odour typical of fresh cow milk', 'White to cream colour, odour typical of fresh milk'],
  acidity: ['0.120 %', '0.125 %', '0.130 %', '0.135 %', '0.140 %', '0.145 %', '0.150 %'],
  mbrt: ['> 30 Minutes', '60 Minutes', '90 Minutes', '120 Minutes', '180 Minutes', '240 Minutes'],
  br_reading: ['40', '40.5', '41', '41.5', '42', '42.5', '43'],
};
const NEG = ['Negative', 'Positive'];

const Field = ({ label, children, className = '' }) => (
  <label className={`block ${className}`}><span className="text-xs text-gray-600">{label}</span>{children}</label>
);

// Dropdown with an "Other…" escape to free text, so a pre-filled value never gets lost.
function Pick({ value, options, onChange, disabled }) {
  const opts = options.includes(value) || !value ? options : [value, ...options];
  const [other, setOther] = useState(false);
  if (other) return <input autoFocus className="input w-full py-1.5" value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value)} onBlur={() => setOther(false)}/>;
  return (
    <select className="input w-full py-1.5" value={value || ''} disabled={disabled}
      onChange={e => (e.target.value === '__other' ? setOther(true) : onChange(e.target.value))}>
      <option value="">—</option>
      {opts.map(o => <option key={o} value={o}>{o}</option>)}
      <option value="__other">Other…</option>
    </select>
  );
}

export default function QaDocuments() {
  const { user } = useAuth();
  const editable = canEdit(user, 'quality');
  const qc = useQueryClient();
  const [date, setDate] = useState(today());
  const [tankerId, setTankerId] = useState('');
  const [doc, setDoc] = useState(null);
  const [saveDefaults, setSaveDefaults] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: tankers = [] } = useQuery({ queryKey: ['qa-doc-tankers', date], queryFn: () => getQaDocTankers(date).then(r => r.data) });
  const { data: loaded, isFetching, isError, error } = useQuery({
    queryKey: ['qa-docs', date, tankerId], enabled: !!tankerId,
    queryFn: () => getQaDocs({ date, tanker_id: tankerId }).then(r => r.data),
  });
  useEffect(() => { setDoc(loaded ? JSON.parse(JSON.stringify(loaded)) : null); setSaveDefaults(false); }, [loaded]);
  useEffect(() => { setTankerId(''); }, [date]);

  const dps = loaded?.delivery_points || [];
  const d = doc?.data || {};
  const set = (path, v) => setDoc(prev => {
    const next = JSON.parse(JSON.stringify(prev)); let o = next.data; const ks = path.split('.');
    ks.slice(0, -1).forEach(k => { o[k] ||= {}; o = o[k]; }); o[ks.at(-1)] = v; return next;
  });
  const setState = (party, name) => { set(`${party}.state`, name); const s = STATES.find(x => x[0] === name); if (s) set(`${party}.state_code`, s[1]); };
  const pickPlant = id => {
    const dp = dps.find(x => String(x.id) === String(id));
    setDoc(prev => ({ ...prev, delivery_point_id: id || null,
      data: { ...prev.data, bill_to: { ...prev.data.bill_to, ...(dp?.bill_to || {}) }, ship_to: { ...prev.data.ship_to, ...(dp?.ship_to || {}) } } }));
  };

  const tankerOpts = useMemo(() => tankers.map(t => ({ value: t.tanker_id, label: `${t.tanker_number} — ${t.route_name || 'no route'}${t.challan_no ? ` (${t.challan_no})` : ''}` })), [tankers]);
  const routeOpts = useMemo(() => [...new Set(tankers.flatMap(t => String(t.route_name || '').split(', ')).filter(Boolean))], [tankers]);

  async function save() {
    setBusy(true);
    try {
      const r = await saveQaDocs({ lifting_date: date, tanker_id: tankerId, challan_no: doc.challan_no, delivery_point_id: doc.delivery_point_id, data: doc.data, save_party_defaults: saveDefaults });
      setDoc(prev => ({ ...prev, ...r.data }));
      qc.invalidateQueries({ queryKey: ['qa-doc-tankers', date] });
      toast.success(`Saved — challan ${r.data.challan_no}`);
      return r.data;
    } catch (e) { toast.error(e.response?.data?.error || e.message); return null; } finally { setBusy(false); }
  }
  async function print(kind) {
    const saved = editable ? await save() : doc;
    if (!saved?.id) return;
    let n = 1;
    try { n = (await markQaDocPrinted(saved.id, kind)).data.count; } catch { /* print anyway */ }
    const full = { ...doc, ...saved, data: doc.data };
    kind === 'coa' ? printQaCoa(full, n) : printQaDispatch(full, n);
  }

  const inp = (path, props = {}) => {
    const v = path.split('.').reduce((o, k) => o?.[k], d);
    return <input className="input w-full py-1.5" value={v ?? ''} disabled={!editable} onChange={e => set(path, e.target.value)} {...props}/>;
  };
  const party = p => (
    <div className="grid grid-cols-2 gap-2">
      {p === 'ship_to' && <Field label="SAP Vendor Code (MD)">{inp('ship_to.sap_vendor_code')}</Field>}
      <Field label="Name" className={p === 'bill_to' ? 'col-span-2' : ''}>{inp(`${p}.name`)}</Field>
      <Field label="Customer Code">{inp(`${p}.customer_code`)}</Field>
      <Field label={p === 'ship_to' ? 'Address of Delivery' : 'Address'} className="col-span-2">{inp(`${p}.address`)}</Field>
      {p === 'ship_to' && <Field label="Place of Supply">{inp('ship_to.place_of_supply')}</Field>}
      <Field label="GSTIN / Unique ID">{inp(`${p}.gstin`)}</Field>
      <Field label="State"><Pick value={d[p]?.state} options={STATES.map(s => s[0])} onChange={v => setState(p, v)} disabled={!editable}/></Field>
      <Field label="State Code">{inp(`${p}.state_code`)}</Field>
    </div>
  );

  return (
    <div className="p-4 space-y-4 max-w-6xl">
      <h1 className="text-xl font-semibold">Dispatch Challan &amp; COA</h1>
      <div className="card p-4 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Lifting date"><input type="date" className="input w-full py-1.5" value={date} max={today()} onChange={e => setDate(e.target.value)}/></Field>
        <Field label="Tanker / route" className="sm:col-span-2">
          <SearchableSelect options={tankerOpts} value={tankerId} onChange={setTankerId} placeholder={tankers.length ? 'Select tanker…' : 'No QA entries on this date'}/>
        </Field>
      </div>

      {tankerId && isFetching && <div className="text-gray-500">Loading…</div>}
      {tankerId && isError && <div className="card p-3 text-red-700">Could not load the documents: {error.response?.data?.error || error.message}</div>}
      {doc && !isFetching && (<>
        <div className="flex flex-wrap gap-2 items-center">
          <span className={`text-xs px-2 py-1 rounded ${doc.saved ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
            {doc.saved ? `Saved · printed dispatch ${doc.print_count_dispatch || 0}× · COA ${doc.print_count_coa || 0}×` : 'Pre-filled — not saved yet'}</span>
          {d.totals && <span className="text-xs text-gray-600">QA entries: {d.totals.litres} L · {d.totals.kgs} kg · Fat {d.totals.fat ?? '—'} % · SNF {d.totals.snf ?? '—'} %</span>}
          <div className="flex-1"/>
          {editable && <button className="btn-secondary flex items-center gap-1" disabled={busy} onClick={save}><Save size={14}/> Save</button>}
          <button className="btn-primary flex items-center gap-1" disabled={busy} onClick={() => print('dispatch')}><Printer size={14}/> Print Dispatch</button>
          <button className="btn-primary flex items-center gap-1" disabled={busy} onClick={() => print('coa')}><Printer size={14}/> Print COA</button>
        </div>

        <div className="card p-4 space-y-3">
          <h2 className="font-semibold">Challan</h2>
          <div className="grid sm:grid-cols-4 gap-2">
            <Field label="Delivery Challan No. (auto on first save)"><input className="input w-full py-1.5" value={doc.challan_no || ''} placeholder="DC/26-27/…" disabled={!editable} onChange={e => setDoc({ ...doc, challan_no: e.target.value })}/></Field>
            <Field label="Delivery Challan Date">{inp('challan_date', { type: 'date' })}</Field>
            <Field label="Name of Route"><Pick value={d.route_name} options={routeOpts} onChange={v => set('route_name', v)} disabled={!editable}/></Field>
            <Field label="Type of Milk"><Pick value={d.milk_type} options={MILK_TYPES} onChange={v => set('milk_type', v)} disabled={!editable}/></Field>
            <Field label="Dispatch Center Code">{inp('dispatch_center_code')}</Field>
            <Field label="Tanker sent from (COA)">{inp('dispatch_from')}</Field>
            <Field label="Address" className="sm:col-span-2">{inp('address')}</Field>
            <Field label="Name of Transporter">{inp('transporter')}</Field>
            <Field label="Name of Driver">{inp('driver')}</Field>
            <Field label="Vehicle No.">{inp('vehicle_no')}</Field>
            <Field label="LR No.">{inp('lr_no')}</Field>
            <Field label="LR Date">{inp('lr_date', { type: 'date' })}</Field>
            <Field label="Date of PO">{inp('po_date', { type: 'date' })}</Field>
          </div>
        </div>

        <div className="card p-4 space-y-3">
          <h2 className="font-semibold">Compartments</h2>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-600"><th>Description</th><th>Front cell (FC)</th><th>Middle cell (MC)</th><th>Back cell (BC)</th></tr></thead>
            <tbody>
              <tr><td>Milk Type</td>{['FC', 'MC', 'BC'].map(c => <td key={c} className="pr-2"><Pick value={d.compartments?.[c]?.milk_type} options={MILK_TYPES} onChange={v => set(`compartments.${c}.milk_type`, v)} disabled={!editable}/></td>)}</tr>
              <tr><td>Milk Quantity In Ltrs</td>{['FC', 'MC', 'BC'].map(c => <td key={c} className="pr-2">{inp(`compartments.${c}.litres`, { type: 'number' })}</td>)}</tr>
              <tr><td>Seal Number</td>{['FC', 'MC', 'BC'].map(c => <td key={c} className="pr-2">{inp(`compartments.${c}.seal_no`)}</td>)}</tr>
            </tbody>
          </table>
        </div>

        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <h2 className="font-semibold">Bill to / Ship to</h2>
            <Field label="Delivering plant" className="min-w-[16rem]">
              <select className="input w-full py-1.5" value={doc.delivery_point_id || ''} disabled={!editable} onChange={e => pickPlant(e.target.value)}>
                <option value="">—</option>{dps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select></Field>
            {editable && doc.delivery_point_id && <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={saveDefaults} onChange={e => setSaveDefaults(e.target.checked)}/> Save these details as default for this plant</label>}
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div><h3 className="text-sm font-medium mb-1">Details of (Bill to Party)</h3>{party('bill_to')}</div>
            <div><h3 className="text-sm font-medium mb-1">Details of (Ship to Party)</h3>{party('ship_to')}</div>
          </div>
        </div>

        <div className="card p-4 space-y-3">
          <h2 className="font-semibold">Item</h2>
          <div className="grid sm:grid-cols-6 gap-2">
            <Field label="Description" className="sm:col-span-2"><Pick value={d.item?.description} options={DESCRIPTIONS} onChange={v => set('item.description', v)} disabled={!editable}/></Field>
            <Field label="HSN/SAC Code"><Pick value={d.item?.hsn} options={['0401', '04012000', '04014000']} onChange={v => set('item.hsn', v)} disabled={!editable}/></Field>
            <Field label="Batch">{inp('item.batch')}</Field>
            <Field label="Quantity">{inp('item.quantity')}</Field>
            <Field label="Unit"><Pick value={d.item?.uom} options={['Ltrs', 'Kgs']} onChange={v => set('item.uom', v)} disabled={!editable}/></Field>
            <Field label="Value">{inp('item.value')}</Field>
            {[['cgst', 'Central Tax'], ['sgst', 'State / UT Tax'], ['igst', 'Integrated Tax']].map(([k, l]) => (
              <Field key={k} label={`${l} rate / amt`}><div className="flex gap-1">
                <Pick value={d.item?.[`${k}_rate`]} options={TAX_RATES} onChange={v => set(`item.${k}_rate`, v)} disabled={!editable}/>
                {inp(`item.${k}_amt`)}</div></Field>))}
            <Field label="Total">{inp('item.total')}</Field>
          </div>
        </div>

        <div className="card p-4 space-y-2">
          <h2 className="font-semibold">Certificate of Analysis — Actual Observation</h2>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-600"><th className="w-10">#</th><th>Test</th><th>Acceptance limit</th><th className="w-72">Observation</th></tr></thead>
            <tbody>{QA_COA_TESTS.map(([k, name, limit], i) => (
              <tr key={k} className="border-t">
                <td>{i + 1}</td><td dangerouslySetInnerHTML={{ __html: name }}/><td className="text-gray-600 text-xs" dangerouslySetInnerHTML={{ __html: limit }}/>
                <td className="py-1">{['fat', 'snf'].includes(k) ? inp(`coa.${k}`, { type: 'number', step: '0.01' })
                  : <Pick value={d.coa?.[k]} options={OBS[k] || NEG} onChange={v => set(`coa.${k}`, v)} disabled={!editable}/>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}
