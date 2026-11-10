/* lang.js — language menu + page translation for resident, guest and driver pages.
 *
 * Add <script src="/lang.js"></script> to a page. It:
 *   - picks the language: ?lang=xx in the link, then the person's last choice,
 *     then their phone/browser language (only languages LotHQ has switched on;
 *     a ?lang= link can preview one that's still off, for reviewers)
 *   - translates the page's text (and text the page adds later) by its English
 *     wording; anything without a translation stays in English
 *   - shows a 🌐 menu in any element with data-lang-menu (or top-right)
 *
 * Never translated: anything inside translate="no" or .notranslate (plates,
 * names, the Parking Terms text), and what people type into inputs.
 *
 * In page code:  LotHQLang.t('Sent to {email}.', {email})   LotHQLang.locale
 *                await LotHQLang.ready      LotHQLang.code      LotHQLang.onChange(fn)
 */
(function () {
  'use strict';
  var KEY = 'lothq_lang', PACK = 'lothq_lang_pack';
  var L = { code: 'en', locale: 'en-US', languages: [{ code: 'en', name: 'English' }], dict: {}, _cbs: [] };
  var patterns = [];
  var orig = new WeakMap();      // text node / element+attr → original English
  var mine = new WeakMap();      // text node → the translation we last wrote
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1, CODE: 1 };

  function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function sread(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function swrite(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function fill(s, vars) { return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : String(s); }

  function build() {
    patterns = [];
    Object.keys(L.dict).forEach(function (k) {
      if (k.indexOf('{') < 0) return;
      var names = [];
      var re = new RegExp('^' + esc(k).replace(/\\\{(\w+)\\\}/g, function (m, n) { names.push(n); return '(.+?)'; }) + '$');
      patterns.push({ re: re, names: names, out: L.dict[k] });
    });
  }
  function tr(en) {
    var s = String(en), lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0], core = s.trim();
    if (!core || L.code === 'en') return s;
    var hit = L.dict[core];
    if (hit == null) {
      for (var i = 0; i < patterns.length; i++) {
        var m = core.match(patterns[i].re);
        if (m) { var vars = {}; patterns[i].names.forEach(function (n, j) { vars[n] = tr(m[j + 1]).trim(); }); hit = fill(patterns[i].out, vars); break; }
      }
    }
    return hit == null ? s : lead + hit + trail;
  }
  L.t = function (en, vars) { return fill(L.code === 'en' ? en : (L.dict[en] || tr(en)), vars); };

  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (SKIP[e.tagName] || e.getAttribute('translate') === 'no' || (e.classList && e.classList.contains('notranslate'))) return true;
    }
    return false;
  }
  function doText(node) {
    if (!node.parentElement || skipped(node.parentElement)) return;
    var cur = node.nodeValue;
    if (mine.get(node) === cur) return;                 // our own translation
    orig.set(node, cur);                                 // the page wrote new English
    var out = tr(cur);
    if (out !== cur) { mine.set(node, out); node.nodeValue = out; } else mine.delete(node);
  }
  function doAttrs(el) {
    if (skipped(el)) return;
    ATTRS.forEach(function (a) {
      if (!el.hasAttribute(a)) return;
      var store_ = orig.get(el) || {}; var cur = el.getAttribute(a);
      if (store_['_' + a] === cur) return;
      store_[a] = cur; var out = tr(cur); store_['_' + a] = out; orig.set(el, store_);
      if (out !== cur) el.setAttribute(a, out);
    });
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (SKIP[root.tagName]) return; doAttrs(root); }
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    var n; while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  // Put the page back to English (before switching language)
  function restore(root) {
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    var n; while ((n = w.nextNode())) {
      if (n.nodeType === 3) { if (mine.get(n) === n.nodeValue && orig.has(n)) n.nodeValue = orig.get(n); mine.delete(n); }
      else { var s = orig.get(n); if (s) ATTRS.forEach(function (a) { if (s[a] != null && n.getAttribute(a) === s['_' + a]) n.setAttribute(a, s[a]); }); orig.delete(n); }
    }
  }

  var obs = null;
  function observe() {
    if (obs || !window.MutationObserver) return;
    obs = new MutationObserver(function (list) {
      if (L.code === 'en') return;
      list.forEach(function (m) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else m.addedNodes.forEach(walk);
      });
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function apply(pack) {
    if (L.code !== 'en' && document.body) restore(document.body);
    L.code = pack.lang || 'en'; L.locale = pack.locale || 'en-US'; L.dict = pack.dict || {};
    if (pack.languages && pack.languages.length) L.languages = pack.languages;
    build();
    document.documentElement.lang = L.code;
    if (document.body && L.code !== 'en') walk(document.body);
    menus();
    L._cbs.forEach(function (f) { try { f(L.code); } catch (e) {} });
  }

  // ── The 🌐 menu ──
  function menus() {
    if (!document.body) return;
    var slots = document.querySelectorAll('[data-lang-menu]');
    if (!slots.length) {
      var f = document.getElementById('lothq-lang-float');
      if (!f) { f = document.createElement('div'); f.id = 'lothq-lang-float'; f.setAttribute('data-lang-menu', ''); f.style.cssText = 'position:fixed;top:12px;right:12px;z-index:9000;'; document.body.appendChild(f); }
      slots = [f];
    }
    if (!document.getElementById('lothq-lang-css')) {
      var st = document.createElement('style'); st.id = 'lothq-lang-css';
      st.textContent = '.lq-lang{position:relative;display:inline-block;font-family:inherit}' +
        '.lq-lang select{appearance:none;-webkit-appearance:none;border:1.5px solid rgba(15,23,42,.14);background:#fff url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2710%27 height=%276%27%3E%3Cpath d=%27M1 1l4 4 4-4%27 stroke=%27%23475569%27 stroke-width=%271.6%27 fill=%27none%27/%3E%3C/svg%3E") no-repeat right 10px center;border-radius:20px;padding:6px 28px 6px 30px;font-size:13px;font-weight:600;color:#0f172a;cursor:pointer;font-family:inherit}' +
        '.lq-lang::before{content:"\\1F310";position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:13px;pointer-events:none}';
      document.head.appendChild(st);
    }
    slots.forEach(function (slot) {
      var langs = L.languages.slice();
      if (!langs.some(function (l) { return l.code === L.code; })) langs.push({ code: L.code, name: L.code.toUpperCase() + ' (preview)' });
      if (langs.length < 2) { slot.innerHTML = ''; return; }
      slot.setAttribute('translate', 'no');
      slot.innerHTML = '<span class="lq-lang"><select aria-label="Language">' + langs.map(function (l) {
        return '<option value="' + l.code + '"' + (l.code === L.code ? ' selected' : '') + '>' + l.name + '</option>';
      }).join('') + '</select></span>';
      slot.querySelector('select').addEventListener('change', function (e) { L.set(e.target.value); });
    });
  }

  function load(want, all) {
    return fetch('/.netlify/functions/i18n?want=' + encodeURIComponent(want.join(',')) + (all ? '&all=1' : ''))
      .then(function (r) { return r.json(); });
  }
  L.set = function (code) {
    store(KEY, code);
    return load([code], true).then(function (p) { swrite(PACK, p); apply(p); });
  };
  L.onChange = function (fn) { L._cbs.push(fn); };

  // ── Start ──
  var q = new URLSearchParams(location.search).get('lang');
  var saved = read(KEY);
  var nav = (navigator.languages || [navigator.language || 'en']).map(function (s) { return String(s).toLowerCase().split('-')[0]; });
  var want = [q, saved].concat(nav).filter(Boolean);
  if (q) store(KEY, q);
  var cached = sread(PACK);
  var first = want[0] || 'en';
  var hide = first !== 'en' && !(cached && cached.lang === first);
  if (hide) document.documentElement.style.visibility = 'hidden';
  var reveal = function () { document.documentElement.style.visibility = ''; };
  var timer = hide ? setTimeout(reveal, 1500) : 0;

  function whenBody(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }
  if (cached && cached.lang === first) whenBody(function () { apply(cached); observe(); });

  L.ready = load(want, !!q).then(function (p) {
    swrite(PACK, p);
    return new Promise(function (res) { whenBody(function () { apply(p); observe(); res(p.lang); }); });
  }).catch(function () {
    return new Promise(function (res) { whenBody(function () { menus(); res('en'); }); });
  }).then(function (c) { clearTimeout(timer); reveal(); return c; });

  window.LotHQLang = L;
})();
