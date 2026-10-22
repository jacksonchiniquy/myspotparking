/* terms-box.js — the "I agree to the Parking Terms" checkbox.
 *
 *   const box = TermsBox.mount(containerEl, terms);   // terms from the server
 *   box.ok()       → true if not required, or the box is checked (else shows a note)
 *   box.version    → the version they agreed to (send it with the save)
 *
 * When a property has no terms (or the database step isn't done yet),
 * nothing is shown and ok() is always true.
 */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function styles() {
    if (document.getElementById('tb-styles')) return;
    var s = document.createElement('style'); s.id = 'tb-styles';
    s.textContent =
      '.tb-box{border:1px solid rgba(15,23,42,.14);background:#f8fafc;border-radius:12px;padding:12px 14px;margin:4px 0 14px;text-align:left;}' +
      '.tb-row{display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;color:#334155;cursor:pointer;}' +
      '.tb-row input{width:18px;height:18px;margin:1px 0 0;flex-shrink:0;accent-color:#1a6fff;cursor:pointer;}' +
      '.tb-link{color:#1a5fe0;font-weight:600;text-decoration:underline;cursor:pointer;background:none;border:none;padding:0;font:inherit;}' +
      '.tb-text{display:none;margin-top:10px;max-height:260px;overflow-y:auto;background:#fff;border:1px solid rgba(15,23,42,.1);border-radius:8px;padding:12px;font-size:12.5px;line-height:1.55;color:#334155;white-space:pre-wrap;}' +
      '.tb-text.show{display:block;}' +
      '.tb-text h4{margin:0 0 8px;font-size:14px;color:#0f172a;white-space:normal;}' +
      '.tb-text h5{margin:12px 0 4px;font-size:12.5px;color:#0f172a;white-space:normal;}' +
      '.tb-err{display:none;font-size:12px;color:#c0262d;margin-top:8px;font-weight:600;}' +
      '.tb-err.show{display:block;}' +
      '.tb-box.need{border-color:#e5484d;background:#fff5f5;}';
    document.head.appendChild(s);
  }

  function mount(container, terms) {
    if (typeof container === 'string') container = document.getElementById(container);
    var api = { version: null, required: false, ok: function () { return true; }, reset: function () {} };
    if (!container) return api;
    container.innerHTML = '';
    if (!terms || !terms.required) return api;
    styles();
    var box = document.createElement('div'); box.className = 'tb-box';
    box.innerHTML =
      '<label class="tb-row"><input type="checkbox"><span>I agree to the <button type="button" class="tb-link">Parking Terms</button> for <b>' +
      esc(terms.propertyName || 'this property') + '</b>.</span></label>' +
      '<div class="tb-text"><h4>' + esc(terms.title || 'Parking Terms') + '</h4>' + esc(terms.body) +
      (terms.rules ? '<h5>Property rules</h5>' + esc(terms.rules) : '') + '</div>' +
      '<div class="tb-err">Please check the box to agree to the Parking Terms.</div>';
    container.appendChild(box);
    var cb = box.querySelector('input'), text = box.querySelector('.tb-text'), err = box.querySelector('.tb-err');
    box.querySelector('.tb-link').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      text.classList.toggle('show');
    });
    cb.addEventListener('change', function () { if (cb.checked) { err.classList.remove('show'); box.classList.remove('need'); } });
    api.required = true;
    api.version = terms.version;
    api.ok = function () {
      if (cb.checked) return true;
      err.classList.add('show'); box.classList.add('need');
      try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
      return false;
    };
    api.reset = function () { cb.checked = false; err.classList.remove('show'); box.classList.remove('need'); text.classList.remove('show'); };
    return api;
  }

  // For pages without their own lookup (resident portal)
  function fetchTerms(propertyId, placement) {
    return fetch('/.netlify/functions/terms', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get', propertyId: propertyId, placement: placement }) })
      .then(function (r) { return r.ok ? r.json() : { required: false }; })
      .catch(function () { return { required: false }; });
  }

  window.TermsBox = { mount: mount, fetchTerms: fetchTerms };
})();
