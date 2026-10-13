// Database setup, schema, shared helpers and demo seed data.
// Two drivers behind one async interface:
// - online (Vercel): a hosted SQLite database (Turso / libSQL) when TURSO_DATABASE_URL is set;
// - local: Node's built-in SQLite file (node:sqlite, Node 22.5+), nothing to install.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || '';
const DB_PATH = process.env.LMS_DB || path.join(__dirname, 'data', 'lms.db');
const txScope = new AsyncLocalStorage();
let driver;

if (REMOTE_URL) {
  const { createClient } = require('@libsql/client');
  const client = createClient({ url: REMOTE_URL, authToken: process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN });
  const target = () => txScope.getStore() || client;
  const rows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, typeof r[i] === 'bigint' ? Number(r[i]) : r[i]])));
  driver = {
    all: async (sql, args) => rows(await target().execute({ sql, args })),
    run: async (sql, args) => {
      const rs = await target().execute({ sql, args });
      return { changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) };
    },
    script: async (sql) => { await client.executeMultiple(sql); },
    tx: async (fn) => {
      const t = await client.transaction('write');
      try {
        const result = await txScope.run(t, fn);
        await t.commit();
        return result;
      } catch (e) {
        await t.rollback().catch(() => {});
        throw e;
      } finally {
        t.close();
      }
    },
  };
} else if (process.env.VERCEL) {
  // Online but no database connected yet: answer every request with a clear setup message.
  const missing = async () => {
    const e = new Error('Setup not finished: connect the Turso database in Vercel (Storage tab), then redeploy.');
    e.status = 503;
    throw e;
  };
  driver = { all: missing, run: missing, script: missing, tx: missing };
} else {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const local = new DatabaseSync(DB_PATH);
  local.exec('PRAGMA foreign_keys = ON;');
  // One transaction at a time, so requests can't interleave inside each other's BEGIN/COMMIT.
  let queue = Promise.resolve();
  driver = {
    all: async (sql, args) => local.prepare(sql).all(...args),
    run: async (sql, args) => { const r = local.prepare(sql).run(...args); return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) }; },
    script: async (sql) => { local.exec(sql); },
    tx: (fn) => {
      const go = async () => {
        local.exec('BEGIN');
        try {
          const result = await txScope.run(true, fn);
          local.exec('COMMIT');
          return result;
        } catch (e) {
          local.exec('ROLLBACK');
          throw e;
        }
      };
      const p = queue.then(go, go);
      queue = p.catch(() => {});
      return p;
    },
  };
}

// Same shape as node:sqlite's prepare(), but every call returns a promise.
const db = {
  prepare: (sql) => ({
    get: async (...args) => (await driver.all(sql, args))[0],
    all: (...args) => driver.all(sql, args),
    run: (...args) => driver.run(sql, args),
  }),
};

// Runs fn in a transaction; nested calls join the outer transaction.
function tx(fn) {
  if (txScope.getStore()) return fn();
  return driver.tx(fn);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','employee')),
  department TEXT NOT NULL DEFAULT '',
  designation TEXT NOT NULL DEFAULT '',
  joining_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  is_onboarding INTEGER NOT NULL DEFAULT 0,
  onboarding_departments TEXT NOT NULL DEFAULT '',
  due_days INTEGER NOT NULL DEFAULT 7,
  pass_mark INTEGER NOT NULL DEFAULT 70,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  video_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  options TEXT NOT NULL,
  correct_index INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('onboarding','manual')),
  assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','in_progress','completed')),
  started_at TEXT,
  completed_at TEXT,
  best_score INTEGER
);
CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_assign_module ON assignments(module_id);
CREATE TABLE IF NOT EXISTS video_progress (
  assignment_id INTEGER NOT NULL,
  lesson_id INTEGER NOT NULL,
  video_url TEXT NOT NULL,
  watched REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0,
  updated_ms INTEGER NOT NULL,
  started_ms INTEGER NOT NULL,
  PRIMARY KEY (assignment_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS lesson_progress (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (assignment_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  answers TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Dates are stored as YYYY-MM-DD strings in local server time.
function today() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function departmentMatches(moduleDepartments, department) {
  const list = String(moduleDepartments || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length === 0 || list.includes(String(department || '').trim().toLowerCase());
}

// Assigns every published onboarding module that targets this employee's department.
// The due date is counted from the joining date. Modules already assigned are skipped.
async function assignOnboarding(userId, assignedBy = null) {
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return 0;
  const modules = await db.prepare('SELECT * FROM modules WHERE is_onboarding = 1 AND published = 1').all();
  const exists = db.prepare('SELECT 1 FROM assignments WHERE module_id = ? AND user_id = ?');
  const insert = db.prepare(
    `INSERT INTO assignments (module_id, user_id, source, assigned_by, due_date)
     VALUES (?, ?, 'onboarding', ?, ?)`
  );
  let count = 0;
  for (const m of modules) {
    if (!departmentMatches(m.onboarding_departments, user.department)) continue;
    if (await exists.get(m.id, user.id)) continue;
    await insert.run(m.id, user.id, assignedBy, addDays(user.joining_date, m.due_days));
    count++;
  }
  return count;
}

// Re-derives an assignment's status from its lesson progress and quiz attempts.
async function refreshAssignmentStatus(assignmentId) {
  const a = await db.prepare('SELECT * FROM assignments WHERE id = ?').get(assignmentId);
  if (!a) return;
  const lessons = (await db.prepare('SELECT COUNT(*) AS n FROM lessons WHERE module_id = ?').get(a.module_id)).n;
  const done = (await db.prepare(
    `SELECT COUNT(*) AS n FROM lesson_progress lp JOIN lessons l ON l.id = lp.lesson_id
     WHERE lp.assignment_id = ? AND l.module_id = ?`
  ).get(a.id, a.module_id)).n;
  const questions = (await db.prepare('SELECT COUNT(*) AS n FROM questions WHERE module_id = ?').get(a.module_id)).n;
  const attempts = await db.prepare('SELECT COUNT(*) AS n, MAX(passed) AS passed FROM quiz_attempts WHERE assignment_id = ?').get(a.id);
  const complete = done >= lessons && (questions === 0 || attempts.passed === 1);
  let status = 'assigned';
  if (complete) status = 'completed';
  else if (done > 0 || attempts.n > 0) status = 'in_progress';
  await db.prepare(
    `UPDATE assignments SET status = ?,
       started_at = CASE WHEN ? != 'assigned' THEN COALESCE(started_at, datetime('now')) ELSE started_at END,
       completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, datetime('now')) ELSE NULL END
     WHERE id = ?`
  ).run(status, status, status, a.id);
}

// withDemoUsers=false (online with Google sign-in) seeds only the sample modules.
async function seed({ withDemoUsers }) {
  const counts = await db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM modules) AS modules').get();
  if (counts.users > 0 || counts.modules > 0) return;

  const addUser = db.prepare(
    `INSERT INTO users (name, email, password_hash, role, department, designation, joining_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const addModule = db.prepare(
    `INSERT INTO modules (title, description, category, is_onboarding, onboarding_departments, due_days, pass_mark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const addLesson = db.prepare('INSERT INTO lessons (module_id, position, title, content, video_url) VALUES (?, ?, ?, ?, ?)');
  const addQuestion = db.prepare('INSERT INTO questions (module_id, position, text, options, correct_index) VALUES (?, ?, ?, ?, ?)');

  const modules = [
    {
      title: 'Welcome to the Company',
      description: 'Our story, values, and how we work together. Every new joiner starts here.',
      category: 'Onboarding', onboarding: 1, departments: '', dueDays: 7, passMark: 70,
      lessons: [
        ['Our story and mission', '# Who we are\nWe started with a simple idea: make complex decisions easier for millions of people.\n\n## Our mission\n- Put the customer first in every decision\n- Build with **integrity** and transparency\n- Move fast, learn faster\n\nTake a few minutes to explore the company intranet and meet your team.', ''],
        ['Our values in practice', '# Values you will see every day\n- **Ownership**: treat problems as your own and see them through\n- **Candour**: share honest feedback kindly and early\n- **Customer obsession**: start from what the customer needs\n- **Learning**: stay curious and help others grow\n\nYour manager will walk you through how your team applies these values.', ''],
        ['Your first 30 days', '# What to expect\n- Week 1: set up your accounts, meet your buddy and team\n- Week 2: shadow colleagues and complete your onboarding modules\n- Weeks 3-4: take on your first piece of real work\n\nAsk questions early. Nobody expects you to know everything yet.', ''],
      ],
      questions: [
        ['Which value means treating problems as your own and seeing them through?', ['Candour', 'Ownership', 'Learning', 'Customer obsession'], 1],
        ['What should you do in your first week?', ['Ship a major project', 'Set up accounts and meet your buddy and team', 'Skip onboarding modules', 'Plan the annual budget'], 1],
      ],
    },
    {
      title: 'Information Security Basics',
      description: 'Protect company and customer data: passwords, phishing, devices and reporting incidents.',
      category: 'Compliance', onboarding: 1, departments: '', dueDays: 14, passMark: 80,
      lessons: [
        ['Passwords and MFA', '# Strong access habits\n- Use a password manager and a unique password for every system\n- Always turn on multi-factor authentication (MFA)\n- Never share your credentials, not even with IT\n\nIT will **never** ask for your password.', ''],
        ['Spotting phishing', '# Phishing red flags\n- Urgent language or threats\n- Sender address that does not match the company domain\n- Unexpected attachments or login links\n\nWhen in doubt, do not click. Report the email to the security team.', ''],
        ['Reporting an incident', '# If something goes wrong\nReport lost devices, suspicious emails and accidental data sharing **immediately** to the security team. Fast reporting limits the damage. You will never be penalised for reporting in good faith.', ''],
      ],
      questions: [
        ['IT asks you for your password over chat. What should you do?', ['Share it, IT needs it', 'Refuse and report it to security', 'Share only half of it', 'Change it after sharing'], 1],
        ['Which is a common phishing red flag?', ['An email from your manager about lunch', 'Urgent language with an unexpected login link', 'A calendar invite for a team meeting', 'A newsletter you subscribed to'], 1],
        ['You lost your laptop. When should you report it?', ['After a week of searching', 'Only if it had customer data', 'Immediately', 'Never'], 2],
      ],
    },
    {
      title: 'Sales Playbook Essentials',
      description: 'Onboarding for the Sales team: pipeline stages, qualification and CRM hygiene.',
      category: 'Onboarding', onboarding: 1, departments: 'Sales', dueDays: 21, passMark: 70,
      lessons: [
        ['Pipeline stages', '# Our pipeline\n- Lead\n- Qualified\n- Proposal\n- Negotiation\n- Closed won / Closed lost\n\nMove a deal forward only when its exit criteria are met.', ''],
        ['CRM hygiene', '# Keep the CRM clean\nLog every call and meeting on the same day, keep the next step and close date up to date, and never leave a deal without an owner.', ''],
      ],
      questions: [
        ['When should you log a customer call in the CRM?', ['At the end of the quarter', 'The same day', 'Only if the deal closes', 'Never'], 1],
      ],
    },
    {
      title: 'POSH Awareness (Prevention of Sexual Harassment)',
      description: 'Annual refresher on a safe and respectful workplace. Assigned as needed.',
      category: 'Compliance', onboarding: 0, departments: '', dueDays: 14, passMark: 80,
      lessons: [
        ['A safe workplace', '# Our commitment\nEveryone deserves a workplace free from harassment. This module explains what harassment is, how to raise a concern and how the Internal Committee handles complaints confidentially.', ''],
        ['Raising a concern', '# How to raise a concern\n- Write to the Internal Committee (IC)\n- Speak to your HR business partner\n- Complaints are handled confidentially and retaliation is not tolerated', ''],
      ],
      questions: [
        ['Who handles harassment complaints?', ['Your direct teammates', 'The Internal Committee', 'Customers', 'Nobody'], 1],
      ],
    },
    {
      title: 'Giving and Receiving Feedback',
      description: 'A short skills module for new managers and anyone who wants to grow. Assigned as needed.',
      category: 'Skills', onboarding: 0, departments: '', dueDays: 30, passMark: 60,
      lessons: [
        ['The SBI model', '# Situation, Behaviour, Impact\nDescribe the **situation**, the specific **behaviour** you observed, and its **impact**. It keeps feedback concrete and fair.', ''],
      ],
      questions: [
        ['What does SBI stand for?', ['Simple, Brief, Informal', 'Situation, Behaviour, Impact', 'Skills, Benefits, Ideas', 'Start, Build, Improve'], 1],
      ],
    },
  ];

  await tx(async () => {
    for (const m of modules) {
      const { lastInsertRowid: id } = await addModule.run(m.title, m.description, m.category, m.onboarding, m.departments, m.dueDays, m.passMark);
      for (const [i, l] of m.lessons.entries()) await addLesson.run(id, i, l[0], l[1], l[2]);
      for (const [i, q] of m.questions.entries()) await addQuestion.run(id, i, q[0], JSON.stringify(q[1]), q[2]);
    }
    if (!withDemoUsers) return;
    const { lastInsertRowid: adminId } = await addUser.run('Admin', 'admin@company.com', hashPassword('admin123'), 'admin', 'HR', 'L&D Admin', '2024-01-01');
    const employees = [
      ['Priya Sharma', 'priya@company.com', 'Engineering', 'Software Engineer', addDays(today(), -3)],
      ['Arjun Mehta', 'arjun@company.com', 'Sales', 'Account Executive', addDays(today(), -10)],
      ['Neha Gupta', 'neha@company.com', 'Marketing', 'Marketing Manager', addDays(today(), -400)],
    ];
    const ids = [];
    for (const e of employees) ids.push((await addUser.run(e[0], e[1], hashPassword('welcome123'), 'employee', e[2], e[3], e[4])).lastInsertRowid);
    // New joiners get onboarding automatically; the long-tenured employee gets an ad hoc refresher.
    await assignOnboarding(ids[0], adminId);
    await assignOnboarding(ids[1], adminId);
    const posh = (await db.prepare("SELECT id FROM modules WHERE title LIKE 'POSH%'").get()).id;
    await db.prepare(
      `INSERT INTO assignments (module_id, user_id, source, assigned_by, note, due_date)
       VALUES (?, ?, 'manual', ?, 'Annual compliance refresher', ?)`
    ).run(posh, ids[2], adminId, addDays(today(), 14));
  });
}

// Creates tables and sample content once per process; await this before using the database.
let readyPromise;
function ready({ withDemoUsers = true } = {}) {
  readyPromise ||= (async () => {
    await driver.script(SCHEMA);
    await seed({ withDemoUsers });
  })().catch((e) => { readyPromise = null; throw e; }); // retry on the next request
  return readyPromise;
}

module.exports = { DB_PATH, REMOTE_URL, ready, db, tx, hashPassword, verifyPassword, today, addDays, assignOnboarding, refreshAssignmentStatus, departmentMatches };
