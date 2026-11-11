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
      const [p] = await sb('GET', `properties?id=eq.${g.property_id}&select=*`);
      const I = require('./lib/i18n'), lang = I.pick(g.guest_lang), t = (en, v) => I.t(lang, en, v);
      const tz = GP.tzOf(p);
      const ends = GP.fmtWhen(g.ends_at, I.locale(lang), tz);
      const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const propName = (p && p.name) || t('the property');
      const line = t('The guest pass for {plate} at {property} ends {when}. Please move your vehicle by then, or ask your host for another pass.', { plate: '\u0001', property: '\u0002', when: '\u0003' });
      const lineHtml = esc(line).replace('\u0001', `<strong>${esc(g.guest_plate)}</strong>`).replace('\u0002', `<strong>${esc(propName)}</strong>`).replace('\u0003', `<strong>${esc(ends)}</strong>`);
      await sendRaw({
        to: g.guest_email,
        subject: t('Your guest parking pass ends at {time}', { time: new Date(g.ends_at).toLocaleTimeString(I.locale(lang), { timeZone: tz, hour: 'numeric', minute: '2-digit' }) }),
        html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  ${logoHeader('#d97706')}
  <h2 style="margin:0 0 8px;">${esc(t('Your guest pass ends soon'))}</h2>
  <p style="color:#475569;">${lineHtml}</p>
  <p style="color:#94a3b8;font-size:11px;text-align:center;margin-top:28px;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
        text: t('The guest pass for {plate} at {property} ends {when}. Please move your vehicle by then, or ask your host for another pass.', { plate: g.guest_plate, property: propName, when: ends }),
      });
      sent++;
    } catch (e) { console.error('guest-reminders: send failed', g.id, e.message); }
  }
  console.log(`guest-reminders: ${sent} sent`);
  return { statusCode: 200 };
};
