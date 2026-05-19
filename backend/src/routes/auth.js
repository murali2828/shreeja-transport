const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const { authenticate } = require('../middleware/auth');

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const result = await query('SELECT * FROM users WHERE username=$1 AND is_active=TRUE', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await query('SELECT id,username,email,full_name,role FROM users WHERE id=$1', [req.user.id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: manage users
router.get('/users', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const result = await query('SELECT id,username,email,full_name,role,is_active,created_at FROM users ORDER BY id');
  res.json(result.rows);
});

router.post('/users', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, email, password, full_name, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      'INSERT INTO users(username,email,password_hash,full_name,role) VALUES($1,$2,$3,$4,$5) RETURNING id,username,email,full_name,role',
      [username, email, hash, full_name, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/users/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { full_name, email, role, is_active, password } = req.body;
  try {
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await query('UPDATE users SET full_name=$1,email=$2,role=$3,is_active=$4,password_hash=$5 WHERE id=$6',
        [full_name, email, role, is_active, hash, req.params.id]);
    } else {
      await query('UPDATE users SET full_name=$1,email=$2,role=$3,is_active=$4 WHERE id=$5',
        [full_name, email, role, is_active, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
