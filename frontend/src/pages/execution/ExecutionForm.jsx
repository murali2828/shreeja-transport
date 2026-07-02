// frontend/src/pages/execution/ExecutionForm.jsx
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ChevronLeft, Send, RefreshCw, XCircle, GripVertical } from 'lucide-react';
import toast from 'react-hot-toast';
import { getExecution, updateExecution, submitForAck, getBmcus, getDeliveryPoints, getStartingPoints, cancelExecution } from '../../api/index';
import { useAuth } from '../../hooks/useAuth';

const KG = 1.0285;
const calc = {
  kgs:   (l)    => l ? +(parseFloat(l) * KG).toFixed(4) : '',
  kgFat: (k, f) => k && f ? +(parseFloat(k) * parseFloat(f) / 100).toFixed(4) : '',
  kgSnf: (k, s) => k && s ? +(parseFloat(k) * parseFloat(s) / 100).toFixed(4) : '',
};

const DESCRIPTIONS = ['RMRD', 'Balance Milk', 'Internal Shifting'];
const CHAMBERS     = ['FC', 'MC', 'BC'];
const SHIFTS       = ['AM', 'PM'];
const BALANCE_CATEGORIES = ['Left Over milk', 'Lifted milk'];

function ChamberDropdown({ value, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const selected = (value || '').split(',').filter(Boolean);
  const label = selected.length === 0 ? '— Select —' : selected.join(', ');

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (c) => {
    const next = selected.includes(c) ? selected.filter(x => x !== c) : [...selected, c];
    onChange(next.join(','));
  };

  return (
    <div ref={ref} className="relative" style={{ minWidth: 80 }}>
      <button type="button" disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        className="input py-0.5 px-2 text-xs w-full text-left flex items-center justify-between gap-1"
        style={{ minWidth: 90, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        <span className={`truncate ${selected.length ? 'text-gray-800' : 'text-gray-400'}`}>{label}</span>
        <span className="text-gray-400 flex-shrink-0">▾</span>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1"
          style={{ minWidth: 80 }}>
          {CHAMBERS.map(c => (
            <label key={c}
              className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-blue-50 select-none">
              <input type="checkbox" checked={selected.includes(c)} onChange={() => toggle(c)}
                className="accent-blue-600"/>
              {c}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function BmcuSearchDropdown({ bmcuList, onSelect }) {
  const [query, setQuery] = useState('');
  const [open,  setOpen]  = useState(false);
  const ref = useRef(null);

  const filtered = query.trim()
    ? bmcuList.filter(b =>
        b.bmcu_code.toLowerCase().includes(query.toLowerCase()) ||
        b.bmcu_name.toLowerCase().includes(query.toLowerCase())
      ).slice(0, 20)
    : bmcuList.slice(0, 20);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="relative" style={{ minWidth: 160 }}>
      <input
        autoFocus
        type="text"
        className="input py-0.5 px-2 text-xs w-full"
        placeholder="Search code or name…"
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-y-auto"
          style={{ maxHeight: 200, minWidth: 220 }}>
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">No results</div>
          )}
          {filtered.map(b => (
            <div key={b.id}
              className="px-3 py-1.5 text-xs cursor-pointer hover:bg-blue-50 flex gap-2"
              onMouseDown={() => { onSelect(b); setOpen(false); }}>
              <span className="font-mono font-semibold text-[#0078d4]">{b.bmcu_code}</span>
              <span className="text-gray-600 truncate">{b.bmcu_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Searchable BMCU selector for the "source plant" field on internal-shifting entries.
function SourcePlantSelect({ bmcuList, code, onSelect, disabled }) {
  const [q, setQ]       = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = (q.trim()
    ? bmcuList.filter(b =>
        b.bmcu_code.toLowerCase().includes(q.toLowerCase()) ||
        b.bmcu_name.toLowerCase().includes(q.toLowerCase()))
    : bmcuList).slice(0, 20);

  return (
    <div ref={ref} className="relative" style={{ minWidth: 140 }}>
      <input
        type="text"
        disabled={disabled}
        className="input py-0 px-1 text-xs w-full"
        placeholder="Search BMCU…"
        value={open ? q : (code || '')}
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => { setQ(''); setOpen(true); }}
      />
      {open && !disabled && (
        <div className="absolute z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-y-auto"
          style={{ maxHeight: 200, minWidth: 200 }}>
          {filtered.length === 0 && <div className="px-3 py-2 text-xs text-gray-400">No results</div>}
          {filtered.map(b => (
            <div key={b.id}
              className="px-3 py-1.5 text-xs cursor-pointer hover:bg-blue-50 flex gap-2"
              onMouseDown={() => { onSelect(b); setOpen(false); }}>
              <span className="font-mono font-semibold text-[#0078d4]">{b.bmcu_code}</span>
              <span className="text-gray-600 truncate">{b.bmcu_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BmcuRow({ row, idx, bmcuList, onUpdate, onDelete, onInsertAfter, isClosed,
                   shiftRowsForBmcu, onAddShiftRow, onUpdateShiftRow, onDeleteShiftRow, execDate,
                   entriesForBmcu, onAddEntry, onUpdateEntry, onDeleteEntry,
                   onDragStart, onDragOver, onDrop, isDragOver }) {
  const u = (field, val) => onUpdate(idx, field, val);
  const kgs    = calc.kgs(row.qty_litres);
  const kgFat  = calc.kgFat(kgs, row.fat_pct);
  const kgSnf  = calc.kgSnf(kgs, row.snf_pct);
  const dpsKgs = calc.kgs(row.dps_qty_litres);

  const syncCalc = (field, val) => {
    onUpdate(idx, field, val);
    if (field === 'qty_litres') {
      const k = calc.kgs(val);
      onUpdate(idx, 'qty_kgs', k);
      if (row.fat_pct) onUpdate(idx, 'kg_fat', calc.kgFat(k, row.fat_pct));
      if (row.snf_pct) onUpdate(idx, 'kg_snf', calc.kgSnf(k, row.snf_pct));
    }
    if (field === 'fat_pct') onUpdate(idx, 'kg_fat', calc.kgFat(kgs, val));
    if (field === 'snf_pct') onUpdate(idx, 'kg_snf', calc.kgSnf(kgs, val));
    if (field === 'dps_qty_litres') onUpdate(idx, 'dps_qty_kgs', calc.kgs(val));
  };

  const TOTAL_COLS = 10;

  return (
    <>
      <tr
        draggable={!isClosed}
        onDragStart={onDragStart}
        onDragOver={e => { e.preventDefault(); onDragOver(); }}
        onDrop={onDrop}
        className={`border-b border-gray-50 text-xs transition-colors
          ${isDragOver ? 'bg-blue-50 border-t-2 border-t-blue-400' : 'hover:bg-gray-50'}`}>
        <td className="table-td text-center" style={{ width: 28 }}>
          {!isClosed && (
            <span className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 inline-flex">
              <GripVertical size={14}/>
            </span>
          )}
        </td>
        <td className="table-td font-bold text-[#0078d4] text-center">{row.seq_no}</td>
        {!row.bmcu_id ? (
          <td className="table-td" colSpan={2}>
            <BmcuSearchDropdown bmcuList={bmcuList} onSelect={bm => {
              onUpdate(idx, 'bmcu_id',   bm.id);
              onUpdate(idx, 'bmcu_code', bm.bmcu_code);
              onUpdate(idx, 'bmcu_name', bm.bmcu_name);
            }}/>
          </td>
        ) : (
          <>
            <td className="table-td font-mono whitespace-nowrap">{row.bmcu_code}</td>
            <td className="table-td text-xs max-w-24 truncate">{row.bmcu_name}</td>
          </>
        )}
        <td className="table-td">
          <input type="date" className="input py-0.5 px-1 text-xs w-28" disabled={isClosed}
            value={row.milk_date || ''} onChange={e => u('milk_date', e.target.value)}/>
        </td>
        <td className="table-td">
          <input type="number" min="0" step="0.01" className="input py-0.5 px-1 text-xs w-20" disabled={isClosed}
            value={row.qty_litres || ''} onChange={e => syncCalc('qty_litres', e.target.value)}/>
        </td>
        <td className="table-td">
          <input type="number" min="0" step="0.001" className="input py-0.5 px-1 text-xs w-16" disabled={isClosed}
            value={row.fat_pct || ''} onChange={e => syncCalc('fat_pct', e.target.value)}/>
        </td>
        <td className="table-td">
          <input type="number" min="0" step="0.001" className="input py-0.5 px-1 text-xs w-16" disabled={isClosed}
            value={row.snf_pct || ''} onChange={e => syncCalc('snf_pct', e.target.value)}/>
        </td>
        <td className="table-td">
          <ChamberDropdown value={row.chamber} onChange={val => u('chamber', val)} disabled={isClosed}/>
        </td>
        <td className="table-td">
          <div className="flex gap-1">
            <button onClick={() => onInsertAfter(idx)} className="btn-secondary btn-sm p-1" title="Add row below" disabled={isClosed}>
              <Plus size={10}/>
            </button>
            <button onClick={() => onDelete(idx)} className="btn-danger btn-sm p-1" disabled={isClosed}>
              <Trash2 size={10}/>
            </button>
          </div>
        </td>
      </tr>
      {/* Shift sub-rows */}
      <tr>
        <td colSpan={TOTAL_COLS} style={{ padding: 0, background: '#f7f8fa' }}>
          <div style={{ padding: '4px 12px 6px 36px' }}>
            {shiftRowsForBmcu.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ color: '#666', borderBottom: '1px solid #e2e8f0' }}>
                    <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Shift</th>
                    <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>RMRD Qty</th>
                    <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>RMRD Fat%</th>
                    <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>RMRD SNF%</th>
                    <th style={{ width: 28 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {shiftRowsForBmcu.map(sr => (
                    <tr key={sr._key} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '2px 4px' }}>
                        <input type="date" disabled={isClosed}
                          className="input py-0 px-1 text-xs w-28"
                          value={sr.milk_date || ''}
                          onChange={e => onUpdateShiftRow(sr._key, 'milk_date', e.target.value)}/>
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        <select disabled={isClosed}
                          className="input py-0 px-1 text-xs w-14"
                          value={sr.shift || ''}
                          onChange={e => onUpdateShiftRow(sr._key, 'shift', e.target.value)}>
                          <option value="">—</option>
                          {SHIFTS.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        <input type="number" min="0" step="0.01" disabled={isClosed}
                          className="input py-0 px-1 text-xs w-20"
                          value={sr.rmrd_qty || ''}
                          onChange={e => onUpdateShiftRow(sr._key, 'rmrd_qty', e.target.value)}
                          placeholder="Qty"/>
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        <input type="number" min="0" step="0.001" disabled={isClosed}
                          className="input py-0 px-1 text-xs w-16"
                          value={sr.rmrd_fat_pct || ''}
                          onChange={e => onUpdateShiftRow(sr._key, 'rmrd_fat_pct', e.target.value)}
                          placeholder="Fat%"/>
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        <input type="number" min="0" step="0.001" disabled={isClosed}
                          className="input py-0 px-1 text-xs w-16"
                          value={sr.rmrd_snf_pct || ''}
                          onChange={e => onUpdateShiftRow(sr._key, 'rmrd_snf_pct', e.target.value)}
                          placeholder="SNF%"/>
                      </td>
                      <td style={{ padding: '2px 4px' }}>
                        {!isClosed && (
                          <button onClick={() => onDeleteShiftRow(sr._key)}
                            className="btn-danger btn-sm p-0.5" title="Remove shift row">
                            <Trash2 size={9}/>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {/* Balance Milk entries */}
            {(() => {
              const rows = entriesForBmcu.filter(e => e.kind === 'balance_milk');
              if (!rows.length) return null;
              return (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 6, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '240px' }}/>
                    <col style={{ width: '130px' }}/>
                    <col style={{ width: '120px' }}/>
                    <col style={{ width: '120px' }}/>
                    <col style={{ width: '32px' }}/>
                  </colgroup>
                  <thead>
                    <tr style={{ color: '#0a7d3c', borderBottom: '1px solid #cfe9d8' }}>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Balance Milk</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Qty (L)</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Fat%</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>SNF%</th>
                      <th style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(e => (
                      <tr key={e._key} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '2px 4px' }}>
                          <select disabled={isClosed} className="input py-0 px-1 text-xs w-32"
                            value={e.category || ''}
                            onChange={ev => onUpdateEntry(e._key, 'category', ev.target.value)}>
                            {BALANCE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.01" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-20" value={e.qty_litres || ''}
                            onChange={ev => onUpdateEntry(e._key, 'qty_litres', ev.target.value)} placeholder="Qty"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.001" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-16" value={e.fat_pct || ''}
                            onChange={ev => onUpdateEntry(e._key, 'fat_pct', ev.target.value)} placeholder="Fat%"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.001" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-16" value={e.snf_pct || ''}
                            onChange={ev => onUpdateEntry(e._key, 'snf_pct', ev.target.value)} placeholder="SNF%"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          {!isClosed && (
                            <button onClick={() => onDeleteEntry(e._key)} className="btn-danger btn-sm p-0.5" title="Remove">
                              <Trash2 size={9}/>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}

            {/* New MPP entries */}
            {(() => {
              const rows = entriesForBmcu.filter(e => e.kind === 'new_mpp');
              if (!rows.length) return null;
              return (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 6, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '240px' }}/>
                    <col style={{ width: '130px' }}/>
                    <col style={{ width: '120px' }}/>
                    <col style={{ width: '120px' }}/>
                    <col style={{ width: '32px' }}/>
                  </colgroup>
                  <thead>
                    <tr style={{ color: '#9a5b00', borderBottom: '1px solid #f0dcc0' }}>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>New MPP</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Qty (L)</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Fat%</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>SNF%</th>
                      <th style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(e => (
                      <tr key={e._key} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '2px 4px', color: '#9a5b00', fontWeight: 600 }}>New MPP</td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.01" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-20" value={e.qty_litres || ''}
                            onChange={ev => onUpdateEntry(e._key, 'qty_litres', ev.target.value)} placeholder="Qty"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.001" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-16" value={e.fat_pct || ''}
                            onChange={ev => onUpdateEntry(e._key, 'fat_pct', ev.target.value)} placeholder="Fat%"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.001" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-16" value={e.snf_pct || ''}
                            onChange={ev => onUpdateEntry(e._key, 'snf_pct', ev.target.value)} placeholder="SNF%"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          {!isClosed && (
                            <button onClick={() => onDeleteEntry(e._key)} className="btn-danger btn-sm p-0.5" title="Remove">
                              <Trash2 size={9}/>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}

            {/* Internal Shifting entries */}
            {(() => {
              const rows = entriesForBmcu.filter(e => e.kind === 'internal_shifting');
              if (!rows.length) return null;
              return (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 6, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '240px' }}/>
                    <col style={{ width: '130px' }}/>
                    <col style={{ width: '120px' }}/>
                    <col style={{ width: '120px' }}/>
                    <col style={{ width: '32px' }}/>
                  </colgroup>
                  <thead>
                    <tr style={{ color: '#6b21a8', borderBottom: '1px solid #e6d6f5' }}>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Internal Shifting — Source Plant</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Qty (L)</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>Fat%</th>
                      <th style={{ textAlign: 'left', padding: '2px 6px', fontWeight: 600 }}>SNF%</th>
                      <th style={{ width: 28 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(e => (
                      <tr key={e._key} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '2px 4px' }}>
                          <SourcePlantSelect bmcuList={bmcuList} code={e.source_bmcu_code} disabled={isClosed}
                            onSelect={bm => {
                              onUpdateEntry(e._key, 'source_bmcu_id', bm.id);
                              onUpdateEntry(e._key, 'source_bmcu_code', bm.bmcu_code);
                            }}/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.01" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-20" value={e.qty_litres || ''}
                            onChange={ev => onUpdateEntry(e._key, 'qty_litres', ev.target.value)} placeholder="Qty"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.001" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-16" value={e.fat_pct || ''}
                            onChange={ev => onUpdateEntry(e._key, 'fat_pct', ev.target.value)} placeholder="Fat%"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          <input type="number" min="0" step="0.001" disabled={isClosed}
                            className="input py-0 px-1 text-xs w-16" value={e.snf_pct || ''}
                            onChange={ev => onUpdateEntry(e._key, 'snf_pct', ev.target.value)} placeholder="SNF%"/>
                        </td>
                        <td style={{ padding: '2px 4px' }}>
                          {!isClosed && (
                            <button onClick={() => onDeleteEntry(e._key)} className="btn-danger btn-sm p-0.5" title="Remove">
                              <Trash2 size={9}/>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()}

            {!isClosed && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                <button onClick={() => onAddShiftRow(row.seq_no, execDate)}
                  className="btn-secondary btn-sm text-xs py-0.5 px-2 flex items-center gap-1">
                  <Plus size={9}/> Add Shift
                </button>
                <button onClick={() => onAddEntry('balance_milk', row.seq_no, row.bmcu_id)}
                  className="btn-secondary btn-sm text-xs py-0.5 px-2 flex items-center gap-1 text-green-700 border-green-300">
                  <Plus size={9}/> Balance Milk
                </button>
                <button onClick={() => onAddEntry('new_mpp', row.seq_no, row.bmcu_id)}
                  className="btn-secondary btn-sm text-xs py-0.5 px-2 flex items-center gap-1 text-amber-700 border-amber-300">
                  <Plus size={9}/> New MPP
                </button>
                <button onClick={() => onAddEntry('internal_shifting', row.seq_no, row.bmcu_id)}
                  className="btn-secondary btn-sm text-xs py-0.5 px-2 flex items-center gap-1 text-purple-700 border-purple-300">
                  <Plus size={9}/> Internal Shifting
                </button>
              </div>
            )}
          </div>
        </td>
      </tr>
    </>
  );
}

export default function ExecutionForm() {
  const { id }   = useParams();
  const navigate = useNavigate();
  const qc       = useQueryClient();
  const { user } = useAuth();
  const isAdmin  = user?.role === 'admin';
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason,    setCancelReason]    = useState('');

  const [actualKm,         setActualKm]         = useState('');
  const [deliveryPointId,  setDeliveryPointId]  = useState('');
  const [startPointId,     setStartPointId]     = useState('');
  const [bmcuRows,         setBmcuRows]         = useState([]);
  const [shiftRows,        setShiftRows]        = useState([]);
  const [entries,          setEntries]          = useState([]);
  const [dragIdx,          setDragIdx]          = useState(null);
  const [dragOverIdx,      setDragOverIdx]      = useState(null);

  const { data: exec, isLoading } = useQuery({
    queryKey: ['execution', id],
    queryFn:  () => getExecution(id).then(r => r.data)
  });
  const { data: bmcuList = [] } = useQuery({
    queryKey: ['bmcus'], queryFn: () => getBmcus().then(r => r.data)
  });
  const { data: deliveryPoints = [] } = useQuery({
    queryKey: ['delivery-points'], queryFn: () => getDeliveryPoints().then(r => r.data)
  });
  const { data: startingPoints = [] } = useQuery({
    queryKey: ['start-pts'], queryFn: () => getStartingPoints().then(r => r.data)
  });

  useEffect(() => {
    if (exec) {
      setActualKm(exec.actual_km || '');
      setDeliveryPointId(String(exec.delivery_point_id || ''));
      setStartPointId(String(exec.start_point_id || ''));
      setBmcuRows((exec.bmcus || []).map(b => ({
        ...b,
        milk_date: b.milk_date ? b.milk_date.slice(0, 10) : ''
      })));
      setShiftRows((exec.shift_rows || []).map((sr, i) => ({
        ...sr,
        milk_date: sr.milk_date ? sr.milk_date.slice(0, 10) : '',
        _key: Date.now() + i
      })));
      setEntries((exec.entries || []).map((e, i) => ({
        ...e,
        _key: 'e' + Date.now() + i
      })));
    }
  }, [exec]);

  const updateRow = (idx, field, val) =>
    setBmcuRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: val } : r));

  const deleteRow = (idx) =>
    setBmcuRows(prev => prev.map((r, i) => i === idx ? { ...r, is_deleted: true } : r));

  const makeEmptyRow = (bm, seqNo) => ({
    bmcu_id: bm ? bm.id : null,
    bmcu_code: bm ? bm.bmcu_code : '',
    bmcu_name: bm ? bm.bmcu_name : '',
    seq_no: seqNo,
    milk_date: exec?.execution_date?.slice(0,10) || '',
    shift: '', qty_litres: '', qty_kgs: '', fat_pct: '', snf_pct: '',
    kg_fat: '', kg_snf: '', description: 'RMRD', chamber: '',
    dps_qty_litres: '', dps_fat_pct: '', dps_snf_pct: '', is_deleted: false
  });

  const addRow = (bmcuId) => {
    const bm = bmcuList.find(b => b.id === parseInt(bmcuId));
    if (!bm) return;
    setBmcuRows(prev => {
      const next = [...prev, makeEmptyRow(bm, prev.filter(r => !r.is_deleted).length + 1)];
      return next;
    });
  };

  const insertRowAfter = (idx) => {
    // The new row is inserted at 0-based position idx+1.
    // All rows previously at positions > idx get their seq_no bumped by 1.
    // Shift rows whose bmcu_seq_no was > idx+1 must also be incremented.
    const insertedAfterSeq = idx + 1; // 1-based seq_no of the row we insert after
    setBmcuRows(prev => {
      const next = [...prev];
      next.splice(idx + 1, 0, makeEmptyRow(null, 0));
      return next.map((r, i) => ({ ...r, seq_no: i + 1 }));
    });
    setShiftRows(prev =>
      prev.map(sr =>
        sr.bmcu_seq_no > insertedAfterSeq
          ? { ...sr, bmcu_seq_no: sr.bmcu_seq_no + 1 }
          : sr
      )
    );
    setEntries(prev =>
      prev.map(e =>
        e.bmcu_seq_no > insertedAfterSeq
          ? { ...e, bmcu_seq_no: e.bmcu_seq_no + 1 }
          : e
      )
    );
  };

  const reorderRows = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    // Capture old seq_nos before reorder
    const oldSeqs = bmcuRows.filter(r => !r.is_deleted).map(r => r.seq_no);
    setBmcuRows(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return next.map((r, i) => ({ ...r, seq_no: i + 1 }));
    });
    // Build a mapping from old seq_no → new seq_no and remap shift rows
    setShiftRows(prev => {
      // After reorder, position i gets the old row that was at oldIdx
      const reordered = [...oldSeqs];
      const [movedSeq] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, movedSeq);
      // reordered[i] = old seq_no that is now at new seq_no (i+1)
      const oldToNew = {};
      reordered.forEach((oldSeq, i) => { oldToNew[oldSeq] = i + 1; });
      return prev.map(sr =>
        oldToNew[sr.bmcu_seq_no] != null
          ? { ...sr, bmcu_seq_no: oldToNew[sr.bmcu_seq_no] }
          : sr
      );
    });
    setEntries(prev => {
      const reordered = [...oldSeqs];
      const [movedSeq] = reordered.splice(fromIdx, 1);
      reordered.splice(toIdx, 0, movedSeq);
      const oldToNew = {};
      reordered.forEach((oldSeq, i) => { oldToNew[oldSeq] = i + 1; });
      return prev.map(e =>
        oldToNew[e.bmcu_seq_no] != null
          ? { ...e, bmcu_seq_no: oldToNew[e.bmcu_seq_no] }
          : e
      );
    });
  };

  const addShiftRow = (seqNo, execDate) => {
    setShiftRows(prev => [...prev, {
      bmcu_seq_no: seqNo,
      milk_date: execDate || '',
      shift: '',
      rmrd_qty: '',
      rmrd_fat_pct: '',
      rmrd_snf_pct: '',
      _key: Date.now() + Math.random()
    }]);
  };

  const updateShiftRow = (key, field, val) =>
    setShiftRows(prev => prev.map(r => r._key === key ? { ...r, [field]: val } : r));

  const deleteShiftRow = (key) =>
    setShiftRows(prev => prev.filter(r => r._key !== key));

  const addEntry = (kind, seqNo, bmcuId) =>
    setEntries(prev => [...prev, {
      bmcu_seq_no: seqNo,
      bmcu_id: bmcuId || null,
      kind,
      category: kind === 'balance_milk' ? BALANCE_CATEGORIES[0] : null,
      source_bmcu_id: null,
      source_bmcu_code: '',
      qty_litres: '', fat_pct: '', snf_pct: '',
      _key: 'e' + Date.now() + Math.random()
    }]);

  const updateEntry = (key, field, val) =>
    setEntries(prev => prev.map(e => e._key === key ? { ...e, [field]: val } : e));

  const deleteEntry = (key) =>
    setEntries(prev => prev.filter(e => e._key !== key));

  const saveMut = useMutation({
    mutationFn: () => updateExecution(id, {
      actual_km: actualKm, delivery_point_id: deliveryPointId || null,
      start_point_id: startPointId || null,
      bmcus: bmcuRows.filter(r => r.bmcu_id), // skip rows where BMCU not yet selected
      shift_rows: shiftRows.map(({ _key, ...r }) => r),
      entries: entries.map(({ _key, source_bmcu_code, source_bmcu_name, bmcu_code, bmcu_name, ...r }) => r)
    }),
    onSuccess: () => { toast.success('Saved'); qc.invalidateQueries(['execution', id]); },
    onError: (e) => toast.error(e.response?.data?.error || 'Save failed'),
  });

  const submitMut = useMutation({
    mutationFn: () => submitForAck(id),
    onSuccess: () => {
      toast.success('Submitted for acknowledgement');
      navigate(`/execution/${id}/acknowledge`);
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Submit failed'),
  });

  const cancelMut = useMutation({
    mutationFn: () => cancelExecution(id, cancelReason),
    onSuccess: () => {
      toast.success('Trip cancelled');
      navigate('/execution');
    },
    onError: (e) => toast.error(e.response?.data?.error || 'Cancel failed'),
  });

  if (isLoading) return <div className="text-gray-400 p-8">Loading…</div>;
  if (!exec) return <div className="text-red-500 p-8">Execution not found</div>;

  const visibleRows = bmcuRows.filter(r => !r.is_deleted);
  const totalLitres = visibleRows.filter(r => r.description !== 'Balance Milk').reduce((s,r) => s + (parseFloat(r.qty_litres)||0), 0);
  const totalKgs    = visibleRows.filter(r => r.description !== 'Balance Milk').reduce((s,r) => s + (parseFloat(r.qty_kgs) || parseFloat(r.qty_litres||0)*1.0285), 0);
  const isClosed    = exec.status === 'closed';
  const canSubmit   = exec.status === 'saved';

  return (
    <div className="space-y-4 w-full">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={() => navigate('/execution')} className="btn-secondary flex items-center gap-1.5">
          <ChevronLeft size={14}/> Back
        </button>
        <div>
          <h2 className="page-title">
            Trip #{exec.trip_no} — {exec.tanker_number}
          </h2>
          <p className="text-xs font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>
            {exec.execution_date?.slice(0,10)}
            {exec.shifts_milk && <> · <span style={{ color: 'white' }}>{exec.shifts_milk}</span></>}
            {exec.route_name  && <> · <span style={{ color: 'white' }}>{exec.route_name}</span></>}
            {exec.delivery_point_name && <> · {exec.delivery_point_name}</>}
          </p>
        </div>
        {isAdmin && !isClosed && (
          <button onClick={() => setShowCancelModal(true)}
            className="ml-auto btn-danger flex items-center gap-1.5 text-xs">
            <XCircle size={13}/> Cancel Trip
          </button>
        )}
        <span className={`${isAdmin && !isClosed ? '' : 'ml-auto'} text-xs px-2.5 py-1 rounded-full font-medium
          ${ exec.status==='in_progress' ? 'bg-blue-100 text-blue-700' :
             exec.status==='saved'       ? 'bg-amber-100 text-amber-700' :
             exec.status==='pending_ack' ? 'bg-purple-100 text-purple-700' :
             'bg-green-100 text-green-700'}`}>
          {exec.status.replace('_',' ')}
        </span>
      </div>

      {/* Trip summary */}
      <div className="card p-4 grid grid-cols-2 sm:grid-cols-5 gap-4 text-sm">
        <div>
          <label className="label text-xs">Starting Point</label>
          <select className="input w-full py-1.5" value={startPointId}
            disabled={isClosed} onChange={e => setStartPointId(e.target.value)}>
            <option value="">— Select —</option>
            {startingPoints.map(sp => <option key={sp.id} value={String(sp.id)}>{sp.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label text-xs">Actual KM</label>
          <input type="number" className="input w-full py-1.5" value={actualKm}
            disabled={isClosed} onChange={e => setActualKm(e.target.value)}/>
        </div>
        <div>
          <label className="label text-xs">Delivery Point</label>
          <select className="input w-full py-1.5" value={deliveryPointId}
            disabled={isClosed} onChange={e => setDeliveryPointId(e.target.value)}>
            <option value="">— Select —</option>
            {deliveryPoints.map(dp => <option key={dp.id} value={String(dp.id)}>{dp.name}</option>)}
          </select>
        </div>
        <div className="text-xs">
          <div className="text-gray-500">Total Litres (TS)</div>
          <div className="font-bold text-lg">{totalLitres.toLocaleString()}</div>
        </div>
        <div className="text-xs">
          <div className="text-gray-500">Total Kgs (TS)</div>
          <div className="font-bold text-lg">{totalKgs.toFixed(2)}</div>
        </div>
        <div className="text-xs">
          <div className="text-gray-500">Expected</div>
          <div className="font-bold text-lg">{parseFloat(exec.expected_total_qty||0).toLocaleString()} L</div>
        </div>
      </div>

      {/* BMCU data table */}
      <div className="card">
        <div className="p-3 border-b flex items-center justify-between">
          <span className="text-sm font-medium">BMCU Data Entry ({visibleRows.length} rows)</span>
          {!isClosed && (
            <select className="input text-xs py-1 w-48" defaultValue=""
              onChange={e => { if (e.target.value) { addRow(e.target.value); e.target.value=''; } }}>
              <option value="">+ Add BMCU row</option>
              {bmcuList.map(b => <option key={b.id} value={b.id}>{b.bmcu_code} — {b.bmcu_name}</option>)}
            </select>
          )}
        </div>
        <div className="overflow-x-auto max-h-[55vh]">
          <table className="text-xs w-full" style={{ minWidth: '760px' }}>
            <thead className="sticky top-0 bg-gray-50 border-b">
              <tr>
                {['','#','Code','Name','Date','Dispatch Qty L','Dispatch Fat%','Dispatch SNF%',
                  'Chamber',''].map((h,i) => (
                  <th key={i} className="table-th py-1.5 text-xs whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bmcuRows.map((row, i) =>
                row.is_deleted ? null : (
                  <BmcuRow key={i} row={row} idx={i}
                    bmcuList={bmcuList}
                    onUpdate={updateRow}
                    onDelete={isClosed ? () => {} : deleteRow}
                    onInsertAfter={isClosed ? () => {} : insertRowAfter}
                    isClosed={isClosed}
                    shiftRowsForBmcu={shiftRows.filter(sr => sr.bmcu_seq_no === row.seq_no)}
                    onAddShiftRow={addShiftRow}
                    onUpdateShiftRow={updateShiftRow}
                    onDeleteShiftRow={deleteShiftRow}
                    entriesForBmcu={entries.filter(e => e.bmcu_seq_no === row.seq_no)}
                    onAddEntry={addEntry}
                    onUpdateEntry={updateEntry}
                    onDeleteEntry={deleteEntry}
                    execDate={exec?.execution_date?.slice(0,10) || ''}
                    onDragStart={() => setDragIdx(i)}
                    onDragOver={() => setDragOverIdx(i)}
                    onDrop={() => { reorderRows(dragIdx, i); setDragIdx(null); setDragOverIdx(null); }}
                    isDragOver={dragOverIdx === i && dragIdx !== i}/>
                )
              )}
              {visibleRows.length === 0 && (
                <tr><td colSpan={10} className="table-td text-center py-8 text-gray-400">No BMCU rows</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Action buttons */}
      {!isClosed && (
        <div className="flex justify-end gap-3">
          <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="btn-secondary">
            {saveMut.isPending ? <><RefreshCw size={14} className="animate-spin"/> Saving…</> : 'Save'}
          </button>
          {canSubmit && (
            <button onClick={() => submitMut.mutate()} disabled={submitMut.isPending} className="btn-primary flex items-center gap-2">
              {submitMut.isPending ? <RefreshCw size={14} className="animate-spin"/> : <Send size={14}/>}
              Submit for Acknowledgement
            </button>
          )}
          {exec.status === 'in_progress' && (
            <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending} className="btn-primary">
              Save Progress
            </button>
          )}
        </div>
      )}

      {exec.status === 'pending_ack' && (
        <div className="flex justify-end">
          <button onClick={() => navigate(`/execution/${id}/acknowledge`)} className="btn-primary flex items-center gap-2">
            <Send size={14}/> Enter Acknowledgement
          </button>
        </div>
      )}

      {/* Acknowledgement entries — shown on closed trips */}
      {isClosed && exec.acknowledgements?.length > 0 && (
        <div className="card p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-700 border-b pb-2">Acknowledgement</h3>
          <div className="text-xs text-gray-500 mb-1">
            Date: <strong className="text-gray-700">{exec.acknowledgements[0]?.ack_date?.slice(0,10)}</strong>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="table-th">Chamber</th>
                  <th className="table-th text-right">Qty Kgs</th>
                  <th className="table-th text-right">Qty Litres</th>
                  <th className="table-th text-right">Fat %</th>
                  <th className="table-th text-right">SNF %</th>
                  <th className="table-th text-right">Kg Fat</th>
                  <th className="table-th text-right">Kg SNF</th>
                  <th className="table-th text-right">Temp</th>
                  <th className="table-th">Description</th>
                </tr>
              </thead>
              <tbody>
                {exec.acknowledgements.map((a, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="table-td">
                      <span className="inline-flex items-center justify-center w-8 h-6 rounded bg-[#0078d4] text-white text-xs font-bold">
                        {a.chamber}
                      </span>
                    </td>
                    <td className="table-td text-right font-medium">{parseFloat(a.qty_kgs||0).toLocaleString()}</td>
                    <td className="table-td text-right">{parseFloat(a.qty_litres||0).toLocaleString()}</td>
                    <td className="table-td text-right">{a.fat_pct || '—'}</td>
                    <td className="table-td text-right">{a.snf_pct || '—'}</td>
                    <td className="table-td text-right">{a.kg_fat || '—'}</td>
                    <td className="table-td text-right">{a.kg_snf || '—'}</td>
                    <td className="table-td text-right">{a.temperature || '—'}</td>
                    <td className="table-td text-xs text-gray-600">{a.description || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-blue-50 border-t font-semibold text-sm">
                <tr>
                  <td className="table-td text-xs text-gray-500">Total</td>
                  <td className="table-td text-right text-[#003a6b]">
                    {exec.acknowledgements.reduce((s,a) => s + parseFloat(a.qty_kgs||0), 0).toFixed(2)}
                  </td>
                  <td className="table-td text-right text-[#003a6b]">
                    {exec.acknowledgements.reduce((s,a) => s + parseFloat(a.qty_litres||0), 0).toFixed(2)}
                  </td>
                  <td colSpan={6}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Admin cancel modal */}
      {showCancelModal && (
        <div className="modal-overlay" onClick={() => setShowCancelModal(false)}>
          <div className="modal-box max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>Cancel Trip #{exec.trip_no}</span>
              <button onClick={() => setShowCancelModal(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="modal-body space-y-3">
              <p className="text-sm text-gray-600">
                This will cancel the trip execution and the associated plan. This action cannot be undone from the UI.
              </p>
              <div>
                <label className="label">Reason (optional)</label>
                <input className="input" placeholder="e.g. Duplicate entry, Wrong tanker..."
                  value={cancelReason} onChange={e => setCancelReason(e.target.value)}/>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowCancelModal(false)} className="btn-secondary">Back</button>
              <button onClick={() => cancelMut.mutate()} disabled={cancelMut.isPending}
                className="btn-danger flex items-center gap-1.5">
                {cancelMut.isPending ? <RefreshCw size={13} className="animate-spin"/> : <XCircle size={13}/>}
                Confirm Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
