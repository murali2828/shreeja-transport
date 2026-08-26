// Public (no-login) billing decision page, reached from approval emails:
//   /billing-decision?token=...&decision=reject   → remarks MANDATORY
//   /billing-decision?token=...&decision=approve  → remarks optional
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { fmtDate } from '../../utils/date';

const nf = v => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function BillingDecision() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const decision = params.get('decision') === 'approve' ? 'approve' : 'reject';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [remarks, setRemarks] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError('This link is malformed — no token present.'); return; }
    axios.get('/api/billing/decision-info', { params: { token } })
      .then(r => setInfo(r.data))
      .catch(e => setError(e.response?.data?.error || 'This link is invalid or was superseded by a resubmission.'));
  }, [token]);

  const submit = () => {
    if (decision === 'reject' && !remarks.trim()) { setError('Remarks are mandatory for rejection.'); return; }
    setBusy(true); setError('');
    axios.post('/api/billing/decide', { token, decision, remarks: remarks.trim() })
      .then(r => setDone(r.data.message))
      .catch(e => setError(e.response?.data?.error || 'Failed to record the decision.'))
      .finally(() => setBusy(false));
  };

  const isReject = decision === 'reject';
  const accent = isReject ? '#dc2626' : '#16a34a';

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'linear-gradient(145deg,#0078d4,#72c7eb)', fontFamily: 'Segoe UI, sans-serif', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '32px 36px', maxWidth: 520, width: '100%',
                    boxShadow: '0 8px 30px rgba(0,60,120,0.2)' }}>
        {done ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40 }}>{isReject ? '🚫' : '✅'}</div>
            <h2 style={{ color: accent, margin: '12px 0 8px' }}>{isReject ? 'Rejection recorded' : 'Approved'}</h2>
            <p style={{ color: '#4b5563', fontSize: 14 }}>{done}</p>
            <p style={{ color: '#9ca3af', fontSize: 12 }}>You may close this window.</p>
          </div>
        ) : error && !info ? (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40 }}>ℹ️</div>
            <h2 style={{ color: '#6b7280', margin: '12px 0 8px' }}>Link not usable</h2>
            <p style={{ color: '#4b5563', fontSize: 14 }}>{error}</p>
          </div>
        ) : (
          <>
            <h2 style={{ color: accent, margin: '0 0 4px' }}>
              {isReject ? 'Reject' : 'Approve'} Tanker Payment
            </h2>
            {info && (
              <p style={{ color: '#4b5563', fontSize: 14, margin: '0 0 14px' }}>
                Billing Run <b>#{info.run_id}</b> · {fmtDate(info.from_date)} → {fmtDate(info.to_date)}<br/>
                Total payable: <b>₹ {nf(info.total_amount)}</b> · You are the Level {info.level} approver
              </p>
            )}
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
              Remarks {isReject ? <span style={{ color: '#dc2626' }}>(mandatory)</span> : '(optional)'}
            </label>
            <textarea rows={4} value={remarks} onChange={e => setRemarks(e.target.value)}
              placeholder={isReject ? 'State the reason for rejection…' : 'Any note for the record (optional)…'}
              style={{ width: '100%', marginTop: 6, padding: 10, borderRadius: 10, border: '1px solid #d1d5db',
                       fontSize: 14, fontFamily: 'inherit', boxSizing: 'border-box' }}/>
            {error && <p style={{ color: '#dc2626', fontSize: 13 }}>{error}</p>}
            <button onClick={submit} disabled={busy || (info && info.status !== 'pending')}
              style={{ marginTop: 14, width: '100%', background: accent, color: '#fff', border: 'none',
                       padding: '12px 0', borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: 'pointer',
                       opacity: busy ? 0.6 : 1 }}>
              {busy ? 'Recording…' : isReject ? 'CONFIRM REJECTION' : 'CONFIRM APPROVAL'}
            </button>
            {info && info.status !== 'pending' && (
              <p style={{ color: '#b45309', fontSize: 13, marginTop: 10 }}>
                This approval is currently “{info.status}” — the link may have been actioned already.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
