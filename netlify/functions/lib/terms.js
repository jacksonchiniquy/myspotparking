// Parking terms: the wording people agree to when they add a plate.
// The wording is one admin-edited template with blanks like {property_name}
// that are filled in per property. Every agreement is recorded.
//
// If the parking terms tables don't exist yet (SQL not run), everything here
// quietly reports "not required" so the site keeps working as before.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PLACEMENTS = ['pay', 'guest', 'unit_vehicle', 'resident_vehicle', 'signup'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const headers = () => ({ 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });
async function get(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`terms ${path.split('?')[0]} ${res.status}`);
  return res.json();
}

let _cache = null; // { at, row }
async function latestTerms(fresh) {
  if (!fresh && _cache && Date.now() - _cache.at < 60e3) return _cache.row;
  const [row] = await get('parking_terms?select=version,title,body,placements,created_at&order=version.desc&limit=1');
  _cache = { at: Date.now(), row: row || null };
  return _cache.row;
}
function clearCache() { _cache = null; }

// Fill in the blanks for one property
async function fillFor(propertyId, template) {
  const [p] = await get(`properties?id=eq.${propertyId}&select=id,name,address,manager_id,terms_owner,terms_manager,terms_rules,terms_enabled`);
  if (!p) return null;
  let managerName = (p.terms_manager || '').trim();
  if (!managerName && p.manager_id) {
    try {
      const [m] = await get(`users?id=eq.${p.manager_id}&select=company,full_name`);
      managerName = (m && (m.company || '').trim()) || '';
    } catch {}
  }
  let enforcement = '';
  try {
    const rows = await get(`enforcement_assignments?property_id=eq.${p.id}&select=company`);
    const names = [...new Set((rows || []).map(r => (r.company || '').trim()).filter(Boolean))];
    enforcement = names.join(' or ');
  } catch {}
  const owner = (p.terms_owner || '').trim() || 'the property owner';
  const manager = managerName || 'the property manager';
  const values = {
    property_name: p.name || 'this property',
    property_address: (p.address || '').trim() || 'address on file',
    owner,
    manager,
    responsible_parties: owner === manager ? owner : `${owner} and ${manager}`,
    enforcement_company: enforcement || "the property's parking enforcement company",
  };
  const fill = s => String(s || '').replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
  return { property: p, values, title: fill(template.title), body: fill(template.body), rules: (p.terms_rules || '').trim() };
}

// What a page should show. → { required, version, title, body, rules, propertyName }
async function termsFor(propertyId, placement) {
  try {
    if (!UUID_RE.test(String(propertyId || '')) || !PLACEMENTS.includes(placement)) return { required: false };
    const t = await latestTerms();
    if (!t) return { required: false };
    const on = t.placements ? t.placements[placement] !== false : true;
    if (!on) return { required: false };
    const f = await fillFor(propertyId, t);
    if (!f || f.property.terms_enabled === false) return { required: false };
    return { required: true, version: t.version, title: f.title, body: f.body, rules: f.rules, propertyName: f.property.name };
  } catch (err) {
    console.error('terms lookup failed:', err.message);
    return { required: false };
  }
}

// Server check before saving: did they tick the box for the current version?
// Returns null if fine, or an error message to show.
async function checkAccepted(propertyId, placement, version) {
  const t = await termsFor(propertyId, placement);
  if (!t.required) return null;
  if (Number(version) === t.version) return null;
  if (version) return 'The parking terms were just updated. Please review them and check the box again.';
  return `Please read and agree to the Parking Terms for ${t.propertyName || 'this property'}.`;
}

// Save who agreed. Never throws.
async function recordAcceptance({ propertyId, placement, version, plate, acceptedBy, userId, event }) {
  try {
    const t = await termsFor(propertyId, placement);
    if (!t.required) return;
    const h = (event && event.headers) || {};
    const ip = String(h['x-nf-client-connection-ip'] || h['x-forwarded-for'] || '').split(',')[0].trim() || null;
    const row = {
      property_id: propertyId, terms_version: Number(version) || t.version, context: placement,
      plate: plate ? String(plate).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : null,
      accepted_by: acceptedBy ? String(acceptedBy).slice(0, 120) : null,
      user_id: UUID_RE.test(String(userId || '')) ? userId : null,
      ip, user_agent: String(h['user-agent'] || '').slice(0, 300) || null,
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/terms_acceptances`, { method: 'POST', headers: headers(), body: JSON.stringify(row) });
    if (!res.ok) console.error('terms acceptance save failed:', res.status, (await res.text()).slice(0, 200));
  } catch (err) {
    console.error('terms acceptance save failed:', err.message);
  }
}

module.exports = { PLACEMENTS, termsFor, checkAccepted, recordAcceptance, latestTerms, fillFor, clearCache };
