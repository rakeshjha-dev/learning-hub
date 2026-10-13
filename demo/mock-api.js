// In-browser stand-in for server.js, used only by the one-file demo build.
// It answers the same /api routes from data kept in the browser, so the real app.js runs unchanged.
(function () {
  'use strict';
  window.LMS_DEMO = true;
  const KEY = 'learning-hub-demo-v1';
  const SEED = window.LMS_SEED;
  const DEFAULT_PASSWORD = 'welcome123';

  // ---------- dates ----------
  function today() {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }
  function addDays(dateStr, n) {
    const d = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(n || 0));
    return d.toISOString().slice(0, 10) + dateStr.slice(10);
  }
  const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5);

  // ---------- store ----------
  function fresh() {
    const s = JSON.parse(JSON.stringify(SEED.tables));
    // Seed dates are relative to when the demo was built; move them so "joined 3 days ago" stays true.
    const shift = daysBetween(SEED.buildDate, today());
    const move = (v) => (v ? addDays(v, shift) : v);
    s.users.forEach((u) => { u.joining_date = move(u.joining_date); u.created_at = move(u.created_at); });
    s.modules.forEach((m) => { m.created_at = move(m.created_at); m.updated_at = move(m.updated_at); });
    s.assignments.forEach((a) => { ['assigned_at', 'due_date', 'started_at', 'completed_at'].forEach((k) => { a[k] = move(a[k]); }); });
    s.lesson_progress.forEach((p) => { p.completed_at = move(p.completed_at); });
    s.quiz_attempts.forEach((t) => { t.created_at = move(t.created_at); });
    s.session = null;
    return s;
  }
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || fresh(); } catch { S = fresh(); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage unavailable: keep in memory */ } };
  window.LMS_RESET_DEMO = () => {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    try { indexedDB.deleteDatabase(VIDEO_DB); } catch { /* ignore */ }
    location.hash = '';
    location.reload();
  };

  // ---------- uploaded videos (kept in this browser's IndexedDB, or in memory if that is blocked) ----------
  const VIDEO_DB = 'learning-hub-demo-videos';
  const memoryVideos = new Map();
  const openVideoDb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open(VIDEO_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('videos');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  async function putVideo(id, blob) {
    memoryVideos.set(id, blob);
    try {
      const d = await openVideoDb();
      await new Promise((resolve, reject) => { const t = d.transaction('videos', 'readwrite'); t.objectStore('videos').put(blob, id); t.oncomplete = resolve; t.onerror = () => reject(t.error); });
    } catch { /* memory copy still works for this visit */ }
  }
  async function getVideo(id) {
    if (memoryVideos.has(id)) return memoryVideos.get(id);
    try {
      const d = await openVideoDb();
      return await new Promise((resolve) => { const r = d.transaction('videos').objectStore('videos').get(id); r.onsuccess = () => resolve(r.result || null); r.onerror = () => resolve(null); });
    } catch { return null; }
  }
  const objectUrls = new Map();
  window.LMS_HYDRATE_VIDEOS = async (root) => {
    for (const v of root.querySelectorAll('video[data-demo-video]')) {
      const id = v.dataset.demoVideo;
      if (!objectUrls.has(id)) {
        const blob = await getVideo(id);
        if (!blob) { v.outerHTML = '<p class="sub">This video was uploaded in another browser, so it can\'t be shown here.</p>'; continue; }
        objectUrls.set(id, URL.createObjectURL(blob));
      }
      v.src = objectUrls.get(id);
    }
  };

  const nextId = (table) => S[table].reduce((m, r) => Math.max(m, r.id || 0), 0) + 1;
  const userById = (id) => S.users.find((u) => u.id === id);
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const str = (v, max = 5000) => String(v ?? '').trim().slice(0, max);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ''));
  const toInt = (v, fb) => (v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v)) : fb);
  const byName = (a, b) => a.name.localeCompare(b.name);

  // ---------- domain logic (mirrors db.js / server.js) ----------
  const lessonsOf = (mid) => S.lessons.filter((l) => l.module_id === mid).sort((a, b) => a.position - b.position);
  const questionsOf = (mid) => S.questions.filter((q) => q.module_id === mid).sort((a, b) => a.position - b.position);

  function departmentMatches(list, dept) {
    const items = String(list || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return !items.length || items.includes(String(dept || '').trim().toLowerCase());
  }

  function assignOnboarding(userId, by) {
    const u = userById(userId);
    if (!u) return 0;
    let n = 0;
    for (const m of S.modules.filter((x) => x.is_onboarding && x.published)) {
      if (!departmentMatches(m.onboarding_departments, u.department)) continue;
      if (S.assignments.some((a) => a.module_id === m.id && a.user_id === u.id)) continue;
      S.assignments.push({ id: nextId('assignments'), module_id: m.id, user_id: u.id, source: 'onboarding', assigned_by: by ?? null, note: '', assigned_at: nowStr(), due_date: addDays(u.joining_date, m.due_days), status: 'assigned', started_at: null, completed_at: null, best_score: null });
      n++;
    }
    return n;
  }

  function counts(a) {
    const lessons = lessonsOf(a.module_id);
    const ids = new Set(lessons.map((l) => l.id));
    return {
      lessons_total: lessons.length,
      lessons_done: S.lesson_progress.filter((p) => p.assignment_id === a.id && ids.has(p.lesson_id)).length,
      questions_total: questionsOf(a.module_id).length,
      quiz_passed: S.quiz_attempts.some((t) => t.assignment_id === a.id && t.passed) ? 1 : 0,
      attempts: S.quiz_attempts.filter((t) => t.assignment_id === a.id).length,
    };
  }

  function refreshStatus(a) {
    const c = counts(a);
    const complete = c.lessons_done >= c.lessons_total && (c.questions_total === 0 || c.quiz_passed);
    const status = complete ? 'completed' : c.lessons_done > 0 || c.attempts > 0 ? 'in_progress' : 'assigned';
    a.status = status;
    if (status !== 'assigned' && !a.started_at) a.started_at = nowStr();
    a.completed_at = status === 'completed' ? a.completed_at || nowStr() : null;
  }

  function decorate(a) {
    const m = S.modules.find((x) => x.id === a.module_id);
    const u = userById(a.user_id);
    const ab = userById(a.assigned_by);
    const c = counts(a);
    const hasQuiz = c.questions_total > 0;
    const steps = c.lessons_total + (hasQuiz ? 1 : 0);
    const done = c.lessons_done + (hasQuiz && c.quiz_passed ? 1 : 0);
    return {
      ...a, module_title: m.title, module_category: m.category, module_description: m.description, pass_mark: m.pass_mark,
      user_name: u.name, user_email: u.email, user_department: u.department, assigned_by_name: ab ? ab.name : null,
      lessons_total: c.lessons_total, lessons_done: c.lessons_done, questions_total: c.questions_total, quiz_passed: c.quiz_passed,
      progress: a.status === 'completed' ? 100 : steps ? Math.round((done / steps) * 100) : 0,
      overdue: a.status !== 'completed' && a.due_date < today(),
    };
  }
  const sortAssign = (x, y) => (x.due_date < y.due_date ? -1 : x.due_date > y.due_date ? 1 : x.user_name.localeCompare(y.user_name));

  function moduleFull(id, includeAnswers) {
    const m = S.modules.find((x) => x.id === id);
    if (!m) fail(404, 'Module not found');
    return {
      ...m,
      lessons: lessonsOf(id).map((l) => ({ ...l })),
      questions: questionsOf(id).map((q) => {
        const o = { id: q.id, text: q.text, options: JSON.parse(q.options) };
        if (includeAnswers) o.correct_index = q.correct_index;
        return o;
      }),
    };
  }

  function validateModule(b) {
    const title = str(b.title, 200);
    if (!title) fail(400, 'Module title is required');
    const lessons = Array.isArray(b.lessons) ? b.lessons : [];
    if (!lessons.length) fail(400, 'Add at least one lesson');
    lessons.forEach((l, i) => { if (!str(l.title)) fail(400, `Lesson ${i + 1} needs a title`); });
    const questions = (Array.isArray(b.questions) ? b.questions : []).map((q, i) => {
      const options = (q.options || []).map((o) => str(o, 500)).filter(Boolean);
      if (!str(q.text)) fail(400, `Question ${i + 1} needs text`);
      if (options.length < 2) fail(400, `Question ${i + 1} needs at least two options`);
      const c = toInt(q.correct_index, -1);
      if (c < 0 || c >= options.length) fail(400, `Pick the correct answer for question ${i + 1}`);
      return { text: str(q.text, 1000), options, correct_index: c };
    });
    return {
      title, description: str(b.description, 2000), category: str(b.category, 100),
      is_onboarding: b.is_onboarding ? 1 : 0, onboarding_departments: str(b.onboarding_departments, 500),
      due_days: Math.max(0, toInt(b.due_days, 7)), pass_mark: Math.min(100, Math.max(0, toInt(b.pass_mark, 70))),
      published: b.published === false || b.published === 0 ? 0 : 1,
      lessons: lessons.map((l) => ({ id: toInt(l.id, null), title: str(l.title, 200), content: str(l.content, 100000), video_url: str(l.video_url, 1000) })),
      questions,
    };
  }

  function saveModule(id, d) {
    const { lessons, questions, ...fields } = d;
    let m;
    if (id) {
      m = S.modules.find((x) => x.id === id);
      if (!m) fail(404, 'Module not found');
      Object.assign(m, fields, { updated_at: nowStr() });
    } else {
      m = { id: nextId('modules'), ...fields, created_at: nowStr(), updated_at: nowStr() };
      S.modules.push(m);
    }
    const existing = new Set(S.lessons.filter((l) => l.module_id === m.id).map((l) => l.id));
    const kept = new Set();
    lessons.forEach((l, i) => {
      if (l.id && existing.has(l.id)) {
        Object.assign(S.lessons.find((x) => x.id === l.id), { position: i, title: l.title, content: l.content, video_url: l.video_url });
        kept.add(l.id);
      } else {
        S.lessons.push({ id: nextId('lessons'), module_id: m.id, position: i, title: l.title, content: l.content, video_url: l.video_url });
      }
    });
    const removed = [...existing].filter((x) => !kept.has(x));
    S.lessons = S.lessons.filter((l) => !removed.includes(l.id));
    S.lesson_progress = S.lesson_progress.filter((p) => !removed.includes(p.lesson_id));
    S.questions = S.questions.filter((q) => q.module_id !== m.id);
    questions.forEach((q, i) => S.questions.push({ id: nextId('questions'), module_id: m.id, position: i, text: q.text, options: JSON.stringify(q.options), correct_index: q.correct_index }));
    S.assignments.filter((a) => a.module_id === m.id && a.status !== 'completed').forEach(refreshStatus);
    return m.id;
  }

  function deleteAssignments(pred) {
    const gone = new Set(S.assignments.filter(pred).map((a) => a.id));
    S.assignments = S.assignments.filter((a) => !gone.has(a.id));
    S.lesson_progress = S.lesson_progress.filter((p) => !gone.has(p.assignment_id));
    S.quiz_attempts = S.quiz_attempts.filter((t) => !gone.has(t.assignment_id));
    return gone.size;
  }

  function validateEmployee(b) {
    const e = {
      name: str(b.name, 200), email: str(b.email, 200).toLowerCase(), department: str(b.department, 100),
      designation: str(b.designation, 100), joining_date: str(b.joining_date, 10) || today(), role: b.role === 'admin' ? 'admin' : 'employee',
    };
    if (!e.name) fail(400, 'Name is required');
    if (!isEmail(e.email)) fail(400, `Invalid email: ${e.email || '(blank)'}`);
    if (!isDate(e.joining_date)) fail(400, 'Joining date must be YYYY-MM-DD');
    return e;
  }

  function createEmployee(b, adminId) {
    const e = validateEmployee(b);
    if (b.password && String(b.password).length < 6) fail(400, 'Password must be at least 6 characters');
    if (S.users.some((u) => u.email === e.email)) fail(409, `${e.email} already exists`);
    const id = nextId('users');
    S.users.push({ id, ...e, password: String(b.password || DEFAULT_PASSWORD), active: 1, created_at: nowStr() });
    return { id, onboarding_assigned: b.assign_onboarding === false ? 0 : assignOnboarding(id, adminId) };
  }

  function parseCsv(text) {
    return String(text || '').split(/\r?\n/).filter((l) => l.trim()).map((line) => {
      const cells = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === ',') { cells.push(cur); cur = ''; } else cur += c;
      }
      cells.push(cur);
      return cells.map((c) => c.trim());
    });
  }

  function listAssignments(q) {
    const t = today();
    const s = (q.get('search') || '').toLowerCase();
    return S.assignments.map(decorate).filter((a) =>
      (!q.get('module_id') || a.module_id === Number(q.get('module_id')))
      && (!q.get('user_id') || a.user_id === Number(q.get('user_id')))
      && (!q.get('department') || a.user_department === q.get('department'))
      && (!q.get('source') || a.source === q.get('source'))
      && (!q.get('status') || (q.get('status') === 'overdue' ? a.status !== 'completed' && a.due_date < t : a.status === q.get('status')))
      && (!s || `${a.user_name} ${a.user_email} ${a.module_title}`.toLowerCase().includes(s))).sort(sortAssign);
  }

  const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, department: u.department, designation: u.designation, joining_date: u.joining_date });

  function myAssignment(user, id) {
    const a = S.assignments.find((x) => x.id === Number(id));
    if (!a || a.user_id !== user.id) fail(404, 'Assignment not found');
    return a;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, role, fn) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, role, fn });
  };

  route('POST', '/login', null, ({ body }) => {
    const u = S.users.find((x) => x.email === str(body.email).toLowerCase() && x.active);
    if (!u || u.password !== String(body.password || '')) fail(401, 'Wrong email or password');
    S.session = u.id;
    return { ok: true };
  });
  route('GET', '/config', null, () => ({ google: false, password: true, demoAccounts: true, domains: [], blobUploads: false }));
  route('POST', '/logout', null, () => { S.session = null; return { ok: true }; });
  route('GET', '/me', 'user', ({ user }) => publicUser(user));
  route('POST', '/me/password', 'user', ({ user, body }) => {
    if (user.password !== String(body.current || '')) fail(400, 'Current password is wrong');
    if (String(body.next || '').length < 6) fail(400, 'New password must be at least 6 characters');
    user.password = String(body.next);
    return { ok: true };
  });

  route('GET', '/dashboard', 'admin', () => {
    const t = today();
    const all = S.assignments.map(decorate);
    const od = (a) => a.status !== 'completed' && a.due_date < t;
    const group = (keyFn) => {
      const map = new Map();
      all.forEach((a) => { const k = keyFn(a); const g = map.get(k) || { assigned: 0, completed: 0, overdue: 0 }; g.assigned++; if (a.status === 'completed') g.completed++; if (od(a)) g.overdue++; map.set(k, g); });
      return map;
    };
    const mod = group((a) => a.module_id);
    const dep = group((a) => a.user_department || '(none)');
    return {
      totals: {
        employees: S.users.filter((u) => u.active && u.role === 'employee').length,
        modules: S.modules.filter((m) => m.published).length,
        assignments: all.length,
        completed: all.filter((a) => a.status === 'completed').length,
        in_progress: all.filter((a) => a.status === 'in_progress').length,
        overdue: all.filter(od).length,
      },
      byModule: S.modules.map((m) => ({ id: m.id, title: m.title, is_onboarding: m.is_onboarding, ...(mod.get(m.id) || { assigned: 0, completed: 0, overdue: 0 }) }))
        .sort((a, b) => b.assigned - a.assigned || a.title.localeCompare(b.title)),
      byDepartment: [...dep.entries()].map(([department, g]) => ({ department, ...g })).sort((a, b) => a.department.localeCompare(b.department)),
      overdue: all.filter(od).sort(sortAssign).slice(0, 10),
      recent: all.filter((a) => a.status === 'completed').sort((a, b) => (b.completed_at > a.completed_at ? 1 : -1)).slice(0, 10),
      newJoiners: S.users.filter((u) => u.active && u.role === 'employee' && u.joining_date >= addDays(t, -30))
        .sort((a, b) => (b.joining_date > a.joining_date ? 1 : -1)).slice(0, 10)
        .map((u) => ({ id: u.id, name: u.name, department: u.department, designation: u.designation, joining_date: u.joining_date })),
    };
  });

  route('GET', '/employees', 'admin', () => {
    const t = today();
    return [...S.users].sort((a, b) => b.active - a.active || byName(a, b)).map((u) => {
      const as = S.assignments.filter((a) => a.user_id === u.id);
      return {
        ...publicUser(u), active: u.active, assigned: as.length,
        completed: as.filter((a) => a.status === 'completed').length,
        overdue: as.filter((a) => a.status !== 'completed' && a.due_date < t).length,
      };
    });
  });
  route('GET', '/departments', 'admin', () => [...new Set(S.users.map((u) => u.department).filter(Boolean))].sort());
  route('POST', '/employees', 'admin', ({ body, user }) => createEmployee(body, user.id));
  route('POST', '/employees/import', 'admin', ({ body, user }) => {
    const rows = parseCsv(body.csv);
    if (rows.length && rows[0].some((c) => c.toLowerCase() === 'email')) rows.shift();
    const created = []; const errors = [];
    rows.forEach((r, i) => {
      const [name, email, department, designation, joining_date] = r;
      try { created.push(createEmployee({ name, email, department, designation, joining_date, assign_onboarding: body.assign_onboarding !== false }, user.id)); }
      catch (e) { errors.push({ row: i + 1, email, error: e.message }); }
    });
    return { created: created.length, onboarding_assigned: created.reduce((s, c) => s + c.onboarding_assigned, 0), errors };
  });
  route('GET', '/employees/:id', 'admin', ({ params }) => {
    const u = userById(Number(params.id));
    if (!u) fail(404, 'Employee not found');
    return { ...publicUser(u), active: u.active, created_at: u.created_at, assignments: S.assignments.filter((a) => a.user_id === u.id).map(decorate).sort((a, b) => (a.due_date > b.due_date ? 1 : -1)) };
  });
  route('PUT', '/employees/:id', 'admin', ({ params, body, user }) => {
    const id = Number(params.id);
    const u = userById(id);
    if (!u) fail(404, 'Employee not found');
    const e = validateEmployee(body);
    const active = body.active === false || body.active === 0 ? 0 : 1;
    if (id === user.id && (!active || e.role !== 'admin')) fail(400, 'You cannot deactivate or demote yourself');
    if (S.users.some((x) => x.email === e.email && x.id !== id)) fail(409, `${e.email} already exists`);
    if (body.password && String(body.password).length < 6) fail(400, 'Password must be at least 6 characters');
    Object.assign(u, e, { active });
    if (body.password) u.password = String(body.password);
    return { ok: true };
  });
  route('POST', '/employees/:id/onboarding', 'admin', ({ params, user }) => ({ assigned: assignOnboarding(Number(params.id), user.id) }));

  route('GET', '/modules', 'admin', () => [...S.modules].sort((a, b) => b.is_onboarding - a.is_onboarding || a.title.localeCompare(b.title)).map((m) => {
    const as = S.assignments.filter((a) => a.module_id === m.id);
    return { ...m, lessons_count: lessonsOf(m.id).length, questions_count: questionsOf(m.id).length, assigned: as.length, completed: as.filter((a) => a.status === 'completed').length };
  }));
  route('GET', '/modules/:id', 'admin', ({ params }) => moduleFull(Number(params.id), true));
  route('POST', '/modules', 'admin', ({ body }) => ({ id: saveModule(null, validateModule(body)) }));
  route('PUT', '/modules/:id', 'admin', ({ params, body }) => ({ id: saveModule(Number(params.id), validateModule(body)) }));
  route('DELETE', '/modules/:id', 'admin', ({ params }) => {
    const id = Number(params.id);
    if (!S.modules.some((m) => m.id === id)) fail(404, 'Module not found');
    deleteAssignments((a) => a.module_id === id);
    S.modules = S.modules.filter((m) => m.id !== id);
    S.lessons = S.lessons.filter((l) => l.module_id !== id);
    S.questions = S.questions.filter((q) => q.module_id !== id);
    return { ok: true };
  });

  route('GET', '/assignments', 'admin', ({ query }) => listAssignments(query));
  route('POST', '/assignments', 'admin', ({ body, user }) => {
    const m = S.modules.find((x) => x.id === Number(body.module_id));
    if (!m) fail(400, 'Choose a module');
    const ids = [...new Set((body.user_ids || []).map(Number).filter(Boolean))];
    if (!ids.length) fail(400, 'Choose at least one employee');
    const due = str(body.due_date, 10) || addDays(today(), m.due_days);
    if (!isDate(due)) fail(400, 'Due date must be YYYY-MM-DD');
    let created = 0; let skipped = 0;
    for (const uid of ids) {
      if (!userById(uid) || S.assignments.some((a) => a.module_id === m.id && a.user_id === uid && a.status !== 'completed')) { skipped++; continue; }
      S.assignments.push({ id: nextId('assignments'), module_id: m.id, user_id: uid, source: 'manual', assigned_by: user.id, note: str(body.note, 500), assigned_at: nowStr(), due_date: due, status: 'assigned', started_at: null, completed_at: null, best_score: null });
      created++;
    }
    return { created, skipped };
  });
  route('POST', '/assignments/bulk', 'admin', ({ body, user }) => {
    const m = S.modules.find((x) => x.id === Number(body.module_id));
    if (!m) fail(400, 'Choose a module');
    const due = str(body.due_date, 10) || addDays(today(), m.due_days);
    if (!isDate(due)) fail(400, 'Due date must be YYYY-MM-DD');
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
    if (!rows.length) fail(400, 'The sheet has no rows');
    const result = { created: 0, skipped: 0, new_employees: 0, errors: [] };
    const seen = new Set();
    rows.forEach((r, i) => {
      const email = str(r.email, 200).toLowerCase();
      try {
        if (!isEmail(email)) fail(400, `Invalid email "${email || '(blank)'}"`);
        if (seen.has(email)) fail(400, `${email} appears more than once`);
        seen.add(email);
        let u = S.users.find((x) => x.email === email);
        if (u && !u.active) fail(400, `${email} is deactivated`);
        if (!u) {
          if (!body.create_missing) fail(400, `${email} is not in the system`);
          if (!str(r.name)) fail(400, `${email} is new, so the Name column is needed`);
          u = userById(createEmployee({ ...r, email }, user.id).id);
          result.new_employees++;
        }
        if (S.assignments.some((a) => a.module_id === m.id && a.user_id === u.id && a.status !== 'completed')) { result.skipped++; return; }
        S.assignments.push({ id: nextId('assignments'), module_id: m.id, user_id: u.id, source: 'manual', assigned_by: user.id, note: str(body.note, 500), assigned_at: nowStr(), due_date: due, status: 'assigned', started_at: null, completed_at: null, best_score: null });
        result.created++;
      } catch (e) {
        if (!e.status) throw e;
        result.errors.push({ row: i + 2, email, error: e.message });
      }
    });
    return result;
  });
  route('POST', '/uploads', 'admin', async ({ body, query }) => {
    const name = String(query.get('name') || 'video.mp4').split(/[\\/]/).pop();
    if (!(body instanceof Blob)) fail(400, 'Please upload a video file (MP4, WebM or MOV)');
    if (!/\.(mp4|m4v|webm|ogg|mov)$/i.test(name)) fail(400, 'Please upload a video file (MP4, WebM or MOV)');
    if (body.size > 1024 * 1024 * 1024) fail(413, 'This video is larger than 1 GB');
    const id = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 8)}`;
    await putVideo(id, body);
    return { url: `demo-video:${id}/${encodeURIComponent(name)}`, size: body.size };
  });
  route('PUT', '/assignments/:id', 'admin', ({ params, body }) => {
    if (!isDate(body.due_date)) fail(400, 'Due date must be YYYY-MM-DD');
    const a = S.assignments.find((x) => x.id === Number(params.id));
    if (!a) fail(404, 'Assignment not found');
    a.due_date = body.due_date;
    return { ok: true };
  });
  route('DELETE', '/assignments/:id', 'admin', ({ params }) => {
    if (!deleteAssignments((a) => a.id === Number(params.id))) fail(404, 'Assignment not found');
    return { ok: true };
  });

  route('GET', '/my/assignments', 'user', ({ user }) => S.assignments.filter((a) => a.user_id === user.id).map(decorate)
    .sort((a, b) => (a.status === 'completed') - (b.status === 'completed') || (a.due_date > b.due_date ? 1 : a.due_date < b.due_date ? -1 : 0)));
  route('GET', '/my/assignments/:id', 'user', ({ user, params }) => {
    const a = decorate(myAssignment(user, params.id));
    const m = moduleFull(a.module_id, false);
    const done = new Set(S.lesson_progress.filter((p) => p.assignment_id === a.id).map((p) => p.lesson_id));
    m.lessons = m.lessons.map((l) => ({ ...l, done: done.has(l.id) }));
    const attempts = S.quiz_attempts.filter((t) => t.assignment_id === a.id).sort((x, y) => y.id - x.id).map(({ id, score, passed, created_at }) => ({ id, score, passed, created_at }));
    return { assignment: a, module: m, attempts };
  });
  route('POST', '/my/assignments/:id/lessons/:lessonId/complete', 'user', ({ user, params }) => {
    const a = myAssignment(user, params.id);
    const l = S.lessons.find((x) => x.id === Number(params.lessonId) && x.module_id === a.module_id);
    if (!l) fail(404, 'Lesson not found');
    if (!S.lesson_progress.some((p) => p.assignment_id === a.id && p.lesson_id === l.id)) S.lesson_progress.push({ assignment_id: a.id, lesson_id: l.id, completed_at: nowStr() });
    refreshStatus(a);
    return decorate(a);
  });
  route('POST', '/my/assignments/:id/quiz', 'user', ({ user, params, body }) => {
    const a = myAssignment(user, params.id);
    const d = decorate(a);
    if (d.lessons_done < d.lessons_total) fail(400, 'Finish all lessons before taking the quiz');
    const qs = questionsOf(a.module_id);
    if (!qs.length) fail(400, 'This module has no quiz');
    const answers = (body.answers || []).map((x) => (x === null || x === undefined ? null : Number(x)));
    const correct = qs.map((q, i) => answers[i] === q.correct_index);
    const score = Math.round((correct.filter(Boolean).length / qs.length) * 100);
    const passed = score >= d.pass_mark ? 1 : 0;
    S.quiz_attempts.push({ id: nextId('quiz_attempts'), assignment_id: a.id, score, passed, answers: JSON.stringify(answers), created_at: nowStr() });
    a.best_score = Math.max(a.best_score || 0, score);
    refreshStatus(a);
    return { score, passed: !!passed, pass_mark: d.pass_mark, results: qs.map((q, i) => ({ correct: correct[i], correct_index: passed ? q.correct_index : undefined })), assignment: decorate(a) };
  });

  // ---------- fetch shim ----------
  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async (input, opts = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://demo.local');
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    const path = url.pathname.slice(4);
    const method = (opts.method || 'GET').toUpperCase();
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    try {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = path.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const user = S.session ? S.users.find((u) => u.id === S.session && u.active) : null;
        if (r.role && !user) fail(401, 'Please sign in');
        if (r.role === 'admin' && user.role !== 'admin') fail(403, 'Admins only');
        const body = opts.body instanceof Blob ? opts.body : opts.body ? JSON.parse(opts.body) : {};
        const result = await r.fn({ params, query: url.searchParams, body, user });
        save();
        return reply(200, result);
      }
      fail(404, 'Not found');
    } catch (e) {
      if (!e.status) console.error(e);
      return reply(e.status || 500, { error: e.status ? e.message : 'Something went wrong' });
    }
    return reply(500, { error: 'Something went wrong' });
  };
})();
