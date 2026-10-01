const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'data', 'forum.db'));

// ========== 寤鸿〃 ==========
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  password_hash TEXT,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  auth_type TEXT DEFAULT 'email',
  uuid TEXT,
  avatar TEXT,
  bio TEXT DEFAULT '',
  last_seen INTEGER DEFAULT (strftime('%s','now')),
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER, user_id INTEGER,
  title TEXT, content TEXT, file_url TEXT, file_name TEXT,
  is_pinned INTEGER DEFAULT 0, is_locked INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s','now')), views INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER, user_id INTEGER, content TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER, friend_id INTEGER, status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, host_id INTEGER, ip TEXT, port INTEGER,
  version TEXT, motd TEXT, max_players INTEGER DEFAULT 20,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS bug_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, title TEXT, content TEXT,
  launcher_version TEXT, java_version TEXT, game_log TEXT,
  status TEXT DEFAULT 'open',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

// 鍒濆鍖栧垎绫?if (!db.prepare('SELECT COUNT(*) c FROM categories').get().c) {
  const ins = db.prepare('INSERT INTO categories (name, description, sort) VALUES (?,?,?)');
  ins.run('鍏憡', 'CarthY 瀹樻柟鍏憡', 1);
  ins.run('缁煎悎璁ㄨ', '闅忎究鑱婅亰', 2);
  ins.run('璧勬簮鍒嗕韩', 'Mod/鏁村悎鍖?鍦板浘涓嬭浇', 3);
  ins.run('鑱旀満澶у巺', '鍒涘缓/鍔犲叆鎴块棿', 4);
}

// 鍒濆鍖栬厫绔硅处鍙?const adminEmail = '3962892029@qq.com';
const admin = db.prepare('SELECT * FROM users WHERE email=?').get(adminEmail);
if (!admin) {
  const hash = crypto.createHash('sha256').update('carthy-admin-2024').digest('hex');
  db.prepare('INSERT INTO users (email,password_hash,name,role,auth_type,uuid) VALUES (?,?,?,?,?,?)')
    .run(adminEmail, hash, '鑵愮', 'admin', 'email', 'admin-' + crypto.randomUUID());
}

app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 30*24*3600*1000 }
}));

// ========== 宸ュ叿鍑芥暟 ==========
function hashPassword(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }
function isAdmin(u) { return u && u.role === 'admin'; }
function isMod(u) { return u && (u.role === 'admin' || u.role === 'moderator'); }

// 鏇存柊鍦ㄧ嚎鐘舵€?setInterval(() => {
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Math.floor(Date.now()/1000));
}, 30000);

// ========== 鐢ㄦ埛/璁よ瘉 ==========
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.json(null);
  db.prepare('UPDATE users SET last_seen=? WHERE id=?').run(Math.floor(Date.now()/1000), req.session.user.id);
  const u = db.prepare('SELECT id,email,name,role,auth_type,avatar,bio FROM users WHERE id=?').get(req.session.user.id);
  res.json(u);
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ok:true})));

app.post('/api/register', (req, res) => {
  const {email, password, name} = req.body;
  if (!email || !password || !name) return res.json({ok:false, error:'璇峰～鍐欓偖绠便€佸瘑鐮佸拰鏄电О'});
  if (db.prepare('SELECT * FROM users WHERE email=?').get(email)) return res.json({ok:false, error:'閭宸叉敞鍐?});
  const hash = hashPassword(password);
  const avatar = `https://mc-heads.net/avatar/${encodeURIComponent(name)}/120.png`;
  const r = db.prepare('INSERT INTO users (email,password_hash,name,auth_type,avatar) VALUES (?,?,?,?,?)')
    .run(email, hash, name, 'email', avatar);
  req.session.user = {id:r.lastInsertRowid, email, name, role:'user', auth_type:'email', avatar};
  res.json({ok:true});
});

app.post('/api/login', (req, res) => {
  const {email, password} = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!u) return res.json({ok:false, error:'閭鏈敞鍐?});
  if (u.password_hash !== hashPassword(password)) return res.json({ok:false, error:'瀵嗙爜閿欒'});
  req.session.user = {id:u.id, email:u.email, name:u.name, role:u.role, auth_type:u.auth_type, avatar:u.avatar};
  res.json({ok:true});
});

app.post('/api/login/littleskin', async (req, res) => {
  try {
    const r = await axios.post('https://littleskin.cn/api/yggdrasil/authserver/authenticate', {
      username: req.body.username, password: req.body.password, clientToken: 'carthy'
    }, { timeout: 10000 });
    const p = r.data.selectedProfile;
    if (!p) return res.json({ok:false, error:'璐﹀彿鏈敞鍐岃鑹?});
    const avatar = `https://littleskin.cn/avatar/${p.id}/120`;
    let u = db.prepare('SELECT * FROM users WHERE uuid=?').get(p.id);
    if (!u) {
      const r2 = db.prepare('INSERT INTO users (uuid,name,auth_type,avatar) VALUES (?,?,?,?)')
        .run(p.id, p.name, 'external', avatar);
      u = {id:r2.lastInsertRowid, email:null, name:p.name, role:'user', auth_type:'external', avatar};
    }
    req.session.user = {id:u.id, email:u.email, name:u.name, role:u.role, auth_type:'external', avatar:u.avatar||avatar};
    res.json({ok:true});
  } catch { res.json({ok:false, error:'鐢ㄦ埛鍚嶆垨瀵嗙爜閿欒'}); }
});

// ========== 鍒嗙被/甯栧瓙 ==========
app.get('/api/categories', (req,res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort').all()));

app.get('/api/threads', (req,res) => {
  const cat = req.query.cat;
  let rows;
  if (cat) {
    rows = db.prepare(`SELECT t.*,u.name as author,u.avatar,u.role as author_role 
      FROM threads t JOIN users u ON t.user_id=u.id WHERE t.category_id=? ORDER BY t.is_pinned DESC, t.created_at DESC`).all(cat);
  } else {
    rows = db.prepare(`SELECT t.*,u.name as author,u.avatar,u.role as author_role 
      FROM threads t JOIN users u ON t.user_id=u.id ORDER BY t.is_pinned DESC, t.created_at DESC LIMIT 100`).all();
  }
  res.json(rows);
});

app.get('/api/thread/:id', (req,res) => {
  db.prepare('UPDATE threads SET views=views+1 WHERE id=?').run(req.params.id);
  const t = db.prepare(`SELECT t.*,u.name as author,u.avatar,u.role as author_role 
    FROM threads t JOIN users u ON t.user_id=u.id WHERE t.id=?`).get(req.params.id);
  if (!t) return res.status(404).json({error:'not found'});
  const posts = db.prepare(`SELECT p.*,u.name as author,u.avatar,u.role as author_role 
    FROM posts p JOIN users u ON p.user_id=u.id WHERE p.thread_id=? ORDER BY p.created_at`).all(req.params.id);
  res.json({thread:t, posts});
});

app.post('/api/thread', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'璇峰厛鐧诲綍'});
  const r = db.prepare('INSERT INTO threads (category_id,user_id,title,content,file_url,file_name) VALUES (?,?,?,?,?,?)')
    .run(req.body.category_id, req.session.user.id, req.body.title, req.body.content, req.body.file_url||'', req.body.file_name||'');
  res.json({id:r.lastInsertRowid});
});

app.post('/api/thread/:id/delete', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'璇峰厛鐧诲綍'});
  const t = db.prepare('SELECT * FROM threads WHERE id=?').get(req.params.id);
  if (!t) return res.json({ok:false, error:'甯栧瓙涓嶅瓨鍦?});
  if (t.user_id !== req.session.user.id && !isMod(req.session.user)) return res.json({ok:false, error:'鏃犳潈闄?});
  db.prepare('DELETE FROM threads WHERE id=?').run(req.params.id);
  db.prepare('DELETE FROM posts WHERE thread_id=?').run(req.params.id);
  res.json({ok:true});
});

app.post('/api/reply/:id', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'璇峰厛鐧诲綍'});
  db.prepare('INSERT INTO posts (thread_id,user_id,content) VALUES (?,?,?)').run(req.params.id, req.session.user.id, req.body.content);
  res.json({ok:true});
});

// ========== 濂藉弸 ==========
app.get('/api/friends', (req,res) => {
  if (!req.session.user) return res.json([]);
  const uid = req.session.user.id;
  const list = db.prepare(`
    SELECT u.id,u.name,u.avatar,u.auth_type, f.status,
      CASE WHEN f.user_id=? THEN f.friend_id ELSE f.user_id END as other_id
    FROM friends f JOIN users u ON u.id = CASE WHEN f.user_id=? THEN f.friend_id ELSE f.user_id END
    WHERE ? IN (f.user_id, f.friend_id)
  `).all(uid,uid,uid);
  res.json(list);
});

app.post('/api/friend/add', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'璇峰厛鐧诲綍'});
  const target = db.prepare('SELECT * FROM users WHERE name=? OR email=?').get(req.body.name, req.body.name);
  if (!target) return res.json({ok:false, error:'鐢ㄦ埛涓嶅瓨鍦?});
  if (target.id === req.session.user.id) return res.json({ok:false, error:'涓嶈兘鍔犺嚜宸?});
  db.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id) VALUES (?,?)')
    .run(req.session.user.id, target.id);
  res.json({ok:true});
});

// ========== 鑱旀満澶у巺 ==========
app.get('/api/rooms', (req,res) => res.json(db.prepare(`
  SELECT r.*, u.name as host_name, u.avatar as host_avatar FROM rooms r
  JOIN users u ON r.host_id=u.id ORDER BY r.created_at DESC
`).all()));

app.post('/api/rooms', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'璇峰厛鐧诲綍'});
  const r = db.prepare('INSERT INTO rooms (name,host_id,ip,port,version,motd,max_players) VALUES (?,?,?,?,?,?,?)')
    .run(req.body.name, req.session.user.id, req.body.ip, req.body.port||25565, req.body.version||'1.20.1', req.body.motd||'', req.body.max_players||20);
  res.json({id:r.lastInsertRowid});
});

app.post('/api/rooms/:id/delete', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'璇峰厛鐧诲綍'});
  const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(req.params.id);
  if (!r) return res.json({ok:false});
  if (r.host_id !== req.session.user.id && !isMod(req.session.user)) return res.json({ok:false, error:'鏃犳潈闄?});
  db.prepare('DELETE FROM rooms WHERE id=?').run(req.params.id);
  res.json({ok:true});
});

// ========== 鍦ㄧ嚎浜烘暟 ==========
app.get('/api/stats', (req,res) => {
  const now = Math.floor(Date.now()/1000);
  const online = db.prepare('SELECT COUNT(*) c FROM users WHERE last_seen > ?').get(now-60).c;
  const threads = db.prepare('SELECT COUNT(*) c FROM threads').get().c;
  const rooms = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
  res.json({online, threads, rooms});
});

// ========== Bug鎶ュ憡 ==========
app.post('/api/bug-report', (req,res) => {
  const r = db.prepare('INSERT INTO bug_reports (user_id,title,content,launcher_version,java_version,game_log) VALUES (?,?,?,?,?,?)')
    .run(req.session.user?.id||0, req.body.title, req.body.content, req.body.launcher_version||'', req.body.java_version||'', req.body.game_log||'');
  res.json({ok:true, id:r.lastInsertRowid});
});

app.get('/api/bug-reports', (req,res) => {
  if (!req.session.user || !isMod(req.session.user)) return res.status(403).json({error:'鏃犳潈闄?});
  res.json(db.prepare(`SELECT b.*,u.name as reporter FROM bug_reports b LEFT JOIN users u ON b.user_id=u.id ORDER BY b.created_at DESC`).all());
});

// ========== 鐢ㄦ埛鍒楄〃锛堢鐞嗗憳娣诲姞瀹℃牳鍛橈級 ==========
app.get('/api/users', (req,res) => {
  if (!req.session.user || !isAdmin(req.session.user)) return res.status(403).json({error:'浠呰厫绔瑰彲鏌ョ湅'});
  res.json(db.prepare('SELECT id,email,name,role,auth_type,created_at FROM users ORDER BY created_at DESC').all());
});

app.post('/api/users/:id/role', (req,res) => {
  if (!req.session.user || !isAdmin(req.session.user)) return res.status(403).json({error:'浠呰厫绔瑰彲璁剧疆'});
  db.prepare('UPDATE users SET role=? WHERE id=?').run(req.body.role, req.params.id);
  res.json({ok:true});
});

app.listen(PORT, '0.0.0.0', () => console.log(`Forum on http://localhost:${PORT}`));
