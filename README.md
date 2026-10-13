# Learning Hub: Employee LMS

A small learning management system for employees. Admins build training modules (lessons plus an optional quiz), assign them to employees, and track progress. Onboarding modules are assigned automatically when an employee joins; any module can also be assigned during employment as needed.

## Run it

Requires **Node.js 22.5 or newer** (it uses Node's built-in SQLite, so there is nothing to `npm install`).

```bash
cd lms
npm start            # or: node --no-warnings=ExperimentalWarning server.js
```

Open http://localhost:3000. The database is created at `data/lms.db` with demo data on first run.

| Role | Email | Password |
| --- | --- | --- |
| Admin | admin@company.com | admin123 |
| Employee | priya@company.com | welcome123 |
| Employee (Sales) | arjun@company.com | welcome123 |
| Employee | neha@company.com | welcome123 |

Options: `PORT=8080 npm start` changes the port, `LMS_DB=/path/to/file.db` changes the database location, and `npm run reset` deletes the database so demo data is recreated on the next start. Change the demo passwords before real use.

## What it does

**Admins**
- **Dashboard**: completion rate, overdue items, completion by module and by department, new joiners, recent completions.
- **Employees**: add one at a time, or many from Excel with a sample file (`public/templates/employees-template.xlsx`; a Role column of "Admin" makes admins). Online, anyone from an allowed company domain is added on their first Google sign-in. **Make admin / Remove admin** on each row. Edit, deactivate.
- **Modules**: lessons with formatted text (`# heading`, `- bullet`, `**bold**`, links) and an optional YouTube, Vimeo or .mp4 video; multiple-choice quiz with a pass mark; a due window in days; draft/published.
- **Onboarding (at joining)**: tick "Onboarding module" and every new employee gets it automatically, due N days after their joining date. You can limit it to departments (e.g. a Sales playbook only for Sales).
- **As needed (during employment)**: assign any module to one person, a department, or everyone, with a due date and an optional note. Completed modules can be assigned again as refreshers.
- **Bulk assign from Excel**: upload an .xlsx (or .csv) with an Email column and optional Name, Department, Designation, Joining Date. The preview shows who was found, who will be added and which rows have problems; new people are created with their onboarding modules. The dialog has a **Download sample file** button (`public/templates/bulk-assign-template.xlsx`).
- **Custom modules with uploaded videos**: each lesson can carry an uploaded video (MP4, WebM or MOV, up to 1 GB, stored in `data/uploads/`) or a YouTube/Vimeo link.
- **Assignment emails**: each employee gets one email per assignment action listing their new modules, with a Start module link (set up in DEPLOY.md, Step 7). Admins can untick the email box.
- **Branding**: company name and logos are set in `public/brand.js` and `public/brand/`.
- **Assignments & progress**: filter by module, department, status (incl. overdue) or source; change due dates; remove; export to CSV.

**Employees**
- **My learning**: assigned modules with progress, due dates and overdue flags.
- **Module player**: step through lessons, mark each complete (lessons with an uploaded video unlock only after the whole video has played: no skipping ahead or speeding up, it pauses when you leave the tab and resumes where you left off), then take the quiz (unlocked after all lessons). Passing the quiz completes the module; correct answers are revealed once passed. Retakes allowed.

## Online version (Vercel)

The same code runs on Vercel with **Sign in with Google** (only verified emails on your company domains), a hosted database (Turso) and video storage (Vercel Blob). Step-by-step setup: [DEPLOY.md](DEPLOY.md).

## How it's built

- `server.js`: Node `http` server with a JSON API under `/api`, cookie sessions, role checks.
- `mailer.js`: assignment emails over SMTP or Resend.
- `db.js`: SQLite schema (built-in SQLite locally, Turso online), onboarding auto-assignment, status calculation, seed data.
- `api/index.js`, `vercel.json`: the Vercel entry point and routing.
- `public/`: a no-build single-page app (`index.html`, `app.js`, `styles.css`).

A module is complete when every lesson is marked complete and, if it has a quiz, the quiz is passed.

## Try it without installing

`demo/learning-hub-demo.html` (plain) and `demo/cardekho-learning-hub-demo.html` (with the company logo) are the whole app in one file. Double-click it to open it in a browser: it runs with demo data and keeps changes in that browser only. Rebuild it after code changes with `node --no-warnings=ExperimentalWarning demo/build.js`.
