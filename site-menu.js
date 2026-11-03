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
    '@media(max-width:960px){.nav-burger{display:inline-flex;}}' +
    // Login drop-down (top bar)
    '.nav-login{position:relative;}' +
    '.nav-login-btn{gap:6px;}' +
    '.nav-login-btn svg{transition:transform .18s;}' +
    '.nav-login.open .nav-login-btn{border-color:var(--blue,#2859a8);color:var(--blue,#2859a8);}' +
    '.nav-login.open .nav-login-btn svg{transform:rotate(180deg);}' +
    '.nav-login-menu{display:none;position:absolute;right:0;top:calc(100% + 8px);width:270px;background:#fff;border:1px solid var(--border,#e2e8f0);border-radius:12px;box-shadow:0 14px 32px rgba(11,18,32,.14);padding:6px;z-index:600;}' +
    '.nav-login.open .nav-login-menu{display:block;}' +
    '.nav-login-menu a{display:block;padding:10px 12px;border-radius:8px;text-decoration:none;color:var(--ink,#0B1220);font-family:Inter,sans-serif;}' +
    '.nav-login-menu a:hover,.nav-login-menu a:focus-visible{background:var(--blue-light,rgba(40,89,168,.08));outline:none;}' +
    '.nav-login-menu b{display:block;font-size:14px;font-weight:600;}' +
    '.nav-login-menu span{display:block;font-size:12.5px;color:var(--slate,#55607d);margin-top:2px;}' +
    '.nav-panel .nav-panel-h{display:block;padding:12px 12px 4px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--slate,#55607d);font-family:Inter,sans-serif;}';
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
  var loginMenu = nav.querySelector('.nav-login-menu');
  if (loginMenu) {
    var h = document.createElement('span');
    h.className = 'nav-panel-h';
    h.textContent = 'Login';
    panel.appendChild(h);
    loginMenu.querySelectorAll('a').forEach(function (a) {
      var c = document.createElement('a');
      c.href = a.getAttribute('href');
      c.textContent = a.querySelector('b') ? a.querySelector('b').textContent : a.textContent.trim();
      panel.appendChild(c);
    });
  }
  var cta = nav.querySelector('.nav-right .nav-talk');
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

  // Login drop-down: click to open (works on phones too), hover to open on desktop
  var login = nav.querySelector('.nav-login');
  if (login) {
    var lb = login.querySelector('.nav-login-btn');
    var hoverable = window.matchMedia('(hover: hover)').matches;
    var timer;
    function setL(on) { login.classList.toggle('open', on); lb.setAttribute('aria-expanded', on ? 'true' : 'false'); }
    // With a mouse, hovering already opened it, so a click keeps it open instead of closing it
    lb.addEventListener('click', function (e) { e.stopPropagation(); set(false); setL(hoverable ? true : !login.classList.contains('open')); });
    if (hoverable) {
      login.addEventListener('mouseenter', function () { clearTimeout(timer); setL(true); });
      login.addEventListener('mouseleave', function () { timer = setTimeout(function () { setL(false); }, 180); });
    }
    document.addEventListener('click', function (e) { if (!login.contains(e.target)) setL(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setL(false); });
  }
})();
