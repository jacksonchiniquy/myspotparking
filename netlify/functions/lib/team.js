// Who can work on a property: its main manager (always an Owner) plus anyone
// on its team (property_team). Roles, most to least access:
//   owner    everything, incl. payouts and the team
//   manager  everything except payouts and the team
//   leasing  units, tenant invites, vehicles, guest passes
//   viewer   sees everything, changes nothing

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ROLES = { owner: 'Owner / Admin', manager: 'Manager', leasing: 'Leasing agent', viewer: 'View only' };
const RANK = { viewer: 1, leasing: 2, manager: 3, owner: 4 };

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) {
    const t = await res.text();
    if (/property_team|42P01/.test(t)) return []; // before the team database step
    throw new Error(`Supabase GET ${path.split('?')[0]} ${res.status}: ${t}`);
  }
  return res.json();
}

// The signed-in user's role on a property, or null.
// `property` needs id and manager_id. `me` is the users row (needs id, role).
async function roleOn(property, me) {
  if (!property || !me) return null;
  if (me.role === 'admin') return 'owner';
  if (me.role !== 'manager') return null;
  if (property.manager_id === me.id) return 'owner';
  const [row] = await sbGet(`property_team?property_id=eq.${property.id}&user_id=eq.${me.id}&status=eq.active&select=role&limit=1`);
  return row ? row.role : null;
}

// True when `role` is at least `min`
const atLeast = (role, min) => !!role && RANK[role] >= RANK[min];

module.exports = { ROLES, RANK, roleOn, atLeast };
