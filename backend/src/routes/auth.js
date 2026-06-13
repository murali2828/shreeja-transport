// backend/src/routes/auth.js
const express    = require('express');
const router     = express.Router();
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const { query }  = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

// Ensure must_change_password column exists
query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE`)
  .catch(err => console.error('Migration error (must_change_password):', err.message));

// Ensure password_reset_tokens table exists
query(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`).catch(err => console.error('Migration error (password_reset_tokens):', err.message));

function getEmailTransporter() {
  return {
    transporter: nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    }),
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
  };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  try {
    const r = await query(
      'SELECT * FROM users WHERE username=$1 AND is_active=TRUE', [username]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const mustChange = !!user.must_change_password;
    const token = jwt.sign(
      { id: user.id, role: user.role, full_name: user.full_name, must_change_password: mustChange },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role, must_change_password: mustChange } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  try {
    const r = await query(
      'SELECT id, username, full_name, role, email FROM users WHERE id=$1', [req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/auth/users
router.get('/users', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await query(
      'SELECT id, username, full_name, role, email, is_active FROM users ORDER BY full_name'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const VALID_ROLES = ['admin', 'planner', 'executor', 'viewer'];

// POST /api/auth/users
router.post('/users', authenticate, authorize('admin'), async (req, res) => {
  const { username, password, full_name, role, email } = req.body;
  if (!username || !password || !full_name || !role)
    return res.status(400).json({ error: 'username, password, full_name, role required' });
  if (!VALID_ROLES.includes(role))
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      'INSERT INTO users (username, password_hash, full_name, role, email, must_change_password) VALUES ($1,$2,$3,$4,$5,TRUE) RETURNING id, username, full_name, role, email, must_change_password',
      [username, hash, full_name, role, email || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/users/:id
router.put('/users/:id', authenticate, authorize('admin'), async (req, res) => {
  const { full_name, role, email, is_active, password } = req.body;
  if (role && !VALID_ROLES.includes(role))
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  try {
    let passwordClause = '';
    const params = [full_name, role, email || null, is_active ?? true, req.params.id];
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      passwordClause = ', password_hash=$6, must_change_password=TRUE';
      params.splice(4, 0, hash);
      params[params.length - 1] = req.params.id;
    }
    const r = await query(
      `UPDATE users SET full_name=$1, role=$2, email=$3, is_active=$4${passwordClause}
       WHERE id=$${params.length} RETURNING id, username, full_name, role, email, is_active`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const r = await query('SELECT id, email FROM users WHERE email=$1 AND is_active=TRUE', [email]);
    // Always respond OK to avoid email enumeration
    if (!r.rows.length) return res.json({ ok: true });
    const user = r.rows[0];

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1,$2,$3)',
      [user.id, token, expiresAt]
    );

    const resetLink = `https://tms.shreejamilk.com/reset-password?token=${token}`;

    try {
      const { transporter, from } = getEmailTransporter();
      await transporter.sendMail({
        from,
        to:      user.email,
        subject: 'Shreeja TMS — Password Reset',
        text:    `You requested a password reset. Use the link below (valid for 1 hour):\n\n${resetLink}\n\nIf you did not request this, ignore this email.`,
        html:    `<p>You requested a password reset for your Shreeja TMS account.</p>
                  <p><a href="${resetLink}" style="color:#0078d4">Reset your password</a></p>
                  <p>This link expires in <strong>1 hour</strong>. If you did not request this, ignore this email.</p>
                  <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
                  <p style="font-family:sans-serif;font-size:12px;color:#9ca3af;">This is an automated message from Shreeja TMS · Developed &amp; maintained by <strong style="color:#6b7280;">Shreeja IT Team</strong>.</p>`,
      });
    } catch (mailErr) {
      console.error('Password reset email error (nodemailer):', mailErr);
      return res.status(500).json({ error: 'Failed to send reset email. Contact administrator.' });
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) return res.status(400).json({ error: 'token and new_password required' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const r = await query(
      `SELECT prt.*, u.id AS uid FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token=$1 AND prt.used=FALSE AND prt.expires_at > NOW()`,
      [token]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const row = r.rows[0];

    const hash = await bcrypt.hash(new_password, 10);
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, row.uid]);
    await query('UPDATE password_reset_tokens SET used=TRUE WHERE id=$1', [row.id]);

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/auth/change-password  (authenticated — for forced password change)
router.post('/change-password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const r = await query('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = r.rows[0];
    const match = await bcrypt.compare(current_password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    await query(
      'UPDATE users SET password_hash=$1, must_change_password=FALSE WHERE id=$2',
      [hash, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
