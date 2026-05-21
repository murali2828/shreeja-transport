// frontend/src/components/MasterTable.jsx
// Shared UI primitives — Shreeja Platform Theme
import { useState } from 'react';
import { X, Check, RefreshCw, Plus } from 'lucide-react';

export function Modal({ title, onClose, children, footer, size = '' }) {
  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={`modal-box ${size === 'lg' ? 'max-w-2xl' : size === 'xl' ? 'max-w-4xl' : ''}`}>
        <div className="modal-header">
          <span>{title}</span>
          <button
            onClick={onClose}
            className="btn-secondary btn-sm p-1.5">
            <X size={14}/>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ActiveBadge({ active }) {
  return (
    <span className={active ? 'badge badge-published' : 'badge'
      + (!active ? ' bg-gray-100 text-gray-500' : '')}>
      {active ? 'Active' : 'Inactive'}
    </span>
  );
}

export function Field({ label, required, children }) {
  return (
    <div className="mb-3">
      <label className="label">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

export function SaveButton({ pending, isEdit, onClick }) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onClick}
      className="btn-primary flex items-center gap-1.5 min-w-[80px] justify-center">
      {pending
        ? <><RefreshCw size={13} className="animate-spin"/> Saving…</>
        : <><Check size={13}/> {isEdit ? 'Update' : 'Save'}</>}
    </button>
  );
}

export function EmptyState({ message }) {
  return (
    <tr>
      <td colSpan={100}>
        <div className="empty-state">{message}</div>
      </td>
    </tr>
  );
}

export function LoadingState() {
  return (
    <tr>
      <td colSpan={100}>
        <div className="empty-state">Loading…</div>
      </td>
    </tr>
  );
}

export function PageHeader({ title, subtitle, onAdd, addLabel = 'Add New', extra }) {
  return (
    <div className="page-header">
      <div>
        <div className="page-title">{title}</div>
        {subtitle && <div className="page-sub">{subtitle}</div>}
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        {extra}
        {onAdd && (
          <button onClick={onAdd} className="btn-primary flex items-center gap-1.5 text-sm">
            <Plus size={14}/> {addLabel}
          </button>
        )}
      </div>
    </div>
  );
}
