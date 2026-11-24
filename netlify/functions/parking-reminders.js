// parking-reminders.js — runs every 5 minutes (schedule in netlify.toml).
// Emails Pay to Park drivers who gave an email about 15 minutes before their
// parking ends. Where the property offers Add time, the email has an Add time button.
// Skips sessions that already have time added, and very short sessions.

const P = require('./lib/parking');
const { sb, latestActive, SITE, fmtTime, esc } = P;
const { sendRaw, logoHeader } = require('./send-email');
const I = require('./lib/i18n');

exports.handler = async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 16 * 60e3).toISOString();
  let rows = [];
  try {
    rows = await sb('GET', `parking_sessions?status=eq.active&email=not.is.null&reminder_sent_at=is.null&expires_at=gt.${now.toISOString()}&expires_at=lte.${soon}&duration_minutes=gte.30&select=*&limit=200`);
  } catch (e) { console.error('parking-reminders: lookup failed (has supabase-add-time.sql been run?)', e.message); return { statusCode: 200 }; }
  let sent = 0;
  for (const s of rows) {
    try {
      // Claim it first so a slow run can't send twice
      const claimed = await sb('PATCH', `parking_sessions?id=eq.${s.id}&reminder_sent_at=is.null`, { reminder_sent_at: now.toISOString() });
      if (!claimed || !claimed.length) continue;
      // Time already added (a later session for the same plate): no reminder needed
      const later = await latestActive(s.property_id, s.plate, s.id);
      if (later && new Date(later.expires_at) > new Date(s.expires_at)) continue;
      const [p] = await sb('GET', `properties?id=eq.${s.property_id}&select=*`);
      const lang = I.pick(s.lang), t = (en, v) => I.t(lang, en, v);
      const tz = (p && p.timezone) || 'America/Denver';
      const name = (p && p.name) || t('the property');
      const time = new Date(s.expires_at).toLocaleTimeString(I.locale(lang), { timeZone: tz, hour: 'numeric', minute: '2-digit' });
      const where = s.area ? `${name} (${s.area})` : name;
      const line = t('Your Pay to Park session for {plate} at {property} ends at {time}.', { plate: s.plate, property: where, time });
      const addTime = p && p.add_time_enabled;
      const after = addTime ? t('Need more time? Add it before then and it starts when this session ends.')
        : t('Please move your vehicle by then, or start a new session.');
      await sendRaw({
        to: s.email,
        subject: t('Your parking at {property} ends at {time}', { property: name, time }),
        html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  ${logoHeader('#1a6fff')}
  <h2 style="margin:0 0 8px;">${esc(t('Your parking ends soon'))}</h2>
  <p style="color:#475569;margin:0 0 12px;">${esc(line)}</p>
  <p style="color:#475569;margin:0 0 20px;">${esc(after)}</p>
  ${addTime ? `<p style="margin:0 0 20px;"><a href="${SITE}/pay.html?extend=${s.id}" style="display:inline-block;background:#1a6fff;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">${esc(t('Add time'))}</a></p>` : ''}
  <p style="color:#94a3b8;font-size:12px;">${esc(t('Expires'))}: ${esc(fmtTime(s.expires_at, lang, tz))}</p>
  <p style="color:#94a3b8;font-size:11px;text-align:center;margin-top:28px;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`,
        text: line + '\n\n' + after + (addTime ? `\n\n${t('Add time')}: ${SITE}/pay.html?extend=${s.id}` : ''),
      });
      sent++;
    } catch (e) { console.error('parking-reminders: send failed', s.id, e.message); }
  }
  console.log(`parking-reminders: ${sent} sent`);
  return { statusCode: 200 };
};
