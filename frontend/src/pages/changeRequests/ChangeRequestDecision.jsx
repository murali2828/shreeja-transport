// Public (no-login) change-request decision page, reached from approval emails:
//   /change-request-decision?token=...&decision=reject   → remarks optional (note)
//   /change-request-decision?token=...&decision=approve  → remarks optional (note)
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { fmtDate } from '../../utils/date';

export default function ChangeRequestDecision() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const decision = params.get('decision') === 'reject' ? 'reject' : 'approve';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [remarks, setRemarks] = useState('');
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError('This link is malformed — no token present.'); return; }
    axios.get('/api/change-requests/decision-info', { params: { token } })
      .then(r => setInfo(r.data))
      .catch(e => setError(e.response?.data?.error || 'This link is invalid or was superseded.'));
  }, [token]);

  const submit = () => {
    setBusy(true); setError('');
    axios.post('/api/change-requests/decide', { token, decision, remarks: remarks.trim() })
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
            <h2 style={{ color: accent, margin: '12px 0 8px' }}>{isReject ? 'Rejected' : 'Approved'}</h2>
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
              {isReject ? 'Reject' : 'Approve'} Change Request
            </h2>
            {info && (
              <p style={{ color: '#4b5563', fontSize: 14, margin: '0 0 14px' }}>
                Change Request <b>#{info.id}</b> — Trip #{info.trip_no} · {info.tanker_number || '—'}
                {info.execution_date ? <> · {fmtDate(info.execution_date)}</> : null}<br/>
                Requested by <b>{info.requested_by_name}</b><br/>
                Reason: {info.reason || '—'}
              </p>
            )}
            <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
              Note (optional)
            </label>
            <textarea rows={4} value={remarks} onChange={e => setRemarks(e.target.value)}
              placeholder="Any note for the record (optional)…"
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
                This request is currently “{info.status}” — the link may have been actioned already.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
