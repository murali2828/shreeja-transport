// backend/src/routes/roles.js
// Admin-only management of DB-backed roles and their per-module permissions.
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticate, authorize, MODULES } = require('../middleware/auth');

const NAME_RE = /^[a-z0-9_]+$/;

// Per-module access level (migration 060). Accepts `access` {m: none|view|edit}
// or the older boolean `permissions` (true = edit). Returns the levels, the
// boolean mirror and the derived read_only (no module at Edit). The viewer
// role is capped at View.
const LEVELS = ['none', 'view', 'edit'];
function normalizeAccess(body, roleName) {
  const src = body.access && typeof body.access === 'object' ? body.access
    : (body.permissions && typeof body.permissions === 'object' ? body.permissions : {});
  const unknown = Object.keys(src).filter(k => !MODULES.includes(k));
  if (unknown.length) return { error: `Unknown module(s): ${unknown.join(', ')}` };
  const access = {}, perms = {};
  for (const m of MODULES) {
    let v = src[m];
    if (v === true) v = body.read_only === true ? 'view' : 'edit';
    if (!LEVELS.includes(v)) v = 'none';
    if (roleName === 'viewer' && v === 'edit') v = 'view';
    access[m] = v; perms[m] = v !== 'none';
  }
  const read_only = !Object.values(access).includes('edit');
  return { access, perms, read_only };
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
  const { name, label } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label required' });
  if (!NAME_RE.test(name)) return res.status(400).json({ error: 'name may contain only lowercase letters, numbers, and underscore (no spaces)' });
  const { access, perms, read_only, error } = normalizeAccess(req.body, name);
  if (error) return res.status(400).json({ error });
  try {
    const r = await query(
      'INSERT INTO roles (name, label, is_system, permissions, access, read_only) VALUES ($1,$2,FALSE,$3,$4,$5) RETURNING *',
      [name, label, JSON.stringify(perms), JSON.stringify(access), read_only]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Role name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/roles/:id
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { label } = req.body;
  try {
    const existing = await query('SELECT * FROM roles WHERE id=$1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Role not found' });
    const { access, perms, read_only, error } = normalizeAccess(req.body, existing.rows[0].name);
    if (error) return res.status(400).json({ error });
    const sets = ['permissions = $1', 'access = $2', 'read_only = $3', 'updated_at = NOW()'];
    const params = [JSON.stringify(perms), JSON.stringify(access), read_only];
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
