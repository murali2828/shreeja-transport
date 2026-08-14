-- 027: Security audit 2026-08 — the seeded default admin (migration 001) ships
-- with a publicly documented password. Force a password change on first login
-- if that account still uses the seeded hash.
UPDATE users
SET must_change_password = TRUE
WHERE username = 'admin'
  AND password_hash = '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi';
