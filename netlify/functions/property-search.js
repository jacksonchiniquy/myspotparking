// property-search.js — "type your property" box on LotHQ Login and the sign-in pages.
// Returns at most 8 matching properties, never the whole list, so the public
// page can't download every customer.
//
// POST { q }   → { results: [{ id, name, place, login, word }] }   (q = 2+ characters)
// POST { id }  → { result: { id, name, place, login, word } }       (pre-filled sign-in links)
//
// login: 'unit'  → people sign in with their unit/suite number (property has units)
//        'email' → people sign in with email (permits belong to people)
//        'none'  → self-managed property, no online accounts
// word:  what that property calls a space ("Unit", "Suite", "Bay"…)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function reply(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) };
}
async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}
// "2445 W 1680 N, Provo, UT 84601" → "Provo, UT"; otherwise the address as typed
function place(address) {
  const a = String(address || '').trim();
  const m = a.match(/,\s*([^,]+?),?\s+([A-Z]{2})\b/);
  return m ? `${m[1].trim()}, ${m[2]}` : a;
}

async function describe(p) {
  let login = 'email';
  if (p.property_type === 'self') login = 'none';
  const units = await sb(`property_units?property_id=eq.${p.id}&select=id&limit=1`).catch(() => []);
  if (Array.isArray(units) && units.length) login = 'unit';
  return { id: p.id, name: p.name, place: place(p.address), login, word: (p.space_word || 'Unit').trim() || 'Unit' };
}
// Works before and after supabase-space-word.sql has been run
async function findProps(filter) {
  try { return await sb(`properties?${filter}&select=id,name,address,property_type,space_word`); }
  catch (e) { return sb(`properties?${filter}&select=id,name,address,property_type`); }
}

exports.handler = async (event) => {
  let body;
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  try {
    if (body.id) {
      if (!UUID_RE.test(String(body.id))) return reply(200, { result: null });
      const [p] = await findProps(`id=eq.${body.id}`);
      return reply(200, { result: p ? await describe(p) : null });
    }
    const q = String(body.q || '').replace(/[^\p{L}\p{N}\s'&.-]/gu, ' ').trim().slice(0, 60);
    if (q.length < 2) return reply(200, { results: [] });
    const props = await findProps(`name=ilike.${encodeURIComponent('*' + q + '*')}&order=name&limit=8`);
    const results = await Promise.all(props.map(describe));
    return reply(200, { results });
  } catch (err) {
    console.error('property-search error:', err);
    return reply(500, { error: 'Search is unavailable right now. Please try again.' });
  }
};
