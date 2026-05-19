-- Dairy Transport Management System - Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','planner','executor')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Tanker Master
CREATE TABLE tankers (
  id SERIAL PRIMARY KEY,
  tanker_number VARCHAR(20) UNIQUE NOT NULL,
  compartments INTEGER NOT NULL CHECK (compartments IN (2,3)),
  capacity_litres INTEGER NOT NULL,
  per_km_rate NUMERIC(8,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- BMCU Master
CREATE TABLE bmcus (
  id SERIAL PRIMARY KEY,
  bmcu_code VARCHAR(10) UNIQUE NOT NULL,
  bmcu_name VARCHAR(100) NOT NULL,
  address TEXT,
  district VARCHAR(50),
  state VARCHAR(50),
  contact VARCHAR(15),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Starting Points Master
CREATE TABLE starting_points (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  location TEXT,
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Testing Points Master
CREATE TABLE testing_points (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  location TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Delivery Points (Processing Plants)
CREATE TABLE delivery_points (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  receiver_name VARCHAR(100),
  location TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Route Masters
CREATE TABLE route_masters (
  id SERIAL PRIMARY KEY,
  route_name VARCHAR(100) NOT NULL,
  start_point_id INTEGER REFERENCES starting_points(id),
  testing_point_id INTEGER REFERENCES testing_points(id),
  delivery_point_id INTEGER REFERENCES delivery_points(id),
  distance_km NUMERIC(8,2),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Route BMCU sequence
CREATE TABLE route_bmcus (
  id SERIAL PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES route_masters(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,
  bmcu_id INTEGER NOT NULL REFERENCES bmcus(id),
  UNIQUE(route_id, seq_no)
);

-- Trip Plans
CREATE TABLE trip_plans (
  id SERIAL PRIMARY KEY,
  plan_date DATE NOT NULL,
  plan_for_date DATE NOT NULL,
  trip_no INTEGER,
  route_id INTEGER REFERENCES route_masters(id),
  tanker_id INTEGER REFERENCES tankers(id),
  start_point_id INTEGER REFERENCES starting_points(id),
  testing_point_id INTEGER REFERENCES testing_points(id),
  delivery_point_id INTEGER REFERENCES delivery_points(id),
  shifts_milk VARCHAR(20),
  expected_km NUMERIC(8,2),
  expected_utilization_pct NUMERIC(6,2),
  expected_total_qty NUMERIC(12,2),
  total_cost NUMERIC(12,2),
  per_liter_cost NUMERIC(8,4),
  driver_name VARCHAR(100),
  loader_name VARCHAR(100),
  remarks TEXT,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft','published','cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Trip Plan BMCUs
CREATE TABLE trip_plan_bmcus (
  id SERIAL PRIMARY KEY,
  trip_plan_id INTEGER NOT NULL REFERENCES trip_plans(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,
  bmcu_id INTEGER NOT NULL REFERENCES bmcus(id),
  shift_code VARCHAR(20),
  expected_qty NUMERIC(10,2)
);

-- Trip Executions
CREATE TABLE trip_executions (
  id SERIAL PRIMARY KEY,
  trip_plan_id INTEGER NOT NULL REFERENCES trip_plans(id),
  execution_date DATE NOT NULL,
  dc_number VARCHAR(50),
  actual_km NUMERIC(8,2),
  total_qty_litres NUMERIC(12,2) DEFAULT 0,
  total_qty_kgs NUMERIC(12,4) DEFAULT 0,
  avg_fat NUMERIC(6,4) DEFAULT 0,
  avg_snf NUMERIC(6,4) DEFAULT 0,
  total_kg_fat NUMERIC(12,4) DEFAULT 0,
  total_kg_snf NUMERIC(12,4) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'in_progress' CHECK (status IN ('in_progress','saved','pending_ack','closed')),
  executed_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Trip Execution BMCU rows
CREATE TABLE trip_execution_bmcus (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  seq_no INTEGER NOT NULL,
  bmcu_id INTEGER NOT NULL REFERENCES bmcus(id),
  milk_date DATE,
  shift VARCHAR(5) CHECK (shift IN ('AM','PM')),
  qty_litres NUMERIC(10,2),
  qty_kgs NUMERIC(12,4),
  fat_pct NUMERIC(6,3),
  snf_pct NUMERIC(6,3),
  kg_fat NUMERIC(12,4),
  kg_snf NUMERIC(12,4),
  description VARCHAR(30) CHECK (description IN ('RMRD','Balance Milk','Internal Shifting')),
  source_bmcu_id INTEGER REFERENCES bmcus(id),
  chamber VARCHAR(5) CHECK (chamber IN ('FC','MC','BC')),
  dps_qty_litres NUMERIC(10,2) DEFAULT 0,
  dps_qty_kgs NUMERIC(12,4) DEFAULT 0,
  rmrd_qty NUMERIC(10,2) DEFAULT 0,
  is_deleted BOOLEAN DEFAULT FALSE
);

-- Trip Acknowledgements (by chamber)
CREATE TABLE trip_acknowledgements (
  id SERIAL PRIMARY KEY,
  execution_id INTEGER NOT NULL REFERENCES trip_executions(id) ON DELETE CASCADE,
  ack_date DATE,
  chamber VARCHAR(5) NOT NULL CHECK (chamber IN ('FC','MC','BC')),
  qty_litres NUMERIC(10,2),
  qty_kgs NUMERIC(12,4),
  fat_pct NUMERIC(6,3),
  snf_pct NUMERIC(6,3),
  kg_fat NUMERIC(12,4),
  kg_snf NUMERIC(12,4),
  temperature VARCHAR(20),
  description VARCHAR(50)
);

-- Report Email Recipients
CREATE TABLE report_email_config (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_trip_plans_plan_for_date ON trip_plans(plan_for_date);
CREATE INDEX idx_trip_plans_status ON trip_plans(status);
CREATE INDEX idx_trip_executions_execution_date ON trip_executions(execution_date);
CREATE INDEX idx_trip_executions_status ON trip_executions(status);
CREATE INDEX idx_trip_execution_bmcus_execution_id ON trip_execution_bmcus(execution_id);

-- Seed default admin user (password: Admin@1234)
INSERT INTO users (username, email, password_hash, full_name, role)
VALUES ('admin', 'admin@dairy.com', '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'System Administrator', 'admin');

-- Seed sample starting points
INSERT INTO starting_points (name, location) VALUES
('Balaji Dairy', 'Chittoor, AP'),
('Bathalapalli', 'Anantapur, AP'),
('KMF Dairy (Kanakapura)', 'Kanakapura, KA'),
('Ramasudram', 'AP'),
('Milma', 'TN');

-- Seed sample testing points
INSERT INTO testing_points (name) VALUES
('Balaji Dairy Lab'),
('Field Testing Point 1'),
('Field Testing Point 2');

-- Seed sample delivery points
INSERT INTO delivery_points (name, receiver_name) VALUES
('Balaji Dairy', 'MDFVPL'),
('Milma Plant', 'Milma'),
('KMF Plant', 'KMF');
