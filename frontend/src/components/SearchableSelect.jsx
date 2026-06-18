// frontend/src/components/SearchableSelect.jsx
import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';

/**
 * props:
 *   options      – [{ value, label }]
 *   value        – current selected value (string/number, '' = none)
 *   onChange     – (value) => void
 *   placeholder  – string
 *   className    – extra class for the wrapper
 *   disabled     – bool
 */
export default function SearchableSelect({
  options = [], value, onChange, placeholder = 'Select…',
  className = '', disabled = false
}) {
  const [open, setOpen]     = useState(false);
  const [query, setQuery]   = useState('');
  const wrapRef             = useRef(null);
  const inputRef            = useRef(null);

  const selected = options.find(o => String(o.value) === String(value));

  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const select = (opt) => {
    onChange(opt.value);
    setOpen(false);
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange('');
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        className="input w-full flex items-center justify-between gap-1 pr-2 text-left"
        style={{ minHeight: 36 }}>
        <span className={`truncate flex-1 ${selected ? '' : 'text-gray-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="flex items-center gap-0.5 shrink-0">
          {value !== '' && value != null && (
            <span onClick={clear} className="p-0.5 rounded hover:bg-gray-200 text-gray-400">
              <X size={11}/>
            </span>
          )}
          <ChevronDown size={13} className="text-gray-400"/>
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="absolute z-50 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg"
          style={{ maxHeight: 260, display: 'flex', flexDirection: 'column' }}>
          <div className="p-1.5 border-b border-gray-100">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to search…"
              className="w-full px-2 py-1 text-sm border border-gray-200 rounded focus:outline-none focus:border-blue-400"
              onKeyDown={e => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter' && filtered.length === 1) select(filtered[0]);
              }}
            />
          </div>
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-400">No results</div>
            ) : filtered.map(opt => (
              <div
                key={opt.value}
                onMouseDown={() => select(opt)}
                className={`px-3 py-1.5 text-sm cursor-pointer hover:bg-blue-50 ${
                  String(opt.value) === String(value) ? 'bg-blue-50 font-medium text-blue-700' : ''
                }`}>
                {opt.label}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
