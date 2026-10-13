// Builds demo/learning-hub-demo.html: the whole app in one file that runs in a browser with no server.
// Usage: node --no-warnings=ExperimentalWarning demo/build.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-demo-'));
process.env.LMS_DB = path.join(tmp, 'seed.db');
delete process.env.TURSO_DATABASE_URL;
delete process.env.LIBSQL_URL;
const { ready, db, today } = require('../db');

(async () => {
await ready({ withDemoUsers: true }); // creates and seeds a fresh database
const tables = {};
for (const t of ['users', 'modules', 'lessons', 'questions', 'assignments', 'lesson_progress', 'quiz_attempts']) {
  tables[t] = (await db.prepare(`SELECT * FROM ${t}`).all()).map((r) => ({ ...r }));
}
// The demo keeps plain demo passwords instead of hashes.
tables.users.forEach((u) => {
  delete u.password_hash;
  u.password = u.role === 'admin' ? 'admin123' : 'welcome123';
});
fs.rmSync(tmp, { recursive: true, force: true });

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
const seed = JSON.stringify({ buildDate: today(), tables }).replace(/</g, '\\u003c');

const dataUri = (p, type = 'image/png') => `data:${type};base64,${fs.readFileSync(path.join(root, p)).toString('base64')}`;
const template = dataUri('public/templates/bulk-assign-template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

function build(file, brand) {
  const title = brand ? `${brand.product} · ${brand.company}` : 'Learning Hub';
  const html = `<meta charset="utf-8">
<title>${title}</title>
${brand ? `<link rel="icon" href="${dataUri('public/brand/mark.png')}">` : ''}
<style>
${read('public/styles.css')}
.demo-bar { background: var(--amber-soft); color: var(--amber); font-size: 13px; padding: 8px 16px; display: flex; gap: 12px; align-items: center; justify-content: center; flex-wrap: wrap; text-align: center; }
.demo-bar button { padding: 3px 10px; font-size: 12px; }
</style>
<div class="demo-bar" role="note"><span><strong>Demo</strong> · Everything works here, and your changes stay in this browser only.</span><button type="button" id="reset-demo">Reset demo data</button></div>
<div id="app"></div>
<div id="toast" class="toast" hidden></div>
<dialog id="dialog"></dialog>
<script>window.LMS_SEED = ${seed};
window.LMS_BRAND = ${brand ? JSON.stringify(brand) : 'null'};
window.LMS_TEMPLATE_URL = ${JSON.stringify(template)};</script>
<script>
${safe(read('demo/mock-api.js'))}
document.getElementById('reset-demo').addEventListener('click', () => window.LMS_RESET_DEMO());
</script>
<script>
${safe(read('public/app.js'))}
</script>
`;
  const out = path.join(__dirname, file);
  fs.writeFileSync(out, html);
  console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}

// Plain version (shareable link) and a company-branded version (file to open locally).
build('learning-hub-demo.html', null);
build('cardekho-learning-hub-demo.html', {
  company: 'CarDekho Group',
  product: 'Learning Hub',
  logo: dataUri('public/brand/logo.png'),
  logoOnDark: dataUri('public/brand/logo-white.png'),
});
})();
