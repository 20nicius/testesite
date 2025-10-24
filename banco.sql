-- Tabela de usuários
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  token TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de configurações por usuário
CREATE TABLE IF NOT EXISTS config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(user_email, key),
  FOREIGN KEY(user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Tabela de leituras dos sensores
CREATE TABLE IF NOT EXISTS leituras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  temp REAL NOT NULL CHECK (temp BETWEEN -50 AND 80),
  umidAr REAL NOT NULL CHECK (umidAr BETWEEN 0 AND 100),
  umidSolo REAL NOT NULL CHECK (umidSolo BETWEEN 0 AND 100),
  gasInflamavel REAL NOT NULL CHECK (gasInflamavel BETWEEN 0 AND 100),
  gasToxico REAL NOT NULL CHECK (gasToxico BETWEEN 0 AND 100),
  estaChovendo INTEGER NOT NULL CHECK (estaChovendo IN (0,1)),
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Tabela de subscriptions para notificações push
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Tabela de log de notificações enviadas
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT,
  subscription_id INTEGER,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  success BOOLEAN DEFAULT 1,
  error_message TEXT,
  FOREIGN KEY(user_email) REFERENCES users(email) ON DELETE SET NULL,
  FOREIGN KEY(subscription_id) REFERENCES push_subscriptions(id) ON DELETE SET NULL
);

-- Tabela de configurações de notificação por usuário
CREATE TABLE IF NOT EXISTS user_notification_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL UNIQUE,
  push_enabled BOOLEAN DEFAULT 1,
  daily_reports BOOLEAN DEFAULT 0,

  -- Umidade
  humidity_alerts_enabled BOOLEAN DEFAULT 1,
  humidity_min INTEGER DEFAULT 30,
  humidity_max INTEGER DEFAULT 80,
  soil_humidity_min INTEGER DEFAULT 20,
  soil_humidity_max INTEGER DEFAULT 90,

  -- Temperatura
  temperature_alerts_enabled BOOLEAN DEFAULT 1,
  temperature_min INTEGER DEFAULT 10,
  temperature_max INTEGER DEFAULT 35,

  -- Chuva
  rain_alerts_enabled BOOLEAN DEFAULT 1,
  rain_start_alert BOOLEAN DEFAULT 1,
  rain_stop_alert BOOLEAN DEFAULT 0,
  no_rain_days INTEGER DEFAULT 7,

  -- Gases
  gas_alerts_enabled BOOLEAN DEFAULT 1,
  inflammable_gas_threshold INTEGER DEFAULT 20,
  toxic_gas_threshold INTEGER DEFAULT 15,
  critical_gas_alert BOOLEAN DEFAULT 1,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_email) REFERENCES users(email) ON DELETE CASCADE
);

-- Tabela de tentativas de login (criação idempotente)
CREATE TABLE IF NOT EXISTS login_tentativas (
  email TEXT NOT NULL,
  tipo TEXT NOT NULL, -- 'login' ou 'codigo'
  tentativas INTEGER DEFAULT 0,
  bloqueado_ate DATETIME,
  atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Remover duplicatas para permitir criação de índice único
DELETE FROM login_tentativas
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM login_tentativas GROUP BY email, tipo
);

-- Índice único para suportar UPSERT em (email, tipo)
CREATE UNIQUE INDEX IF NOT EXISTS idx_login_tentativas_email_tipo
ON login_tentativas (email, tipo);
