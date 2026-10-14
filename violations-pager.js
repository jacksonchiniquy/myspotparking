// Violations list shown a page at a time, with search, sort and page size.
// Used by manager.html and admin.html.
//
//   vpShow('key', {
//     mount: 'element-id',            // where the toolbar, table and pager go
//     rows:  () => [...],             // all violations for this list
//     cols:  [{label, sort?}],        // table headers; sort = key in sorts
//     sorts: {date: v => ..., ...},   // how to sort by each column
//     text:  v => '...',              // what search looks through
//     row:   v => '<tr>\u2026</tr>',
//     empty: 'No violations logged.',
//   })
(function () {
  const S = {};
  const SIZES = [10, 25, 50, 100, 200];
  const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  window.VP_ACTION = { tow: 'Towed', boot: 'Booted', ticket: 'Ticketed' };
  window.vpAction = a => {
    const label = window.VP_ACTION[a];
    if (!label) return '<span style="color:#94a3b8">&mdash;</span>';
    return `<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:700;background:rgba(220,38,38,.08);color:#b91c1c;border:1px solid rgba(220,38,38,.2);">${label}</span>`;
  };

  window.vpShow = function (key, cfg) {
    const st = S[key] || (S[key] = { page: 1, size: 10, q: '', sort: 'date', dir: -1 });
    // Switching to a different property starts back at page 1 with no search
    const switched = st.resetKey !== undefined && cfg.resetKey !== st.resetKey;
    Object.assign(st, cfg);
    if (switched) {
      st.page = 1; st.q = '';
      const box = document.querySelector(`#${st.mount} [data-vp-q]`);
      if (box) box.value = '';
    }
    const mount = document.getElementById(st.mount);
    if (!mount) return;
    if (mount.dataset.vp !== key) {
      mount.dataset.vp = key;
      mount.innerHTML = `
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
          <input type="search" placeholder="Search plate or reason\u2026" data-vp-q
            style="flex:1;min-width:180px;padding:8px 12px;border:1px solid rgba(15,23,42,.15);border-radius:8px;font-size:13px;font-family:inherit;">
          <label style="font-size:12px;color:#64748b;display:flex;align-items:center;gap:6px;">Show
            <select data-vp-size style="padding:7px 8px;border:1px solid rgba(15,23,42,.15);border-radius:8px;font-size:13px;font-family:inherit;background:#fff;">
              ${SIZES.map(n => `<option value="${n}">${n}</option>`).join('')}
            </select></label>
        </div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr></tr></thead><tbody></tbody></table></div>
        <div data-vp-foot style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-top:12px;font-size:12px;color:#64748b;"></div>`;
      const q = mount.querySelector('[data-vp-q]');
      q.value = st.q;
      q.addEventListener('input', () => { st.q = q.value; st.page = 1; draw(key); });
      const size = mount.querySelector('[data-vp-size]');
      size.value = String(st.size);
      size.addEventListener('change', () => { st.size = Number(size.value) || 10; st.page = 1; draw(key); });
    }
    draw(key);
  };

  window.vpSort = function (key, col) {
    const st = S[key]; if (!st) return;
    if (st.sort === col) st.dir = -st.dir;
    else { st.sort = col; st.dir = col === 'date' ? -1 : 1; }
    st.page = 1; draw(key);
  };
  window.vpPage = function (key, delta) {
    const st = S[key]; if (!st) return;
    st.page += delta; draw(key);
  };

  function draw(key) {
    const st = S[key];
    const mount = document.getElementById(st.mount);
    if (!mount) return;

    // Headers (click to sort)
    mount.querySelector('thead tr').innerHTML = st.cols.map(c => {
      if (!c.sort) return `<th>${e(c.label)}</th>`;
      const on = st.sort === c.sort;
      return `<th style="cursor:pointer;user-select:none;white-space:nowrap;${on ? 'color:#2563eb;' : ''}" title="Sort by ${e(c.label)}" onclick="vpSort('${key}','${c.sort}')">${e(c.label)} ${on ? (st.dir < 0 ? '&#9660;' : '&#9650;') : '<span style="opacity:.35">&#8597;</span>'}</th>`;
    }).join('');

    // Search, sort, page
    let rows = st.rows() || [];
    const q = st.q.trim().toLowerCase();
    if (q) rows = rows.filter(v => String(st.text(v) || '').toLowerCase().includes(q));
    const get = st.sorts[st.sort] || st.sorts.date;
    rows = rows.slice().sort((a, b) => {
      const x = get(a), y = get(b);
      return (x < y ? -1 : x > y ? 1 : 0) * st.dir;
    });
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / st.size));
    st.page = Math.min(Math.max(1, st.page), pages);
    const start = (st.page - 1) * st.size;
    const shown = rows.slice(start, start + st.size);

    mount.querySelector('tbody').innerHTML = shown.map(st.row).join('') ||
      `<tr><td colspan="${st.cols.length}" style="text-align:center;padding:36px;color:#94a3b8">${q ? 'No violations match your search.' : e(st.empty || 'No violations logged.')}</td></tr>`;

    const btn = (label, delta, disabled) =>
      `<button class="btn btn-ghost btn-sm" ${disabled ? 'disabled style="opacity:.4;cursor:default"' : `onclick="vpPage('${key}',${delta})"`}>${label}</button>`;
    mount.querySelector('[data-vp-foot]').innerHTML = total
      ? `<div>Showing ${start + 1}&ndash;${start + shown.length} of ${total}${q ? ' matching' : ''}</div>
         <div style="display:flex;align-items:center;gap:8px;">${btn('&lsaquo; Prev', -1, st.page <= 1)}<span>Page ${st.page} of ${pages}</span>${btn('Next &rsaquo;', 1, st.page >= pages)}</div>`
      : '';
  }
})();
