// Employee LMS server: JSON API + static frontend. No dependencies beyond Node 22.5+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  DB_PATH, ready, db, tx, hashPassword, verifyPassword, today, addDays, assignOnboarding, refreshAssignmentStatus,
} = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 7;
const DEFAULT_PASSWORD = 'welcome123';
const UPLOAD_DIR = path.join(path.dirname(DB_PATH), 'uploads');
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mov': 'video/quicktime' };

// Online settings (all optional locally). See DEPLOY.md.
const list = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const GOOGLE_AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
// Company defaults; override with the ALLOWED_DOMAINS / ADMIN_EMAILS settings in Vercel.
const ALLOWED_DOMAINS = list(process.env.ALLOWED_DOMAINS || 'girnarsoft.com,cardekho.com');
// The owner stays an admin even when ADMIN_EMAILS is set, so a typo there can't lock everyone out of the admin panel.
const ADMIN_EMAILS = [...new Set([...list(process.env.ADMIN_EMAILS), 'rakesh.jha@girnarsoft.com'])];
// With Google sign-in on, email + password sign-in is off unless explicitly allowed.
const PASSWORD_LOGIN = !GOOGLE_ENABLED || process.env.ALLOW_PASSWORD_LOGIN === '1';
// Vercel names the Blob token BLOB_READ_WRITE_TOKEN, or <PREFIX>_READ_WRITE_TOKEN when the store was given a custom prefix.
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN
  || Object.entries(process.env).find(([k, v]) => k.endsWith('READ_WRITE_TOKEN') && String(v).startsWith('vercel_blob_rw_'))?.[1] || '';
// Newer Vercel Blob stores connect with a store id and Vercel's built-in login (OIDC) instead of a token.
const BLOB_STORE_ID = process.env.BLOB_STORE_ID || '';
const BLOB_MODE = BLOB_TOKEN ? 'token' : (BLOB_STORE_ID ? 'presigned' : '');
const BLOB_ENABLED = !!BLOB_MODE;
const VIDEO_CONTENT_TYPES = () => [...new Set(Object.values(VIDEO_TYPES)), 'application/octet-stream'];
// Vercel's disk is read-only and temporary, so videos there go to Blob storage instead.
const ON_VERCEL = !!process.env.VERCEL;
// Videos the site plays itself (uploads and direct video files) must be watched to the end before the lesson completes.
// YouTube and Vimeo links play inside their own players, which the site can't control, so they aren't tracked.
const isTrackedVideo = (url) => /^\/(uploads|api\/media)\//.test(url || '') || /^demo-video:/.test(url || '')
  || /^https:\/\/[\w-]+\.public\.blob\.vercel-storage\.com\//.test(url || '') || /^https?:\/\/\S+\.(mp4|webm|ogg)(\?|$)/i.test(url || '');
const VIDEO_REPORT_SLACK = 15; // seconds a report may run ahead of real time (network delays, buffering)
const VIDEO_END_SLACK = 2; // seconds short of the end that still counts as finished
if (!ON_VERCEL) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- routing ----------
const routes = [];
function route(method, pattern, role, handler, { raw = false } = {}) {
  const keys = [];
  // ":name" matches one path segment; ":name*" matches the rest of the path, slashes included.
  const re = new RegExp(`^${pattern.replace(/:(\w+)(\*?)/g, (_, k, rest) => { keys.push(k); return rest ? '(.+)' : '([^/]+)'; })}$`);
  routes.push({ method, re, keys, role, handler, raw });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) reject(new HttpError(413, 'Request too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

async function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return await db.prepare(
    `SELECT u.id, u.name, u.email, u.role, u.department, u.designation, u.joining_date
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
  ).get(token, Date.now()) || null;
}

// ---------- helpers ----------
const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
const toInt = (v, fallback) => (v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : fallback);

const ASSIGNMENT_SELECT = `
  SELECT a.*, m.title AS module_title, m.category AS module_category, m.description AS module_description,
         m.pass_mark, u.name AS user_name, u.email AS user_email, u.department AS user_department,
         ab.name AS assigned_by_name,
         (SELECT COUNT(*) FROM lessons l WHERE l.module_id = a.module_id) AS lessons_total,
         (SELECT COUNT(*) FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
            WHERE lp.assignment_id = a.id AND l.module_id = a.module_id) AS lessons_done,
         (SELECT COUNT(*) FROM questions q WHERE q.module_id = a.module_id) AS questions_total,
         (SELECT COALESCE(MAX(passed), 0) FROM quiz_attempts qa WHERE qa.assignment_id = a.id) AS quiz_passed
  FROM assignments a
  JOIN modules m ON m.id = a.module_id
  JOIN users u ON u.id = a.user_id
  LEFT JOIN users ab ON ab.id = a.assigned_by`;

function decorate(a) {
  const hasQuiz = a.questions_total > 0;
  const steps = a.lessons_total + (hasQuiz ? 1 : 0);
  const done = a.lessons_done + (hasQuiz && a.quiz_passed ? 1 : 0);
  const progress = a.status === 'completed' ? 100 : steps ? Math.round((done / steps) * 100) : 0;
  const overdue = a.status !== 'completed' && a.due_date < today();
  return { ...a, progress, overdue };
}

async function getModuleFull(id, { includeAnswers }) {
  const m = await db.prepare('SELECT * FROM modules WHERE id = ?').get(id);
  if (!m) throw new HttpError(404, 'Module not found');
  m.lessons = await db.prepare('SELECT * FROM lessons WHERE module_id = ? ORDER BY position').all(id);
  m.questions = (await db.prepare('SELECT * FROM questions WHERE module_id = ? ORDER BY position').all(id)).map((q) => {
    const out = { id: q.id, text: q.text, options: JSON.parse(q.options) };
    if (includeAnswers) out.correct_index = q.correct_index;
    return out;
  });
  return m;
}

function validateModule(body) {
  const title = str(body.title, 200);
  if (!title) throw new HttpError(400, 'Module title is required');
  const lessons = Array.isArray(body.lessons) ? body.lessons : [];
  const questions = Array.isArray(body.questions) ? body.questions : [];
  if (!lessons.length) throw new HttpError(400, 'Add at least one lesson');
  lessons.forEach((l, i) => { if (!str(l.title)) throw new HttpError(400, `Lesson ${i + 1} needs a title`); });
  const cleanQuestions = questions.map((q, i) => {
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => str(o, 500)).filter(Boolean);
    if (!str(q.text)) throw new HttpError(400, `Question ${i + 1} needs text`);
    if (options.length < 2) throw new HttpError(400, `Question ${i + 1} needs at least two options`);
    const correct = toInt(q.correct_index, -1);
    if (correct < 0 || correct >= options.length) throw new HttpError(400, `Pick the correct answer for question ${i + 1}`);
    return { text: str(q.text, 1000), options, correct_index: correct };
  });
  return {
    title,
    description: str(body.description, 2000),
    category: str(body.category, 100),
    is_onboarding: body.is_onboarding ? 1 : 0,
    onboarding_departments: str(body.onboarding_departments, 500),
    due_days: Math.max(0, toInt(body.due_days, 7)),
    pass_mark: Math.min(100, Math.max(0, toInt(body.pass_mark, 70))),
    published: body.published === false || body.published === 0 ? 0 : 1,
    lessons: lessons.map((l) => ({ id: toInt(l.id, null), title: str(l.title, 200), content: str(l.content, 100000), video_url: str(l.video_url, 1000) })),
    questions: cleanQuestions,
  };
}

async function saveModule(id, data) {
  return tx(async () => {
    const fields = [data.title, data.description, data.category, data.is_onboarding, data.onboarding_departments, data.due_days, data.pass_mark, data.published];
    if (id) {
      const r = await db.prepare(
        `UPDATE modules SET title=?, description=?, category=?, is_onboarding=?, onboarding_departments=?, due_days=?, pass_mark=?, published=?, updated_at=datetime('now')
         WHERE id=?`
      ).run(...fields, id);
      if (!r.changes) throw new HttpError(404, 'Module not found');
    } else {
      id = (await db.prepare(
        `INSERT INTO modules (title, description, category, is_onboarding, onboarding_departments, due_days, pass_mark, published)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...fields)).lastInsertRowid;
    }
    // Lessons keep their ids so learners' progress survives edits.
    const existing = new Set((await db.prepare('SELECT id FROM lessons WHERE module_id = ?').all(id)).map((r) => r.id));
    const kept = new Set();
    for (const [i, l] of data.lessons.entries()) {
      if (l.id && existing.has(l.id)) {
        await db.prepare('UPDATE lessons SET position=?, title=?, content=?, video_url=? WHERE id=?').run(i, l.title, l.content, l.video_url, l.id);
        kept.add(l.id);
      } else {
        await db.prepare('INSERT INTO lessons (module_id, position, title, content, video_url) VALUES (?, ?, ?, ?, ?)').run(id, i, l.title, l.content, l.video_url);
      }
    }
    for (const lid of existing) {
      if (kept.has(lid)) continue;
      await db.prepare('DELETE FROM lesson_progress WHERE lesson_id = ?').run(lid);
      await db.prepare('DELETE FROM video_progress WHERE lesson_id = ?').run(lid);
      await db.prepare('DELETE FROM lessons WHERE id = ?').run(lid);
    }
    await db.prepare('DELETE FROM questions WHERE module_id = ?').run(id);
    for (const [i, q] of data.questions.entries()) {
      await db.prepare('INSERT INTO questions (module_id, position, text, options, correct_index) VALUES (?, ?, ?, ?, ?)').run(id, i, q.text, JSON.stringify(q.options), q.correct_index);
    }
    // Completed assignments stay completed; others are re-evaluated against the new content.
    for (const a of await db.prepare("SELECT id FROM assignments WHERE module_id = ? AND status != 'completed'").all(id)) await refreshAssignmentStatus(a.id);
    return id;
  });
}

function validateEmployee(body, { partial } = {}) {
  const out = {
    name: str(body.name, 200),
    email: str(body.email, 200).toLowerCase(),
    department: str(body.department, 100),
    designation: str(body.designation, 100),
    joining_date: str(body.joining_date, 10) || today(),
    role: body.role === 'admin' ? 'admin' : 'employee',
  };
  if (!out.name) throw new HttpError(400, 'Name is required');
  if (!isEmail(out.email)) throw new HttpError(400, `Invalid email: ${out.email || '(blank)'}`);
  if (!isDate(out.joining_date)) throw new HttpError(400, 'Joining date must be YYYY-MM-DD');
  if (!partial && body.password && String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
  return out;
}

async function createEmployee(body, adminId) {
  const e = validateEmployee(body);
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').get(e.email)) throw new HttpError(409, `${e.email} already exists`);
  return tx(async () => {
    const { lastInsertRowid: id } = await db.prepare(
      `INSERT INTO users (name, email, password_hash, role, department, designation, joining_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(e.name, e.email, hashPassword(String(body.password || DEFAULT_PASSWORD)), e.role, e.department, e.designation, e.joining_date);
    const onboarding = body.assign_onboarding === false ? 0 : await assignOnboarding(id, adminId);
    return { id, onboarding_assigned: onboarding };
  });
}

function parseCsv(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') quoted = false;
        else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function listAssignments(q) {
  const where = [];
  const args = [];
  if (q.get('module_id')) { where.push('a.module_id = ?'); args.push(Number(q.get('module_id'))); }
  if (q.get('user_id')) { where.push('a.user_id = ?'); args.push(Number(q.get('user_id'))); }
  if (q.get('department')) { where.push('u.department = ?'); args.push(q.get('department')); }
  if (q.get('source')) { where.push('a.source = ?'); args.push(q.get('source')); }
  const status = q.get('status');
  if (status === 'overdue') { where.push("a.status != 'completed' AND a.due_date < ?"); args.push(today()); }
  else if (status) { where.push('a.status = ?'); args.push(status); }
  if (q.get('search')) {
    where.push('(u.name LIKE ? OR u.email LIKE ? OR m.title LIKE ?)');
    const s = `%${q.get('search')}%`;
    args.push(s, s, s);
  }
  const sql = `${ASSIGNMENT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.due_date ASC, u.name ASC`;
  return (await db.prepare(sql).all(...args)).map(decorate);
}

async function myAssignment(user, id) {
  const a = await db.prepare(`${ASSIGNMENT_SELECT} WHERE a.id = ?`).get(Number(id));
  if (!a || a.user_id !== user.id) throw new HttpError(404, 'Assignment not found');
  return decorate(a);
}

// ---------- auth ----------
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
const origin = (req) => process.env.APP_URL?.replace(/\/+$/, '') || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
const cookie = (req, name, value, maxAge) => `${name}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

async function startSession(req, res, userId, { redirect } = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, Date.now() + SESSION_DAYS * 864e5);
  const set = cookie(req, 'sid', token, SESSION_DAYS * 86400);
  if (redirect) {
    res.writeHead(302, { Location: redirect, 'Set-Cookie': [set, cookie(req, 'g_state', '', 0)] });
    return res.end();
  }
  send(res, 200, { ok: true }, { 'Set-Cookie': set });
}

route('GET', '/api/config', null, async () => ({
  google: GOOGLE_ENABLED,
  password: PASSWORD_LOGIN,
  demoAccounts: !GOOGLE_ENABLED,
  domains: ALLOWED_DOMAINS,
  blobUploads: BLOB_MODE || false,
}));

route('POST', '/api/login', null, async ({ req, body, res }) => {
  if (!PASSWORD_LOGIN) throw new HttpError(403, 'Please sign in with Google');
  const user = await db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(str(body.email).toLowerCase());
  if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) throw new HttpError(401, 'Wrong email or password');
  await startSession(req, res, user.id);
});

// Sign in with Google (OAuth 2.0 authorization code flow). Only verified emails on ALLOWED_DOMAINS get in.
route('GET', '/api/auth/google', null, async ({ req, res, query }) => {
  if (!GOOGLE_ENABLED) throw new HttpError(404, 'Google sign-in is not set up');
  const state = crypto.randomBytes(16).toString('hex');
  // ?auto=1 is the silent attempt made when the sign-in page opens: if the person is already signed in to
  // Google with one account, Google sends them straight back signed in; otherwise it returns an error
  // and the sign-in page shows the button instead.
  const auto = query.get('auto') === '1';
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${origin(req)}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: auto ? 'none' : 'select_account',
  });
  if (ALLOWED_DOMAINS.length === 1) params.set('hd', ALLOWED_DOMAINS[0]); // pre-filters Google's account picker
  // The email used last time on this browser, so Google can pick that account silently when several are signed in.
  const hint = String(query.get('hint') || '').toLowerCase();
  if (isEmail(hint) && (!ALLOWED_DOMAINS.length || ALLOWED_DOMAINS.includes(hint.split('@')[1]))) params.set('login_hint', hint);
  res.writeHead(302, { Location: `${GOOGLE_AUTH_URL}?${params}`, 'Set-Cookie': cookie(req, 'g_state', auto ? `${state}.auto` : state, 600) });
  res.end();
});

route('GET', '/api/auth/google/callback', null, async ({ req, res, query }) => {
  const fail = (msg) => {
    res.writeHead(302, { Location: `/?login_error=${encodeURIComponent(msg)}`, 'Set-Cookie': cookie(req, 'g_state', '', 0) });
    res.end();
  };
  if (!GOOGLE_ENABLED) return fail('Google sign-in is not set up');
  const [expected, mode] = String(parseCookies(req).g_state || '').split('.');
  if (query.get('error')) {
    if (mode === 'auto') {
      // The silent attempt didn't work (not signed in to Google, or several accounts): show the normal sign-in page.
      res.writeHead(302, { Location: '/?sso=0', 'Set-Cookie': cookie(req, 'g_state', '', 0) });
      return res.end();
    }
    return fail('Google sign-in was cancelled');
  }
  if (!expected || query.get('state') !== expected) return fail('Your sign-in link expired. Please try again.');

  let claims;
  try {
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(query.get('code') || ''),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${origin(req)}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await r.json();
    if (!r.ok || !tokens.id_token) throw new Error(tokens.error_description || tokens.error || `token endpoint ${r.status}`);
    // The ID token came straight from Google over TLS in exchange for our secret, so its claims can be read directly.
    claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
  } catch (e) {
    console.error('Google sign-in failed:', e.message);
    return fail('Could not complete Google sign-in. Please try again.');
  }
  const email = String(claims.email || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  // GOOGLE_TOKEN_URL is only overridden for local testing against a stand-in Google.
  const issuerOk = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || !!process.env.GOOGLE_TOKEN_URL;
  if (claims.aud !== GOOGLE_CLIENT_ID || !issuerOk || Number(claims.exp) * 1000 < Date.now()) {
    return fail('Could not complete Google sign-in. Please try again.');
  }
  if (!claims.email_verified || !isEmail(email)) return fail('Your Google account email is not verified.');
  if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain)) {
    return fail(`Please use your company Google account (${ALLOWED_DOMAINS.map((d) => `@${d}`).join(' or ')}).`);
  }

  const isAdmin = ADMIN_EMAILS.includes(email);
  let user = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user && !user.active) return fail('Your account has been deactivated. Please contact HR.');
  if (!user) {
    // First sign-in from an allowed domain: create the employee and give them their onboarding modules.
    const created = await createEmployee({ name: claims.name || email.split('@')[0], email, joining_date: today(), password: crypto.randomBytes(24).toString('hex') }, null);
    user = { id: created.id, role: 'employee' };
  }
  if (isAdmin && user.role !== 'admin') await db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  await startSession(req, res, user.id, { redirect: '/' });
});

route('POST', '/api/logout', null, async ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  send(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, 'sid', '', 0) });
});

route('GET', '/api/me', 'user', async ({ user }) => user);

route('POST', '/api/me/password', 'user', async ({ user, body }) => {
  const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is wrong');
  if (String(body.next || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters');
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.next)), user.id);
  return { ok: true };
});

// ---------- admin: dashboard ----------
route('GET', '/api/dashboard', 'admin', async () => {
  const t = today();
  const totals = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE active = 1 AND role = 'employee') AS employees,
       (SELECT COUNT(*) FROM modules WHERE published = 1) AS modules,
       (SELECT COUNT(*) FROM assignments) AS assignments,
       (SELECT COUNT(*) FROM assignments WHERE status = 'completed') AS completed,
       (SELECT COUNT(*) FROM assignments WHERE status = 'in_progress') AS in_progress,
       (SELECT COUNT(*) FROM assignments WHERE status != 'completed' AND due_date < ?) AS overdue`
  ).get(t);
  const byModule = await db.prepare(
    `SELECT m.id, m.title, m.is_onboarding, COUNT(a.id) AS assigned,
       COALESCE(SUM(a.status = 'completed'), 0) AS completed,
       COALESCE(SUM(a.status != 'completed' AND a.due_date < ?), 0) AS overdue
     FROM modules m LEFT JOIN assignments a ON a.module_id = m.id
     GROUP BY m.id ORDER BY assigned DESC, m.title`
  ).all(t);
  const byDepartment = await db.prepare(
    `SELECT CASE WHEN u.department = '' THEN '(none)' ELSE u.department END AS department, COUNT(a.id) AS assigned,
       COALESCE(SUM(a.status = 'completed'), 0) AS completed,
       COALESCE(SUM(a.status != 'completed' AND a.due_date < ?), 0) AS overdue
     FROM assignments a JOIN users u ON u.id = a.user_id
     GROUP BY 1 ORDER BY 1`
  ).all(t);
  const overdue = (await db.prepare(`${ASSIGNMENT_SELECT} WHERE a.status != 'completed' AND a.due_date < ? ORDER BY a.due_date LIMIT 10`).all(t)).map(decorate);
  const recent = (await db.prepare(`${ASSIGNMENT_SELECT} WHERE a.status = 'completed' ORDER BY a.completed_at DESC LIMIT 10`).all()).map(decorate);
  const newJoiners = await db.prepare(
    `SELECT id, name, department, designation, joining_date FROM users
     WHERE active = 1 AND role = 'employee' AND joining_date >= ? ORDER BY joining_date DESC LIMIT 10`
  ).all(addDays(t, -30));
  return { totals, byModule, byDepartment, overdue, recent, newJoiners };
});

// ---------- admin: employees ----------
route('GET', '/api/employees', 'admin', async () => await db.prepare(
  `SELECT u.id, u.name, u.email, u.role, u.department, u.designation, u.joining_date, u.active,
     COUNT(a.id) AS assigned,
     COALESCE(SUM(a.status = 'completed'), 0) AS completed,
     COALESCE(SUM(a.status != 'completed' AND a.due_date < ?), 0) AS overdue
   FROM users u LEFT JOIN assignments a ON a.user_id = u.id
   GROUP BY u.id ORDER BY u.active DESC, u.name`
).all(today()));

route('GET', '/api/departments', 'admin', async () => (await db.prepare(
  "SELECT DISTINCT department FROM users WHERE department != '' ORDER BY department"
).all()).map((r) => r.department));

route('POST', '/api/employees', 'admin', async ({ body, user }) => createEmployee(body, user.id));

route('POST', '/api/employees/import', 'admin', async ({ body, user }) => {
  // Rows come either from an uploaded sheet (objects, header in row 1) or from pasted CSV text.
  let rows;
  let firstRow = 2;
  if (Array.isArray(body.rows)) rows = body.rows.slice(0, 5000);
  else {
    const csv = parseCsv(body.csv);
    firstRow = 1;
    if (csv.length && csv[0].some((c) => c.toLowerCase() === 'email')) { csv.shift(); firstRow = 2; }
    rows = csv.map(([name, email, department, designation, joining_date, role]) => ({ name, email, department, designation, joining_date, role }));
  }
  const created = [];
  const errors = [];
  for (const [i, r] of rows.entries()) {
    const email = str(r.email, 200).toLowerCase();
    try {
      const role = String(r.role || '').trim().toLowerCase() === 'admin' ? 'admin' : 'employee';
      const out = await createEmployee({ ...r, email, role, assign_onboarding: body.assign_onboarding !== false }, user.id);
      created.push({ email, ...out });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      errors.push({ row: i + firstRow, email, error: e.message });
    }
  }
  return { created: created.length, onboarding_assigned: created.reduce((s, c) => s + c.onboarding_assigned, 0), errors };
});

// Give or take away admin access in one click (Employees page).
route('PUT', '/api/employees/:id/role', 'admin', async ({ params, body, user }) => {
  const id = Number(params.id);
  const role = body.role === 'admin' ? 'admin' : 'employee';
  if (id === user.id && role !== 'admin') throw new HttpError(400, 'You cannot remove your own admin access');
  const r = await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  if (!r.changes) throw new HttpError(404, 'Employee not found');
  return { ok: true, role };
});

route('GET', '/api/employees/:id', 'admin', async ({ params }) => {
  const u = await db.prepare('SELECT id, name, email, role, department, designation, joining_date, active, created_at FROM users WHERE id = ?').get(Number(params.id));
  if (!u) throw new HttpError(404, 'Employee not found');
  u.assignments = (await db.prepare(`${ASSIGNMENT_SELECT} WHERE a.user_id = ? ORDER BY a.due_date`).all(u.id)).map(decorate);
  return u;
});

route('PUT', '/api/employees/:id', 'admin', async ({ params, body, user }) => {
  const id = Number(params.id);
  const e = validateEmployee(body, { partial: true });
  const active = body.active === false || body.active === 0 ? 0 : 1;
  if (id === user.id && (!active || e.role !== 'admin')) throw new HttpError(400, 'You cannot deactivate or demote yourself');
  const clash = await db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(e.email, id);
  if (clash) throw new HttpError(409, `${e.email} already exists`);
  const r = await db.prepare('UPDATE users SET name=?, email=?, role=?, department=?, designation=?, joining_date=?, active=? WHERE id=?')
    .run(e.name, e.email, e.role, e.department, e.designation, e.joining_date, active, id);
  if (!r.changes) throw new HttpError(404, 'Employee not found');
  if (body.password) {
    if (String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), id);
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (!active) await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { ok: true };
});

route('POST', '/api/employees/:id/onboarding', 'admin', async ({ params, user }) => ({ assigned: await assignOnboarding(Number(params.id), user.id) }));

// ---------- admin: modules ----------
route('GET', '/api/modules', 'admin', async () => await db.prepare(
  `SELECT m.*,
     (SELECT COUNT(*) FROM lessons l WHERE l.module_id = m.id) AS lessons_count,
     (SELECT COUNT(*) FROM questions q WHERE q.module_id = m.id) AS questions_count,
     (SELECT COUNT(*) FROM assignments a WHERE a.module_id = m.id) AS assigned,
     (SELECT COUNT(*) FROM assignments a WHERE a.module_id = m.id AND a.status = 'completed') AS completed
   FROM modules m ORDER BY m.is_onboarding DESC, m.title`
).all());

route('GET', '/api/modules/:id', 'admin', async ({ params }) => getModuleFull(Number(params.id), { includeAnswers: true }));
route('POST', '/api/modules', 'admin', async ({ body }) => ({ id: await saveModule(null, validateModule(body)) }));
route('PUT', '/api/modules/:id', 'admin', async ({ params, body }) => ({ id: await saveModule(Number(params.id), validateModule(body)) }));
// Child rows are deleted explicitly so this works whether or not the database enforces foreign keys.
async function deleteAssignmentsWhere(where, ...args) {
  const ids = `SELECT id FROM assignments WHERE ${where}`;
  await db.prepare(`DELETE FROM lesson_progress WHERE assignment_id IN (${ids})`).run(...args);
  await db.prepare(`DELETE FROM video_progress WHERE assignment_id IN (${ids})`).run(...args);
  await db.prepare(`DELETE FROM quiz_attempts WHERE assignment_id IN (${ids})`).run(...args);
  return db.prepare(`DELETE FROM assignments WHERE ${where}`).run(...args);
}

route('DELETE', '/api/modules/:id', 'admin', async ({ params }) => {
  const id = Number(params.id);
  await tx(async () => {
    await deleteAssignmentsWhere('module_id = ?', id);
    await db.prepare('DELETE FROM lessons WHERE module_id = ?').run(id);
    await db.prepare('DELETE FROM questions WHERE module_id = ?').run(id);
    const r = await db.prepare('DELETE FROM modules WHERE id = ?').run(id);
    if (!r.changes) throw new HttpError(404, 'Module not found');
  });
  return { ok: true };
});

// ---------- admin: assignments ----------
route('GET', '/api/assignments', 'admin', async ({ query }) => listAssignments(query));

route('GET', '/api/assignments.csv', 'admin', async ({ query, res }) => {
  const rows = await listAssignments(query);
  const header = ['Employee', 'Email', 'Department', 'Module', 'Source', 'Assigned on', 'Due date', 'Status', 'Overdue', 'Progress %', 'Best score', 'Completed at'];
  const lines = [header, ...rows.map((a) => [a.user_name, a.user_email, a.user_department, a.module_title, a.source, a.assigned_at.slice(0, 10), a.due_date, a.status, a.overdue ? 'yes' : 'no', a.progress, a.best_score ?? '', a.completed_at || ''])];
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="lms-progress-${today()}.csv"` });
  res.end(lines.map((l) => l.map(csvCell).join(',')).join('\n'));
});

async function assignmentInput(body) {
  const m = await db.prepare('SELECT * FROM modules WHERE id = ?').get(Number(body.module_id));
  if (!m) throw new HttpError(400, 'Choose a module');
  const due = str(body.due_date, 10) || addDays(today(), m.due_days);
  if (!isDate(due)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
  return { moduleId: m.id, due, note: str(body.note, 500) };
}

// Returns false when the employee already has this module open; completed ones can be re-assigned (refreshers).
async function assignOne({ moduleId, due, note }, userId, adminId) {
  if (await db.prepare("SELECT 1 FROM assignments WHERE module_id = ? AND user_id = ? AND status != 'completed'").get(moduleId, userId)) return false;
  await db.prepare(
    `INSERT INTO assignments (module_id, user_id, source, assigned_by, note, due_date) VALUES (?, ?, 'manual', ?, ?, ?)`
  ).run(moduleId, userId, adminId, note, due);
  return true;
}

route('POST', '/api/assignments', 'admin', async ({ body, user }) => {
  const input = await assignmentInput(body);
  const userIds = [...new Set((Array.isArray(body.user_ids) ? body.user_ids : []).map(Number).filter(Boolean))];
  if (!userIds.length) throw new HttpError(400, 'Choose at least one employee');
  let created = 0;
  let skipped = 0;
  await tx(async () => {
    for (const uid of userIds) {
      if (await db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid) && await assignOne(input, uid, user.id)) created++;
      else skipped++;
    }
  });
  return { created, skipped };
});

// Bulk assignment from an uploaded sheet: rows are matched to employees by email,
// and unknown people can be added on the spot (they also get their onboarding modules).
route('POST', '/api/assignments/bulk', 'admin', async ({ body, user }) => {
  const input = await assignmentInput(body);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
  if (!rows.length) throw new HttpError(400, 'The sheet has no rows');
  const result = { created: 0, skipped: 0, new_employees: 0, errors: [] };
  const seen = new Set();
  // Rows are independent: one bad row never undoes the others.
  for (const [i, r] of rows.entries()) {
      const row = i + 2; // row 1 is the header in the sheet
      const email = str(r.email, 200).toLowerCase();
      try {
        if (!isEmail(email)) throw new HttpError(400, `Invalid email "${email || '(blank)'}"`);
        if (seen.has(email)) throw new HttpError(400, `${email} appears more than once`);
        seen.add(email);
        let u = await db.prepare('SELECT id, active FROM users WHERE email = ?').get(email);
        if (u && !u.active) throw new HttpError(400, `${email} is deactivated`);
        if (!u) {
          if (!body.create_missing) throw new HttpError(400, `${email} is not in the system`);
          if (!str(r.name)) throw new HttpError(400, `${email} is new, so the Name column is needed`);
          u = { id: (await createEmployee({ ...r, email, role: 'employee' }, user.id)).id };
          result.new_employees++;
        }
        if (await assignOne(input, u.id, user.id)) result.created++;
        else result.skipped++;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        result.errors.push({ row, email, error: e.message });
      }
  }
  return result;
});

// Video upload: the request body is the raw file, streamed to disk.
// Online (Vercel): the browser uploads the video straight to Vercel Blob storage; this route only hands it a
// short-lived permission to do so. Functions on Vercel can't receive large request bodies themselves.
route('POST', '/api/uploads/blob', 'admin', async ({ req, body }) => {
  if (!BLOB_ENABLED) throw new HttpError(404, 'Online video storage is not set up');
  const checkName = (pathname) => {
    if (!VIDEO_TYPES[path.extname(pathname).toLowerCase()]) throw new HttpError(400, 'Please upload a video file (MP4, WebM or MOV)');
  };
  if (BLOB_MODE === 'presigned') {
    const { handleUploadPresigned } = require('@vercel/blob/client');
    const { issueSignedToken } = require('@vercel/blob');
    return handleUploadPresigned({
      request: req,
      body,
      getSignedToken: async (pathname) => {
        checkName(pathname);
        const limits = { allowedContentTypes: VIDEO_CONTENT_TYPES(), maximumSizeInBytes: MAX_UPLOAD_BYTES };
        const token = await issueSignedToken({ pathname: '*', operations: ['put'], validUntil: Date.now() + 3600e3, ...limits });
        return { token, urlOptions: { ...limits, addRandomSuffix: true } };
      },
    });
  }
  const { handleUpload } = require('@vercel/blob/client');
  return handleUpload({
    token: BLOB_TOKEN,
    request: req,
    body,
    onBeforeGenerateToken: async (pathname) => {
      checkName(pathname);
      return {
        allowedContentTypes: VIDEO_CONTENT_TYPES(),
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        addRandomSuffix: true,
      };
    },
  });
});

// Playback for videos in a Blob store that uses store-id login: signed-in users get a short-lived link.
// The stored pathname contains a slash (videos/…); the link may arrive with it encoded or not, so match the rest of the path.
route('GET', '/api/media/:access/:pathname*', 'user', async ({ res, params, query }) => {
  if (BLOB_MODE !== 'presigned') throw new HttpError(404, 'Video not found');
  const access = params.access === 'public' ? 'public' : 'private';
  const pathname = String(params.pathname);
  const { issueSignedToken, presignUrl } = require('@vercel/blob');
  let presignedUrl;
  try {
    const token = await issueSignedToken({ pathname, operations: ['get', 'head'], validUntil: Date.now() + 6 * 3600e3 });
    ({ presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access }));
  } catch (e) {
    console.error('Video link failed:', pathname, e.message);
    throw new HttpError(502, `Video storage refused the request: ${e.message}`);
  }
  // ?check=1 is asked by the player when a video won't play, so the page can say why.
  if (query.get('check') === '1') {
    const r = await fetch(presignedUrl, { headers: { Range: 'bytes=0-0' } }).catch((e) => ({ ok: false, status: 0, statusText: e.message, headers: new Headers() }));
    return { ok: r.ok, status: r.status, statusText: r.statusText, contentType: r.headers.get('content-type'), pathname, access };
  }
  res.writeHead(302, { Location: presignedUrl, 'Cache-Control': 'private, max-age=300' });
  res.end();
});

route('POST', '/api/uploads', 'admin', async ({ req, query }) => new Promise((resolve, reject) => {
  if (ON_VERCEL) return reject(new HttpError(400, 'Video uploads need Blob storage connected in Vercel'));
  const type = String(req.headers['content-type'] || '');
  const original = path.basename(String(query.get('name') || 'video.mp4'));
  const ext = path.extname(original).toLowerCase();
  if (!VIDEO_TYPES[ext] || !(type.startsWith('video/') || type === 'application/octet-stream')) {
    return reject(new HttpError(400, 'Please upload a video file (MP4, WebM or MOV)'));
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) return reject(new HttpError(413, 'This video is larger than 1 GB'));
  const safeName = original.slice(0, -ext.length).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video';
  const name = `${crypto.randomBytes(6).toString('hex')}-${safeName}${ext}`;
  const tmp = path.join(UPLOAD_DIR, `.${name}.part`);
  const out = fs.createWriteStream(tmp);
  let size = 0;
  let failed = false;
  const abort = (err) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(tmp, { force: true }, () => reject(err));
  };
  req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD_BYTES) abort(new HttpError(413, 'This video is larger than 1 GB')); });
  req.on('error', abort);
  out.on('error', abort);
  out.on('finish', () => {
    if (failed) return;
    if (!size) return abort(new HttpError(400, 'The file is empty'));
    fs.rename(tmp, path.join(UPLOAD_DIR, name), (err) => (err ? abort(err) : resolve({ url: `/uploads/${name}`, size })));
  });
  req.pipe(out);
}), { raw: true });

route('PUT', '/api/assignments/:id', 'admin', async ({ params, body }) => {
  if (!isDate(body.due_date)) throw new HttpError(400, 'Due date must be YYYY-MM-DD');
  const r = await db.prepare('UPDATE assignments SET due_date = ? WHERE id = ?').run(body.due_date, Number(params.id));
  if (!r.changes) throw new HttpError(404, 'Assignment not found');
  return { ok: true };
});

route('DELETE', '/api/assignments/:id', 'admin', async ({ params }) => {
  const r = await tx(() => deleteAssignmentsWhere('id = ?', Number(params.id)));
  if (!r.changes) throw new HttpError(404, 'Assignment not found');
  return { ok: true };
});

// ---------- learner ----------
route('GET', '/api/my/assignments', 'user', async ({ user }) =>
  (await db.prepare(`${ASSIGNMENT_SELECT} WHERE a.user_id = ? ORDER BY (a.status = 'completed'), a.due_date`).all(user.id)).map(decorate));

route('GET', '/api/my/assignments/:id', 'user', async ({ user, params }) => {
  const a = await myAssignment(user, params.id);
  const m = await getModuleFull(a.module_id, { includeAnswers: false });
  const done = new Set((await db.prepare('SELECT lesson_id FROM lesson_progress WHERE assignment_id = ?').all(a.id)).map((r) => r.lesson_id));
  const watched = new Map((await db.prepare('SELECT * FROM video_progress WHERE assignment_id = ?').all(a.id)).map((r) => [r.lesson_id, r]));
  m.lessons = m.lessons.map((l) => {
    const v = watched.get(l.id);
    const mine = v && v.video_url === l.video_url ? v : null; // progress on a replaced video doesn't count
    return { ...l, done: done.has(l.id), must_watch: isTrackedVideo(l.video_url), video_watched: mine?.watched || 0, video_duration: mine?.duration || 0 };
  });
  const attempts = await db.prepare('SELECT id, score, passed, created_at FROM quiz_attempts WHERE assignment_id = ? ORDER BY id DESC').all(a.id);
  return { assignment: a, module: m, attempts };
});

route('POST', '/api/my/assignments/:id/lessons/:lessonId/complete', 'user', async ({ user, params }) => {
  const a = await myAssignment(user, params.id);
  const lesson = await db.prepare('SELECT id, video_url FROM lessons WHERE id = ? AND module_id = ?').get(Number(params.lessonId), a.module_id);
  if (!lesson) throw new HttpError(404, 'Lesson not found');
  if (isTrackedVideo(lesson.video_url)) {
    const v = await db.prepare('SELECT * FROM video_progress WHERE assignment_id = ? AND lesson_id = ?').get(a.id, lesson.id);
    const finished = v && v.video_url === lesson.video_url && v.duration > 0 && v.watched >= v.duration - VIDEO_END_SLACK;
    const already = await db.prepare('SELECT 1 FROM lesson_progress WHERE assignment_id = ? AND lesson_id = ?').get(a.id, lesson.id);
    if (!finished && !already) throw new HttpError(400, 'Please watch the full video before marking this lesson complete');
  }
  await db.prepare('INSERT OR IGNORE INTO lesson_progress (assignment_id, lesson_id) VALUES (?, ?)').run(a.id, lesson.id);
  await refreshAssignmentStatus(a.id);
  return myAssignment(user, a.id);
});

// The player reports how far the learner has watched. "Watched" can never exceed the real time since they first
// started this video (plus a little slack), so the full video has to actually play before the lesson can be completed.
route('POST', '/api/my/assignments/:id/lessons/:lessonId/video', 'user', async ({ user, params, body }) => {
  const a = await myAssignment(user, params.id);
  const lesson = await db.prepare('SELECT id, video_url FROM lessons WHERE id = ? AND module_id = ?').get(Number(params.lessonId), a.module_id);
  if (!lesson) throw new HttpError(404, 'Lesson not found');
  const reported = Math.max(0, Number(body.watched) || 0);
  const duration = Math.max(0, Number(body.duration) || 0);
  const now = Date.now();
  const prev = await db.prepare('SELECT * FROM video_progress WHERE assignment_id = ? AND lesson_id = ?').get(a.id, lesson.id);
  const same = prev && prev.video_url === lesson.video_url;
  const before = same ? prev.watched : 0;
  const started = same ? prev.started_ms : now;
  const allowed = ((now - started) / 1000) * 1.05 + VIDEO_REPORT_SLACK;
  let watched = Math.max(before, Math.min(reported, allowed));
  if (duration) watched = Math.min(watched, duration);
  await db.prepare(`INSERT INTO video_progress (assignment_id, lesson_id, video_url, watched, duration, updated_ms, started_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (assignment_id, lesson_id) DO UPDATE SET video_url = excluded.video_url, watched = excluded.watched, duration = excluded.duration,
      updated_ms = excluded.updated_ms, started_ms = excluded.started_ms`)
    .run(a.id, lesson.id, lesson.video_url, watched, duration || (same ? prev.duration : 0), now, started);
  return { watched, duration, finished: duration > 0 && watched >= duration - VIDEO_END_SLACK };
});

route('POST', '/api/my/assignments/:id/quiz', 'user', async ({ user, params, body }) => {
  const a = await myAssignment(user, params.id);
  if (a.lessons_done < a.lessons_total) throw new HttpError(400, 'Finish all lessons before taking the quiz');
  const questions = await db.prepare('SELECT * FROM questions WHERE module_id = ? ORDER BY position').all(a.module_id);
  if (!questions.length) throw new HttpError(400, 'This module has no quiz');
  const answers = Array.isArray(body.answers) ? body.answers.map((x) => (x === null || x === undefined ? null : Number(x))) : [];
  const correct = questions.map((q, i) => answers[i] === q.correct_index);
  const score = Math.round((correct.filter(Boolean).length / questions.length) * 100);
  const passed = score >= a.pass_mark ? 1 : 0;
  await tx(async () => {
    await db.prepare('INSERT INTO quiz_attempts (assignment_id, score, passed, answers) VALUES (?, ?, ?, ?)').run(a.id, score, passed, JSON.stringify(answers));
    await db.prepare('UPDATE assignments SET best_score = MAX(COALESCE(best_score, 0), ?) WHERE id = ?').run(score, a.id);
    await refreshAssignmentStatus(a.id);
  });
  return {
    score,
    passed: !!passed,
    pass_mark: a.pass_mark,
    // Correct answers are revealed only once the learner passes.
    results: questions.map((q, i) => ({ correct: correct[i], correct_index: passed ? q.correct_index : undefined })),
    assignment: await myAssignment(user, a.id),
  };
});

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app shell.
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        res.writeHead(e2 ? 404 : 200, { 'Content-Type': MIME['.html'] });
        res.end(html || 'Not found');
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Uploaded videos: signed-in users only, with byte-range support so the player can seek.
async function serveUpload(req, res, pathname) {
  if (!(await currentUser(req))) throw new HttpError(401, 'Please sign in');
  const file = path.join(UPLOAD_DIR, path.basename(decodeURIComponent(pathname)));
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const type = VIDEO_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, st.size - 1);
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    await ready({ withDemoUsers: !GOOGLE_ENABLED });
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const user = await currentUser(req);
        if (r.role && !user) throw new HttpError(401, 'Please sign in');
        if (r.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Admins only');
        let body = {};
        if (!r.raw && ['POST', 'PUT', 'DELETE'].includes(req.method)) {
          // Requiring a JSON content type blocks cross-site form posts (CSRF).
          if (req.method !== 'DELETE' && !String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Send JSON');
          body = await readBody(req);
        }
        const result = await r.handler({ req, res, params, query: url.searchParams, body, user });
        if (result !== undefined && !res.writableEnded) send(res, 200, result);
        return;
      }
      throw new HttpError(404, 'Not found');
    }
    if (url.pathname.startsWith('/uploads/')) return serveUpload(req, res, url.pathname);
    serveStatic(url.pathname, res);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
  }
}

module.exports = { handle };

if (require.main === module) {
  http.createServer(handle).listen(PORT, () => {
    console.log(`LMS running at http://localhost:${PORT}`);
    if (!GOOGLE_ENABLED) console.log('Demo admin: admin@company.com / admin123 · Demo employee: priya@company.com / welcome123');
  });
}
