// backend/src/routes/auth.js
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

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
    const token = jwt.sign(
      { id: user.id, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
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

// POST /api/auth/users
router.post('/users', authenticate, authorize('admin'), async (req, res) => {
  const { username, password, full_name, role, email } = req.body;
  if (!username || !password || !full_name || !role)
    return res.status(400).json({ error: 'username, password, full_name, role required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      'INSERT INTO users (username, password_hash, full_name, role, email) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, full_name, role, email',
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
  try {
    let passwordClause = '';
    const params = [full_name, role, email || null, is_active ?? true, req.params.id];
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      passwordClause = ', password_hash=$6';
      params.splice(4, 0, hash);
      params[params.length - 1] = req.params.id;
    }
    const r = await query(
      `UPDATE users SET full_name=$1, role=$2, email=$3, is_active=$4${passwordClause}, updated_at=NOW()
       WHERE id=$${params.length} RETURNING id, username, full_name, role, email, is_active`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
