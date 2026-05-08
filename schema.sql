-- ================================================================
--  AdsCash Database Schema
--  Run this in MySQL: mysql -u root -p adscash < schema.sql
-- ================================================================

CREATE DATABASE IF NOT EXISTS adscash CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE adscash;

-- ── USERS ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  uid            VARCHAR(20) NOT NULL UNIQUE,
  username       VARCHAR(50) NOT NULL UNIQUE,
  email          VARCHAR(100) NOT NULL UNIQUE,
  phone          VARCHAR(20),
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(100) NOT NULL,
  balance        DECIMAL(10,4) DEFAULT 0.0000,
  total_ads      INT DEFAULT 0,
  ads_today      INT DEFAULT 0,
  last_ad_time   DATETIME,
  last_ad_date   DATE,
  referral_code  VARCHAR(20) NOT NULL UNIQUE,
  referred_by    INT DEFAULT NULL,
  ref_earnings   DECIMAL(10,4) DEFAULT 0.0000,
  total_earned   DECIMAL(10,4) DEFAULT 0.0000,
  status         ENUM('active','banned') DEFAULT 'active',
  is_admin       TINYINT(1) DEFAULT 0,
  join_date      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL
);

-- ── TASKS (ADS) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  title       VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  duration    INT NOT NULL DEFAULT 30,   -- seconds
  reward      DECIMAL(6,4) NOT NULL DEFAULT 0.1000,
  emoji       VARCHAR(10) DEFAULT '📺',
  category    VARCHAR(50),
  active      TINYINT(1) DEFAULT 1,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── WATCH LOG ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watch_log (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  task_id    INT NOT NULL,
  earned     DECIMAL(6,4) NOT NULL,
  watched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE KEY unique_daily_watch (user_id, task_id, watched_at)
);

-- ── WITHDRAWALS ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  amount     DECIMAL(10,4) NOT NULL,
  method     ENUM('bank','bitcoin','usdt') NOT NULL,
  details    JSON NOT NULL,
  status     ENUM('pending','approved','rejected') DEFAULT 'pending',
  note       TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── REFERRALS ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  referrer_id INT NOT NULL,
  referred_id INT NOT NULL UNIQUE,
  bonus_paid  DECIMAL(6,4) DEFAULT 0.2000,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (referred_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── TRANSACTIONS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  type        ENUM('earn','withdrawal','referral','reset','forfeit','refund') NOT NULL,
  amount      DECIMAL(10,4) DEFAULT 0.0000,
  description VARCHAR(255),
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ── DEFAULT ADMIN ─────────────────────────────────────────────────
-- Password: admin2025 (bcrypt hashed)
INSERT IGNORE INTO users (uid, username, email, password_hash, name, referral_code, status, is_admin, join_date)
VALUES (
  'ADMIN001',
  'eesha10',
  'ola068527@gmail.com',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- placeholder, run: node -e "const b=require('bcryptjs');b.hash('admin2025',10).then(console.log)"
  'Admin',
  'ADMIN0000',
  'active',
  1,
  NOW()
);

-- ── DEFAULT TASKS ─────────────────────────────────────────────────
INSERT IGNORE INTO tasks (title, description, duration, reward, emoji, category) VALUES
('Watch Brand Commercial','30-second product advertisement',30,0.10,'📺','Brand'),
('App Download Promo','Explore a new mobile app',35,0.10,'📱','App'),
('E-commerce Ad','Discover amazing online deals',30,0.10,'🛍️','Shopping'),
('Finance Service Ad','Learn about banking solutions',40,0.10,'🏦','Finance'),
('Gaming Ad','Check out this exciting game',30,0.10,'🎮','Gaming'),
('Food Delivery Promo','Order food at great discounts',25,0.10,'🍔','Food'),
('Crypto Exchange Ad','Trade crypto with ease',35,0.10,'₿','Crypto'),
('Health App Promo','Stay healthy with this app',30,0.10,'💊','Health'),
('Travel Deals Ad','Book amazing travel deals',40,0.10,'✈️','Travel'),
('Education Platform','Learn skills online',30,0.10,'📚','Education'),
('Sports Betting Promo','Bet and win big',35,0.10,'⚽','Sports'),
('Fashion Brand Ad','Trendy clothes and accessories',30,0.10,'👗','Fashion'),
('Streaming Service','Watch movies and shows',30,0.10,'🎬','Entertainment'),
('Insurance Ad','Protect what matters',40,0.10,'🛡️','Insurance'),
('Telecom Promo','Best data and call plans',30,0.10,'📶','Telecom'),
('Real Estate Ad','Find your dream home',45,0.10,'🏠','Realty'),
('Ride Share Promo','Get around faster',30,0.10,'🚗','Transport'),
('Online Course Ad','Upgrade your skills',35,0.10,'🎓','Education'),
('VPN Service Ad','Browse securely',30,0.10,'🔐','Tech'),
('Solar Energy Promo','Go green and save money',40,0.10,'☀️','Energy');

-- ── INDEXES ───────────────────────────────────────────────────────
CREATE INDEX idx_watch_log_user_date ON watch_log(user_id, watched_at);
CREATE INDEX idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);
