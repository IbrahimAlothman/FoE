# KAU Signing Platform — Backend Setup

Two pieces: **Supabase** (auth + database + file storage) and **Railway**
(a small service for the two things Supabase can't do on its own: docx→PDF
conversion via LibreOffice, and server-side signature stamping).

## 1. Supabase project

1. Create a project at supabase.com.
2. Go to **SQL Editor** → paste the entire contents of `schema.sql` → Run.
   This creates all tables, the storage bucket, and every RLS policy.
3. Go to **Authentication → Providers** → make sure **Email** is enabled.
   For a real deployment, turn email confirmations on; for quick testing you
   can leave them off.
4. Go to **Project Settings → API** and copy:
   - `Project URL` → this is `SUPABASE_URL`
   - `anon public` key → goes in the **frontend** (safe to expose — RLS
     protects the data)
   - `service_role` key → goes **only** in Railway (this key bypasses RLS —
     never put it in frontend code)
5. There is no self-signup page anywhere in this system — every account is
   created by an admin (Section 3 below). Create your own first admin
   account manually: Supabase dashboard → **Authentication → Add user** →
   enter your email + a password directly (skip the invite flow just this
   once). Then in the SQL editor:
   ```sql
   update public.profiles set role='admin' where email='YOUR_EMAIL';
   ```
   Every account after this one gets created the normal way, through the
   admin panel.

## 2. Railway service

1. Push the `railway-service/` folder to a git repo (or use `railway up`
   directly from this folder with the Railway CLI).
2. In Railway: **New Project → Deploy from repo**, point it at this folder
   (it will detect the `Dockerfile` automatically — LibreOffice needs the
   Docker build, not Railway's default Node buildpack).
3. Set these environment variables on the service (Railway dashboard →
   Variables):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `RESEND_API_KEY` — from resend.com (used to send the signing-link
     emails; free tier is plenty for this). Without it, the service still
     works but just logs the link instead of emailing it — useful for
     testing before you've set up a sending domain.
   - `FROM_EMAIL` — e.g. `signing@your-verified-domain.sa` (must be a domain
     verified in Resend)
   - `APP_URL` — your frontend's public URL, e.g.
     `https://sign.kau.edu.sa` — used to build the `/sign/<token>` links
     that go out in emails
4. Deploy. Railway gives you a public URL like
   `https://kau-signing-backend-production.up.railway.app`.
5. Sanity check: `curl https://<your-railway-url>/health` should return
   `{"ok":true}`.

## 3. What each endpoint does

- `POST /convert-docx` — body `{ documentId }`. Called after a docx upload,
  before opening the signature placement editor. Downloads the original
  file, converts it with LibreOffice, uploads the PDF back, and updates
  `documents.pdf_file_path`.
- `POST /stamp-signature` — body `{ documentId, xPct, yPct, widthPct }`.
  Called when the assigned approver confirms signature placement. Loads
  their saved signature (server-side only), embeds it into the PDF at the
  given position, uploads the signed PDF, and updates the document status.
- `POST /send-signing-link` — body `{ documentId }`. Called right after a
  document is created (when the approver isn't the uploader themselves).
  Generates a single-use, 7-day token and emails the assigned approver a
  direct link — `{APP_URL}/sign/<token>`.
- `GET /action/:token` — **public, no login required.** Returns the
  document's title, requirements, status, and a short-lived signed file URL,
  for whoever holds this exact token. Fails on expired/used/missing tokens.
- `POST /action/:token/approve` — marks the document approved. If it also
  needs a signature, the token stays valid so the same link can sign next;
  otherwise the token is consumed immediately.
- `POST /action/:token/reject` — body `{ reason }` (optional). Marks
  rejected and consumes the token.
- `POST /action/:token/sign` — body `{ xPct, yPct, widthPct }`. Same
  stamping logic as `/stamp-signature`, but authenticated by the token
  instead of a login session. Consumes the token on success.
- `POST /admin/create-user` — admin-only. Body
  `{ email, fullName, role, department }`, where `role` is one of
  `faculty` (Dr / instructor), `dept_head`, `vice_dean`, `dean`, `admin`.
  This is the **only** way an account gets created — there is no signup
  page. It invites the person via Supabase Auth (they get an email, set
  their own password, and only ever see a sign-in screen after that).
- `POST /admin/disable-user` — admin-only. Body `{ userId }`. Offboarding —
  flips their profile to `disabled`, which blocks them via RLS without
  deleting their history.

The `/stamp-signature` and `/convert-docx` endpoints above still require a
normal Supabase Auth JWT — those are for someone using the full dashboard.
The `/action/:token/*` endpoints are the no-login path for the email flow.

Both endpoints expect a Supabase Auth JWT in the `Authorization: Bearer
<token>` header — the frontend gets this from
`supabase.auth.getSession()` after login.

## 4. Do you need a domain for Resend?

- **For testing, no.** Resend gives you a shared sender
  (`onboarding@resend.dev`) that works with zero setup — but it can only
  send to the email address you signed up to Resend with. Fine for testing
  the invite/signing-link flow solo.
- **For real use (emailing actual deans, department heads, etc.), yes.**
  You need to verify a domain you control in Resend — add the DNS records
  (SPF/DKIM) they give you. It doesn't have to be a newly bought domain; a
  subdomain works fine, e.g. `notifications.kau.edu.sa`, if IT can add a
  couple of DNS records for you. Without a verified domain, Resend won't
  let you send to arbitrary recipients, and unverified "from" addresses are
  also far more likely to land in spam.

## 5. What's still needed

This gives you the real backend (database, auth, storage, file conversion,
signature stamping, and now the email-link flow) with proper access control
enforced by RLS + the service-role checks in the Railway service. The
current frontend prototype still runs on in-memory mock data — it isn't
wired to call any of this yet.

That wiring has two parts now:
1. Replacing the mock `state.*` objects and functions with real
   `supabase-js` calls, and calling the Railway endpoints at the right
   moments (upload → `/convert-docx` if docx, sign → `/stamp-signature`).
2. A new, separate lightweight page/route — `/sign/<token>` — that isn't
   part of the logged-in dashboard at all. It calls `GET /action/:token` on
   load, shows the PDF with the same drag-to-place signature editor, and
   calls `/action/:token/approve` and `/action/:token/sign` — no login
   screen involved, since the token itself is the credential.
3. Removing the signup page from the prototype entirely, and replacing the
   admin panel's "pending signup requests" section with an "add user" form
   (name, email, role, department) that calls `/admin/create-user`.

Happy to build all three next — it's the natural next step now that the
backend exists to talk to.
