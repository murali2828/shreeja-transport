CREATE TABLE IF NOT EXISTS plan_email_configs (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(150) NOT NULL UNIQUE,
  name       VARCHAR(100),
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
