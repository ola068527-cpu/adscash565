// ================================================================
//  AdsCash Backend - Node.js + Express + MySQL
//  Install: npm install express mysql2 bcryptjs jsonwebtoken cors dotenv
//  Run: node server.js
// ================================================================
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serve index.html from /public

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'adscash_secret_2025_change_this';

// ── DB POOL ──────────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'adscash',
  waitForConnections: true,
  connectionLimit: 10,
});

// ── AUTH MIDDLEWARE ───────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// ── HELPER ────────────────────────────────────────────────────────
function genUID() { return 'AC' + Math.random().toString(36).substr(2, 8).toUpperCase(); }
function genRefCode(username) { return username.toUpperCase().substr(0, 4) + Math.floor(1000 + Math.random() * 9000); }

// ─────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────────────

// REGISTER
app.post('/api/register', async (req, res) => {
  const { name, username, email, phone, password, referralCode } = req.body;
  if (!name || !username || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Invalid username format' });

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE username=? OR email=?', [username, email]);
    if (existing.length) return res.status(400).json({ error: 'Username or email already exists' });

    let referredBy = null;
    if (referralCode) {
      const [refRows] = await pool.query('SELECT id FROM users WHERE referral_code=?', [referralCode]);
      if (!refRows.length) return res.status(400).json({ error: 'Invalid referral code' });
      referredBy = refRows[0].id;
    }

    const uid = genUID();
    const hashed = await bcrypt.hash(password, 10);
    const refCode = genRefCode(username);

    await pool.query(
      `INSERT INTO users (uid, username, email, phone, password_hash, name, referral_code, referred_by, status, is_admin, join_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
      [uid, username, email, phone || null, hashed, name, refCode, referredBy, 'active', 0]
    );

    res.json({ success: true, message: 'Account created!' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// LOGIN
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username=? OR email=?', [identifier, identifier]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const u = rows[0];
    if (u.status === 'banned') return res.status(403).json({ error: 'Account banned. Contact support.' });
    const valid = await bcrypt.compare(password, u.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Check 72h reset
    await check72hReset(u.id);

    const token = jwt.sign({ id: u.id, uid: u.uid, username: u.username, isAdmin: !!u.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    const [fresh] = await pool.query('SELECT * FROM users WHERE id=?', [u.id]);
    res.json({ token, user: sanitizeUser(fresh[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// GET CURRENT USER
app.get('/api/me', auth, async (req, res) => {
  try {
    await check72hReset(req.user.id);
    const [rows] = await pool.query('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(sanitizeUser(rows[0]));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────
//  ADS ROUTES
// ─────────────────────────────────────────────────────────────────

// GET TASKS
app.get('/api/tasks', auth, async (req, res) => {
  try {
    const [tasks] = await pool.query('SELECT * FROM tasks WHERE active=1 ORDER BY id');
    // Get today's watched ads by this user
    const today = new Date().toISOString().split('T')[0];
    const [watched] = await pool.query(
      'SELECT task_id FROM watch_log WHERE user_id=? AND DATE(watched_at)=?',
      [req.user.id, today]
    );
    const watchedIds = watched.map(w => w.task_id);
    res.json({ tasks, watchedIds });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// WATCH AD
app.post('/api/watch-ad', auth, async (req, res) => {
  const { taskId } = req.body;
  try {
    const [userRows] = await pool.query('SELECT * FROM users WHERE id=?', [req.user.id]);
    const u = userRows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.status === 'banned') return res.status(403).json({ error: 'Account banned' });

    // Check daily limit
    const today = new Date().toISOString().split('T')[0];
    const [countRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM watch_log WHERE user_id=? AND DATE(watched_at)=?',
      [u.id, today]
    );
    if (countRows[0].cnt >= 20) return res.status(400).json({ error: 'Daily limit reached (20 ads/day)' });

    // Check not already watched today
    const [alreadyRows] = await pool.query(
      'SELECT id FROM watch_log WHERE user_id=? AND task_id=? AND DATE(watched_at)=?',
      [u.id, taskId, today]
    );
    if (alreadyRows.length) return res.status(400).json({ error: 'Already watched this ad today' });

    // Get task
    const [taskRows] = await pool.query('SELECT * FROM tasks WHERE id=? AND active=1', [taskId]);
    if (!taskRows.length) return res.status(404).json({ error: 'Task not found' });
    const task = taskRows[0];

    // Record watch
    await pool.query(
      'INSERT INTO watch_log (user_id, task_id, earned, watched_at) VALUES (?,?,?,NOW())',
      [u.id, taskId, task.reward]
    );

    // Update user balance
    await pool.query(
      'UPDATE users SET balance=balance+?, total_ads=total_ads+1, ads_today=ads_today+1, last_ad_time=NOW() WHERE id=?',
      [task.reward, u.id]
    );

    // Add transaction
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?,?,?,?,NOW())',
      [u.id, 'earn', task.reward, 'Ad watched: ' + task.title]
    );

    // Check referral bonus (at 5 ads)
    const newTotal = (u.total_ads || 0) + 1;
    if (newTotal === 5 && u.referred_by) {
      const [refCheck] = await pool.query(
        'SELECT id FROM referrals WHERE referrer_id=? AND referred_id=?',
        [u.referred_by, u.id]
      );
      if (!refCheck.length) {
        await pool.query(
          'UPDATE users SET balance=balance+0.20, ref_earnings=ref_earnings+0.20 WHERE id=?',
          [u.referred_by]
        );
        await pool.query(
          'INSERT INTO referrals (referrer_id, referred_id, bonus_paid, created_at) VALUES (?,?,0.20,NOW())',
          [u.referred_by, u.id]
        );
        await pool.query(
          'INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?,?,?,?,NOW())',
          [u.referred_by, 'referral', 0.20, 'Referral bonus from ' + u.username]
        );
      }
    }

    const [updated] = await pool.query('SELECT * FROM users WHERE id=?', [u.id]);
    res.json({ success: true, earned: task.reward, user: sanitizeUser(updated[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────
//  WITHDRAWAL ROUTES
// ─────────────────────────────────────────────────────────────────

app.post('/api/withdraw', auth, async (req, res) => {
  const { amount, method, details } = req.body;
  if (!amount || amount < 10) return res.status(400).json({ error: 'Minimum withdrawal is $10' });

  try {
    const [userRows] = await pool.query('SELECT * FROM users WHERE id=?', [req.user.id]);
    const u = userRows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    if (u.total_ads < 80) return res.status(400).json({ error: 'Need 80 total ads watched to withdraw' });

    // 24h cooldown
    const [recent] = await pool.query(
      'SELECT id FROM withdrawals WHERE user_id=? AND status="pending" AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)',
      [u.id]
    );
    if (recent.length) return res.status(400).json({ error: 'One withdrawal per 24 hours' });

    // Insert withdrawal
    await pool.query(
      'INSERT INTO withdrawals (user_id, amount, method, details, status, created_at) VALUES (?,?,?,?,?,NOW())',
      [u.id, amount, method, JSON.stringify(details), 'pending']
    );

    // Deduct balance
    await pool.query('UPDATE users SET balance=balance-? WHERE id=?', [amount, u.id]);
    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, description, created_at) VALUES (?,?,?,?,NOW())',
      [u.id, 'withdrawal', amount, 'Withdrawal via ' + method]
    );

    res.json({ success: true, message: 'Withdrawal request submitted!' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/withdrawals/my', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM withdrawals WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────
//  REFERRAL ROUTES
// ─────────────────────────────────────────────────────────────────

app.get('/api/referrals/my', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.username, u.total_ads, r.bonus_paid, r.created_at
       FROM referrals r JOIN users u ON r.referred_id=u.id
       WHERE r.referrer_id=?`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────
//  TRANSACTION HISTORY
// ─────────────────────────────────────────────────────────────────

app.get('/api/transactions', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 50', [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────

// Overview stats
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [[{ totalUsers }]] = await pool.query('SELECT COUNT(*) as totalUsers FROM users WHERE is_admin=0');
    const [[{ totalAds }]] = await pool.query('SELECT COUNT(*) as totalAds FROM watch_log');
    const [[{ pending }]] = await pool.query('SELECT COUNT(*) as pending FROM withdrawals WHERE status="pending"');
    const [[{ paid }]] = await pool.query('SELECT COALESCE(SUM(amount),0) as paid FROM withdrawals WHERE status="approved"');
    res.json({ totalUsers, totalAds, pending, paid });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// All users
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { search } = req.query;
    let q = 'SELECT * FROM users WHERE is_admin=0';
    const params = [];
    if (search) { q += ' AND (username LIKE ? OR email LIKE ? OR uid LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    q += ' ORDER BY join_date DESC';
    const [rows] = await pool.query(q, params);
    res.json(rows.map(sanitizeUser));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Ban user
app.post('/api/admin/users/:id/ban', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET status=? WHERE id=?', ['banned', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Unban user
app.post('/api/admin/users/:id/unban', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET status=? WHERE id=?', ['active', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Forfeit balance
app.post('/api/admin/users/:id/forfeit', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET balance=0 WHERE id=?', [req.params.id]);
    await pool.query('INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())', [req.params.id, 'forfeit', 0, 'Balance forfeited by admin']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// All withdrawals
app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id=u.id ORDER BY w.created_at DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Approve withdrawal
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE withdrawals SET status="approved" WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Reject withdrawal
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM withdrawals WHERE id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const w = rows[0];
    await pool.query('UPDATE withdrawals SET status="rejected" WHERE id=?', [req.params.id]);
    // Refund
    await pool.query('UPDATE users SET balance=balance+? WHERE id=?', [w.amount, w.user_id]);
    await pool.query('INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())', [w.user_id, 'refund', w.amount, 'Withdrawal rejected - refunded']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Watch log
app.get('/api/admin/watch-log', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT wl.*, u.username, t.title FROM watch_log wl JOIN users u ON wl.user_id=u.id JOIN tasks t ON wl.task_id=t.id ORDER BY wl.watched_at DESC LIMIT 200`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Manage tasks
app.get('/api/admin/tasks', adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasks ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/tasks', adminAuth, async (req, res) => {
  const { title, description, duration, reward, emoji, category } = req.body;
  try {
    await pool.query('INSERT INTO tasks (title, description, duration, reward, emoji, category, active) VALUES (?,?,?,?,?,?,1)',
      [title, description || '', duration || 30, reward || 0.10, emoji || '📺', category || 'Custom']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/admin/tasks/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE tasks SET active=0 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ─────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────

async function check72hReset(userId) {
  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE id=?', [userId]);
    if (!rows.length) return;
    const u = rows[0];
    if (!u.last_ad_time || u.balance <= 0) return;
    const elapsed = Date.now() - new Date(u.last_ad_time).getTime();
    if (elapsed > 72 * 3600 * 1000) {
      await pool.query('UPDATE users SET balance=0 WHERE id=?', [userId]);
      await pool.query('INSERT INTO transactions (user_id,type,amount,description,created_at) VALUES (?,?,?,?,NOW())',
        [userId, 'reset', 0, 'Balance reset - 72h inactivity']);
    }
  } catch (e) { console.error('72h check error:', e); }
}

// Daily ads reset cron (check every hour)
setInterval(async () => {
  try {
    await pool.query("UPDATE users SET ads_today=0, last_ad_date=CURDATE() WHERE last_ad_date < CURDATE()");
  } catch (e) { /* ignore */ }
}, 3600 * 1000);

function sanitizeUser(u) {
  const { password_hash, ...safe } = u;
  return safe;
}

app.listen(PORT, () => console.log(`✅ AdsCash server running on port ${PORT}`));
