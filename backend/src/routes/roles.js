// backend/src/routes/roles.js
// Admin-only management of DB-backed roles and their per-module permissions.
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, authorize, MODULES } = require('../middleware/auth');

const NAME_RE = /^[a-z0-9_]+$/;

function normalizePermissions(input) {
  const perms = {};
  const src = input && typeof input === 'object' ? input : {};
  const unknown = Object.keys(src).filter(k => !MODULES.includes(k));
  if (unknown.length) return { error: `Unknown permission key(s): ${unknown.join(', ')}` };
  for (const m of MODULES) perms[m] = src[m] === true;
  return { perms };
}

// GET /api/roles
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await query('SELECT * FROM roles ORDER BY is_system DESC, label');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/roles
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  const { name, label, permissions } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label required' });
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'name may contain only lowercase letters, numbers, and underscore (no spaces)' });
  const { perms, error } = normalizePermissions(permissions);
  if (error) return res.status(400).json({ error });
  try {
    const r = await query(
      'INSERT INTO roles (name, label, is_system, permissions) VALUES ($1,$2,FALSE,$3) RETURNING *',
      [name, label, JSON.stringify(perms)]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Role name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/roles/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { label, permissions } = req.body;
  const { perms, error } = normalizePermissions(permissions);
  if (error) return res.status(400).json({ error });
  try {
    const existing = await query('SELECT * FROM roles WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Role not found' });
    const sets = ['permissions = $1', 'updated_at = NOW()'];
    const params = [JSON.stringify(perms)];
    if (label !== undefined) {
      params.push(label);
      sets.push(`label = $${params.length}`);
    }
    params.push(req.params.id);
    const r = await query(
      `UPDATE roles SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/roles/:id
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const existing = await query('SELECT * FROM roles WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Role not found' });
    const role = existing.rows[0];
    if (role.is_system) return res.status(400).json({ error: 'Built-in roles cannot be deleted' });
    const used = await query('SELECT COUNT(*)::int AS n FROM users WHERE role = $1', [role.name]);
    const n = used.rows[0].n;
    if (n > 0) return res.status(400).json({ error: `${n} user(s) still have this role — reassign them first` });
    await query('DELETE FROM roles WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
