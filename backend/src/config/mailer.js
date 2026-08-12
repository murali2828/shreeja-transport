// backend/src/config/mailer.js
// Single shared mailer. If EMAIL_REDIRECT_ALL is set (QA environments), EVERY
// outgoing email is diverted to that address instead of the real recipients —
// the original To/Cc/Bcc are noted in the subject and an X-header so the flow
// can still be verified end-to-end without disturbing real users.
const nodemailer = require('nodemailer');

function createTransport() {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const redirect = (process.env.EMAIL_REDIRECT_ALL || '').trim();
  if (!redirect) return transporter;

  const realSend = transporter.sendMail.bind(transporter);
  transporter.sendMail = (mail, cb) => {
    const orig = [mail.to, mail.cc, mail.bcc].filter(Boolean)
      .map(v => Array.isArray(v) ? v.join(', ') : v).join('; ');
    const diverted = {
      ...mail,
      to: redirect,
      cc: undefined,
      bcc: undefined,
      subject: `[QA→${orig}] ${mail.subject || ''}`,
      headers: { ...(mail.headers || {}), 'X-Original-To': orig },
    };
    console.log(`[mailer] EMAIL_REDIRECT_ALL active — "${mail.subject}" diverted from (${orig}) to ${redirect}`);
    return realSend(diverted, cb);
  };
  return transporter;
}

module.exports = { createTransport };
