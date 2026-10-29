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
// LotHQ admin only (Admin → Managers → a manager's card):
//   POST { action:'person',          userId }    their properties and roles
//   POST { action:'setTempPassword', userId, password }   they must change it at sign-in
//   POST { action:'notify',          userId }    email a "set your password" link
//   POST { action:'loginSettings',   userId, mustChange, notify }   after creating a login
//   POST { action:'makeMain',        propertyId, userId }   hand a property to them
// Owners (top-bar Team page) and admins:
//   POST { action:'myTeam' }          everyone on the properties I own, by person
//   POST { action:'addDirect',  userId, propertyId, role }   someone already on my
//                                     team (any login, for admins) joins right away
//   POST { action:'inviteMany', email, role, propertyIds }   one invite, several properties
//   POST { action:'removeEverywhere', email }   off all the properties I own
// Signed in, anyone with a manager login:
//   POST { action:'changePassword', password }   also clears "must change password"
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


const listNames = a => a.length <= 1 ? (a[0] || '') : a.length === 2 ? `${a[0]} and ${a[1]}` : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
const actorOf = async me => ({ ...(await userActor(me.id)), actorRole: me.role, portal: me.role === 'admin' ? 'admin' : 'manager' });
function requireAdmin(me) { if (me.role !== 'admin') throw new UserError('Only LotHQ admins can do that.', 403); }

async function authAdmin(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    method, headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = out.msg || out.message || out.error_description || '';
    if (/password/i.test(msg)) throw new UserError(msg);
    throw new Error(`Auth ${method} ${path} ${res.status}: ${JSON.stringify(out)}`);
  }
  return out;
}

async function personRow(userId) {
  if (!UUID_RE.test(String(userId || ''))) throw new UserError('Person not found.', 404);
  const [u] = await sb('GET', `users?id=eq.${userId}&select=*`);
  if (!u) throw new UserError('Person not found.', 404);
  return u;
}

// Properties where `me` is an Owner (main manager, or a team Owner). Admins: all.
async function ownedProps(me) {
  if (me.role === 'admin') return sb('GET', 'properties?select=id,name,manager_id&order=name');
  const own = await sb('GET', `properties?manager_id=eq.${me.id}&select=id,name,manager_id`);
  const rows = await sb('GET', `property_team?user_id=eq.${me.id}&status=eq.active&role=eq.owner&select=property_id`);
  const extra = rows.map(r => r.property_id).filter(id => !own.some(p => p.id === id));
  const more = extra.length ? await sb('GET', `properties?id=in.(${extra.join(',')})&select=id,name,manager_id`) : [];
  return [...own, ...more].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// One person's properties: the ones they're main manager of plus team rows.
// `within` limits it to those property ids (an owner only sees their own).
async function personView(u, within) {
  const main = await sb('GET', `properties?manager_id=eq.${u.id}&select=id,name&order=name`);
  const rows = await sb('GET', `property_team?or=(user_id.eq.${u.id},email.eq.${q('"' + String(u.email || '').toLowerCase() + '"')})&select=*`);
  const ids = rows.map(r => r.property_id).filter(id => !main.some(p => p.id === id));
  const names = ids.length ? await sb('GET', `properties?id=in.(${ids.join(',')})&select=id,name`) : [];
  const nameOf_ = id => names.find(p => p.id === id)?.name || 'Property';
  let list = [
    ...main.map(p => ({ propertyId: p.id, name: p.name, role: 'owner', status: 'active', main: true })),
    ...rows.filter(r => !main.some(p => p.id === r.property_id)).map(r => ({
      propertyId: r.property_id, name: nameOf_(r.property_id), role: r.role, status: r.status, memberId: r.id,
      expired: r.status === 'invited' && r.expires_at && new Date(r.expires_at) < new Date(),
    })),
  ];
  if (within) list = list.filter(x => within.includes(x.propertyId));
  list.sort((a, b) => (b.main - a.main) || String(a.name).localeCompare(String(b.name)));
  return { id: u.id, name: nameOf(u), email: u.email, company: u.company || '', phone: u.phone || '',
    mustChange: !!u.must_change_password, properties: list };
}

async function addedEmail(u, props, role, byName) {
  const names = listNames(props.map(p => p.name));
  await sendRaw({
    to: u.email,
    subject: `You've been added to ${props.length === 1 ? props[0].name : props.length + ' properties'} on LotHQ`,
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 10px;">You've been added to ${esc(names)}</h2>
  <p style="color:#475569;line-height:1.6;margin:0 0 18px;">${esc(byName || 'LotHQ')} gave you access to <strong>${esc(names)}</strong> as a <strong>${esc(ROLES[role])}</strong>. Sign in with your usual LotHQ manager login and ${props.length === 1 ? 'it' : 'they'}'ll be in your dashboard.</p>
  <p style="text-align:center;margin:0 0 20px;"><a href="${SITE}/manager.html" style="display:inline-block;background:#2859a8;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;">Open the manager portal →</a></p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"><p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `${byName || 'LotHQ'} gave you access to ${names} on LotHQ as a ${ROLES[role]}. Sign in: ${SITE}/manager.html`,
  });
}

// "Set your password" link (Supabase recovery link → manager.html asks for a new password)
async function notifyLogin(u, byName) {
  const link = await authAdmin('POST', 'generate_link', { type: 'recovery', email: u.email, redirect_to: `${SITE}/manager.html` });
  const url = link.action_link || link.properties?.action_link;
  if (!url) throw new Error('No password link returned');
  await sendRaw({
    to: u.email,
    subject: 'Your LotHQ manager login is ready',
    html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;background:#ffffff;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 10px;">Your LotHQ login is ready</h2>
  <p style="color:#475569;line-height:1.6;margin:0 0 18px;">${esc(byName || 'LotHQ')} set up a LotHQ property manager login for <strong>${esc(u.email)}</strong>. Click below to choose your password and sign in.</p>
  <p style="text-align:center;margin:0 0 20px;"><a href="${url}" style="display:inline-block;background:#2859a8;color:#ffffff;text-decoration:none;padding:13px 28px;border-radius:9px;font-weight:700;">Choose my password →</a></p>
  <p style="color:#94a3b8;font-size:12px;line-height:1.5;">This link works once and expires soon. If it stops working, go to ${SITE}/manager.html and click "Forgot password".</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;"><p style="color:#94a3b8;font-size:11px;text-align:center;">© ${new Date().getFullYear()} LotHQ</p>
</body></html>`,
    text: `${byName || 'LotHQ'} set up a LotHQ manager login for ${u.email}. Choose your password: ${url}`,
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
    const props = await sb('GET', `properties?id=in.(${m.all.map(r => r.property_id).join(',')})&select=name&order=name`);
    const [u] = await sb('GET', `users?email=eq.${q(m.email)}&select=id,role&limit=1`);
    return { email: m.email, role: m.role, roleName: ROLES[m.role], does: DOES[m.role], propertyName: listNames(props.map(p => p.name)) || 'a property',
      invitedBy: m.invited_by_name || 'LotHQ', hasAccount: !!u };
  },

  async accept({ token, name, password }, event) {
    const m = await inviteFor(token);
    const props = await sb('GET', `properties?id=in.(${m.all.map(r => r.property_id).join(',')})&select=id,name&order=name`);
    const property = { name: listNames(props.map(p => p.name)) };
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
    await sb('PATCH', `property_team?token_hash=eq.${hash(token)}&status=eq.invited`, { user_id: u.id, status: 'active', accepted_at: new Date().toISOString(), token_hash: null });
    await logActivity({ actorId: u.id, actorName: name || m.email, actorRole: 'manager', portal: 'manager',
      action: 'team.joined', propertyId: m.property_id, target: m.email,
      summary: `${m.email} accepted the invite to ${property?.name || 'a property'} as ${ROLES[m.role]}` });
    return { ok: true, email: m.email, propertyName: property?.name || '' };
  },

  // ── Admin: a manager's card ──
  async person({ userId }, event) {
    const me = await signedIn(event); requireAdmin(me);
    const u = await personRow(userId);
    let lastSignIn = null;
    try { lastSignIn = (await authAdmin('GET', `users/${u.id}`)).last_sign_in_at || null; } catch (e) { console.error('last sign-in lookup:', e.message); }
    const all = await sb('GET', 'properties?select=id,name&order=name');
    return { ...(await personView(u)), lastSignIn, all };
  },

  async setTempPassword({ userId, password }, event) {
    const me = await signedIn(event); requireAdmin(me);
    const u = await personRow(userId);
    password = String(password || '');
    if (password.length < 8) throw new UserError('Use at least 8 characters.');
    await authAdmin('PUT', `users/${u.id}`, { password });
    await sb('PATCH', `users?id=eq.${u.id}`, { must_change_password: true });
    await logActivity({ ...(await actorOf(me)), action: 'team.password_set', target: u.email,
      summary: `Set a temporary password for ${u.email} (they must change it at sign-in)` });
    return { ok: true };
  },

  async notify({ userId }, event) {
    const me = await signedIn(event); requireAdmin(me);
    const u = await personRow(userId);
    await notifyLogin(u, 'LotHQ');
    await logActivity({ ...(await actorOf(me)), action: 'team.notified', target: u.email, summary: `Emailed ${u.email} a link to set their password` });
    return { ok: true, sentTo: u.email };
  },

  async loginSettings({ userId, mustChange, notify }, event) {
    const me = await signedIn(event); requireAdmin(me);
    const u = await personRow(userId);
    if (mustChange) await sb('PATCH', `users?id=eq.${u.id}`, { must_change_password: true });
    if (notify) {
      await notifyLogin(u, 'LotHQ');
      await logActivity({ ...(await actorOf(me)), action: 'team.notified', target: u.email, summary: `Emailed ${u.email} a link to set their password` });
    }
    return { ok: true };
  },

  async makeMain({ propertyId, userId }, event) {
    const me = await signedIn(event); requireAdmin(me);
    const property = await ownerOf(me, propertyId);
    const u = await personRow(userId);
    if (u.role !== 'manager') throw new UserError('Only a manager login can run a property.');
    if (property.manager_id === u.id) return personView(u);
    const old = property.manager_id ? await personRow(property.manager_id).catch(() => null) : null;
    // The new main manager no longer needs a team row; the old one stays on as Manager
    await sb('DELETE', `property_team?property_id=eq.${property.id}&or=(user_id.eq.${u.id},email.eq.${q('"' + String(u.email).toLowerCase() + '"')})`);
    await sb('PATCH', `properties?id=eq.${property.id}`, { manager_id: u.id });
    if (old && old.role === 'manager') {
      const em = String(old.email || '').toLowerCase();
      const [row] = await sb('GET', `property_team?property_id=eq.${property.id}&email=eq.${q(em)}&select=id`);
      const fields = { user_id: old.id, role: 'manager', status: 'active', accepted_at: new Date().toISOString(), token_hash: null, invited_by: me.id, invited_by_name: 'LotHQ' };
      if (row) await sb('PATCH', `property_team?id=eq.${row.id}`, fields);
      else await sb('POST', 'property_team', { property_id: property.id, email: em, ...fields });
    }
    await logActivity({ ...(await actorOf(me)), action: 'team.main_changed', propertyId: property.id, target: u.email,
      summary: `Made ${nameOf(u)} the main manager of ${property.name}${old ? ` (${nameOf(old)} stays on as Manager)` : ''}` });
    return personView(u);
  },

  // ── Owners' Team page (admins can use these too) ──
  async myTeam(body, event) {
    const me = await signedIn(event);
    if (me.role !== 'manager' && me.role !== 'admin') throw new UserError('Please sign in again.', 401);
    const props = await ownedProps(me);
    if (!props.length) return { properties: [], people: [] };
    const ids = props.map(p => p.id);
    const rows = await sb('GET', `property_team?property_id=in.(${ids.join(',')})&select=*`);
    const mainIds = [...new Set(props.map(p => p.manager_id).filter(id => id && id !== me.id))];
    const userIds = [...new Set([...rows.filter(r => r.user_id).map(r => r.user_id), ...mainIds])];
    const users = userIds.length ? await sb('GET', `users?id=in.(${userIds.join(',')})&select=*`) : [];
    const byId = Object.fromEntries(users.map(u => [u.id, u]));
    const people = {};
    const person = (key, u, email) => people[key] || (people[key] = { key, userId: u?.id || null, name: u ? nameOf(u) : null, email: u?.email || email, properties: [] });
    props.forEach(p => {
      if (p.manager_id && p.manager_id !== me.id && byId[p.manager_id]) {
        const u = byId[p.manager_id];
        person(String(u.email).toLowerCase(), u).properties.push({ propertyId: p.id, name: p.name, role: 'owner', status: 'active', main: true });
      }
    });
    rows.forEach(r => {
      if (r.user_id === me.id) return;
      const u = r.user_id ? byId[r.user_id] : null;
      const p = props.find(x => x.id === r.property_id);
      person(String(r.email).toLowerCase(), u, r.email).properties.push({ propertyId: r.property_id, name: p?.name || 'Property', role: r.role, status: r.status, memberId: r.id,
        expired: r.status === 'invited' && r.expires_at && new Date(r.expires_at) < new Date(), invitedAt: r.invited_at });
    });
    const list = Object.values(people).map(x => ({ ...x,
      status: x.properties.some(p => p.status === 'active') ? 'active' : 'invited',
      properties: x.properties.sort((a, b) => (b.main - a.main) || String(a.name).localeCompare(String(b.name))) }))
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
    return { properties: props.map(p => ({ id: p.id, name: p.name })), people: list };
  },

  async addDirect({ userId, propertyId, role }, event) {
    const me = await signedIn(event);
    const property = await ownerOf(me, propertyId);
    if (!ROLES[role]) throw new UserError('Choose a role.');
    const u = await personRow(userId);
    if (u.role !== 'manager') throw new UserError('That login isn\'t a property manager login.');
    if (property.manager_id === u.id) throw new UserError('They\'re already the main manager of that property.');
    let within = null;
    if (me.role !== 'admin') {
      // Owners can add, without an invite, people who already work on one of their properties
      const mine = (await ownedProps(me)).map(p => p.id);
      const theirs = await sb('GET', `property_team?user_id=eq.${u.id}&status=eq.active&property_id=in.(${mine.join(',')})&select=id`);
      const mainOfMine = (await sb('GET', `properties?manager_id=eq.${u.id}&id=in.(${mine.join(',')})&select=id`)).length;
      if (!theirs.length && !mainOfMine) throw new UserError('Send them an invite first. Once they accept, you can add them to more properties instantly.');
      within = mine;
    }
    const em = String(u.email || '').toLowerCase();
    const [row] = await sb('GET', `property_team?property_id=eq.${property.id}&email=eq.${q(em)}&select=*`);
    if (row && row.status === 'active') throw new UserError('They\'re already on that property.');
    const byName = me.role === 'admin' ? 'LotHQ' : (nameOf(me) || 'LotHQ');
    const fields = { user_id: u.id, role, status: 'active', invited_by: me.id, invited_by_name: byName, invited_at: new Date().toISOString(), accepted_at: new Date().toISOString(), token_hash: null };
    if (row) await sb('PATCH', `property_team?id=eq.${row.id}`, fields);
    else await sb('POST', 'property_team', { property_id: property.id, email: em, ...fields });
    try { await addedEmail(u, [property], role, byName); } catch (e) { console.error('Added email failed:', e.message); }
    await logActivity({ ...(await actorOf(me)), action: 'team.added', propertyId: property.id, target: u.email,
      summary: `Added ${nameOf(u)} to ${property.name} as ${ROLES[role]}` });
    if (me.role !== 'admin') {
      try { await sendRaw({ to: NOTIFY_TO, subject: `${byName} added ${u.email} to ${property.name}`,
        html: `<p>${esc(byName)} (${esc(me.email)}) added <b>${esc(u.email)}</b> to <b>${esc(property.name)}</b> as <b>${esc(ROLES[role])}</b>.</p>`,
        text: `${byName} (${me.email}) added ${u.email} to ${property.name} as ${ROLES[role]}.` }); } catch (e) { console.error('Admin notice failed:', e.message); }
    }
    return personView(u, within);
  },

  async inviteMany({ email, role, propertyIds }, event) {
    const me = await signedIn(event);
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new UserError('Enter a valid email address.');
    if (!ROLES[role]) throw new UserError('Choose a role.');
    const ids = [...new Set((Array.isArray(propertyIds) ? propertyIds : []).map(String))];
    if (!ids.length) throw new UserError('Pick at least one property.');
    if (ids.length > 200) throw new UserError('Too many properties at once.');
    const props = [];
    for (const id of ids) props.push(await ownerOf(me, id));
    const [existingUser] = await sb('GET', `users?email=eq.${q(email)}&select=*&limit=1`);
    if (existingUser && existingUser.role === 'admin') throw new UserError('That\'s a LotHQ admin login; it already has access to every property.');
    if (existingUser && !['manager', 'manager_pending', 'manager_declined'].includes(existingUser.role)) {
      throw new UserError('That email is already used for a resident or enforcement login. Ask them for a different email for property work.');
    }
    const byName = me.role === 'admin' ? 'LotHQ' : (nameOf(me) || 'LotHQ');
    const todo = [];
    for (const p of props) {
      if (existingUser && p.manager_id === existingUser.id) continue; // already main manager
      const [row] = await sb('GET', `property_team?property_id=eq.${p.id}&email=eq.${q(email)}&select=*`);
      if (row && row.status === 'active') continue;
      todo.push({ p, row });
    }
    if (!todo.length) throw new UserError('They already have access to every property you picked.');
    // Someone with a manager login who already works on one of my properties joins right away
    let direct = false;
    if (existingUser && existingUser.role === 'manager') {
      if (me.role === 'admin') direct = true;
      else {
        const mine = (await ownedProps(me)).map(p => p.id);
        direct = (await sb('GET', `property_team?user_id=eq.${existingUser.id}&status=eq.active&property_id=in.(${mine.join(',')})&select=id`)).length > 0
          || (await sb('GET', `properties?manager_id=eq.${existingUser.id}&id=in.(${mine.join(',')})&select=id`)).length > 0;
      }
    }
    const now = new Date().toISOString();
    const t = direct ? null : newToken();
    for (const { p, row } of todo) {
      const fields = direct
        ? { user_id: existingUser.id, role, status: 'active', invited_by: me.id, invited_by_name: byName, invited_at: now, accepted_at: now, token_hash: null }
        : { role, status: 'invited', invited_by: me.id, invited_by_name: byName, invited_at: now, token_hash: t.token_hash, expires_at: t.expires_at };
      if (row) await sb('PATCH', `property_team?id=eq.${row.id}`, fields);
      else await sb('POST', 'property_team', { property_id: p.id, email, ...fields });
    }
    const list = todo.map(x => x.p);
    const names = listNames(list.map(p => p.name));
    if (direct) { try { await addedEmail(existingUser, list, role, byName); } catch (e) { console.error('Added email failed:', e.message); } }
    else await sendInvite({ name: names }, { email, role }, t.token, byName);
    await logActivity({ ...(await actorOf(me)), action: direct ? 'team.added' : 'team.invited', propertyId: list.length === 1 ? list[0].id : null, target: email,
      summary: `${direct ? 'Added' : 'Invited'} ${email} to ${names} as ${ROLES[role]}` });
    if (me.role !== 'admin') {
      try { await sendRaw({ to: NOTIFY_TO, subject: `${byName} ${direct ? 'added' : 'invited'} ${email} (${list.length} propert${list.length === 1 ? 'y' : 'ies'})`,
        html: `<p>${esc(byName)} (${esc(me.email)}) ${direct ? 'added' : 'invited'} <b>${esc(email)}</b> to <b>${esc(names)}</b> as <b>${esc(ROLES[role])}</b>.</p><p>See or change access in Admin → Managers or Properties → Access.</p>`,
        text: `${byName} (${me.email}) ${direct ? 'added' : 'invited'} ${email} to ${names} as ${ROLES[role]}.` }); } catch (e) { console.error('Admin notice failed:', e.message); }
    }
    return { ok: true, direct, count: list.length };
  },

  async removeEverywhere({ email }, event) {
    const me = await signedIn(event);
    email = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new UserError('Person not found.', 404);
    if (email === String(me.email || '').toLowerCase()) throw new UserError('You can\'t remove yourself. Ask another owner or LotHQ.');
    const props = await ownedProps(me);
    if (!props.length) throw new UserError('Only a property\'s owner can manage its team.', 403);
    const rows = await sb('GET', `property_team?email=eq.${q(email)}&property_id=in.(${props.map(p => p.id).join(',')})&select=id,property_id`);
    if (!rows.length) return { ok: true, removed: 0 };
    await sb('DELETE', `property_team?id=in.(${rows.map(r => r.id).join(',')})`);
    const names = listNames(rows.map(r => props.find(p => p.id === r.property_id)?.name || 'a property'));
    await logActivity({ ...(await actorOf(me)), action: 'team.removed', target: email, summary: `Removed ${email} from ${names}` });
    return { ok: true, removed: rows.length };
  },

  // ── Anyone signed in: choose a new password (clears "must change password") ──
  async changePassword({ password }, event) {
    const me = await signedIn(event);
    password = String(password || '');
    if (password.length < 8) throw new UserError('Choose a password with at least 8 characters.');
    await authAdmin('PUT', `users/${me.id}`, { password });
    if (me.must_change_password) await sb('PATCH', `users?id=eq.${me.id}`, { must_change_password: false });
    await logActivity({ ...(await actorOf(me)), action: 'auth.password_changed', target: me.email, summary: 'Chose a new password' });
    return { ok: true };
  },
};

async function inviteFor(token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) throw new UserError('This invite link isn\'t valid.', 404);
  const rows = await sb('GET', `property_team?token_hash=eq.${hash(token)}&status=eq.invited&select=*`);
  const m = rows[0];
  if (m) m.all = rows;
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
