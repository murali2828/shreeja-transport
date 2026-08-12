// backend/src/config/mailer.js
// Single shared mailer. createTransport() sends normally. Callers that want
// their mails divertible on QA pass a redirect address:
//   createTransport(process.env.BILLING_EMAIL_REDIRECT)
// When that address is set, every mail sent through THAT transport goes to it
// instead of the real recipients (originals noted in the subject prefix and
// an X-Original-To header). Other modules are unaffected.
const nodemailer = require('nodemailer');

function createTransport(redirectTo) {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const redirect = (redirectTo || '').trim();
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
    console.log(`[mailer] redirect active — "${mail.subject}" diverted from (${orig}) to ${redirect}`);
    return realSend(diverted, cb);
  };
  return transporter;
}

module.exports = { createTransport };
