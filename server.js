// KAU Signing Platform — backend service (deploy on Railway)
//
// Responsibilities (things Supabase itself can't do):
//   1. Convert uploaded docx files to real PDFs using LibreOffice headless.
//   2. Stamp a signer's saved signature onto a PDF server-side, so the raw
//      signature image never has to be exposed to another user's browser.
//
// This service uses the Supabase SERVICE ROLE key, which bypasses Row Level
// Security. NEVER put that key in frontend code — it only lives here, as a
// Railway environment variable.

import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import libre from 'libreoffice-convert';
import { promisify } from 'util';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

const libreConvertAsync = promisify(libre.convert);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'signing@your-verified-domain.sa';
const APP_URL = process.env.APP_URL || 'https://your-frontend-domain.example';
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const BUCKET = 'documents';

const app = express();
app.use(cors()); // lock this down to your actual frontend origin in production
app.use(express.json({ limit: '25mb' }));

// Verifies the caller's Supabase Auth JWT (sent from the frontend as a
// normal Bearer token) and returns the authenticated user, or null.
async function getUserFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// Sends a transactional email via Resend (resend.com). Swap this for
// SendGrid/Postmark/SES if you prefer — same idea, different HTTP call.
async function sendSigningEmail({ to, recipientName, docTitle, actionUrl, needsApproval, needsSignature }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email send. Link:', actionUrl);
    return;
  }
  const actionWord = needsApproval && needsSignature ? 'اعتماد وتوقيع'
    : needsApproval ? 'اعتماد' : 'توقيع';
  const html = `
    <div dir="rtl" style="font-family:sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#055934;">جامعة الملك عبدالعزيز — نظام التوقيع والاعتماد</h2>
      <p>مرحبًا ${recipientName}،</p>
      <p>وصلك مستند بعنوان <b>${docTitle}</b> يحتاج ${actionWord}.</p>
      <p><a href="${actionUrl}" style="background:#208D44;color:#fff;padding:12px 22px;
        border-radius:8px;text-decoration:none;display:inline-block;">فتح المستند الآن</a></p>
      <p style="color:#888;font-size:12px;">هذا الرابط صالح لمدة 7 أيام ولمرة استخدام واحدة فقط.</p>
    </div>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject: `مستند يحتاج ${actionWord}: ${docTitle}`, html }),
  });
  if (!resp.ok) console.error('email send failed', await resp.text());
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// ------------------------------------------------------------
// POST /document-file-url   { documentId, variant }
// variant: 'working' (original/converted PDF) or 'signed' (final signed PDF).
// Storage RLS alone only lets the uploader (or admin) read a file directly —
// it can't grant the assigned approver access to someone else's upload.
// This endpoint checks uploader/approver/admin server-side and issues a
// short-lived signed URL either way.
// ------------------------------------------------------------
app.post('/document-file-url', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { documentId, variant } = req.body;
    const { data: doc, error: docErr } = await supabase
      .from('documents').select('*').eq('id', documentId).single();
    if (docErr || !doc) return res.status(404).json({ error: 'document not found' });

    if (doc.uploaded_by !== user.id && doc.approver_id !== user.id) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
      if (!profile || profile.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    }

    const path = variant === 'signed' ? doc.signed_pdf_path : (doc.pdf_file_path || doc.original_file_path);
    if (!path) return res.status(404).json({ error: 'file not available yet' });

    const { data: signed, error: urlErr } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 20);
    if (urlErr) return res.status(500).json({ error: 'could not create signed url', detail: urlErr.message });

    res.json({ url: signed.signedUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to get file url', detail: String(err) });
  }
});

// ------------------------------------------------------------
// POST /admin/create-user   { email, fullName, role, department }
// Admin-only. There is no self-signup anywhere in this system — every
// account is provisioned here. Creates the auth user via Supabase's invite
// flow (they set their own password via the emailed link) and the
// on_auth_user_created trigger fills in their profile from the metadata
// we pass, pre-approved.
// ------------------------------------------------------------
const VALID_ROLES = ['faculty', 'dept_head', 'vice_dean', 'dean', 'admin'];

app.post('/admin/create-user', async (req, res) => {
  try {
    const caller = await getUserFromRequest(req);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });

    const { data: callerProfile } = await supabase
      .from('profiles').select('role,status').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
      return res.status(403).json({ error: 'only an admin can create accounts' });
    }

    const { email, fullName, role, department } = req.body;
    if (!email || !fullName || !role) {
      return res.status(400).json({ error: 'email, fullName, and role are required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    // A temporary password, set directly rather than sent via an invite
    // link — simpler and avoids needing a separate "set password" page.
    // The new user should change it after their first login.
    const tempPassword = crypto.randomBytes(6).toString('base64url'); // ~8 chars

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, role, department: department || null },
    });
    if (error) return res.status(400).json({ error: error.message });

    let emailed = false;
    if (RESEND_API_KEY) {
      try {
        await sendWelcomeEmail({ to: email, recipientName: fullName, tempPassword });
        emailed = true;
      } catch (e) { console.error('welcome email failed', e); }
    }

    res.json({ created: true, userId: data.user.id, tempPassword, emailed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to create user', detail: String(err) });
  }
});

async function sendWelcomeEmail({ to, recipientName, tempPassword }) {
  const html = `
    <div dir="rtl" style="font-family:sans-serif;max-width:520px;margin:auto;">
      <h2 style="color:#055934;">جامعة الملك عبدالعزيز — نظام التوقيع والاعتماد</h2>
      <p>مرحبًا ${recipientName}،</p>
      <p>تم إنشاء حسابك في النظام. بيانات الدخول:</p>
      <p style="background:#F2F7ED;padding:12px 16px;border-radius:8px;">
        البريد الإلكتروني: <b>${to}</b><br/>
        كلمة المرور المؤقتة: <b>${tempPassword}</b>
      </p>
      <p style="color:#888;font-size:12px;">يُنصح بتغيير كلمة المرور بعد أول تسجيل دخول.</p>
    </div>`;
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject: 'حسابك في نظام التوقيع والاعتماد', html }),
  });
  if (!resp.ok) throw new Error(await resp.text());
}

// ------------------------------------------------------------
// POST /admin/disable-user   { userId }
// Admin-only. Offboarding, since accounts are never self-service-created
// there's no "reject" step anymore — just disable.
// ------------------------------------------------------------
app.post('/admin/disable-user', async (req, res) => {
  const caller = await getUserFromRequest(req);
  if (!caller) return res.status(401).json({ error: 'unauthorized' });
  const { data: callerProfile } = await supabase
    .from('profiles').select('role,status').eq('id', caller.id).single();
  if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
    return res.status(403).json({ error: 'only an admin can disable accounts' });
  }
  const { userId } = req.body;
  await supabase.from('profiles').update({ status: 'disabled' }).eq('id', userId);
  res.json({ disabled: true });
});

// ------------------------------------------------------------
// POST /admin/reset-password   { userId }
// Admin-only. Generates a new random password for an EXISTING account
// (e.g. they lost the one shown at creation time) and returns it the same
// way /admin/create-user does — shown to the admin to share, or emailed if
// Resend is configured.
// ------------------------------------------------------------
app.post('/admin/reset-password', async (req, res) => {
  try {
    const caller = await getUserFromRequest(req);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabase
      .from('profiles').select('role,status').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
      return res.status(403).json({ error: 'only an admin can reset passwords' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: profile, error: profErr } = await supabase
      .from('profiles').select('*').eq('id', userId).single();
    if (profErr || !profile) return res.status(404).json({ error: 'user not found' });

    const tempPassword = crypto.randomBytes(6).toString('base64url');
    const { error } = await supabase.auth.admin.updateUserById(userId, { password: tempPassword });
    if (error) return res.status(400).json({ error: error.message });

    let emailed = false;
    if (RESEND_API_KEY) {
      try {
        await sendWelcomeEmail({ to: profile.email, recipientName: profile.full_name, tempPassword });
        emailed = true;
      } catch (e) { console.error('reset-password email failed', e); }
    }

    res.json({ reset: true, tempPassword, emailed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to reset password', detail: String(err) });
  }
});

// ------------------------------------------------------------
// POST /admin/login-link   { userId }
// Admin-only. Generates a one-time magic-link sign-in URL for the given
// account, bypassing password auth entirely. Opening it in a browser tab
// logs in AS that user. Useful for admin testing/verification, and as a
// diagnostic: if this also fails, the problem is the account itself
// (e.g. unconfirmed email, deleted auth user) rather than the password.
// ------------------------------------------------------------
app.post('/admin/login-link', async (req, res) => {
  try {
    const caller = await getUserFromRequest(req);
    if (!caller) return res.status(401).json({ error: 'unauthorized' });
    const { data: callerProfile } = await supabase
      .from('profiles').select('role,status').eq('id', caller.id).single();
    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'approved') {
      return res.status(403).json({ error: 'only an admin can generate sign-in links' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: profile, error: profErr } = await supabase
      .from('profiles').select('*').eq('id', userId).single();
    if (profErr || !profile) return res.status(404).json({ error: 'user not found' });

    const { data, error } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: profile.email,
      options: { redirectTo: APP_URL },
    });
    if (error) return res.status(400).json({ error: error.message });

    res.json({ link: data.properties.action_link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to generate sign-in link', detail: String(err) });
  }
});


// ------------------------------------------------------------
// POST /send-signing-link   { documentId }
// Called right after a document is created (or re-sent later). Generates a
// single-use token and emails the assigned approver a direct link.
// ------------------------------------------------------------
app.post('/send-signing-link', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { documentId } = req.body;
    const { data: doc, error: docErr } = await supabase
      .from('documents').select('*').eq('id', documentId).single();
    if (docErr || !doc) return res.status(404).json({ error: 'document not found' });
    if (doc.uploaded_by !== user.id) return res.status(403).json({ error: 'only the uploader can send this' });

    const { data: approver } = await supabase
      .from('profiles').select('*').eq('id', doc.approver_id).single();
    if (!approver) return res.status(404).json({ error: 'approver profile not found' });

    const token = crypto.randomBytes(32).toString('hex');
    const { error: tokErr } = await supabase.from('document_action_tokens').insert({
      token, document_id: documentId, approver_id: doc.approver_id,
    });
    if (tokErr) return res.status(500).json({ error: 'could not create link', detail: tokErr.message });

    const actionUrl = `${APP_URL}/sign/${token}`;
    await sendSigningEmail({
      to: approver.email,
      recipientName: approver.full_name,
      docTitle: doc.title,
      actionUrl,
      needsApproval: doc.requires_approval,
      needsSignature: doc.requires_signature,
    });

    res.json({ sent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'failed to send link', detail: String(err) });
  }
});

// ------------------------------------------------------------
// GET /action/:token
// Public (no login) — returns just enough to render the PDF + action
// buttons for whoever holds this exact token. Fails closed on anything
// expired, used, or missing.
// ------------------------------------------------------------
app.get('/action/:token', async (req, res) => {
  const { token } = req.params;
  const { data: row, error } = await supabase
    .from('document_action_tokens').select('*').eq('token', token).single();
  if (error || !row) return res.status(404).json({ error: 'invalid link' });
  if (row.used_at) return res.status(410).json({ error: 'this link has already been used' });
  if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'this link has expired' });

  const { data: doc } = await supabase.from('documents').select('*').eq('id', row.document_id).single();
  if (!doc) return res.status(404).json({ error: 'document not found' });

  const filePath = doc.pdf_file_path || doc.original_file_path;
  const { data: signedUrl } = await supabase.storage.from(BUCKET)
    .createSignedUrl(filePath, 60 * 15); // 15 minutes, just enough to load the viewer

  res.json({
    documentId: doc.id,
    title: doc.title,
    requiresApproval: doc.requires_approval,
    requiresSignature: doc.requires_signature,
    status: doc.status,
    fileUrl: signedUrl?.signedUrl,
  });
});

// ------------------------------------------------------------
// POST /action/:token/approve
// ------------------------------------------------------------
app.post('/action/:token/approve', async (req, res) => {
  const { token } = req.params;
  const row = await validActionToken(token);
  if (!row) return res.status(410).json({ error: 'invalid, used, or expired link' });

  const { data: doc } = await supabase.from('documents').select('*').eq('id', row.document_id).single();
  const nextStatus = doc.requires_signature ? 'approved_pending_signature' : 'approved';
  await supabase.from('documents').update({ status: nextStatus }).eq('id', doc.id);
  await supabase.from('approval_log').insert({ document_id: doc.id, actor_id: row.approver_id, action: 'approved' });

  // only mark the token used if there's nothing left for this link to do
  if (!doc.requires_signature) {
    await supabase.from('document_action_tokens').update({ used_at: new Date().toISOString() }).eq('token', token);
  }
  res.json({ status: nextStatus });
});

// ------------------------------------------------------------
// POST /action/:token/reject   { reason }
// ------------------------------------------------------------
app.post('/action/:token/reject', async (req, res) => {
  const { token } = req.params;
  const { reason } = req.body;
  const row = await validActionToken(token);
  if (!row) return res.status(410).json({ error: 'invalid, used, or expired link' });

  await supabase.from('documents').update({ status: 'rejected' }).eq('id', row.document_id);
  await supabase.from('approval_log').insert({
    document_id: row.document_id, actor_id: row.approver_id, action: 'rejected', reason: reason || null,
  });
  await supabase.from('document_action_tokens').update({ used_at: new Date().toISOString() }).eq('token', token);
  res.json({ status: 'rejected' });
});

// ------------------------------------------------------------
// POST /action/:token/sign   { xPct, yPct, widthPct }
// Same stamping logic as /stamp-signature, but authenticated via the token
// (and the approver_id recorded on it) instead of a Supabase session.
// ------------------------------------------------------------
app.post('/action/:token/sign', async (req, res) => {
  try {
    const { token } = req.params;
    const { xPct, yPct, widthPct } = req.body;
    const row = await validActionToken(token);
    if (!row) return res.status(410).json({ error: 'invalid, used, or expired link' });

    const { data: doc } = await supabase.from('documents').select('*').eq('id', row.document_id).single();
    if (doc.requires_approval && doc.status !== 'approved_pending_signature') {
      return res.status(409).json({ error: 'document must be approved before it can be signed' });
    }

    const { data: sig } = await supabase.from('signatures').select('*').eq('user_id', row.approver_id).single();
    if (!sig) return res.status(400).json({ error: 'approver has no saved signature yet' });

    const sourcePath = doc.pdf_file_path || doc.original_file_path;
    const { data: pdfBlob } = await supabase.storage.from(BUCKET).download(sourcePath);
    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const base64 = sig.signature_png.split(',')[1] || sig.signature_png;
    const pngImage = await pdfDoc.embedPng(Buffer.from(base64, 'base64'));
    const page = pdfDoc.getPages()[0];
    const { width: pageW, height: pageH } = page.getSize();
    const sigWidthPt = pageW * (widthPct / 100);
    const aspect = pngImage.height / pngImage.width;
    const sigHeightPt = sigWidthPt * aspect;
    const xPt = (xPct / 100) * pageW - sigWidthPt / 2;
    const yPt = pageH - (yPct / 100) * pageH - sigHeightPt / 2;

    page.drawImage(pngImage, {
      x: Math.max(4, Math.min(pageW - sigWidthPt - 4, xPt)),
      y: Math.max(4, Math.min(pageH - sigHeightPt - 4, yPt)),
      width: sigWidthPt, height: sigHeightPt,
    });

    const signedBytes = await pdfDoc.save();
    const signedPath = sourcePath.replace(/\.pdf$/, '') + '_signed.pdf';
    await supabase.storage.from(BUCKET).upload(signedPath, signedBytes, { contentType: 'application/pdf', upsert: true });

    await supabase.from('documents')
      .update({ signed_pdf_path: signedPath, status: 'signed', stamp_position: { xPct, yPct, widthPct } })
      .eq('id', doc.id);
    await supabase.from('approval_log').insert({ document_id: doc.id, actor_id: row.approver_id, action: 'signed' });
    await supabase.from('document_action_tokens').update({ used_at: new Date().toISOString() }).eq('token', token);

    res.json({ status: 'signed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'signing failed', detail: String(err) });
  }
});

async function validActionToken(token) {
  const { data: row, error } = await supabase
    .from('document_action_tokens').select('*').eq('token', token).single();
  if (error || !row) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

// ------------------------------------------------------------
// POST /convert-docx   { documentId }
// Downloads the original docx from Storage, converts it to a real PDF via
// LibreOffice, uploads the result back, and records the path on the row.
// ------------------------------------------------------------
app.post('/convert-docx', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { documentId } = req.body;
    if (!documentId) return res.status(400).json({ error: 'documentId required' });

    const { data: doc, error: docErr } = await supabase
      .from('documents').select('*').eq('id', documentId).single();
    if (docErr || !doc) return res.status(404).json({ error: 'document not found' });

    // only the uploader or the assigned approver may trigger conversion
    if (doc.uploaded_by !== user.id && doc.approver_id !== user.id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (doc.original_file_type !== 'docx') {
      return res.status(400).json({ error: 'document is not a docx file' });
    }

    const { data: fileBlob, error: dlErr } = await supabase
      .storage.from(BUCKET).download(doc.original_file_path);
    if (dlErr) return res.status(500).json({ error: 'download failed', detail: dlErr.message });

    const inputBuffer = Buffer.from(await fileBlob.arrayBuffer());
    const pdfBuffer = await libreConvertAsync(inputBuffer, '.pdf', undefined);

    const pdfPath = doc.original_file_path.replace(/\.\w+$/, '') + '_converted.pdf';
    const { error: upErr } = await supabase.storage.from(BUCKET)
      .upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (upErr) return res.status(500).json({ error: 'upload failed', detail: upErr.message });

    await supabase.from('documents').update({ pdf_file_path: pdfPath }).eq('id', documentId);

    res.json({ pdfPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'conversion failed', detail: String(err) });
  }
});

// ------------------------------------------------------------
// POST /stamp-signature   { documentId, xPct, yPct, widthPct }
// Fetches the CALLER's own saved signature (they must be the assigned
// approver), embeds it into the working PDF at the chosen position, and
// stores the signed result. Marks the document as signed + logs the action.
// ------------------------------------------------------------
app.post('/stamp-signature', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    const { documentId, xPct, yPct, widthPct } = req.body;
    if (!documentId || xPct == null || yPct == null || widthPct == null) {
      return res.status(400).json({ error: 'documentId, xPct, yPct, widthPct required' });
    }

    const { data: doc, error: docErr } = await supabase
      .from('documents').select('*').eq('id', documentId).single();
    if (docErr || !doc) return res.status(404).json({ error: 'document not found' });
    if (doc.approver_id !== user.id) {
      return res.status(403).json({ error: 'only the assigned approver can sign this document' });
    }
    if (doc.requires_approval && doc.status !== 'approved_pending_signature') {
      return res.status(409).json({ error: 'document must be approved before it can be signed' });
    }

    const { data: sig, error: sigErr } = await supabase
      .from('signatures').select('*').eq('user_id', user.id).single();
    if (sigErr || !sig) return res.status(400).json({ error: 'you have no saved signature yet' });

    const sourcePath = doc.pdf_file_path || doc.original_file_path;
    const { data: pdfBlob, error: dlErr } = await supabase.storage.from(BUCKET).download(sourcePath);
    if (dlErr) return res.status(500).json({ error: 'could not load document', detail: dlErr.message });

    const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const base64 = sig.signature_png.split(',')[1] || sig.signature_png;
    const pngImage = await pdfDoc.embedPng(Buffer.from(base64, 'base64'));
    const page = pdfDoc.getPages()[0];
    const { width: pageW, height: pageH } = page.getSize();

    const sigWidthPt = pageW * (widthPct / 100);
    const aspect = pngImage.height / pngImage.width;
    const sigHeightPt = sigWidthPt * aspect;
    const xPt = (xPct / 100) * pageW - sigWidthPt / 2;
    const yPt = pageH - (yPct / 100) * pageH - sigHeightPt / 2;

    page.drawImage(pngImage, {
      x: Math.max(4, Math.min(pageW - sigWidthPt - 4, xPt)),
      y: Math.max(4, Math.min(pageH - sigHeightPt - 4, yPt)),
      width: sigWidthPt,
      height: sigHeightPt,
    });

    const signedBytes = await pdfDoc.save();
    const signedPath = sourcePath.replace(/\.pdf$/, '') + '_signed.pdf';
    const { error: upErr } = await supabase.storage.from(BUCKET)
      .upload(signedPath, signedBytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) return res.status(500).json({ error: 'upload failed', detail: upErr.message });

    await supabase.from('documents')
      .update({ signed_pdf_path: signedPath, status: 'signed', stamp_position: { xPct, yPct, widthPct } })
      .eq('id', documentId);

    await supabase.from('approval_log')
      .insert({ document_id: documentId, actor_id: user.id, action: 'signed' });

    res.json({ signedPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'signing failed', detail: String(err) });
  }
});

// ------------------------------------------------------------
// BOOTSTRAP — creates a hardcoded first admin account on startup if it
// doesn't exist yet, so there's no manual Supabase Dashboard step.
// CHANGE THE PASSWORD (or delete this whole block) once you've logged in —
// this is a convenience for initial setup only, not something to leave
// running long-term with a weak hardcoded password.
// ------------------------------------------------------------
const BOOTSTRAP_ADMIN_EMAIL = 'admin@kau.edu.sa';
const BOOTSTRAP_ADMIN_PASSWORD = '123456';

async function ensureBootstrapAdmin() {
  try {
    const { data: existing } = await supabase
      .from('profiles').select('id').eq('email', BOOTSTRAP_ADMIN_EMAIL).maybeSingle();
    if (existing) {
      console.log(`bootstrap admin already exists (${BOOTSTRAP_ADMIN_EMAIL}) — skipping`);
      return;
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email: BOOTSTRAP_ADMIN_EMAIL,
      password: BOOTSTRAP_ADMIN_PASSWORD,
      email_confirm: true, // skip email verification — this is the bootstrap account
      user_metadata: { full_name: 'إدارة النظام', role: 'admin' },
    });
    if (error) { console.error('bootstrap admin creation failed:', error.message); return; }
    console.log(`✓ bootstrap admin created: ${BOOTSTRAP_ADMIN_EMAIL} / ${BOOTSTRAP_ADMIN_PASSWORD}`);
    console.log('  change this password after your first login.');
  } catch (err) {
    console.error('bootstrap admin creation error:', err);
  }
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`kau-signing-backend listening on ${port}`);
  ensureBootstrapAdmin();
});
