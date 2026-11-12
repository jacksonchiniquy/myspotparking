// training-video.js — hands signed-in enforcement officers short-lived links to
// their training videos. The videos sit in a PRIVATE Supabase Storage bucket
// ("training"), so nobody can open them without one of these links, and each
// link stops working after 2 hours.
// POST with the officer's sign-in token → { videos: [{ id, title, about, mins, url }] }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'training';
const LINK_SECONDS = 2 * 60 * 60;

// Which videos each kind of account may watch (file names inside the bucket)
const VIDEOS = {
  manager: [
    { id: 'M1', file: 'Manager/01-add-property-units-spots.mp4', title: 'Add a property, units and spots', about: 'Setting up a property, adding units (one at a time or in bulk) and parking spots.', mins: 3 },
    { id: 'M2', file: 'Manager/02-invite-tenants-move-outs.mp4', title: 'Invite tenants and handle move-outs', about: 'Sending unit invites, resending them, and closing out a unit when tenants leave.', mins: 2 },
    { id: 'M3', file: 'Manager/03-set-up-payouts.mp4', title: 'Set up payouts', about: 'Choosing who gets paid for a property and connecting the bank account through Stripe.', mins: 2 },
    { id: 'M4', file: 'Manager/04-pay-to-park-setup.mp4', title: 'Set up Pay to Park', about: 'Signs, QR stickers, rates and promo codes.', mins: 2 },
    { id: 'M5', file: 'Manager/05-refunds.mp4', title: 'Refund a Pay to Park payment', about: 'Full or partial refunds, and ending the driver’s time.', mins: 1 },
    { id: 'M6', file: 'Manager/06-discounts-price-changes.mp4', title: 'Discounts and price changes', about: 'Giving a tenant a discount, and changing prices for tenants already paying.', mins: 2 },
    { id: 'M7', file: 'Manager/07-guest-pass-settings.mp4', title: 'Guest pass settings', about: 'Pass types, limits and extra passes.', mins: 2 },
    { id: 'M8', file: 'Manager/08-lot-map.mp4', title: 'Build a map of your lot', about: 'Optional: drawing your lot and placing its spots.', mins: 2 },
    { id: 'M9', file: 'Manager/09-residents-and-permits.mp4', title: 'Residents and permits', about: 'For properties where residents have their own login: issuing, finding and deactivating permits.', mins: 2 },
    { id: 'M10', file: 'Manager/10-team-and-roles.mp4', title: 'Your team and roles', about: 'Inviting staff and choosing what each person can do.', mins: 1 },
  ],
  enforcer: [
    { id: 'E1', file: 'Enforcement/E1-sign-in-and-check-plates.mp4', title: 'Sign in and check a plate', about: 'Signing in, picking your property, and what green results mean.', mins: 2 },
    { id: 'E2', file: 'Enforcement/E2-possible-matches.mp4', title: 'When the plate is close, but not exact', about: 'Amber possible matches, and how to confirm or reject them.', mins: 1 },
    { id: 'E3', file: 'Enforcement/E3-tow-boot-ticket-and-records.mp4', title: 'No valid permit: tow, boot or ticket', about: 'Logging an action, the Violations Log and Patrol Summary.', mins: 2 },
  ],
};

const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });
  try {
    const jwt = String(event.headers?.authorization || event.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return reply(401, { error: 'Please sign in again.' });
    const ures = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${jwt}` } });
    if (!ures.ok) return reply(401, { error: 'Please sign in again.' });
    const user = await ures.json();
    const pres = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(user.id)}&select=role`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    const [me] = pres.ok ? await pres.json() : [];
    // LotHQ admins can see every set (to check them); everyone else only their own
    const role = me && me.role;
    const list = role === 'admin' ? Object.values(VIDEOS).flat() : (VIDEOS[role] || []);
    if (!list.length) return reply(403, { error: 'No training videos for this account.' });

    const videos = await Promise.all(list.map(async v => {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${v.file}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        body: JSON.stringify({ expiresIn: LINK_SECONDS }),
      });
      const d = r.ok ? await r.json() : null;
      const signed = d && (d.signedURL || d.signedUrl);
      return { id: v.id, title: v.title, about: v.about, mins: v.mins, url: signed ? `${SUPABASE_URL}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}` : null };
    }));
    return reply(200, { videos });
  } catch (e) {
    console.error('training-video', e.message);
    return reply(500, { error: 'Could not load the videos. Try again in a minute.' });
  }
};
