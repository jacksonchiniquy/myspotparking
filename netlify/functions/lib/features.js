// Which parts of LotHQ a property uses. LotHQ admins set these per property
// (Admin → Properties → Edit → Features). A property with no settings saved
// (created before features existed) keeps everything on.
const FEATURES = {
  units: 'Units & tenant invites',
  lot_map: 'Lot map',
  pay_to_park: 'Pay to Park',
  guest_passes: 'Guest passes',
  payouts: 'Payouts (paid parking)',
  team: 'Team',
  tenant_history: 'Tenant history',
  enforcement: 'Enforcement / violations',
};
const NEW_PROPERTY = { units: true, lot_map: false, pay_to_park: false, guest_passes: false, payouts: false, team: true, tenant_history: true, enforcement: true };

function on(property, key) {
  const f = property && property.features;
  if (!f || typeof f !== 'object') return true;
  return f[key] !== false;
}
function clean(input) {
  const out = {};
  Object.keys(FEATURES).forEach(k => { out[k] = !!(input && input[k]); });
  return out;
}
module.exports = { FEATURES, NEW_PROPERTY, on, clean };
