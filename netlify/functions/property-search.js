// property-search.js — "type your property" box on the unit login page.
// Returns at most 8 matching properties (only ones with units), never the
// whole list, so the public page can't download every customer.
//
// POST { q }   → { results: [{ id, name, place }] }   (q = 2+ characters)
// POST { id }  → { result: { id, name, place } }       (pre-filled sign-in links)

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

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'Invalid request' }); }
  try {
    if (body.id) {
      if (!UUID_RE.test(String(body.id))) return reply(200, { result: null });
      const [p] = await sb(`properties?id=eq.${body.id}&select=id,name,address`);
      return reply(200, { result: p ? { id: p.id, name: p.name, place: place(p.address) } : null });
    }
    const q = String(body.q || '').replace(/[^\p{L}\p{N}\s'&.-]/gu, ' ').trim().slice(0, 60);
    if (q.length < 2) return reply(200, { results: [] });
    const props = await sb(`properties?name=ilike.${encodeURIComponent('*' + q + '*')}&select=id,name,address&order=name&limit=25`);
    if (!props.length) return reply(200, { results: [] });
    // Only properties that actually use unit parking
    const withUnits = await sb(`property_units?property_id=in.(${props.map(p => p.id).join(',')})&select=property_id&limit=1000`);
    const ok = new Set(withUnits.map(r => r.property_id));
    const results = props.filter(p => ok.has(p.id)).slice(0, 8).map(p => ({ id: p.id, name: p.name, place: place(p.address) }));
    return reply(200, { results });
  } catch (err) {
    console.error('property-search error:', err);
    return reply(500, { error: 'Search is unavailable right now. Please try again.' });
  }
};
