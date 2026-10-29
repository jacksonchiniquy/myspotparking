// team.js — several people on one property (Manager portal → property → Team,
// and Admin → Properties → Access).
//
// Signed in (Authorization: Bearer <login>), property Owner/Admin or LotHQ admin:
//   POST { action:'list',    propertyId }
//   POST { action:'invite',  propertyId, email, role }   role: owner|manager|leasing|viewer
//   POST { action:'setRole', propertyId, memberId, role }
//   POST { action:'remove',  propertyId, memberId }      also cancels an invite
//   POST { action:'resend',  propertyId, memberId }
// Signed in, any manager:
//   POST { action:'mine' }   → the properties I'm on and my role on each
// From the invite email (no sign-in; the emailed link proves the address):
//   POST { action:'lookup', token }
//   POST { action:'accept', token, name?, password? }   new people choose a password
//
// The property's main manager is always an Owner and can't be removed here.

const crypto = require('crypto');
const { sendRaw, logoHeader } = require('./send-email');
const { logActivity, userActor } = require('./lib/activity');
const { ROLES, roleOn, atLeast } = require('./lib/team');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SITE = process.env.SITE_URL || 'https://myspotparking.com';
const NOTIFY_TO = process.env.LEADS_NOTIFY_EMAIL || 'jackson@chiniquy.com';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_DAYS = 14;
const DOES = {
  owner: 'manage everything for this property, including payouts and the team',
  manager: 'manage permits, units, rates, guest passes and enforcement',
  leasing: 'manage units, tenant invites, vehicles and guest passes',
  viewer: 'see the property\'s permits, units and activity',
};

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
class UserError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }

async function sb(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, ...(method === 'GET' ? {} : { Prefer: 'return=representation' }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    if (/property_team/.test(text) && /42P01|does not exist|schema cache/.test(text)) throw new UserError('Team access isn\'t switched on yet. LotHQ needs to finish one setup step first.', 503);
    throw new Error(`Supabase ${method} ${path.split('?')[0]} ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}
const q = encodeURIComponent;
const hash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = u => (u && (u.full_name || u.name || u.email)) || '';

async function signedIn(event) {
  const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new UserError('Please sign in again.', 401);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
  if (!res.ok) throw new UserError('Please sign in again.', 401);
  const user = await res.json();
  const [me] = await sb('GET', `users?id=eq.${user.id}&select=*`);
  if (!me) throw new UserError('Please sign in again.', 401);
  return me;
}

// Caller must be an Owner on the property (main manager, team Owner) or a LotHQ admin
async function ownerOf(me, propertyId) {
  if (!UUID_RE.test(String(propertyId || ''))) throw new UserError('Property not found.', 404);
  const [property] = await sb('GET', `properties?id=eq.${propertyId}&select=id,name,manager_id`);
  if (!property) throw new UserError('Property not found.', 404);
  if (!atLeast(await roleOn(property, me), 'owner')) throw new UserError('Only the property\'s owner can manage its team.', 403);
  return property;
}

async function memberOf(property, memberId) {
  if (!UUID_RE.test(String(memberId || ''))) throw new UserError('Not found.', 404);
  const [m] = await sb('GET', `property_team?id=eq.${memberId}&property_id=eq.${property.id}&select=*`);
  if (!m) throw new UserError('That person isn\'t on this property.', 404);
  return m;
}

async function teamList(property) {
  const [main] = property.manager_id ? await sb('GET', `users?id=eq.${property.manager_id}&select=*`) : [];
  const rows = await sb('GET', `property_team?property_id=eq.${property.id}&select=*&order=invited_at`);
  const ids = rows.filter(r => r.user_id).map(r => r.user_id);
  let people = [];
  if (ids.length) people = await sb('GET', `users?id=in.(${ids.join(',')})&select=*`);
  const byId = Object.fromEntries(people.map(p => [p.id, p]));
  const list = rows.map(r => ({
    id: r.id, email: r.email, role: r.role, status: r.status,
    name: r.user_id ? nameOf(byId[r.user_id]) : null,
    invitedBy: r.invited_by_name || null, invitedAt: r.invited_at, acceptedAt: r.accepted_at,
    expired: r.status === 'invited' && r.expires_at && new Date(r.expires_at) < new Date(),
  }));
  return {
    property: { id: property.id, name: property.name },
    primary: main ? { id: main.id, name: nameOf(main), email: main.email } : null,
    members: list,
  };
}

async function sendInvite(property, row, token, inviterName) {
  const url = `${SITE}/team-accept.html?t=${token}`;
  const roleName = ROLES[row.role];
  await sendRaw({
    to: row.email,
    subject: `You're invited to ${property.name} on LotHQ`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 10px;">You're invited to ${esc(property.name)}</h2>
  <p style="color:#475569;line-height:1.6;margin:0 0 18px;">${esc(inviterName || 'LotHQ')} added you to <strong>${esc(property.name)}</strong> on LotHQ as a <strong>${esc(roleName)}</strong>. You'll be able to ${esc(DOES[row.role])}.</p>
  <p style="text-align:center;margin:0 0 20px;"><a href="${url}" style="display:inline-block;background:#2859a8;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;">Accept invite →</a></p>
  <p style="color:#94a3b8;font-size:12px;line-height:1.5;">Already have a LotHQ manager login with this email? Accept, then sign in as usual and the property appears in your dashboard. This invite works for ${INVITE_DAYS} days.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"><p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `${inviterName || 'LotHQ'} added you to ${property.name} on LotHQ as a ${roleName}.\n\nAccept the invite: ${url}\n\nThis invite works for ${INVITE_DAYS} days.`,
  });
}

function newToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, token_hash: hash(token), expires_at: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString() };
}

const actions = {
  async mine(body, event) {
    const me = await signedIn(event);
    const rows = await sb('GET', `property_team?user_id=eq.${me.id}&status=eq.active&select=property_id,role`).catch(() => []);
    return { roles: Object.fromEntries(rows.map(r => [r.property_id, r.role])) };
  },

  async list({ propertyId }, event) {
    const me = await signedIn(event);
    return teamList(await ownerOf(me, propertyId));
  },

  async invite({ propertyId, email, role }, event) {
    const me = await signedIn(event);
    const property = await ownerOf(me, propertyId);
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new UserError('Enter a valid email address.');
    if (!ROLES[role]) throw new UserError('Choose a role.');
    const [main] = property.manager_id ? await sb('GET', `users?id=eq.${property.manager_id}&select=email`) : [];
    if (main && String(main.email).toLowerCase() === email) throw new UserError('That person is already the property\'s main manager.');
    const [existingUser] = await sb('GET', `users?email=eq.${q(email)}&select=id,role&limit=1`);
    if (existingUser && existingUser.role === 'admin') throw new UserError('That\'s a LotHQ admin login; it already has access to every property.');
    if (existingUser && !['manager', 'manager_pending', 'manager_declined'].includes(existingUser.role)) {
      throw new UserError('That email is already used for a resident or enforcement login. Ask them for a different email for property work.');
    }
    const [row] = await sb('GET', `property_team?property_id=eq.${property.id}&email=eq.${q(email)}&select=*`);
    if (row && row.status === 'active') throw new UserError('That person is already on this property\'s team.');
    const t = newToken();
    const inviterName = nameOf(me) || 'LotHQ';
    const fields = { role, status: 'invited', invited_by: me.id, invited_by_name: me.role === 'admin' ? 'LotHQ' : inviterName, invited_at: new Date().toISOString(), token_hash: t.token_hash, expires_at: t.expires_at };
    const [saved] = row
      ? await sb('PATCH', `property_team?id=eq.${row.id}`, fields)
      : await sb('POST', 'property_team', { property_id: property.id, email, ...fields });
    await sendInvite(property, saved, t.token, fields.invited_by_name);
    await logActivity({ ...(await userActor(me.id)), actorRole: me.role, portal: me.role === 'admin' ? 'admin' : 'manager',
      action: 'team.invited', propertyId: property.id, target: email,
      summary: `Invited ${email} to ${property.name} as ${ROLES[role]}` });
    if (me.role !== 'admin') {
      try {
        await sendRaw({ to: NOTIFY_TO, subject: `${inviterName} invited ${email} to ${property.name}`,
          html: `<p>${esc(inviterName)} (${esc(me.email)}) invited <b>${esc(email)}</b> to <b>${esc(property.name)}</b> as <b>${esc(ROLES[role])}</b>.</p><p>See or change access in Admin → Properties → Access.</p>`,
          text: `${inviterName} (${me.email}) invited ${email} to ${property.name} as ${ROLES[role]}.` });
      } catch (e) { console.error('Admin invite notice failed:', e.message); }
    }
    return teamList(property);
  },

  async resend({ propertyId, memberId }, event) {
    const me = await signedIn(event);
    const property = await ownerOf(me, propertyId);
    const m = await memberOf(property, memberId);
    if (m.status !== 'invited') throw new UserError('They\'ve already accepted.');
    const t = newToken();
    const [saved] = await sb('PATCH', `property_team?id=eq.${m.id}`, { token_hash: t.token_hash, expires_at: t.expires_at, invited_at: new Date().toISOString() });
    await sendInvite(property, saved, t.token, m.invited_by_name);
    return teamList(property);
  },

  async setRole({ propertyId, memberId, role }, event) {
    const me = await signedIn(event);
    const property = await ownerOf(me, propertyId);
    if (!ROLES[role]) throw new UserError('Choose a role.');
    const m = await memberOf(property, memberId);
    if (m.user_id === me.id && role !== 'owner') throw new UserError('You can\'t lower your own role. Ask another owner or LotHQ.');
    await sb('PATCH', `property_team?id=eq.${m.id}`, { role });
    await logActivity({ ...(await userActor(me.id)), actorRole: me.role, portal: me.role === 'admin' ? 'admin' : 'manager',
      action: 'team.role_changed', propertyId: property.id, target: m.email,
      summary: `Changed ${m.email} on ${property.name} from ${ROLES[m.role]} to ${ROLES[role]}` });
    return teamList(property);
  },

  async remove({ propertyId, memberId }, event) {
    const me = await signedIn(event);
    const property = await ownerOf(me, propertyId);
    const m = await memberOf(property, memberId);
    if (m.user_id === me.id) throw new UserError('You can\'t remove yourself. Ask another owner or LotHQ.');
    await sb('DELETE', `property_team?id=eq.${m.id}`);
    await logActivity({ ...(await userActor(me.id)), actorRole: me.role, portal: me.role === 'admin' ? 'admin' : 'manager',
      action: m.status === 'invited' ? 'team.invite_cancelled' : 'team.removed', propertyId: property.id, target: m.email,
      summary: m.status === 'invited' ? `Cancelled the invite for ${m.email} to ${property.name}` : `Removed ${m.email} (${ROLES[m.role]}) from ${property.name}` });
    return teamList(property);
  },

  async lookup({ token }) {
    const m = await inviteFor(token);
    const [property] = await sb('GET', `properties?id=eq.${m.property_id}&select=name`);
    const [u] = await sb('GET', `users?email=eq.${q(m.email)}&select=id,role&limit=1`);
    return { email: m.email, role: m.role, roleName: ROLES[m.role], does: DOES[m.role], propertyName: property?.name || 'a property',
      invitedBy: m.invited_by_name || 'LotHQ', hasAccount: !!u };
  },

  async accept({ token, name, password }, event) {
    const m = await inviteFor(token);
    const [property] = await sb('GET', `properties?id=eq.${m.property_id}&select=id,name`);
    let [u] = await sb('GET', `users?email=eq.${q(m.email)}&select=id,role&limit=1`);
    if (u) {
      if (u.role === 'admin') throw new UserError('That\'s a LotHQ admin login; it already has access.');
      if (!['manager', 'manager_pending', 'manager_declined'].includes(u.role)) {
        throw new UserError('This email is used for a resident or enforcement login, so it can\'t join a property team. Ask for an invite to a different email.');
      }
      // The invite counts as approval
      if (u.role !== 'manager') await sb('PATCH', `users?id=eq.${u.id}`, { role: 'manager' });
    } else {
      name = String(name || '').trim().slice(0, 120);
      password = String(password || '');
      if (name.length < 2) throw new UserError('Enter your name.');
      if (password.length < 8) throw new UserError('Choose a password with at least 8 characters.');
      const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ email: m.email, password, email_confirm: true, user_metadata: { name, role: 'manager' } }),
      });
      const auth = await res.json().catch(() => ({}));
      if (!res.ok || !auth.id) {
        if (/registered|exists/i.test(JSON.stringify(auth))) throw new UserError('This email already has a LotHQ login. Contact LotHQ and we\'ll connect it.');
        throw new Error(`Create login failed: ${res.status} ${JSON.stringify(auth)}`);
      }
      [u] = await sb('POST', 'users', { id: auth.id, email: m.email, full_name: name, role: 'manager' });
    }
    await sb('PATCH', `property_team?id=eq.${m.id}`, { user_id: u.id, status: 'active', accepted_at: new Date().toISOString(), token_hash: null });
    await logActivity({ actorId: u.id, actorName: name || m.email, actorRole: 'manager', portal: 'manager',
      action: 'team.joined', propertyId: m.property_id, target: m.email,
      summary: `${m.email} accepted the invite to ${property?.name || 'a property'} as ${ROLES[m.role]}` });
    return { ok: true, email: m.email, propertyName: property?.name || '' };
  },
};

async function inviteFor(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw new UserError('This invite link isn\'t valid.', 404);
  const [m] = await sb('GET', `property_team?token_hash=eq.${hash(token)}&select=*`);
  if (!m || m.status !== 'invited') throw new UserError('This invite has already been used or was cancelled. Ask for a new one.', 404);
  if (m.expires_at && new Date(m.expires_at) < new Date()) throw new UserError('This invite has expired. Ask the person who invited you to resend it.', 410);
  return m;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  const fn = actions[body.action];
  if (!fn) return reply(400, { error: 'Unknown action' });
  try {
    return reply(200, await fn(body, event));
  } catch (e) {
    if (e instanceof UserError) return reply(e.code, { error: e.message });
    console.error('team error:', e);
    return reply(500, { error: 'Something went wrong. Please try again.' });
  }
};
