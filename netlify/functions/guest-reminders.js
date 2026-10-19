// guest-reminders.js — runs every 15 minutes (schedule in netlify.toml).
// Emails guests who asked for their pass by email about an hour before it ends.

const GP = require('./lib/guest-passes');
const { sb } = require('./lib/parking');
const { sendRaw, logoHeader } = require('./send-email');

exports.handler = async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 70 * 60e3).toISOString();
  let rows = [];
  try {
    rows = await sb('GET', `guest_passes?status=eq.active&guest_email=not.is.null&reminder_sent_at=is.null&ends_at=gt.${now.toISOString()}&ends_at=lte.${soon}&select=*&limit=200`);
  } catch (e) { console.error('guest-reminders: lookup failed', e.message); return { statusCode: 200 }; }
  let sent = 0;
  for (const g of rows) {
    try {
      // Claim it first so a slow run can't send twice
      const claimed = await sb('PATCH', `guest_passes?id=eq.${g.id}&reminder_sent_at=is.null`, { reminder_sent_at: now.toISOString() });
      if (!claimed || !claimed.length) continue;
      const [p] = await sb('GET', `properties?id=eq.${g.property_id}&select=name`);
      const ends = GP.fmtWhen(g.ends_at);
      await sendRaw({
        to: g.guest_email,
        subject: `Your guest parking pass ends at ${new Date(g.ends_at).toLocaleTimeString('en-US', { timeZone: GP.TZ, hour: 'numeric', minute: '2-digit' })}`,
        html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  ${logoHeader('#d97706')}
  <h2 style="margin:0 0 8px;">Your guest pass ends soon</h2>
  <p style="color:#475569;">The guest pass for <strong>${g.guest_plate}</strong> at <strong>${(p && p.name) || 'the property'}</strong> ends <strong>${ends}</strong>.
  Please move your vehicle by then, or ask your host for another pass.</p>
  <p style="color:#94a3b8;font-size:11px;text-align:center;margin-top:28px;">© ${new Date().getFullYear()} My Spot Parking Inc. · Provo, UT</p>
</body></html>`,
        text: `Your guest pass for ${g.guest_plate} at ${(p && p.name) || 'the property'} ends ${ends}. Please move your vehicle by then, or ask your host for another pass.`,
      });
      sent++;
    } catch (e) { console.error('guest-reminders: send failed', g.id, e.message); }
  }
  console.log(`guest-reminders: ${sent} sent`);
  return { statusCode: 200 };
};
