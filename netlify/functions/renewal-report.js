// renewal-report.js — runs on the 20th of each month (schedule in netlify.toml).
// Emails each property's managers a list of permits that end NEXT month, so they
// can renew them in time. Card-paid permits are left out: Stripe renews those.
// Who gets it: the property's main manager, plus active team members with the
// Owner or Manager role. Leasing agents and view-only users don't.
// Nothing ending next month → no email.

const { sb } = require('./lib/parking');
const { sendRaw, logoHeader } = require('./send-email');

const SITE = process.env.SITE_URL || 'https://lothq.com';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ymd = d => d.toISOString().slice(0, 10);
const inList = ids => `(${[...new Set(ids)].map(encodeURIComponent).join(',')})`;

// Next calendar month, from the day this runs
function nextMonth(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1));
  return { start: ymd(start), end: ymd(end), name: start.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }), year: start.getUTCFullYear() };
}
const fmtDay = s => new Date(String(s).slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

async function build(now) {
  const m = nextMonth(now);
  const permits = await sb('GET', `permits?status=eq.active&stripe_subscription_id=is.null&end_date=gte.${m.start}&end_date=lt.${m.end}&select=id,property_id,plate,unit_number,permit_type,end_date,holder_id,holder_name,holder_email&order=end_date.asc&limit=5000`) || [];
  if (!permits.length) return { m, mail: [] };

  const propIds = permits.map(p => p.property_id);
  const props = await sb('GET', `properties?id=in.${inList(propIds)}&select=id,name,manager_id`) || [];
  const team = await sb('GET', `property_team?property_id=in.${inList(propIds)}&status=eq.active&role=in.(owner,manager)&select=property_id,user_id,email`) || [];
  const userIds = [...props.map(p => p.manager_id), ...team.map(t => t.user_id), ...permits.map(p => p.holder_id)].filter(Boolean);
  const users = userIds.length ? (await sb('GET', `users?id=in.${inList(userIds)}&select=id,email,full_name`) || []) : [];
  const U = Object.fromEntries(users.map(u => [u.id, u]));

  // Who receives each property's list (one email per person, grouped by property)
  const byPerson = {};
  const add = (email, name, propId) => {
    if (!email) return; const k = email.toLowerCase();
    (byPerson[k] = byPerson[k] || { email: k, name: name || '', props: new Set() }).props.add(propId);
  };
  for (const p of props) { const u = U[p.manager_id]; if (u) add(u.email, u.full_name, p.id); }
  for (const t of team) { const u = U[t.user_id]; add((u && u.email) || t.email, u && u.full_name, t.property_id); }

  const P = Object.fromEntries(props.map(p => [p.id, p]));
  const holder = p => p.holder_name || (U[p.holder_id] && (U[p.holder_id].full_name || U[p.holder_id].email)) || p.holder_email || '—';
  const mail = Object.values(byPerson).map(person => {
    const groups = [...person.props].map(id => ({ prop: P[id], rows: permits.filter(x => x.property_id === id) }))
      .filter(g => g.prop && g.rows.length).sort((a, b) => a.prop.name.localeCompare(b.prop.name));
    const count = groups.reduce((n, g) => n + g.rows.length, 0);
    return { to: person.email, first: (person.name || '').split(' ')[0], groups, count };
  }).filter(x => x.count);
  return { m, mail, holder };
}

function render({ first, groups, count }, m, holder) {
  const where = groups.length === 1 ? groups[0].prop.name : `${groups.length} properties`;
  const subject = `${count} permit${count === 1 ? '' : 's'} expire${count === 1 ? 's' : ''} in ${m.name} — ${where}`;
  const th = 'text-align:left;padding:8px 10px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#64748b;border-bottom:1px solid #e2e8f0;';
  const td = 'padding:8px 10px;font-size:13px;border-bottom:1px solid #f1f5f9;';
  const tables = groups.map(g => `
  <h3 style="margin:24px 0 8px;font-size:15px;">${esc(g.prop.name)} <span style="color:#64748b;font-weight:400;">· ${g.rows.length}</span></h3>
  <table style="width:100%;border-collapse:collapse;">
    <tr><th style="${th}">Plate</th><th style="${th}">Unit</th><th style="${th}">Holder</th><th style="${th}">Type</th><th style="${th}">Ends</th></tr>
    ${g.rows.map(r => `<tr><td style="${td}font-family:monospace;font-weight:700;">${esc(r.plate || '—')}</td><td style="${td}">${esc(r.unit_number || '—')}</td><td style="${td}">${esc(holder(r))}</td><td style="${td}">${esc(r.permit_type || '—')}</td><td style="${td}white-space:nowrap;">${esc(fmtDay(r.end_date))}</td></tr>`).join('')}
  </table>`).join('');
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:32px 16px;color:#0f172a;">
  ${logoHeader('#2859a8')}
  <h2 style="margin:0 0 8px;">Permits ending in ${esc(m.name)}</h2>
  <p style="color:#475569;margin:0 0 4px;">Hi ${esc(first || 'there')}, these permits run out in ${esc(m.name)}. Renew them in LotHQ before they expire, or enforcement will see them as expired.</p>
  ${tables}
  <a href="${SITE}/manager.html" style="display:block;background:#2859a8;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:9px;font-weight:700;font-size:15px;margin:28px 0 12px;">Open Permits in LotHQ →</a>
  <p style="color:#94a3b8;font-size:12px;">In LotHQ, open Permits and click Renew next to each one. Card-paid permits renew on their own and aren't listed.</p>
  <p style="color:#94a3b8;font-size:11px;text-align:center;margin-top:28px;">© ${new Date().getFullYear()} LotHQ · Provo, UT</p>
</body></html>`;
  const text = `Permits ending in ${m.name}\n\n` + groups.map(g => `${g.prop.name}\n` + g.rows.map(r => `  ${r.plate || '—'}  Unit ${r.unit_number || '—'}  ${holder(r)}  ${r.permit_type || ''}  ends ${fmtDay(r.end_date)}`).join('\n')).join('\n\n') + `\n\nRenew them in LotHQ: ${SITE}/manager.html`;
  return { subject, html, text };
}

exports.handler = async () => {
  let sent = 0;
  try {
    const { m, mail, holder } = await build(new Date());
    for (const x of mail) {
      try { await sendRaw({ to: x.to, ...render(x, m, holder) }); sent++; }
      catch (e) { console.error('renewal-report: send failed', x.to, e.message); }
    }
  } catch (e) { console.error('renewal-report: failed', e.message); }
  console.log(`renewal-report: ${sent} sent`);
  return { statusCode: 200 };
};
exports._test = { build, render, nextMonth };
