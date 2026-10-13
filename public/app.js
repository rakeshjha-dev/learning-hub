// Learning Hub frontend: a small hash-routed single-page app with no build step.
'use strict';

const state = { user: null, config: { password: true, demoAccounts: true } };
const BRAND = window.LMS_BRAND || null;
if (BRAND) document.title = `${BRAND.product} · ${BRAND.company}`;
const app = document.getElementById('app');
const dialog = document.getElementById('dialog');

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function todayStr() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(n || 0));
  return d.toISOString().slice(0, 10);
}
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : `${s.replace(' ', 'T')}Z`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    state.user = null;
    renderLogin();
    throw new Error(data.error || 'Please sign in');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

let toastTimer;
function toast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function statusBadge(a) {
  if (a.status === 'completed') return '<span class="badge green">Completed</span>';
  if (a.overdue) return '<span class="badge red">Overdue</span>';
  if (a.status === 'in_progress') return '<span class="badge amber">In progress</span>';
  return '<span class="badge">Not started</span>';
}
const sourceBadge = (s) => (s === 'onboarding' ? '<span class="badge blue">Onboarding</span>' : '<span class="badge">Assigned</span>');
const progressBar = (p, done) => `<div class="progress-row"><div class="progress ${done ? 'done' : ''}" style="flex:1"><span style="width:${p}%"></span></div><span class="pct">${p}%</span></div>`;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

// Minimal, safe markdown: headings, bullets, bold, italics, links. Input is escaped first.
function renderContent(text) {
  const inline = (s) => s
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  let html = '';
  let list = false;
  let para = [];
  const flush = () => { if (para.length) { html += `<p>${para.join(' ')}</p>`; para = []; } };
  for (const raw of esc(text).split('\n')) {
    const line = raw.trim();
    if (/^[-*] /.test(line)) {
      flush();
      if (!list) { html += '<ul>'; list = true; }
      html += `<li>${inline(line.slice(2))}</li>`;
      continue;
    }
    if (list) { html += '</ul>'; list = false; }
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,3}) (.*)$/);
    if (h) { flush(); const n = h[1].length + 1; html += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
    para.push(inline(line));
  }
  flush();
  if (list) html += '</ul>';
  return html;
}

const isUploadedVideo = (url) => /^\/uploads\//.test(url || '') || /^demo-video:/.test(url || '')
  || /^https:\/\/[\w-]+\.public\.blob\.vercel-storage\.com\//.test(url || '');
// Server uploads are "<12 hex>-name.mp4"; online (Blob) uploads are "name-<random suffix>.mp4".
const uploadedName = (url) => decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop().replace(/^[a-f0-9]{12}-/, '').replace(/-[A-Za-z0-9]{20,40}(\.\w+)$/, '$1'));
function uploadedVideoTag(url) {
  if (url.startsWith('demo-video:')) return `<video data-demo-video="${esc(url.slice(11).split('/')[0])}" controls preload="metadata"></video>`;
  return `<video src="${esc(url)}" controls preload="metadata"></video>`;
}
// Uploaded videos in the demo live in the browser; this swaps in the real source after render.
const hydrateVideos = (root) => window.LMS_HYDRATE_VIDEOS?.(root);

function renderVideo(url) {
  if (!url) return '';
  if (isUploadedVideo(url)) return `<div class="video">${uploadedVideoTag(url)}</div>`;
  if (window.LMS_DEMO) return /^https?:\/\//.test(url) ? `<p><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">▶ Watch the lesson video ↗</a></p>` : '';
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}" allowfullscreen allow="encrypted-media; picture-in-picture"></iframe></div>`;
  const vimeo = url.match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `<div class="video"><iframe src="https://player.vimeo.com/video/${vimeo[1]}" allowfullscreen></iframe></div>`;
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(url)) return `<div class="video"><video src="${esc(url)}" controls></video></div>`;
  if (/^https?:\/\//.test(url)) return `<p><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Open lesson resource ↗</a></p>`;
  return '';
}

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
async function uploadVideo(file, onStatus) {
  if (!/^video\//.test(file.type) && !/\.(mp4|webm|mov|m4v|ogg)$/i.test(file.name)) throw new Error('Please choose a video file (MP4, WebM or MOV)');
  if (file.size > MAX_VIDEO_BYTES) throw new Error('This video is larger than 1 GB. Please compress it and try again.');
  const label = `Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)`;
  onStatus?.(`${label}…`);
  if (state.config.blobUploads) {
    // Online: the video goes straight from the browser to Vercel Blob storage.
    await loadScript('/vendor/blob-upload.js');
    const blob = await window.BlobUpload.upload(`videos/${file.name.replace(/[^\w.-]+/g, '-')}`, file, {
      access: 'public',
      handleUploadUrl: '/api/uploads/blob',
      multipart: file.size > 50 * 1048576,
      onUploadProgress: ({ percentage }) => onStatus?.(`${label}: ${Math.round(percentage)}%`),
    }).catch((e) => { throw new Error(e.message?.replace(/^Vercel Blob: /, '') || 'Upload failed'); });
    onStatus?.('');
    return blob.url;
  }
  const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, {
    method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  onStatus?.('');
  return data.url;
}

function loadScript(src) {
  loadScript.cache ||= {};
  return (loadScript.cache[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete loadScript.cache[src]; reject(new Error('Could not load the uploader. Please refresh and try again.')); };
    document.head.appendChild(s);
  }));
}

// ---------- shell ----------
const GOOGLE_ICON = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function renderLogin() {
  const cfg = state.config;
  // A failed Google sign-in comes back as ?login_error=…; show it once and tidy the address bar.
  const loginError = new URLSearchParams(location.search).get('login_error') || renderLogin.error;
  if (loginError && location.search) history.replaceState(null, '', location.pathname + location.hash);
  renderLogin.error = loginError; // survives a re-render during startup
  const domains = (cfg.domains || []).map((d) => `@${d}`).join(' or ');
  app.innerHTML = `
    <div class="login"><form class="card" id="login-form">
      ${BRAND?.logo ? `<img class="login-logo" src="${esc(BRAND.logo)}" alt="${esc(BRAND.company)}">` : ''}
      <h1>${esc(BRAND?.product || 'Learning Hub')}</h1>
      <p>Sign in to continue your learning.</p>
      ${loginError ? `<div class="login-error" role="alert">${esc(loginError)}</div>` : ''}
      ${cfg.google ? `<a class="btn google-btn" id="google-signin" href="/api/auth/google">${GOOGLE_ICON} Sign in with Google</a>
        ${domains ? `<div class="hint login-hint">Use your company account (${esc(domains)}).</div>` : ''}` : ''}
      ${cfg.google && cfg.password ? '<div class="login-or"><span>or</span></div>' : ''}
      ${cfg.password ? `
      <div class="field"><label for="email">Work email</label><input type="email" id="email" required autocomplete="username"></div>
      <div class="field"><label for="password">Password</label><input type="password" id="password" required autocomplete="current-password"></div>
      <button class="primary" style="width:100%;justify-content:center">Sign in</button>` : ''}
      ${cfg.demoAccounts ? `<div class="demo"><strong>Demo accounts</strong><br>Admin: admin@company.com / admin123<br>Employee: priya@company.com / welcome123
        ${window.LMS_DEMO ? '<div class="quick"><button type="button" class="small" data-as="admin@company.com|admin123">Try as admin (HR)</button><button type="button" class="small" data-as="priya@company.com|welcome123">Try as employee</button></div>' : ''}</div>` : ''}
    </form></div>`;
  $$('[data-as]').forEach((b) => b.addEventListener('click', () => {
    [$('#email').value, $('#password').value] = b.dataset.as.split('|');
    $('#login-form').requestSubmit();
  }));
  $('#login-form').addEventListener('submit', async (e) => {
    if (!cfg.password) { e.preventDefault(); return; }
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
      await boot();
    } catch (err) { toast(err.message, 'error'); }
  });
}

function renderShell() {
  const admin = state.user.role === 'admin';
  const links = admin
    ? [['#/dashboard', 'Dashboard'], ['#/employees', 'Employees'], ['#/modules', 'Modules'], ['#/assignments', 'Assignments & progress']]
    : [];
  app.innerHTML = `
    <div class="shell">
      <nav class="sidebar">
        ${BRAND?.logoOnDark
          ? `<div class="brand with-logo"><img class="brand-logo" src="${esc(BRAND.logoOnDark)}" alt="${esc(BRAND.company)}"><div class="brand-sub">${esc(BRAND.product)}</div></div>`
          : '<div class="brand"><span class="brand-mark"><svg width="18" height="18" viewBox="0 0 32 32"><path d="M4 12l12-6 12 6-12 6z M9 15v6c0 2 3.5 4 7 4s7-2 7-4v-6" fill="none" stroke="white" stroke-width="2.4" stroke-linejoin="round"/></svg></span>Learning Hub</div>'}
        ${admin ? '<div class="nav-label">Manage</div>' : ''}
        ${links.map(([h, t]) => `<a href="${h}" data-nav>${t}</a>`).join('')}
        <div class="nav-label">Learn</div>
        <a href="#/my" data-nav>My learning</a>
        <a href="#/account" data-nav>Account</a>
        <div class="me"><div><div class="name">${esc(state.user.name)}</div><div class="sub">${esc(state.user.email)}</div></div><button class="small" id="logout">Sign out</button></div>
      </nav>
      <main class="main" id="view"></main>
    </div>`;
  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST', body: {} });
    state.user = null;
    location.hash = '';
    renderLogin();
  });
}

const routes = [
  [/^#\/dashboard$/, viewDashboard, true],
  [/^#\/employees$/, viewEmployees, true],
  [/^#\/employees\/(\d+)$/, viewEmployee, true],
  [/^#\/modules$/, viewModules, true],
  [/^#\/modules\/new$/, () => viewModuleEditor(null), true],
  [/^#\/modules\/(\d+)$/, viewModuleEditor, true],
  [/^#\/assignments$/, viewAssignments, true],
  [/^#\/my$/, viewMyLearning, false],
  [/^#\/learn\/(\d+)(?:\/(quiz|\d+))?$/, viewLearn, false],
  [/^#\/account$/, viewAccount, false],
];

async function router() {
  if (!state.user) return;
  if (!$('#view')) renderShell();
  const hash = location.hash || '';
  const match = routes.find(([re, , adminOnly]) => re.test(hash) && (!adminOnly || state.user.role === 'admin'));
  if (!match) {
    location.replace(state.user.role === 'admin' ? '#/dashboard' : '#/my');
    return;
  }
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', hash.startsWith(a.getAttribute('href'))
    || (a.getAttribute('href') === '#/my' && hash.startsWith('#/learn'))));
  const view = $('#view');
  view.onclick = view.oninput = view.onchange = null; // drop handlers left by the previous page
  try {
    await match[1](...hash.match(match[0]).slice(1));
  } catch (err) {
    view.innerHTML = `<div class="card empty">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

async function boot() {
  if (!boot.configured) {
    state.config = await api('/config').catch(() => state.config);
    boot.configured = true;
  }
  try { state.user = await api('/me'); } catch { return; }
  renderLogin.error = null;
  renderShell();
  router();
}
window.addEventListener('hashchange', router);
// Empty the dialog when it closes so a slow-loading dialog never shows stale content.
dialog.addEventListener('close', () => { dialog.innerHTML = ''; });

// ---------- dialogs ----------
function askConfirm(message, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    openDialog(`<div class="dlg"><h2>Are you sure?</h2><p>${esc(message)}</p>
      <div class="dlg-foot"><button type="button" id="confirm-no">Cancel</button><button type="button" class="primary" id="confirm-yes">${esc(okLabel)}</button></div></div>`, (dlg) => {
      let answered = false;
      const done = (v) => { answered = true; dialog.close(); resolve(v); };
      $('#confirm-yes', dlg).addEventListener('click', () => done(true));
      $('#confirm-no', dlg).addEventListener('click', () => done(false));
      dialog.addEventListener('close', () => { if (!answered) resolve(false); }, { once: true });
    });
  });
}

function openDialog(html, onMount) {
  dialog.innerHTML = html;
  dialog.showModal();
  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', () => dialog.close()));
  if (onMount) onMount(dialog);
}

// ---------- spreadsheet reading (.xlsx and .csv, no library needed) ----------
async function unzipEntries(buf) {
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This file is not a valid Excel (.xlsx) file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries[name] = { method, data: new Uint8Array(buf, start, size) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return async (name) => {
    const e = entries[name];
    if (!e) return null;
    if (e.method === 0) return dec.decode(e.data);
    const stream = new Blob([e.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  };
}

const xmlNodes = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
const xmlText = (el) => xmlNodes(el, 't').map((t) => t.textContent).join('');

async function readSpreadsheet(file) {
  if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files are not supported. In Excel, use File > Save As > Excel Workbook (.xlsx).');
  if (/\.(csv|txt)$/i.test(file.name)) {
    return (await file.text()).split(/\r?\n/).filter((l) => l.trim()).map((line) => {
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
  const read = await unzipEntries(await file.arrayBuffer());
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const sharedXml = await read('xl/sharedStrings.xml');
  const shared = sharedXml ? xmlNodes(parse(sharedXml), 'si').map(xmlText) : [];
  // Use the first sheet in the workbook.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = xmlNodes(parse(wb), 'sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rel = xmlNodes(parse(rels), 'Relationship').find((r) => r.getAttribute('Id') === rid);
    if (rel) sheetPath = `xl/${rel.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\//, '')}`;
  }
  const sheetXml = await read(sheetPath);
  if (!sheetXml) throw new Error('Could not find a sheet in this file');
  const colIndex = (ref) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return xmlNodes(parse(sheetXml), 'row').map((row) => {
    const out = [];
    xmlNodes(row, 'c').forEach((c, i) => {
      const ref = c.getAttribute('r');
      const idx = ref ? colIndex(ref) : i;
      const type = c.getAttribute('t');
      const v = xmlNodes(c, 'v')[0]?.textContent ?? '';
      out[idx] = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? xmlText(c) : v;
    });
    return Array.from(out, (x) => String(x ?? '').trim());
  }).filter((r) => r.some(Boolean));
}

const HEADER_KEYS = {
  email: ['email', 'emailid', 'emailaddress', 'workemail', 'officialemail', 'officialemailid', 'mail'],
  name: ['name', 'fullname', 'employeename', 'empname'],
  department: ['department', 'dept', 'function', 'team'],
  designation: ['designation', 'title', 'jobtitle', 'position'],
  joining_date: ['joiningdate', 'dateofjoining', 'doj', 'joindate', 'startdate'],
};

function excelDate(v) {
  if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 20000) {
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 864e5).toISOString().slice(0, 10);
  }
  const dmy = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return v;
}

// Turns sheet rows into employee records using the header row.
function rowsToPeople(rows) {
  if (!rows.length) throw new Error('The sheet is empty');
  const header = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = {};
  for (const [key, names] of Object.entries(HEADER_KEYS)) col[key] = header.findIndex((h) => names.includes(h));
  if (col.email < 0) throw new Error('Add a column called "Email" in the first row of the sheet');
  return rows.slice(1).map((r) => {
    const get = (k) => (col[k] >= 0 ? r[col[k]] || '' : '');
    return { email: get('email').toLowerCase(), name: get('name'), department: get('department'), designation: get('designation'), joining_date: get('joining_date') ? excelDate(get('joining_date')) : '' };
  });
}

async function openAssignDialog({ moduleId = '', userIds = [], onDone, tab = 'pick' } = {}) {
  const [modules, employees, departments] = await Promise.all([api('/modules'), api('/employees'), api('/departments')]);
  const active = employees.filter((e) => e.active);
  const byEmail = new Map(employees.map((e) => [e.email.toLowerCase(), e]));
  const selected = new Set(userIds.map(Number));
  let people = null;
  openDialog(`
    <form id="assign-form">
      <h2>Assign a module</h2>
      <div class="field"><label>Module</label>
        <select name="module_id" required><option value="">Choose a module…</option>
          ${modules.filter((m) => m.published).map((m) => `<option value="${m.id}" data-days="${m.due_days}" ${String(m.id) === String(moduleId) ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}
        </select></div>
      <div class="tabs"><button type="button" data-tab="pick">Choose employees</button><button type="button" data-tab="upload">Upload Excel sheet (bulk)</button></div>
      <div class="field" id="tab-pick">
        <div class="filters" style="margin-bottom:6px">
          <input type="search" id="pick-search" placeholder="Search name or email">
          <select id="pick-dept"><option value="">All departments</option>${departments.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
          <button type="button" class="small" id="pick-all">Select shown</button>
          <button type="button" class="small" id="pick-none">Clear</button>
        </div>
        <div class="pick-list" id="pick-list">
          ${active.map((e) => `<label data-dept="${esc(e.department)}" data-text="${esc(`${e.name} ${e.email}`.toLowerCase())}"><input type="checkbox" value="${e.id}" ${selected.has(e.id) ? 'checked' : ''}> ${esc(e.name)} <span class="sub">${esc(e.department || '')} · ${esc(e.email)}</span></label>`).join('')}
        </div>
        <div class="hint" id="pick-count"></div>
      </div>
      <div class="field" id="tab-upload" hidden>
        <div class="sample-file">
          <div><strong>Step 1.</strong> Download the sample file, fill in one person per row and save it.<br><span class="sub">Email is required. Name, Department, Designation and Joining Date are optional.</span></div>
          <a class="btn" id="download-sample" href="${esc(window.LMS_TEMPLATE_URL || '/templates/bulk-assign-template.xlsx')}" download="bulk-assign-sample.xlsx">⬇ Download sample file</a>
        </div>
        <div class="hint" style="margin:10px 0 6px"><strong>Step 2.</strong> Upload the filled-in file here.</div>
        <div class="drop" id="drop">Drag an Excel file here, or <button type="button" class="small" id="choose-file">Choose file</button><input type="file" id="sheet-file" accept=".xlsx,.csv" hidden></div>
        <label class="check" style="margin-top:8px"><input type="checkbox" id="create-missing" checked> Also add people who aren't in the system yet (they get their onboarding modules too)</label>
        <div id="sheet-preview"></div>
      </div>
      <div class="row">
        <div class="field"><label>Due date</label><input type="date" name="due_date" required></div>
        <div class="field"><label>Note (optional)</label><input type="text" name="note" placeholder="e.g. Required after policy update"></div>
      </div>
      <div class="hint">Employees who already have this module open are skipped. Completed modules can be assigned again as a refresher.</div>
      <div id="assign-errors"></div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary" id="assign-submit">Assign</button></div>
    </form>`, (dlg) => {
    const form = $('#assign-form', dlg);
    // Inside the claude.ai viewer a plain download link is blocked, so the demo saves the sample through the viewer.
    if (window.LMS_DEMO && window.claude?.use) {
      $('#download-sample', dlg).addEventListener('click', async (e) => {
        e.preventDefault();
        const downloads = await window.claude.use('downloads').catch(() => null);
        if (!downloads) { toast('Downloading works in the hosted version', 'error'); return; }
        const data = Uint8Array.from(atob(e.currentTarget.href.split(',')[1]), (c) => c.charCodeAt(0));
        downloads.save({ filename: 'bulk-assign-sample.xlsx', data }).catch((err) => {
          if (err?.code !== 'declined') toast('Could not download the sample file here', 'error');
        });
      });
    }
    const sel = form.module_id;
    const due = form.due_date;
    let current = tab;
    const showTab = (t) => {
      current = t;
      $$('[data-tab]', dlg).forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      $('#tab-pick', dlg).hidden = t !== 'pick';
      $('#tab-upload', dlg).hidden = t !== 'upload';
    };
    $$('[data-tab]', dlg).forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    showTab(tab);
    const setDue = () => { const o = sel.selectedOptions[0]; due.value = addDays(todayStr(), o?.dataset.days || 7); };
    setDue();
    sel.addEventListener('change', setDue);
    const count = () => { $('#pick-count', dlg).textContent = `${$$('#pick-list input:checked', dlg).length} selected`; };
    const filter = () => {
      const q = $('#pick-search', dlg).value.toLowerCase();
      const d = $('#pick-dept', dlg).value;
      $$('#pick-list label', dlg).forEach((l) => { l.hidden = (q && !l.dataset.text.includes(q)) || (d && l.dataset.dept !== d); });
    };
    $('#pick-search', dlg).addEventListener('input', filter);
    $('#pick-dept', dlg).addEventListener('change', filter);
    $('#pick-all', dlg).addEventListener('click', () => { $$('#pick-list label:not([hidden]) input', dlg).forEach((i) => { i.checked = true; }); count(); });
    $('#pick-none', dlg).addEventListener('click', () => { $$('#pick-list input', dlg).forEach((i) => { i.checked = false; }); count(); });
    $('#pick-list', dlg).addEventListener('change', count);
    count();

    // Bulk upload
    const renderPreview = () => {
      const box = $('#sheet-preview', dlg);
      if (!people) { box.innerHTML = ''; return; }
      const create = $('#create-missing', dlg).checked;
      const rowsHtml = people.map((p, i) => {
        const existing = byEmail.get(p.email);
        let status;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) status = '<span class="badge red">Invalid email</span>';
        else if (existing && !existing.active) status = '<span class="badge red">Deactivated</span>';
        else if (existing) status = '<span class="badge green">Employee found</span>';
        else if (create && p.name) status = '<span class="badge blue">Will be added</span>';
        else status = `<span class="badge red">${create ? 'Name missing' : 'Not in system'}</span>`;
        return `<tr><td class="num sub">${i + 2}</td><td>${esc(p.name || existing?.name || '')}<div class="sub">${esc(p.email)}</div></td><td>${esc(p.department || existing?.department || '')}</td><td>${status}</td></tr>`;
      }).join('');
      const ok = people.filter((p) => { const e = byEmail.get(p.email); return e ? e.active : create && p.name && /@/.test(p.email); }).length;
      box.innerHTML = `<div class="hint" style="margin-top:10px"><strong>${people.length}</strong> row${people.length === 1 ? '' : 's'} read · <strong>${ok}</strong> ready to assign</div>
        <div class="preview-table"><table><tr><th class="num">Row</th><th>Employee</th><th>Department</th><th>Status</th></tr>${rowsHtml}</table></div>`;
    };
    const loadFile = async (file) => {
      if (!file) return;
      try {
        people = rowsToPeople(await readSpreadsheet(file));
        $('#drop', dlg).firstChild.textContent = `📄 ${file.name} · `;
        renderPreview();
      } catch (err) { people = null; renderPreview(); toast(err.message, 'error'); }
    };
    $('#choose-file', dlg).addEventListener('click', () => $('#sheet-file', dlg).click());
    $('#sheet-file', dlg).addEventListener('change', (e) => loadFile(e.target.files[0]));
    $('#create-missing', dlg).addEventListener('change', renderPreview);
    const drop = $('#drop', dlg);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (current === 'upload') {
          if (!people) throw new Error('Choose an Excel file first');
          const r = await api('/assignments/bulk', { method: 'POST', body: {
            module_id: sel.value, due_date: due.value, note: form.note.value, rows: people, create_missing: $('#create-missing', dlg).checked,
          } });
          toast(`Assigned to ${r.created} employee${r.created === 1 ? '' : 's'}${r.new_employees ? ` (${r.new_employees} newly added)` : ''}${r.skipped ? `, ${r.skipped} skipped (already assigned)` : ''}`);
          onDone?.();
          if (r.errors.length) {
            $('#assign-errors', dlg).innerHTML = `<div class="result fail">${r.errors.length} row(s) not assigned:<br>${r.errors.map((x) => `Row ${x.row}: ${esc(x.error)}`).join('<br>')}</div>`;
            return;
          }
          dialog.close();
          return;
        }
        const r = await api('/assignments', { method: 'POST', body: {
          module_id: sel.value, due_date: due.value, note: form.note.value,
          user_ids: $$('#pick-list input:checked', dlg).map((i) => Number(i.value)),
        } });
        dialog.close();
        toast(`Assigned to ${r.created} employee${r.created === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} skipped (already assigned)` : ''}`);
        onDone?.();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function openEmployeeDialog(emp, onDone) {
  const isNew = !emp;
  emp = emp || { joining_date: todayStr(), role: 'employee', active: 1 };
  openDialog(`
    <form id="emp-form">
      <h2>${isNew ? 'Add employee' : 'Edit employee'}</h2>
      <div class="row">
        <div class="field"><label>Full name</label><input type="text" name="name" required value="${esc(emp.name)}"></div>
        <div class="field"><label>Work email</label><input type="email" name="email" required value="${esc(emp.email)}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Department</label><input type="text" name="department" value="${esc(emp.department)}" placeholder="e.g. Sales"></div>
        <div class="field"><label>Designation</label><input type="text" name="designation" value="${esc(emp.designation)}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Joining date</label><input type="date" name="joining_date" required value="${esc(emp.joining_date)}"></div>
        <div class="field"><label>Role</label><select name="role"><option value="employee">Employee</option><option value="admin" ${emp.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>
      </div>
      <div class="field"><label>${isNew ? 'Initial password' : 'Reset password'}</label><input type="text" name="password" placeholder="${isNew ? 'Leave blank for welcome123' : 'Leave blank to keep current'}"></div>
      ${isNew
        ? '<label class="check"><input type="checkbox" name="assign_onboarding" checked> Assign onboarding modules now (due dates count from the joining date)</label>'
        : `<label class="check"><input type="checkbox" name="active" ${emp.active ? 'checked' : ''}> Active (inactive employees cannot sign in)</label>`}
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary">${isNew ? 'Add employee' : 'Save'}</button></div>
    </form>`, (dlg) => {
    const form = $('#emp-form', dlg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(['name', 'email', 'department', 'designation', 'joining_date', 'role', 'password'].map((k) => [k, form[k].value]));
      try {
        if (isNew) {
          body.assign_onboarding = form.assign_onboarding.checked;
          const r = await api('/employees', { method: 'POST', body });
          toast(`Employee added${r.onboarding_assigned ? ` with ${r.onboarding_assigned} onboarding module${r.onboarding_assigned === 1 ? '' : 's'}` : ''}`);
        } else {
          body.active = form.active.checked;
          await api(`/employees/${emp.id}`, { method: 'PUT', body });
          toast('Employee saved');
        }
        dialog.close();
        onDone?.();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function openImportDialog(onDone) {
  openDialog(`
    <form id="import-form">
      <h2>Import employees</h2>
      <p class="sub">Paste CSV rows: <code>name,email,department,designation,joining_date</code>. A header row is optional. Joining date is YYYY-MM-DD (blank means today). Everyone starts with the password <code>welcome123</code>.</p>
      <div class="field"><textarea name="csv" placeholder="Rahul Verma,rahul@company.com,Engineering,Backend Engineer,2026-10-20"></textarea></div>
      <label class="check"><input type="checkbox" name="assign_onboarding" checked> Assign onboarding modules automatically</label>
      <div id="import-errors"></div>
      <div class="dlg-foot"><button type="button" data-close>Close</button><button class="primary">Import</button></div>
    </form>`, (dlg) => {
    const form = $('#import-form', dlg);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/employees/import', { method: 'POST', body: { csv: form.csv.value, assign_onboarding: form.assign_onboarding.checked } });
        toast(`Imported ${r.created} employee${r.created === 1 ? '' : 's'}, ${r.onboarding_assigned} onboarding assignment${r.onboarding_assigned === 1 ? '' : 's'}`);
        onDone?.();
        if (r.errors.length) {
          $('#import-errors', dlg).innerHTML = `<div class="result fail">${r.errors.length} row(s) skipped:<br>${r.errors.map((x) => `Row ${x.row}: ${esc(x.error)}`).join('<br>')}</div>`;
        } else dialog.close();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// ---------- admin views ----------
async function viewDashboard() {
  const d = await api('/dashboard');
  const t = d.totals;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Dashboard</h1><p>Training status across the organisation.</p></div>
      <div class="actions"><button id="bulk">Bulk assign from Excel</button><button class="primary" id="assign">Assign a module</button></div></div>
    <div class="stats">
      <div class="stat"><div class="label">Active employees</div><div class="value">${t.employees}</div></div>
      <div class="stat"><div class="label">Published modules</div><div class="value">${t.modules}</div></div>
      <div class="stat"><div class="label">Assignments</div><div class="value">${t.assignments}</div></div>
      <div class="stat green"><div class="label">Completion rate</div><div class="value">${pct(t.completed, t.assignments)}%</div></div>
      <div class="stat"><div class="label">In progress</div><div class="value">${t.in_progress}</div></div>
      <div class="stat red"><div class="label">Overdue</div><div class="value">${t.overdue}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card flush"><h2>Completion by module</h2><div class="table-wrap"><table>
        <tr><th>Module</th><th class="num">Assigned</th><th class="num">Overdue</th><th style="width:160px">Completed</th></tr>
        ${d.byModule.map((m) => `<tr><td><a href="#/modules/${m.id}">${esc(m.title)}</a> ${m.is_onboarding ? '<span class="badge blue">Onboarding</span>' : ''}</td><td class="num">${m.assigned}</td><td class="num">${m.overdue || ''}</td><td>${progressBar(pct(m.completed, m.assigned), m.assigned && m.completed === m.assigned)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No modules yet</td></tr>'}
      </table></div></div>
      <div class="card flush"><h2>Completion by department</h2><div class="table-wrap"><table>
        <tr><th>Department</th><th class="num">Assigned</th><th class="num">Overdue</th><th style="width:160px">Completed</th></tr>
        ${d.byDepartment.map((x) => `<tr><td>${esc(x.department)}</td><td class="num">${x.assigned}</td><td class="num">${x.overdue || ''}</td><td>${progressBar(pct(x.completed, x.assigned), x.assigned && x.completed === x.assigned)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No assignments yet</td></tr>'}
      </table></div></div>
      <div class="card flush"><h2>Overdue</h2><div class="table-wrap"><table>
        <tr><th>Employee</th><th>Module</th><th>Due</th></tr>
        ${d.overdue.map((a) => `<tr><td><a href="#/employees/${a.user_id}">${esc(a.user_name)}</a></td><td>${esc(a.module_title)}</td><td><span class="badge red">${fmtDate(a.due_date)}</span></td></tr>`).join('') || '<tr><td colspan="3" class="empty">Nothing overdue 🎉</td></tr>'}
      </table></div></div>
      <div class="card flush"><h2>New joiners (last 30 days)</h2><div class="table-wrap"><table>
        <tr><th>Employee</th><th>Department</th><th>Joined</th></tr>
        ${d.newJoiners.map((u) => `<tr><td><a href="#/employees/${u.id}">${esc(u.name)}</a><div class="sub">${esc(u.designation)}</div></td><td>${esc(u.department)}</td><td>${fmtDate(u.joining_date)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No recent joiners</td></tr>'}
      </table></div></div>
      <div class="card flush" style="grid-column:1/-1"><h2>Recently completed</h2><div class="table-wrap"><table>
        <tr><th>Employee</th><th>Module</th><th class="num">Score</th><th>Completed</th></tr>
        ${d.recent.map((a) => `<tr><td><a href="#/employees/${a.user_id}">${esc(a.user_name)}</a></td><td>${esc(a.module_title)}</td><td class="num">${a.best_score ?? '–'}${a.best_score != null ? '%' : ''}</td><td>${fmtDate(a.completed_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No completions yet</td></tr>'}
      </table></div></div>
    </div>`;
  $('#assign').addEventListener('click', () => openAssignDialog({ onDone: router }));
  $('#bulk').addEventListener('click', () => openAssignDialog({ onDone: router, tab: 'upload' }));
}

async function viewEmployees() {
  const employees = await api('/employees');
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Employees</h1><p>New employees get onboarding modules automatically when you add them.</p></div>
      <div class="actions"><button id="import">Import CSV</button><button class="primary" id="add">Add employee</button></div></div>
    <div class="filters"><input type="search" id="search" placeholder="Search name, email or department"></div>
    <div class="card flush"><div class="table-wrap"><table id="emp-table">
      <tr><th>Name</th><th>Department</th><th>Joined</th><th class="num">Assigned</th><th class="num">Completed</th><th class="num">Overdue</th><th></th></tr>
      ${employees.map((e) => `<tr data-text="${esc(`${e.name} ${e.email} ${e.department}`.toLowerCase())}">
        <td><a href="#/employees/${e.id}">${esc(e.name)}</a> ${e.role === 'admin' ? '<span class="badge blue">Admin</span>' : ''} ${e.active ? '' : '<span class="badge">Inactive</span>'}<div class="sub">${esc(e.email)}</div></td>
        <td>${esc(e.department)}<div class="sub">${esc(e.designation)}</div></td>
        <td>${fmtDate(e.joining_date)}</td>
        <td class="num">${e.assigned}</td><td class="num">${e.completed}</td>
        <td class="num">${e.overdue ? `<span class="badge red">${e.overdue}</span>` : ''}</td>
        <td class="num"><button class="small" data-assign="${e.id}">Assign</button></td></tr>`).join('')}
    </table></div></div>`;
  $('#add').addEventListener('click', () => openEmployeeDialog(null, router));
  $('#import').addEventListener('click', () => openImportDialog(router));
  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    $$('#emp-table tr[data-text]').forEach((tr) => { tr.hidden = q && !tr.dataset.text.includes(q); });
  });
  $$('[data-assign]').forEach((b) => b.addEventListener('click', () => openAssignDialog({ userIds: [b.dataset.assign], onDone: router })));
}

function assignmentRows(list, { showEmployee = true, showModule = true } = {}) {
  if (!list.length) return `<tr><td colspan="8" class="empty">No assignments</td></tr>`;
  return list.map((a) => `<tr>
    ${showEmployee ? `<td><a href="#/employees/${a.user_id}">${esc(a.user_name)}</a><div class="sub">${esc(a.user_department)}</div></td>` : ''}
    ${showModule ? `<td>${esc(a.module_title)}${a.note ? `<div class="sub">${esc(a.note)}</div>` : ''}</td>` : ''}
    <td>${sourceBadge(a.source)}<div class="sub">${fmtDate(a.assigned_at)}${a.assigned_by_name ? ` by ${esc(a.assigned_by_name)}` : ''}</div></td>
    <td>${fmtDate(a.due_date)}</td>
    <td>${statusBadge(a)}</td>
    <td style="min-width:140px">${progressBar(a.progress, a.status === 'completed')}</td>
    <td class="num">${a.best_score != null ? `${a.best_score}%` : '–'}</td>
    <td class="num"><button class="small" data-due="${a.id}" data-date="${a.due_date}">Due date</button> <button class="small danger" data-remove="${a.id}">Remove</button></td>
  </tr>`).join('');
}

function bindAssignmentActions(onChange) {
  $$('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await askConfirm('Remove this assignment? The employee\'s progress on it will be deleted.', 'Remove'))) return;
    try { await api(`/assignments/${b.dataset.remove}`, { method: 'DELETE' }); toast('Assignment removed'); onChange(); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-due]').forEach((b) => b.addEventListener('click', () => {
    openDialog(`<form class="dlg" id="due-form"><h2>Change due date</h2>
      <div class="field"><input type="date" name="due" value="${b.dataset.date}" required></div>
      <div class="dlg-foot"><button type="button" data-close>Cancel</button><button class="primary">Save</button></div></form>`, (dlg) => {
      $('#due-form', dlg).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api(`/assignments/${b.dataset.due}`, { method: 'PUT', body: { due_date: e.target.due.value } }); dialog.close(); toast('Due date updated'); onChange(); }
        catch (err) { toast(err.message, 'error'); }
      });
    });
  }));
}

async function viewEmployee(id) {
  const e = await api(`/employees/${id}`);
  const done = e.assignments.filter((a) => a.status === 'completed').length;
  const overdue = e.assignments.filter((a) => a.overdue).length;
  $('#view').innerHTML = `
    <div class="page-head"><div><a href="#/employees" class="sub">← Employees</a><h1>${esc(e.name)} ${e.active ? '' : '<span class="badge">Inactive</span>'}</h1>
      <p>${esc(e.designation)}${e.designation && e.department ? ' · ' : ''}${esc(e.department)} · ${esc(e.email)} · Joined ${fmtDate(e.joining_date)}</p></div>
      <div class="actions"><button id="edit">Edit</button><button id="onboard">Assign onboarding</button><button class="primary" id="assign">Assign a module</button></div></div>
    <div class="stats">
      <div class="stat"><div class="label">Assigned</div><div class="value">${e.assignments.length}</div></div>
      <div class="stat green"><div class="label">Completed</div><div class="value">${done}</div></div>
      <div class="stat red"><div class="label">Overdue</div><div class="value">${overdue}</div></div>
    </div>
    <div class="card flush"><div class="table-wrap"><table>
      <tr><th>Module</th><th>Source</th><th>Due</th><th>Status</th><th>Progress</th><th class="num">Score</th><th></th></tr>
      ${assignmentRows(e.assignments, { showEmployee: false })}
    </table></div></div>`;
  $('#edit').addEventListener('click', () => openEmployeeDialog(e, router));
  $('#assign').addEventListener('click', () => openAssignDialog({ userIds: [e.id], onDone: router }));
  $('#onboard').addEventListener('click', async () => {
    try {
      const r = await api(`/employees/${e.id}/onboarding`, { method: 'POST', body: {} });
      toast(r.assigned ? `Assigned ${r.assigned} onboarding module${r.assigned === 1 ? '' : 's'}` : 'All matching onboarding modules are already assigned');
      router();
    } catch (err) { toast(err.message, 'error'); }
  });
  bindAssignmentActions(router);
}

async function viewModules() {
  const modules = await api('/modules');
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Modules</h1><p>Onboarding modules are assigned automatically to new joiners. Others are assigned as needed.</p></div>
      <div class="actions"><a class="btn primary" href="#/modules/new">+ Create custom module</a></div></div>
    <div class="card flush"><div class="table-wrap"><table>
      <tr><th>Module</th><th>Type</th><th class="num">Lessons</th><th class="num">Questions</th><th class="num">Due in</th><th style="width:170px">Completion</th><th></th></tr>
      ${modules.map((m) => `<tr>
        <td><a href="#/modules/${m.id}">${esc(m.title)}</a> ${m.published ? '' : '<span class="badge">Draft</span>'}<div class="sub">${esc(m.category)}</div></td>
        <td>${m.is_onboarding ? `<span class="badge blue">Onboarding</span><div class="sub">${m.onboarding_departments ? esc(m.onboarding_departments) : 'All departments'}</div>` : '<span class="badge">As needed</span>'}</td>
        <td class="num">${m.lessons_count}</td><td class="num">${m.questions_count}</td><td class="num">${m.due_days} days</td>
        <td>${progressBar(pct(m.completed, m.assigned), m.assigned && m.completed === m.assigned)}<div class="sub">${m.completed} of ${m.assigned} completed</div></td>
        <td class="num"><button class="small" data-assign="${m.id}" ${m.published ? '' : 'disabled'}>Assign</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty">No modules yet</td></tr>'}
    </table></div></div>`;
  $$('[data-assign]').forEach((b) => b.addEventListener('click', () => openAssignDialog({ moduleId: b.dataset.assign, onDone: router })));
}

async function viewModuleEditor(id) {
  const draft = id ? await api(`/modules/${id}`) : {
    title: '', description: '', category: '', is_onboarding: 0, onboarding_departments: '', due_days: 7, pass_mark: 70, published: 1,
    lessons: [{ title: '', content: '', video_url: '' }], questions: [],
  };
  const view = $('#view');

  const render = () => {
    view.innerHTML = `
      <div class="page-head"><div><a href="#/modules" class="sub">← Modules</a><h1>${id ? 'Edit module' : 'Create custom module'}</h1></div>
        <div class="actions">${id ? '<button class="danger" id="delete">Delete</button>' : ''}<button class="primary" id="save">Save module</button></div></div>
      <div class="card" style="margin-bottom:16px">
        <h2>Details</h2>
        <div class="field"><label>Title</label><input type="text" data-k="title" value="${esc(draft.title)}" placeholder="e.g. Information Security Basics"></div>
        <div class="field"><label>Description</label><input type="text" data-k="description" value="${esc(draft.description)}"></div>
        <div class="row">
          <div class="field"><label>Category</label><input type="text" data-k="category" value="${esc(draft.category)}" placeholder="Onboarding, Compliance, Skills…"></div>
          <div class="field"><label>Due within (days)</label><input type="number" min="0" data-k="due_days" value="${esc(draft.due_days)}"><div class="hint">From joining date for onboarding, from assignment otherwise.</div></div>
          <div class="field"><label>Quiz pass mark (%)</label><input type="number" min="0" max="100" data-k="pass_mark" value="${esc(draft.pass_mark)}"></div>
        </div>
        <label class="check" style="margin-bottom:8px"><input type="checkbox" data-k="published" ${draft.published ? 'checked' : ''}> Published (draft modules can't be assigned)</label>
        <label class="check"><input type="checkbox" data-k="is_onboarding" ${draft.is_onboarding ? 'checked' : ''}> Onboarding module: assign automatically when an employee joins</label>
        <div class="field" style="margin:10px 0 0 24px" ${draft.is_onboarding ? '' : 'hidden'} id="dept-field"><label>Only for departments (comma separated, blank = everyone)</label><input type="text" data-k="onboarding_departments" value="${esc(draft.onboarding_departments)}" placeholder="e.g. Sales, Support"></div>
      </div>
      <div class="card" style="margin-bottom:16px">
        <h2>Lessons</h2>
        <p class="sub" style="margin-top:-6px">Content supports simple formatting: <code># Heading</code>, <code>- bullet</code>, <code>**bold**</code>, <code>[link](https://…)</code>. Each lesson can have an uploaded video or a YouTube / Vimeo link.</p>
        ${draft.lessons.map((l, i) => `
          <div class="block">
            <div class="block-head"><strong>Lesson ${i + 1}</strong><div class="actions">
              <button class="small" data-move-lesson="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="small" data-move-lesson="${i}" data-dir="1" ${i === draft.lessons.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="small danger" data-del-lesson="${i}" ${draft.lessons.length === 1 ? 'disabled' : ''}>Remove</button></div></div>
            <div class="field"><label>Title</label><input type="text" data-lesson="${i}" data-f="title" value="${esc(l.title)}"></div>
            <div class="field"><label>Video (optional)</label>
              ${isUploadedVideo(l.video_url)
                ? `<div class="upload-row"><span class="badge green">🎬 ${esc(uploadedName(l.video_url))}</span><button type="button" class="small" data-upload="${i}">Replace video</button><button type="button" class="small danger" data-clear-video="${i}">Remove video</button></div>
                   <div class="lesson-preview">${uploadedVideoTag(l.video_url)}</div>`
                : `<div class="upload-row"><button type="button" class="small" data-upload="${i}">⬆ Upload video file</button><span class="sub">MP4, WebM or MOV, up to 1 GB · or paste a YouTube / Vimeo link:</span></div>
                   <input type="url" data-lesson="${i}" data-f="video_url" value="${esc(l.video_url)}" placeholder="https://www.youtube.com/watch?v=…" style="margin-top:6px">`}
              <div class="upload-status" id="upload-status-${i}"></div>
              <input type="file" accept="video/mp4,video/webm,video/quicktime,video/ogg,.mp4,.webm,.mov,.m4v,.ogg" data-file="${i}" hidden>
            </div>
            <div class="field"><label>Content</label><textarea data-lesson="${i}" data-f="content">${esc(l.content)}</textarea></div>
          </div>`).join('')}
        <button id="add-lesson">+ Add lesson</button>
      </div>
      <div class="card">
        <h2>Quiz</h2>
        <p class="sub" style="margin-top:-6px">Optional. Learners take it after finishing all lessons and must reach the pass mark to complete the module. Select the radio button next to the correct answer.</p>
        ${draft.questions.map((q, i) => `
          <div class="block">
            <div class="block-head"><strong>Question ${i + 1}</strong><button class="small danger" data-del-q="${i}">Remove</button></div>
            <div class="field"><input type="text" data-q="${i}" data-f="text" value="${esc(q.text)}" placeholder="Question"></div>
            ${q.options.map((o, j) => `<div class="option-row">
              <input type="radio" name="correct-${i}" data-correct="${i}" value="${j}" ${q.correct_index === j ? 'checked' : ''} title="Correct answer">
              <input type="text" data-q="${i}" data-opt="${j}" value="${esc(o)}" placeholder="Option ${j + 1}">
              <button class="small" data-del-opt="${i}" data-j="${j}" ${q.options.length <= 2 ? 'disabled' : ''}>✕</button></div>`).join('')}
            <button class="small link" data-add-opt="${i}" ${q.options.length >= 6 ? 'disabled' : ''}>+ Add option</button>
          </div>`).join('')}
        <button id="add-q">+ Add question</button>
      </div>`;
    hydrateVideos(view);
  };

  render();

  const onUpload = async (e) => {
    const input = e.target;
    if (!input.files[0]) return;
    const i = Number(input.dataset.file);
    const status = $(`#upload-status-${i}`);
    const save = $('#save');
    try {
      save.disabled = true;
      draft.lessons[i].video_url = await uploadVideo(input.files[0], (msg) => { status.textContent = msg; });
      toast('Video uploaded');
      render();
    } catch (err) {
      status.textContent = '';
      toast(err.message, 'error');
    } finally {
      if ($('#save')) $('#save').disabled = false;
    }
  };

  // Inputs write straight into the draft; structural changes re-render.
  view.oninput = view.onchange = (e) => {
    const t = e.target;
    if (t.dataset.file !== undefined) { if (e.type === 'change') onUpload(e); return; }
    if (t.dataset.k) {
      draft[t.dataset.k] = t.type === 'checkbox' ? (t.checked ? 1 : 0) : t.value;
      if (t.dataset.k === 'is_onboarding') $('#dept-field').hidden = !t.checked;
    } else if (t.dataset.lesson !== undefined) draft.lessons[t.dataset.lesson][t.dataset.f] = t.value;
    else if (t.dataset.opt !== undefined) draft.questions[t.dataset.q].options[t.dataset.opt] = t.value;
    else if (t.dataset.q !== undefined) draft.questions[t.dataset.q][t.dataset.f] = t.value;
    else if (t.dataset.correct !== undefined) draft.questions[t.dataset.correct].correct_index = Number(t.value);
  };

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.upload !== undefined) { $(`[data-file="${d.upload}"]`).click(); return; }
    if (d.clearVideo !== undefined) { draft.lessons[d.clearVideo].video_url = ''; render(); return; }
    if (b.id === 'add-lesson') { draft.lessons.push({ title: '', content: '', video_url: '' }); render(); }
    else if (d.delLesson !== undefined) { draft.lessons.splice(Number(d.delLesson), 1); render(); }
    else if (d.moveLesson !== undefined) {
      const i = Number(d.moveLesson); const j = i + Number(d.dir);
      [draft.lessons[i], draft.lessons[j]] = [draft.lessons[j], draft.lessons[i]];
      render();
    } else if (b.id === 'add-q') { draft.questions.push({ text: '', options: ['', '', '', ''], correct_index: null }); render(); }
    else if (d.delQ !== undefined) { draft.questions.splice(Number(d.delQ), 1); render(); }
    else if (d.addOpt !== undefined) { draft.questions[d.addOpt].options.push(''); render(); }
    else if (d.delOpt !== undefined) {
      const q = draft.questions[d.delOpt]; const j = Number(d.j);
      q.options.splice(j, 1);
      if (q.correct_index === j) q.correct_index = null; else if (q.correct_index > j) q.correct_index--;
      render();
    } else if (b.id === 'save') {
      try {
        const body = { ...draft, questions: draft.questions.map((q) => ({ ...q, options: q.options.filter((o) => o.trim()) })) };
        // Keep the correct answer pointing at the same option after blank options are dropped.
        body.questions.forEach((q, i) => {
          const orig = draft.questions[i];
          if (orig.correct_index != null) q.correct_index = q.options.indexOf(orig.options[orig.correct_index]);
        });
        await api(id ? `/modules/${id}` : '/modules', { method: id ? 'PUT' : 'POST', body });
        toast('Module saved');
        location.hash = '#/modules';
      } catch (err) { toast(err.message, 'error'); }
    } else if (b.id === 'delete') {
      if (!(await askConfirm('Delete this module? All assignments and progress for it will be deleted. To hide it instead, untick Published.', 'Delete module'))) return;
      try { await api(`/modules/${id}`, { method: 'DELETE' }); toast('Module deleted'); location.hash = '#/modules'; }
      catch (err) { toast(err.message, 'error'); }
    }
  };
}

async function viewAssignments() {
  const [modules, departments] = await Promise.all([api('/modules'), api('/departments')]);
  const params = new URLSearchParams(sessionStorage.getItem('assignFilters') || '');
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Assignments & progress</h1><p>Every module assigned to every employee, with live progress.</p></div>
      <div class="actions"><a class="btn" id="export" href="#">Export CSV</a><button id="bulk">Bulk assign from Excel</button><button class="primary" id="assign">Assign a module</button></div></div>
    <div class="filters" id="filters">
      <input type="search" name="search" placeholder="Search employee or module" value="${esc(params.get('search') || '')}">
      <select name="module_id"><option value="">All modules</option>${modules.map((m) => `<option value="${m.id}">${esc(m.title)}</option>`).join('')}</select>
      <select name="department"><option value="">All departments</option>${departments.map((d) => `<option>${esc(d)}</option>`).join('')}</select>
      <select name="status"><option value="">Any status</option><option value="assigned">Not started</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="overdue">Overdue</option></select>
      <select name="source"><option value="">Onboarding + as needed</option><option value="onboarding">Onboarding</option><option value="manual">Assigned as needed</option></select>
    </div>
    <div class="card flush"><div class="table-wrap"><table>
      <thead><tr><th>Employee</th><th>Module</th><th>Source</th><th>Due</th><th>Status</th><th>Progress</th><th class="num">Score</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div></div>`;
  const filters = $('#filters');
  ['module_id', 'department', 'status', 'source'].forEach((k) => { filters.querySelector(`[name=${k}]`).value = params.get(k) || ''; });
  const query = () => {
    const p = new URLSearchParams();
    $$('[name]', filters).forEach((el) => { if (el.value) p.set(el.name, el.value); });
    return p;
  };
  const load = async () => {
    const p = query();
    sessionStorage.setItem('assignFilters', p.toString());
    $('#export').href = `/api/assignments.csv?${p}`;
    if (window.LMS_DEMO) $('#export').onclick = (e) => { e.preventDefault(); toast('CSV export works in the installed version'); };
    const rows = await api(`/assignments?${p}`);
    $('#rows').innerHTML = assignmentRows(rows);
    bindAssignmentActions(load);
  };
  let timer;
  filters.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $('#assign').addEventListener('click', () => openAssignDialog({ moduleId: query().get('module_id') || '', onDone: load }));
  $('#bulk').addEventListener('click', () => openAssignDialog({ moduleId: query().get('module_id') || '', onDone: load, tab: 'upload' }));
  await load();
}

// ---------- learner views ----------
async function viewMyLearning() {
  const list = await api('/my/assignments');
  const open = list.filter((a) => a.status !== 'completed');
  const done = list.filter((a) => a.status === 'completed');
  const card = (a) => `
    <div class="card module-card">
      <div class="meta">${sourceBadge(a.source)} ${statusBadge(a)} ${a.module_category && a.module_category.toLowerCase() !== 'onboarding' ? `<span class="badge">${esc(a.module_category)}</span>` : ''}</div>
      <h3>${esc(a.module_title)}</h3>
      <p>${esc(a.module_description)}</p>
      ${a.note ? `<div class="sub">Note: ${esc(a.note)}</div>` : ''}
      ${progressBar(a.progress, a.status === 'completed')}
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="sub">${a.status === 'completed' ? `Completed ${fmtDate(a.completed_at)}` : `Due ${fmtDate(a.due_date)}`} · ${a.lessons_total} lesson${a.lessons_total === 1 ? '' : 's'}${a.questions_total ? ' + quiz' : ''}</span>
        <a class="btn ${a.status === 'completed' ? '' : 'primary'} small" href="#/learn/${a.id}">${a.status === 'completed' ? 'Review' : a.status === 'in_progress' ? 'Continue' : 'Start'}</a>
      </div>
    </div>`;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>My learning</h1><p>Hi ${esc(state.user.name.split(' ')[0])}, here are the modules assigned to you.</p></div></div>
    <div class="stats">
      <div class="stat"><div class="label">To do</div><div class="value">${open.length}</div></div>
      <div class="stat red"><div class="label">Overdue</div><div class="value">${open.filter((a) => a.overdue).length}</div></div>
      <div class="stat green"><div class="label">Completed</div><div class="value">${done.length}</div></div>
    </div>
    <h2>To do</h2>
    ${open.length ? `<div class="module-cards">${open.map(card).join('')}</div>` : '<div class="card empty">You\'re all caught up. Nice work!</div>'}
    ${done.length ? `<h2 style="margin-top:28px">Completed</h2><div class="module-cards">${done.map(card).join('')}</div>` : ''}`;
}

async function viewLearn(id, step) {
  const { assignment: a, module: m, attempts } = await api(`/my/assignments/${id}`);
  const lessonsDone = m.lessons.every((l) => l.done);
  const hasQuiz = m.questions.length > 0;
  const passed = attempts.some((t) => t.passed);
  // Default to the first unfinished lesson (or the quiz once lessons are done).
  if (step === undefined) {
    const next = m.lessons.find((l) => !l.done);
    step = next ? String(next.id) : hasQuiz && !passed ? 'quiz' : String(m.lessons[0].id);
  }
  const lessonIndex = m.lessons.findIndex((l) => String(l.id) === step);

  const toc = `
    <div class="card toc">
      <div style="padding:8px 10px 12px"><strong>${esc(m.title)}</strong>${progressBar(a.progress, a.status === 'completed')}</div>
      ${m.lessons.map((l, i) => `<a href="#/learn/${a.id}/${l.id}" class="${String(l.id) === step ? 'active' : ''}"><span class="dot ${l.done ? 'done' : ''}">${l.done ? '✓' : ''}</span>${i + 1}. ${esc(l.title)}</a>`).join('')}
      ${hasQuiz ? `<a href="#/learn/${a.id}/quiz" class="${step === 'quiz' ? 'active' : ''} ${lessonsDone ? '' : 'locked'}"><span class="dot ${passed ? 'done' : ''}">${passed ? '✓' : ''}</span>Quiz ${lessonsDone ? '' : '🔒'}</a>` : ''}
    </div>`;

  let body;
  if (step === 'quiz' && hasQuiz) {
    body = !lessonsDone
      ? '<div class="empty">Finish all lessons to unlock the quiz.</div>'
      : `<h2>Quiz</h2>
         <p class="sub">${m.questions.length} question${m.questions.length === 1 ? '' : 's'} · pass mark ${a.pass_mark}%${attempts.length ? ` · best score ${a.best_score}% after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}` : ''}</p>
         ${passed ? '<div class="result pass">You passed this quiz. You can retake it any time to refresh your knowledge.</div>' : ''}
         <form id="quiz">
           <div id="quiz-result"></div>
           ${m.questions.map((q, i) => `<div class="question" data-i="${i}"><div class="q">${i + 1}. ${esc(q.text)}</div>
             ${q.options.map((o, j) => `<label class="opt" data-j="${j}"><input type="radio" name="q${i}" value="${j}"> ${esc(o)}</label>`).join('')}</div>`).join('')}
           <button class="primary">Submit answers</button>
         </form>`;
  } else {
    const l = m.lessons[lessonIndex] || m.lessons[0];
    const i = m.lessons.indexOf(l);
    const nextHref = i < m.lessons.length - 1 ? `#/learn/${a.id}/${m.lessons[i + 1].id}` : hasQuiz ? `#/learn/${a.id}/quiz` : '#/my';
    body = `
      <div class="sub">Lesson ${i + 1} of ${m.lessons.length}</div>
      <h2 style="font-size:22px;margin:4px 0 16px">${esc(l.title)}</h2>
      ${renderVideo(l.video_url)}
      <div class="lesson-content">${renderContent(l.content)}</div>
      <div class="lesson-foot">
        ${i > 0 ? `<a class="btn" href="#/learn/${a.id}/${m.lessons[i - 1].id}">← Previous</a>` : '<span></span>'}
        ${l.done
          ? `<a class="btn primary" href="${nextHref}">${i < m.lessons.length - 1 ? 'Next lesson →' : hasQuiz ? 'Go to quiz →' : 'Back to my learning'}</a>`
          : `<button class="primary" id="complete" data-lesson="${l.id}" data-next="${nextHref}">Mark complete${i < m.lessons.length - 1 || hasQuiz ? ' & continue →' : ''}</button>`}
      </div>`;
  }

  $('#view').innerHTML = `
    <div class="page-head"><div><a href="#/my" class="sub">← My learning</a><h1>${esc(m.title)}</h1>
      <p>${statusBadge(a)} · ${a.status === 'completed' ? `Completed ${fmtDate(a.completed_at)}` : `Due ${fmtDate(a.due_date)}`}</p></div></div>
    <div class="player">${toc}<div class="card">${body}</div></div>`;
  hydrateVideos($('#view'));

  $('#complete')?.addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const updated = await api(`/my/assignments/${a.id}/lessons/${b.dataset.lesson}/complete`, { method: 'POST', body: {} });
      if (updated.status === 'completed' && a.status !== 'completed') toast('Module completed 🎉');
      if (location.hash === b.dataset.next) router(); else location.hash = b.dataset.next;
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  });

  $('#quiz')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const answers = m.questions.map((_, i) => { const c = form.querySelector(`[name=q${i}]:checked`); return c ? Number(c.value) : null; });
    if (answers.includes(null)) { toast('Please answer every question before submitting', 'error'); return; }
    try {
      const r = await api(`/my/assignments/${a.id}/quiz`, { method: 'POST', body: { answers } });
      r.results.forEach((res, i) => {
        const qEl = form.querySelector(`.question[data-i="${i}"]`);
        qEl.classList.remove('right', 'wrong');
        qEl.classList.add(res.correct ? 'right' : 'wrong');
        if (res.correct_index !== undefined) qEl.querySelector(`label[data-j="${res.correct_index}"]`).classList.add('right');
      });
      $('#quiz-result').innerHTML = r.passed
        ? `<div class="result pass">You scored ${r.score}% and passed! ${r.assignment.status === 'completed' ? 'This module is complete.' : ''} <a href="#/my">Back to my learning</a></div>`
        : `<div class="result fail">You scored ${r.score}%. You need ${r.pass_mark}% to pass. Review the lessons and try again.</div>`;
      $('#quiz-result').scrollIntoView({ behavior: 'smooth' });
      if (r.passed && a.status !== 'completed') {
        toast('Module completed 🎉');
        // Reflect the new status without leaving the results on screen.
        const done = r.assignment;
        $('.page-head p').innerHTML = `${statusBadge(done)} · Completed ${fmtDate(done.completed_at)}`;
        $('.toc .progress-row').outerHTML = progressBar(done.progress, true);
        const quizDot = $('.toc a.active .dot');
        if (quizDot) { quizDot.classList.add('done'); quizDot.textContent = '✓'; }
      }
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function viewAccount() {
  const u = state.user;
  $('#view').innerHTML = `
    <div class="page-head"><div><h1>Account</h1></div></div>
    <div class="grid grid-2">
      <div class="card"><h2>Profile</h2>
        <p><strong>${esc(u.name)}</strong><br>${esc(u.email)}<br>${esc(u.designation)}${u.designation && u.department ? ' · ' : ''}${esc(u.department)}<br><span class="sub">Joined ${fmtDate(u.joining_date)}</span></p></div>
      <form class="card" id="pw"><h2>Change password</h2>
        <div class="field"><label>Current password</label><input type="password" name="current" required autocomplete="current-password"></div>
        <div class="field"><label>New password</label><input type="password" name="next" required minlength="6" autocomplete="new-password"></div>
        <button class="primary">Update password</button></form>
    </div>`;
  $('#pw').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/me/password', { method: 'POST', body: { current: e.target.current.value, next: e.target.next.value } }); e.target.reset(); toast('Password updated'); }
    catch (err) { toast(err.message, 'error'); }
  });
}

boot().then(() => { if (!state.user) renderLogin(); });
