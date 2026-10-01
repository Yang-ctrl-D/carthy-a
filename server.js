const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'data', 'forum.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE, name TEXT NOT NULL, auth_type TEXT NOT NULL,
  avatar TEXT, bio TEXT DEFAULT '',
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER, friend_id INTEGER, status TEXT DEFAULT 'pending',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  PRIMARY KEY (user_id, friend_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, description TEXT, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER, user_id INTEGER,
  title TEXT, content TEXT, file_url TEXT, file_name TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')), views INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER, user_id INTEGER, content TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, host_id INTEGER, ip TEXT, port INTEGER,
  version TEXT, motd TEXT, online INTEGER DEFAULT 0, max INTEGER DEFAULT 20,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

if (!db.prepare('SELECT COUNT(*) c FROM categories').get().c) {
  const ins = db.prepare('INSERT INTO categories (name, description, sort) VALUES (?,?,?)');
  ins.run('鍏憡', 'CarthY 瀹樻柟鍏憡', 1);
  ins.run('缁煎悎璁ㄨ', '闅忎究鑱婅亰', 2);
  ins.run('璧勬簮鍒嗕韩', 'Mod/鏁村悎鍖?鍦板浘涓嬭浇', 3);
  ins.run('鑱旀満澶у巺', '鍒涘缓/鍔犲叆鎴块棿', 4);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 30*24*3600*1000 }
}));

// ===== 鐢ㄦ埛/鐧诲綍 =====
app.get('/api/me', (req, res) => res.json(req.session.user || null));
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ok:true})));

function upsertUser(req, uuid, name, authType, avatar) {
  const ex = db.prepare('SELECT * FROM users WHERE uuid=?').get(uuid);
  let uid;
  if (ex) { db.prepare('UPDATE users SET name=?,avatar=? WHERE uuid=?').run(name,avatar,uuid); uid = ex.id; }
  else { uid = db.prepare('INSERT INTO users (uuid,name,auth_type,avatar) VALUES (?,?,?,?)').run(uuid,name,authType,avatar).lastInsertRowid; }
  req.session.user = {id:uid, uuid, name, auth_type:authType, avatar};
}

app.post('/api/login/littleskin', async (req, res) => {
  try {
    const r = await axios.post('https://littleskin.cn/api/yggdrasil/authserver/authenticate', {
      username: req.body.username, password: req.body.password, clientToken: 'carthy'
    }, { timeout: 10000 });
    const p = r.data.selectedProfile;
    if (!p) return res.json({ok:false, error:'璐﹀彿鏈敞鍐岃鑹?});
    upsertUser(req, p.id, p.name, 'external', `https://littleskin.cn/avatar/${p.id}/120`);
    res.json({ok:true});
  } catch { res.json({ok:false, error:'鐢ㄦ埛鍚嶆垨瀵嗙爜閿欒'}); }
});

const MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'd50a21bf-a33c-4d10-9b2e-a6cc97012187';
const MS_TENANT = process.env.MS_TENANT || '31333245-f903-44a2-a9f1-c822244570c5';
const MS_REDIRECT = process.env.MS_REDIRECT || 'http://localhost:3000/auth/microsoft/callback';

app.get('/auth/microsoft', (req, res) => {
  res.redirect(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/authorize?client_id=${MS_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(MS_REDIRECT)}&scope=XboxLive.User.Read%20offline_access&response_mode=query`);
});

app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const t = await axios.post(`https://login.microsoftonline.com/${MS_TENANT}/oauth2/v2.0/token`,
      new URLSearchParams({client_id:MS_CLIENT_ID, code:req.query.code, grant_type:'authorization_code', redirect_uri:MS_REDIRECT, scope:'XboxLive.User.Read offline_access'}).toString(),
      {headers:{'Content-Type':'application/x-www-form-urlencoded'}, timeout:10000});
    const xbl = await axios.post('https://user.auth.xboxlive.com/user/authenticate', {Properties:{RpsTicket:`d=${t.data.access_token}`,SiteName:'user.auth.xboxlive.com'},RelyingParty:'http://auth.xboxlive.com',TokenType:'JWT'}, {timeout:10000});
    const xsts = await axios.post('https://xsts.auth.xboxlive.com/xsts/authorize', {Properties:{SandboxId:'RETAIL',UserTokens:[xbl.data.Token]},RelyingParty:'rp://api.minecraftservices.com/',TokenType:'JWT'}, {timeout:10000});
    const mc = await axios.post('https://api.minecraftservices.com/minecraft/login/xbox', {identityToken:`XBL3.0 x=${xbl.data.DisplayClaims.xui[0].uhs};${xsts.data.Token}`}, {timeout:10000});
    upsertUser(req, mc.data.id, mc.data.name, 'microsoft', `https://mc-heads.net/avatar/${mc.data.id}/120.png`);
    res.redirect('/');
  } catch(e) { console.error(e.message); res.redirect('/?error=ms'); }
});

// ===== 鍒嗙被/甯栧瓙 =====
app.get('/api/categories', (req,res) => res.json(db.prepare('SELECT * FROM categories ORDER BY sort').all()));

app.get('/api/threads', (req,res) => {
  const cat = req.query.cat;
  const rows = cat
    ? db.prepare(`SELECT t.*,u.name as author,u.avatar FROM threads t JOIN users u ON t.user_id=u.id WHERE t.category_id=? ORDER BY t.created_at DESC`).all(cat)
    : db.prepare(`SELECT t.*,u.name as author,u.avatar FROM threads t JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC LIMIT 50`).all();
  res.json(rows);
});

app.get('/api/thread/:id', (req,res) => {
  db.prepare('UPDATE threads SET views=views+1 WHERE id=?').run(req.params.id);
  const t = db.prepare(`SELECT t.*,u.name as author,u.avatar FROM threads t JOIN users u ON t.user_id=u.id WHERE t.id=?`).get(req.params.id);
  if (!t) return res.status(404).json({error:'not found'});
  const posts = db.prepare(`SELECT p.*,u.name as author,u.avatar FROM posts p JOIN users u ON p.user_id=u.id WHERE p.thread_id=? ORDER BY p.created_at`).all(req.params.id);
  res.json({thread:t, posts});
});

app.post('/api/thread', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'login required'});
  const r = db.prepare('INSERT INTO threads (category_id,user_id,title,content,file_url,file_name) VALUES (?,?,?,?,?,?)')
    .run(req.body.category_id, req.session.user.id, req.body.title, req.body.content, req.body.file_url||'', req.body.file_name||'');
  res.json({id:r.lastInsertRowid});
});

app.post('/api/reply/:id', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'login required'});
  db.prepare('INSERT INTO posts (thread_id,user_id,content) VALUES (?,?,?)').run(req.params.id, req.session.user.id, req.body.content);
  res.json({ok:true});
});

// ===== 濂藉弸 =====
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
  if (!req.session.user) return res.status(401).json({error:'login required'});
  const target = db.prepare('SELECT * FROM users WHERE name=?').get(req.body.name);
  if (!target) return res.json({ok:false, error:'鐢ㄦ埛涓嶅瓨鍦?});
  if (target.id === req.session.user.id) return res.json({ok:false, error:'涓嶈兘鍔犺嚜宸?});
  db.prepare('INSERT OR IGNORE INTO friends (user_id,friend_id,status) VALUES (?,?,?)')
    .run(req.session.user.id, target.id, req.body.accept ? 'accepted' : 'pending');
  res.json({ok:true});
});

app.post('/api/friend/accept', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'login required'});
  db.prepare('UPDATE friends SET status=? WHERE user_id=? AND friend_id=?')
    .run('accepted', req.body.from_id, req.session.user.id);
  res.json({ok:true});
});

// ===== 鑱旀満澶у巺 =====
app.get('/api/rooms', (req,res) => res.json(db.prepare(`
  SELECT r.*, u.name as host_name, u.avatar as host_avatar FROM rooms r
  JOIN users u ON r.host_id=u.id ORDER BY r.created_at DESC
`).all()));

app.post('/api/rooms', (req,res) => {
  if (!req.session.user) return res.status(401).json({error:'login required'});
  const r = db.prepare('INSERT INTO rooms (name,host_id,ip,port,version,motd,max) VALUES (?,?,?,?,?,?,?)')
    .run(req.body.name, req.session.user.id, req.body.ip, req.body.port||25565, req.body.version||'1.20.1', req.body.motd||'', req.body.max||20);
  res.json({id:r.lastInsertRowid});
});

app.listen(PORT, '0.0.0.0', () => console.log(`Forum on http://localhost:${PORT}`));
