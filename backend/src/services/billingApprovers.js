// services/billingApprovers.js
// The billing run's L1 / L2 / L3 approvers (BILLING_APPROVER_1..3), shared by
// billing runs and the tanker utilisation approval (migration 074, owner
// 2026-10-16), plus the billing-only QA mail divert (BILLING_EMAIL_REDIRECT).
const { query } = require('../config/db');
const { createTransport: baseTransport } = require('../config/mailer');

const APPROVERS = [
  // title: salutation in the utilisation approval mails (owner, 2026-10-17).
  { level: 1, email: process.env.BILLING_APPROVER_1 || 'Mahesh.k@shreejamilk.com',      name: 'Mahesh K',       title: process.env.BILLING_APPROVER_1_TITLE || 'Sir' },
  { level: 2, email: process.env.BILLING_APPROVER_2 || 'krithiga.a@shreejamilk.com',    name: 'Krithiga A',     title: process.env.BILLING_APPROVER_2_TITLE || 'Madam' },
  { level: 3, email: process.env.BILLING_APPROVER_3 || 'Thimmappa.sura@shreejamilk.com', name: 'Thimmappa Sura', title: process.env.BILLING_APPROVER_3_TITLE || 'Sir' },
];
const approverFor = level => APPROVERS.find(a => a.level === level) || null;

// Portal user of a level's approver: the active user whose email matches.
async function approverUser(level) {
  const a = approverFor(level);
  if (!a) return null;
  const r = await query('SELECT id, user_id, full_name, email FROM users WHERE LOWER(email)=LOWER($1) AND is_active=TRUE ORDER BY id LIMIT 1', [a.email]);
  return r.rows[0] || null;
}

const billingTransport = () => baseTransport(process.env.BILLING_EMAIL_REDIRECT);

module.exports = { APPROVERS, approverFor, approverUser, billingTransport };
