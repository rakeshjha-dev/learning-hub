# Putting Learning Hub online (Vercel + Google sign-in)

This takes about 20 minutes of clicking, done once. You need a Google Workspace admin login for your company account, a free Vercel account, and a GitHub account. Never paste passwords, secrets or keys into chat: they only go into the Vercel and Google pages named below.

## Step 1. Give Claude a place to put the code (GitHub)

1. Open https://claude.ai/connect-github and connect your GitHub account.
2. On GitHub, create a new **private** repository named `learning-hub` (leave it empty: no README).
3. Tell Claude in the thread: "repo is ready: <your-github-name>/learning-hub". Claude uploads the app there.

## Step 2. Create the site on Vercel

1. Go to https://vercel.com/new and sign in with GitHub.
2. Find `learning-hub` in the list and click **Import**, then **Deploy**. Leave every setting as it is.
3. Open **Settings → Deployment Protection**, turn **Vercel Authentication** off and click **Save**. Otherwise everyone is sent to a Vercel login page instead of the app.
4. Copy the site address it shows, for example `https://learning-hub-abc.vercel.app`. You need it in Step 4.

## Step 3. Add the database and video storage

In your Vercel project, open the **Storage** tab.

1. Click **Create Database**, pick **Turso** (under Marketplace), accept the free plan and connect it to this project. This holds employees, modules and progress.
2. Click **Create Database** again, pick **Blob**, name it `videos` and connect it to this project. This holds the uploaded lesson videos.

## Step 4. Create the Google sign-in key

1. Go to https://console.cloud.google.com and sign in with your company Google account. Create a project called `Learning Hub` if asked.
2. Open **APIs & Services → OAuth consent screen**. Choose **Internal** (only people in your company can sign in), app name `Learning Hub`, your email as support email, then **Save**.
3. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**
   - Authorised redirect URI: your site address from Step 2 followed by `/api/auth/google/callback`, for example `https://learning-hub-abc.vercel.app/api/auth/google/callback`
4. Click **Create**. Google shows a **Client ID** and a **Client secret**. Keep this window open for Step 5.

Note: "Internal" works only for addresses inside one Google Workspace. If staff use two separate workspaces (for example girnarsoft.com and cardekho.com), choose **External** instead and click **Publish app**; Learning Hub itself still lets in only the domains you list in Step 5.

## Step 5. Tell Vercel the settings

In Vercel open **Settings → Environment Variables** and add these, one at a time:

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the Client ID from Step 4 |
| `GOOGLE_CLIENT_SECRET` | the Client secret from Step 4 |
| `ALLOWED_DOMAINS` | optional: email domains that may sign in, separated by commas (default `girnarsoft.com,cardekho.com`) |
| `ADMIN_EMAILS` | optional: work emails of HR/admins, separated by commas (rakesh.jha@girnarsoft.com is always an admin; admins can also be set later from the app) |

Then open **Deployments**, click the three dots on the top one and choose **Redeploy**.

## Step 6. Try it

Open your site address and click **Sign in with Google**.

- People in `ADMIN_EMAILS` see the admin dashboard.
- Anyone else with an allowed company email is added as an employee on their first sign-in and gets the onboarding modules automatically.
- Anyone else (for example a personal @gmail.com) sees "Please use your company Google account".
- Anyone already signed in to Google with their company account is let in automatically, without clicking.
- Admins can give or remove admin access from **Employees** (Make admin / Remove admin), and add many people at once with **Add from Excel**.

## Step 7 (optional). Turn on assignment emails

Employees get an email whenever a module is assigned to them, with a **Start module** button. The emails are sent from a company Google mailbox.

1. Pick the mailbox the emails come from, for example `learning@cardekho.com` or your own work email, and sign in to it.
2. Open https://myaccount.google.com/apppasswords. Type the name `Learning Hub` and click **Create**. Google shows a 16-letter password. Keep this window open. (If Google says the page isn't available, 2-Step Verification must be turned on first, or your Google Workspace admin has switched app passwords off. Ask IT to allow it.)
3. In Vercel, open **Settings → Environment Variables** and add:

| Name | Value |
| --- | --- |
| `SMTP_USER` | the mailbox from step 1 |
| `SMTP_PASS` | the 16-letter password from step 2 (without spaces) |
| `MAIL_FROM` | optional: the sender name and address people see, e.g. `CarDekho Learning Hub <learning@cardekho.com>` |
| `APP_URL` | optional: the site address used in email links, e.g. `https://learning-hub-cardekho.vercel.app` |

4. Open **Deployments**, click the three dots on the top one and choose **Redeploy**.

When assigning a module, the **Email each employee about this assignment** box is ticked by default; untick it to assign quietly.

---

## Reference (for whoever maintains it)

- `api/index.js` runs `server.js` as a Vercel function; `vercel.json` serves `public/` and rewrites `/api/*` to it.
- Database: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (set by the Turso integration). Tables and starter modules are created on first request. No demo accounts are created when Google sign-in is on.
- Videos: `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` for stores that sign in by store id (set by the Blob store). Browsers upload straight to Blob (`/api/uploads/blob` issues short-lived upload permissions, admins only, video files up to 1 GB). Blob URLs are public but unguessable.
- Email: `mailer.js` uses SMTP (`SMTP_USER`, `SMTP_PASS`, optional `SMTP_HOST` default smtp.gmail.com, `SMTP_PORT` default 465) or Resend (`RESEND_API_KEY` + `MAIL_FROM` on a verified domain). Each request's new assignments are emailed once it succeeds, one email per employee.
- Optional: `ALLOW_PASSWORD_LOGIN=1` keeps email + password sign-in alongside Google; `APP_URL` fixes the site address used for the Google redirect (e.g. when using a custom domain).
- Locally nothing changes: `npm start` still runs with no install, the built-in SQLite file and demo accounts.
