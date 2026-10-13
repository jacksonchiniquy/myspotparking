// Server-side entries for the admin Activity log (who did what, when).
// Never throws: a logging problem must never break the real action.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = () => ({ 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

async function logActivity(e) {
  try {
    const row = {
      actor_id: e.actorId || null,
      actor_name: e.actorName || null,
      actor_role: e.actorRole || 'system',
      portal: e.portal || 'system',
      action: e.action,
      summary: e.summary || null,
      property_id: e.propertyId || null,
      target: e.target || null,
      details: e.details || {},
      source: 'server',
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, { method: 'POST', headers: headers(), body: JSON.stringify(row) });
    if (!res.ok) console.error('activity log failed:', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('activity log failed:', err.message);
  }
}

// Name + role for a signed-in user id (managers, admins, officers)
async function userActor(userId) {
  if (!userId) return { actorId: null, actorName: null, actorRole: 'system' };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=*`, { headers: headers() });
    const [u] = res.ok ? await res.json() : [];
    return { actorId: userId, actorName: u?.full_name || u?.name || u?.email || null, actorRole: u?.role || null };
  } catch { return { actorId: userId, actorName: null, actorRole: null }; }
}

const money = cents => `$${(Number(cents || 0) / 100).toFixed(2)}`;

module.exports = { logActivity, userActor, money };
