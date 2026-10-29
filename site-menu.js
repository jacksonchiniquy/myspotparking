// Phone menu (☰) for pages with the homepage top bar (index.html, help.html).
// Copies the top-bar links into a drop-down panel, so the links stay in one place.
(function () {
  var nav = document.querySelector('nav.nav');
  var links = nav && nav.querySelector('.nav-links');
  if (!nav || !links) return;

  var css = document.createElement('style');
  css.textContent =
    '.nav-burger{display:none;width:40px;height:40px;border:1px solid var(--border,#e2e8f0);border-radius:8px;background:#fff;cursor:pointer;align-items:center;justify-content:center;flex-shrink:0;}' +
    '.nav-burger svg{display:block;}' +
    '.nav-panel{display:none;position:fixed;top:64px;left:0;right:0;z-index:499;background:#fff;border-bottom:1px solid var(--border,#e2e8f0);box-shadow:0 12px 28px rgba(11,18,32,.12);padding:10px 14px 16px;}' +
    '.nav-panel.open{display:block;}' +
    '.nav-panel a{display:block;padding:13px 12px;font-size:16px;font-weight:500;color:var(--ink,#0B1220);text-decoration:none;border-radius:8px;font-family:Inter,sans-serif;}' +
    '.nav-panel a:hover,.nav-panel a:focus-visible{background:var(--blue-light,rgba(27,111,255,.08));color:var(--blue,#1B6FFF);}' +
    '.nav-panel a.nav-panel-cta{margin-top:8px;text-align:center;background:var(--blue,#1B6FFF);color:#fff;font-weight:600;}' +
    '@media(max-width:960px){.nav-burger{display:inline-flex;}}';
  document.head.appendChild(css);

  var panel = document.createElement('div');
  panel.className = 'nav-panel';
  panel.id = 'nav-panel';
  links.querySelectorAll('a').forEach(function (a) {
    var c = document.createElement('a');
    c.href = a.getAttribute('href');
    c.textContent = a.textContent.trim();
    panel.appendChild(c);
  });
  var cta = nav.querySelector('.nav-right a[href="get-started.html"]');
  if (cta) {
    var c = document.createElement('a');
    c.href = cta.getAttribute('href');
    c.textContent = cta.textContent.trim();
    c.className = 'nav-panel-cta';
    panel.appendChild(c);
  }

  var open = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1E2A3B" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>';
  var close = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1E2A3B" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-burger';
  btn.setAttribute('aria-label', 'Menu');
  btn.setAttribute('aria-controls', 'nav-panel');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = open;
  (nav.querySelector('.nav-right') || nav).appendChild(btn);
  nav.parentNode.insertBefore(panel, nav.nextSibling);

  function set(on) {
    panel.classList.toggle('open', on);
    btn.setAttribute('aria-expanded', on ? 'true' : 'false');
    btn.innerHTML = on ? close : open;
  }
  btn.addEventListener('click', function (e) { e.stopPropagation(); set(!panel.classList.contains('open')); });
  panel.addEventListener('click', function (e) { if (e.target.tagName === 'A') set(false); });
  document.addEventListener('click', function (e) { if (!panel.contains(e.target)) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') set(false); });
  window.addEventListener('resize', function () { if (window.innerWidth > 960) set(false); });
})();
