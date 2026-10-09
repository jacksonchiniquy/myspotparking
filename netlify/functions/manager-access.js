// manager-access.js — manager access requests (sign up → admin approves/declines)
//
// POST { action: 'requested', userId }
//   Called by manager.html right after someone submits the sign-up form.
//   Emails My Spot about the request. Only works for accounts that are
//   still 'manager_pending' and haven't been announced yet, so it can't be
//   used to send email to arbitrary people.
//
// POST { action: 'approved' | 'declined', userId }   (Authorization: Bearer <admin token>)
//   Called by admin.html. Verifies the caller is an admin, changes the
//   account's role, and emails the applicant.

const { sendRaw, logoHeader } = require('./send-email');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const NOTIFY_TO = process.env.LEADS_NOTIFY_EMAIL || 'jackson@chiniquy.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function sbHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...extra };
}

async function getUser(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${id}&select=*`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function patchUser(id, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${id}`, {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
}

// Who is calling? Returns their users row if the token is a valid admin session.
async function getAdmin(event) {
  const auth = event.headers?.authorization || event.headers?.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const authUser = await res.json();
  if (!authUser?.id) return null;
  const profile = await getUser(authUser.id);
  return profile?.role === 'admin' ? profile : null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function shell(color, inner) {
  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader(color)}${inner}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`;
}

function requestEmail(u) {
  const a = u.access_request || {};
  const rows = [
    ['Name', u.full_name], ['Email', u.email], ['Phone', u.phone || '—'], ['Company', u.company || '—'],
    ['Properties', a.properties || '—'], ['Approx. units', a.units || '—'],
    ['Parking types', (a.parking_types || []).join(', ') || '—'],
  ];
  const html = rows.map(([k, v]) => `<div style="margin-top:8px;"><strong>${k}:</strong> ${esc(v)}</div>`).join('')
    + (a.notes ? `<div style="margin-top:14px;"><strong>Notes:</strong><div style="white-space:pre-wrap;color:#475569;margin-top:4px;">${esc(a.notes)}</div></div>` : '');
  return {
    to: NOTIFY_TO,
    subject: `Manager access request — ${u.full_name}${u.company ? ' (' + u.company + ')' : ''}`,
    html: shell('#2859a8', `
  <h2 style="margin:0 0 16px;">New Manager Access Request</h2>
  <div style="background:#f4f7ff;border-radius:10px;padding:20px;margin-bottom:24px;">${html}</div>
  <a href="${SITE}/admin.html" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;">Review in Admin →</a>`),
    text: rows.map(([k, v]) => `${k}: ${v}`).join('\n') + (a.notes ? `\n\nNotes:\n${a.notes}` : '') + `\n\nReview: ${SITE}/admin.html`,
  };
}

function approvedEmail(u) {
  const first = (u.full_name || '').split(' ')[0] || 'there';
  return {
    to: u.email,
    subject: 'Your My Spot Parking manager access is approved',
    html: shell('#059669', `
  <h2 style="margin:0 0 8px;">You're approved, ${esc(first)}!</h2>
  <p style="color:#475569;margin:0 0 24px;">Your manager account is active. Sign in with the email and password you chose when you requested access.</p>
  <a href="${SITE}/manager.html" style="display:block;background:#059669;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin-bottom:16px;">Sign In to the Manager Portal →</a>
  <p style="color:#94a3b8;font-size:12px;">Our team will reach out to help set up your properties. Questions? Reply to sales@myspotparking.com.</p>`),
    text: `You're approved, ${first}! Sign in at ${SITE}/manager.html with the email and password you chose.`,
  };
}

function declinedEmail(u) {
  const first = (u.full_name || '').split(' ')[0] || 'there';
  return {
    to: u.email,
    subject: 'Your My Spot Parking access request',
    html: shell('#475569', `
  <h2 style="margin:0 0 8px;">Thanks for your interest, ${esc(first)}</h2>
  <p style="color:#475569;margin:0 0 16px;">We weren't able to activate a manager account from this request. A member of our team will be in touch if we need more information.</p>
  <p style="color:#475569;margin:0;">Questions? Email <a href="mailto:sales@myspotparking.com">sales@myspotparking.com</a> or call (801) 374-8487.</p>`),
    text: `Thanks for your interest, ${first}. We weren't able to activate a manager account from this request. Questions? sales@myspotparking.com or (801) 374-8487.`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const { action, userId } = body;
  if (!UUID_RE.test(String(userId || ''))) return reply(400, { error: 'Invalid user' });

  try {
    if (action === 'requested') {
      const u = await getUser(userId);
      // Only announce genuine, not-yet-announced pending requests
      if (!u || u.role !== 'manager_pending' || u.access_request?.notified_at) return reply(200, { ok: true });
      await sendRaw(requestEmail(u));
      await patchUser(userId, { access_request: { ...(u.access_request || {}), notified_at: new Date().toISOString() } });
      return reply(200, { ok: true });
    }

    if (action === 'approved' || action === 'declined') {
      const admin = await getAdmin(event);
      if (!admin) return reply(403, { error: 'Admins only' });
      const u = await getUser(userId);
      if (!u || !['manager_pending', 'manager_declined'].includes(u.role)) {
        return reply(400, { error: 'This account is not an open access request' });
      }
      const newRole = action === 'approved' ? 'manager' : 'manager_declined';
      await patchUser(userId, {
        role: newRole,
        access_request: { ...(u.access_request || {}), decided_at: new Date().toISOString(), decided_by: admin.email, decision: action },
      });
      let emailed = true;
      try { await sendRaw(action === 'approved' ? approvedEmail(u) : declinedEmail(u)); }
      catch (e) { emailed = false; console.error('manager-access email failed:', e); }
      return reply(200, { ok: true, emailed });
    }

    return reply(400, { error: 'Unknown action' });
  } catch (err) {
    console.error('manager-access error:', err);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
