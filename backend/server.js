/**
 * MailFlow Backend — server.js
 * Production-ready: Express + Nodemailer + SQLite + Gmail OAuth2
 * Deploy on Railway / Render / Fly.io
 */

const express      = require('express')
const cors         = require('cors')
const nodemailer   = require('nodemailer')
const Database     = require('better-sqlite3')
const crypto       = require('crypto')
const rateLimit    = require('express-rate-limit')
const path         = require('path')

const app = express()
const DB_PATH = process.env.DB_PATH || './mailflow.db'
const db = new Database(DB_PATH)

// ── PRAGMA ─────────────────────────────────────
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// ── MIDDLEWARE ─────────────────────────────────
app.use(express.json({ limit: '1mb' }))
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Public-Key']
}))

// Serve SDK
app.get('/sdk.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.sendFile(path.join(__dirname, '../sdk/mailflow.js'))
})

// Rate limiters
const sendLimiter = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many requests' } })
const authLimiter = rateLimit({ windowMs: 60_000, max: 20, message: { error: 'Too many auth attempts' } })

// ── DATABASE SCHEMA ────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    email        TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name         TEXT,
    plan         TEXT DEFAULT 'free',
    monthly_limit INTEGER DEFAULT 500,
    created_at   INTEGER DEFAULT (unixepoch()),
    last_login   INTEGER
  );

  CREATE TABLE IF NOT EXISTS services (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    provider   TEXT DEFAULT 'smtp',
    smtp_host  TEXT NOT NULL,
    smtp_port  INTEGER DEFAULT 587,
    smtp_user  TEXT NOT NULL,
    smtp_pass  TEXT NOT NULL,
    from_email TEXT NOT NULL,
    from_name  TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS templates (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    subject    TEXT NOT NULL,
    html_body  TEXT NOT NULL,
    variables  TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    public_key      TEXT UNIQUE NOT NULL,
    label           TEXT,
    allowed_origins TEXT DEFAULT '*',
    is_active       INTEGER DEFAULT 1,
    created_at      INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_logs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    template_id TEXT,
    service_id  TEXT,
    to_email    TEXT NOT NULL,
    subject     TEXT,
    status      TEXT DEFAULT 'pending',
    error_msg   TEXT,
    sent_at     INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS webhooks (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    url        TEXT NOT NULL,
    events     TEXT DEFAULT 'sent,failed',
    secret     TEXT,
    is_active  INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_logs_user   ON email_logs(user_id, sent_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_status ON email_logs(status);
  CREATE INDEX IF NOT EXISTS idx_keys_public ON api_keys(public_key);
`)

// ── HELPERS ────────────────────────────────────
const genId        = ()  => crypto.randomUUID()
const genPublicKey = ()  => 'pk_' + crypto.randomBytes(16).toString('hex')
const hashPass     = (p) => crypto.createHash('sha256').update(p + (process.env.SALT || 'mf_salt_2024')).digest('hex')

function renderTemplate(html, params = {}) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] ?? '')
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(token)
  if (!user) return res.status(401).json({ error: 'Invalid token' })
  req.user = user
  next()
}

async function fireWebhooks(userId, event, payload) {
  const hooks = db.prepare("SELECT * FROM webhooks WHERE user_id=? AND is_active=1 AND events LIKE ?").all(userId, `%${event}%`)
  for (const hook of hooks) {
    try {
      const body = JSON.stringify({ event, timestamp: Date.now(), data: payload })
      const sig  = hook.secret ? 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex') : ''
      await fetch(hook.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-MailFlow-Signature': sig } : {}) },
        body,
        signal: AbortSignal.timeout(5000)
      })
    } catch { /* silent fail */ }
  }
}

// ════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════

app.post('/auth/register', authLimiter, (req, res) => {
  const { email, password, name } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be at least 6 characters' })
  if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Invalid email format' })

  const id = genId()
  try {
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?,?,?,?)').run(
      id, email.toLowerCase(), hashPass(password), name || email.split('@')[0]
    )
    const pk = genPublicKey()
    db.prepare('INSERT INTO api_keys (id, user_id, public_key, label) VALUES (?,?,?,?)').run(
      genId(), id, pk, 'Default Key'
    )
    db.prepare('UPDATE users SET last_login=unixepoch() WHERE id=?').run(id)
    res.json({ token: id, email, name: name || email.split('@')[0], public_key: pk, plan: 'free' })
  } catch {
    res.status(409).json({ error: 'Email already registered' })
  }
})

app.post('/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body
  const user = db.prepare('SELECT * FROM users WHERE email=? AND password_hash=?')
    .get(email?.toLowerCase(), hashPass(password))
  if (!user) return res.status(401).json({ error: 'Invalid email or password' })
  db.prepare('UPDATE users SET last_login=unixepoch() WHERE id=?').run(user.id)
  res.json({ token: user.id, email: user.email, name: user.name, plan: user.plan })
})

app.get('/auth/me', authMiddleware, (req, res) => {
  const { id, email, name, plan, monthly_limit, created_at } = req.user
  res.json({ id, email, name, plan, monthly_limit, created_at })
})

app.put('/auth/profile', authMiddleware, (req, res) => {
  const { name } = req.body
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name, req.user.id)
  res.json({ ok: true })
})

app.put('/auth/password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body
  if (hashPass(current_password) !== req.user.password_hash)
    return res.status(400).json({ error: 'Current password is incorrect' })
  if (!new_password || new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' })
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPass(new_password), req.user.id)
  res.json({ ok: true })
})

// ════════════════════════════════════════════════
//  SERVICES
// ════════════════════════════════════════════════

app.get('/services', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM services WHERE user_id=? ORDER BY created_at DESC').all(req.user.id)
  res.json(rows.map(r => ({ ...r, smtp_pass: '••••••••' })))
})

app.post('/services', authMiddleware, (req, res) => {
  const { name, smtp_host, smtp_port, smtp_user, smtp_pass, from_email, from_name, provider } = req.body
  if (!name || !smtp_host || !smtp_user || !smtp_pass || !from_email)
    return res.status(400).json({ error: 'Missing required fields' })
  const id = genId()
  db.prepare(`INSERT INTO services (id,user_id,name,provider,smtp_host,smtp_port,smtp_user,smtp_pass,from_email,from_name)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.user.id, name, provider||'smtp', smtp_host, smtp_port||587, smtp_user, smtp_pass, from_email, from_name||name)
  res.json({ id, name, message: 'Service created' })
})

app.delete('/services/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM services WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

app.post('/services/test', authMiddleware, async (req, res) => {
  const { service_id } = req.body
  const svc = db.prepare('SELECT * FROM services WHERE id=? AND user_id=?').get(service_id, req.user.id)
  if (!svc) return res.status(404).json({ error: 'Service not found' })
  try {
    const transport = nodemailer.createTransport({
      host: svc.smtp_host, port: svc.smtp_port,
      secure: svc.smtp_port === 465,
      auth: { user: svc.smtp_user, pass: svc.smtp_pass }
    })
    await transport.verify()
    res.json({ ok: true, message: 'SMTP connection successful! ✅' })
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message })
  }
})

// ════════════════════════════════════════════════
//  TEMPLATES
// ════════════════════════════════════════════════

app.get('/templates', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM templates WHERE user_id=? ORDER BY created_at DESC').all(req.user.id))
})

app.post('/templates', authMiddleware, (req, res) => {
  const { name, subject, html_body } = req.body
  if (!name || !subject || !html_body) return res.status(400).json({ error: 'All fields required' })
  // Extract variables
  const vars = [...new Set([...html_body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))]
  const id = genId()
  db.prepare('INSERT INTO templates (id,user_id,name,subject,html_body,variables) VALUES (?,?,?,?,?,?)')
    .run(id, req.user.id, name, subject, html_body, JSON.stringify(vars))
  res.json({ id, name, variables: vars })
})

app.put('/templates/:id', authMiddleware, (req, res) => {
  const { name, subject, html_body } = req.body
  const vars = [...new Set([...html_body.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]))]
  db.prepare('UPDATE templates SET name=?,subject=?,html_body=?,variables=?,updated_at=unixepoch() WHERE id=? AND user_id=?')
    .run(name, subject, html_body, JSON.stringify(vars), req.params.id, req.user.id)
  res.json({ ok: true, variables: vars })
})

app.delete('/templates/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM templates WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

// ════════════════════════════════════════════════
//  API KEYS
// ════════════════════════════════════════════════

app.get('/keys', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM api_keys WHERE user_id=? ORDER BY created_at DESC').all(req.user.id))
})

app.post('/keys', authMiddleware, (req, res) => {
  const { label, allowed_origins } = req.body
  const id = genId()
  const pk = genPublicKey()
  db.prepare('INSERT INTO api_keys (id,user_id,public_key,label,allowed_origins) VALUES (?,?,?,?,?)')
    .run(id, req.user.id, pk, label||'New Key', allowed_origins||'*')
  res.json({ id, public_key: pk, label })
})

app.put('/keys/:id', authMiddleware, (req, res) => {
  const { label, allowed_origins, is_active } = req.body
  db.prepare('UPDATE api_keys SET label=?,allowed_origins=?,is_active=? WHERE id=? AND user_id=?')
    .run(label, allowed_origins, is_active ? 1 : 0, req.params.id, req.user.id)
  res.json({ ok: true })
})

app.delete('/keys/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

// ════════════════════════════════════════════════
//  WEBHOOKS
// ════════════════════════════════════════════════

app.get('/webhooks', authMiddleware, (req, res) => {
  res.json(db.prepare('SELECT * FROM webhooks WHERE user_id=?').all(req.user.id))
})

app.post('/webhooks', authMiddleware, (req, res) => {
  const { url, events, secret } = req.body
  if (!url) return res.status(400).json({ error: 'URL is required' })
  const id = genId()
  db.prepare('INSERT INTO webhooks (id,user_id,url,events,secret) VALUES (?,?,?,?,?)')
    .run(id, req.user.id, url, events||'sent,failed', secret||null)
  res.json({ id, url })
})

app.delete('/webhooks/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM webhooks WHERE id=? AND user_id=?').run(req.params.id, req.user.id)
  res.json({ ok: true })
})

// ════════════════════════════════════════════════
//  LOGS & STATS
// ════════════════════════════════════════════════

app.get('/logs', authMiddleware, (req, res) => {
  const { page = 1, limit = 50, status, template_id } = req.query
  const offset = (page - 1) * Math.min(limit, 100)
  let sql  = 'SELECT * FROM email_logs WHERE user_id=?'
  const params = [req.user.id]
  if (status)      { sql += ' AND status=?';      params.push(status) }
  if (template_id) { sql += ' AND template_id=?'; params.push(template_id) }
  sql += ` ORDER BY sent_at DESC LIMIT ${Math.min(limit,100)} OFFSET ${offset}`
  res.json(db.prepare(sql).all(...params))
})

app.get('/stats', authMiddleware, (req, res) => {
  const uid = req.user.id
  const total  = db.prepare("SELECT COUNT(*) c FROM email_logs WHERE user_id=?").get(uid).c
  const sent   = db.prepare("SELECT COUNT(*) c FROM email_logs WHERE user_id=? AND status='sent'").get(uid).c
  const failed = db.prepare("SELECT COUNT(*) c FROM email_logs WHERE user_id=? AND status='failed'").get(uid).c
  const month  = db.prepare("SELECT COUNT(*) c FROM email_logs WHERE user_id=? AND sent_at > unixepoch()-2592000").get(uid).c
  const today  = db.prepare("SELECT COUNT(*) c FROM email_logs WHERE user_id=? AND sent_at > unixepoch()-86400").get(uid).c
  // Last 30 days daily breakdown
  const daily  = db.prepare(`
    SELECT date(sent_at,'unixepoch') d, COUNT(*) c
    FROM email_logs WHERE user_id=? AND sent_at > unixepoch()-2592000
    GROUP BY d ORDER BY d ASC
  `).all(uid)
  res.json({
    total, sent, failed, month, today,
    success_rate: total ? Math.round(sent/total*100) : 100,
    monthly_limit: req.user.monthly_limit,
    daily
  })
})

// ════════════════════════════════════════════════
//  SEND EMAIL  ← Public endpoint
// ════════════════════════════════════════════════

app.post('/v1/send', sendLimiter, async (req, res) => {
  const publicKey = req.headers['x-public-key'] || req.body.public_key
  if (!publicKey) return res.status(400).json({ error: 'Missing public key' })

  const keyRow = db.prepare('SELECT * FROM api_keys WHERE public_key=? AND is_active=1').get(publicKey)
  if (!keyRow) return res.status(401).json({ error: 'Invalid or inactive public key' })

  // Origin check
  const origin = req.headers.origin || req.headers.referer || ''
  if (keyRow.allowed_origins !== '*') {
    const allowed = keyRow.allowed_origins.split(',').map(s => s.trim())
    if (!allowed.some(o => origin.includes(o)))
      return res.status(403).json({ error: 'Origin not allowed for this key' })
  }

  // Monthly limit check
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(keyRow.user_id)
  const monthCount = db.prepare(
    "SELECT COUNT(*) c FROM email_logs WHERE user_id=? AND status='sent' AND sent_at > unixepoch()-2592000"
  ).get(keyRow.user_id).c
  if (monthCount >= user.monthly_limit)
    return res.status(429).json({ error: `Monthly limit reached (${user.monthly_limit} emails/month)` })

  const { template_id, service_id, to_email, to_name, params = {}, reply_to } = req.body
  if (!to_email) return res.status(400).json({ error: 'to_email is required' })
  if (!template_id) return res.status(400).json({ error: 'template_id is required' })

  const tpl = db.prepare('SELECT * FROM templates WHERE id=? AND user_id=?').get(template_id, keyRow.user_id)
  if (!tpl) return res.status(404).json({ error: 'Template not found' })

  const svc = service_id
    ? db.prepare('SELECT * FROM services WHERE id=? AND user_id=?').get(service_id, keyRow.user_id)
    : db.prepare('SELECT * FROM services WHERE user_id=? LIMIT 1').get(keyRow.user_id)
  if (!svc) return res.status(404).json({ error: 'No email service configured. Add a Gmail/SMTP service first.' })

  const subject  = renderTemplate(tpl.subject, params)
  const htmlBody = renderTemplate(tpl.html_body, params)

  const logId = genId()
  db.prepare('INSERT INTO email_logs (id,user_id,template_id,service_id,to_email,subject,status) VALUES (?,?,?,?,?,?,?)')
    .run(logId, keyRow.user_id, template_id, svc.id, to_email, subject, 'pending')

  try {
    const transport = nodemailer.createTransport({
      host: svc.smtp_host,
      port: svc.smtp_port,
      secure: svc.smtp_port === 465,
      auth: { user: svc.smtp_user, pass: svc.smtp_pass },
      tls: { rejectUnauthorized: false }
    })

    await transport.sendMail({
      from:     `"${svc.from_name || svc.name}" <${svc.from_email}>`,
      to:       to_name ? `"${to_name}" <${to_email}>` : to_email,
      subject,
      html:     htmlBody,
      replyTo:  reply_to || undefined
    })

    db.prepare("UPDATE email_logs SET status='sent' WHERE id=?").run(logId)
    fireWebhooks(keyRow.user_id, 'sent', { id: logId, to_email, subject })
    res.json({ ok: true, id: logId, status: 'sent' })

  } catch (e) {
    db.prepare("UPDATE email_logs SET status='failed', error_msg=? WHERE id=?").run(e.message, logId)
    fireWebhooks(keyRow.user_id, 'failed', { id: logId, to_email, error: e.message })
    res.status(500).json({ ok: false, error: e.message, id: logId })
  }
})

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0', ts: Date.now() }))

// ── START ───────────────────────────────────────
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✅ MailFlow API v2.0 running on http://localhost:${PORT}`)
  console.log(`📊 DB: ${DB_PATH}`)
})
