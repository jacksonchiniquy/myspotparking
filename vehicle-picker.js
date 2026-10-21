/* vehicle-picker.js — spelling help for Year / Make / Model boxes.
 *
 * Suggests a year, a common make, and (from the free NHTSA database, through
 * /.netlify/functions/vehicle-models) the models for that make and year.
 * People can always type something that isn't on the list; it is saved as
 * typed, with a small note so they know. If NHTSA can't be reached the model
 * box falls back to a short built-in list and plain typing.
 *
 * Usage: VehiclePicker.attach({ year: 'av-year', make: 'av-make', model: 'av-model' });
 */
(function () {
  'use strict';
  var MAKES = ['Acura','Alfa Romeo','Aston Martin','Audi','Bentley','BMW','Buick','Cadillac','Chevrolet','Chrysler','Dodge','Ferrari','Fiat','Fisker','Ford','Genesis','GMC','Harley-Davidson','Honda','Hummer','Hyundai','Infiniti','Isuzu','Jaguar','Jeep','Kawasaki','Kia','Lamborghini','Land Rover','Lexus','Lincoln','Lotus','Lucid','Maserati','Mazda','McLaren','Mercedes-Benz','Mercury','Mini','Mitsubishi','Nissan','Oldsmobile','Polestar','Pontiac','Porsche','Ram','Rivian','Rolls-Royce','Saab','Saturn','Scion','Smart','Subaru','Suzuki','Tesla','Toyota','Triumph','Vespa','Volkswagen','Volvo','Yamaha'];
  var FALLBACK = {Toyota:['4Runner','Camry','Corolla','Highlander','Prius','RAV4','Sienna','Tacoma','Tundra','Venza'],Honda:['Accord','Civic','CR-V','HR-V','Odyssey','Passport','Pilot','Ridgeline'],Ford:['Bronco','Edge','Escape','Expedition','Explorer','F-150','F-250','Maverick','Mustang','Ranger'],Chevrolet:['Blazer','Colorado','Equinox','Malibu','Silverado','Suburban','Tahoe','Trailblazer','Traverse'],Tesla:['Cybertruck','Model 3','Model S','Model X','Model Y'],Nissan:['Altima','Frontier','Maxima','Murano','Pathfinder','Rogue','Sentra','Titan'],Hyundai:['Elantra','Ioniq 5','Ioniq 6','Palisade','Santa Fe','Sonata','Tucson'],Kia:['EV6','Forte','K5','Sorento','Soul','Sportage','Telluride'],Jeep:['Cherokee','Compass','Gladiator','Grand Cherokee','Renegade','Wrangler'],Subaru:['Ascent','Crosstrek','Forester','Impreza','Legacy','Outback','WRX'],Ram:['1500','2500','3500','ProMaster'],GMC:['Acadia','Canyon','Sierra','Terrain','Yukon'],Mazda:['CX-30','CX-5','CX-50','CX-90','Mazda3','MX-5 Miata'],Volkswagen:['Atlas','Golf','ID.4','Jetta','Passat','Tiguan'],Dodge:['Challenger','Charger','Durango','Hornet']};
  var NOTE = 'Not in our list. We’ll save it as typed.';
  var modelCache = {};

  function el(id) { return typeof id === 'string' ? document.getElementById(id) : id; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function injectStyles() {
    if (document.getElementById('vp-styles')) return;
    var s = document.createElement('style'); s.id = 'vp-styles';
    s.textContent =
      '.vp-wrap{position:relative;}' +
      '.vp-list{display:none;position:absolute;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid rgba(15,23,42,.14);border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.14);z-index:2000;max-height:220px;overflow-y:auto;}' +
      '.vp-list.show{display:block;}' +
      '.vp-opt{padding:10px 14px;font-size:14px;color:#0f172a;cursor:pointer;}' +
      '.vp-opt:hover,.vp-opt.on{background:#eef4ff;}' +
      '.vp-opt b{font-weight:700;}' +
      '.vp-note{display:none;font-size:11px;color:#64748b;margin-top:5px;}' +
      '.vp-note.show{display:block;}';
    document.head.appendChild(s);
  }

  // Tidy capitals for free typing: "toyota camry" -> "Toyota Camry". Leaves mixed case alone.
  function tidy(v) {
    v = String(v || '').replace(/\s+/g, ' ').trim();
    if (!v) return v;
    if (v === v.toLowerCase() || (v === v.toUpperCase() && v.length > 4)) {
      return v.toLowerCase().replace(/(^|[\s-])([a-z])/g, function (m, a, b) { return a + b.toUpperCase(); });
    }
    return v;
  }

  function findCase(list, v) {
    var lv = String(v || '').trim().toLowerCase();
    for (var i = 0; i < list.length; i++) if (list[i].toLowerCase() === lv) return list[i];
    return null;
  }

  function years() {
    var out = [], top = new Date().getFullYear() + 1;
    for (var y = top; y >= 1960; y--) out.push(String(y));
    return out;
  }

  function fetchModels(make, year) {
    var key = make.toLowerCase() + '|' + (year || '');
    if (modelCache[key]) return modelCache[key];
    var url = '/.netlify/functions/vehicle-models?make=' + encodeURIComponent(make) + (year ? '&year=' + year : '');
    modelCache[key] = fetch(url).then(function (r) { return r.ok ? r.json() : { models: [] }; })
      .then(function (d) {
        var list = (d && d.models) || [];
        if (!list.length) {
          var fb = FALLBACK[findCase(Object.keys(FALLBACK), make) || ''] || [];
          list = fb.slice();
        }
        return list;
      })
      .catch(function () {
        delete modelCache[key];
        var fb = FALLBACK[findCase(Object.keys(FALLBACK), make) || ''] || [];
        return fb.slice();
      });
    return modelCache[key];
  }

  // One suggestion box under an input. getList() returns an array or a Promise of one.
  function combo(input, opts) {
    var wrap = input.parentElement;
    if (!wrap.classList.contains('vp-wrap')) wrap.classList.add('vp-wrap');
    var list = document.createElement('div'); list.className = 'vp-list'; list.setAttribute('role', 'listbox');
    input.insertAdjacentElement('afterend', list);
    var note = document.createElement('div'); note.className = 'vp-note'; note.textContent = NOTE;
    list.insertAdjacentElement('afterend', note);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    var items = [], on = -1, known = [], token = 0;

    function render(all) {
      known = all || [];
      var q = input.value.trim().toLowerCase();
      var starts = [], contains = [];
      for (var i = 0; i < known.length; i++) {
        var lv = known[i].toLowerCase();
        if (!q || lv.indexOf(q) === 0) starts.push(known[i]);
        else if (lv.indexOf(q) > 0) contains.push(known[i]);
      }
      items = starts.concat(contains).slice(0, opts.max || 8);
      if (q && items.length === 1 && items[0].toLowerCase() === q) items = [];
      on = -1;
      if (!items.length) { list.classList.remove('show'); list.innerHTML = ''; return; }
      list.innerHTML = items.map(function (it, i) {
        var lv = it.toLowerCase(), k = q ? lv.indexOf(q) : -1;
        var label = k >= 0 ? esc(it.slice(0, k)) + '<b>' + esc(it.slice(k, k + q.length)) + '</b>' + esc(it.slice(k + q.length)) : esc(it);
        return '<div class="vp-opt" role="option" data-i="' + i + '">' + label + '</div>';
      }).join('');
      list.classList.add('show');
    }
    function refresh() {
      var my = ++token;
      Promise.resolve(opts.getList()).then(function (all) { if (my === token && document.activeElement === input) render(all); });
    }
    function pick(i) {
      if (i < 0 || i >= items.length) return;
      input.value = items[i];
      list.classList.remove('show'); note.classList.remove('show');
      if (opts.onPick) opts.onPick(items[i]);
    }
    function check() {
      var v = input.value.trim();
      if (!v) { note.classList.remove('show'); return; }
      Promise.resolve(opts.getList()).then(function (all) {
        var match = findCase(all || [], v);
        if (match) { input.value = match; note.classList.remove('show'); }
        else {
          input.value = opts.tidy === false ? v : tidy(v);
          note.classList.toggle('show', !!opts.showNote && (all || []).length > 0);
        }
      });
    }

    input.addEventListener('focus', refresh);
    input.addEventListener('input', function () {
      if (opts.digitsOnly) input.value = input.value.replace(/\D/g, '').slice(0, 4);
      note.classList.remove('show');
      refresh();
      if (opts.onType) opts.onType();
    });
    input.addEventListener('keydown', function (e) {
      if (!list.classList.contains('show')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        on = (on + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        [].forEach.call(list.children, function (c, i) { c.classList.toggle('on', i === on); });
      } else if (e.key === 'Enter' && on >= 0) { e.preventDefault(); pick(on); }
      else if (e.key === 'Escape') { list.classList.remove('show'); }
    });
    list.addEventListener('mousedown', function (e) {
      var o = e.target.closest('.vp-opt'); if (!o) return;
      e.preventDefault(); pick(+o.getAttribute('data-i'));
    });
    input.addEventListener('blur', function () {
      setTimeout(function () { list.classList.remove('show'); }, 120);
      check();
    });
    return { clearNote: function () { note.classList.remove('show'); }, check: check };
  }

  function attach(ids) {
    injectStyles();
    var yearEl = el(ids.year), makeEl = el(ids.make), modelEl = el(ids.model);
    if (!makeEl || makeEl.dataset.vp) return;
    makeEl.dataset.vp = '1';
    var yearList = years();

    function currentYear() {
      var y = yearEl ? yearEl.value.trim() : '';
      return /^\d{4}$/.test(y) ? y : '';
    }
    function modelsNow() {
      var mk = makeEl.value.trim();
      if (!mk) return [];
      return fetchModels(findCase(MAKES, mk) || mk, currentYear());
    }

    if (yearEl) combo(yearEl, { getList: function () { return yearList; }, digitsOnly: true, tidy: false, max: 8 });
    combo(makeEl, {
      getList: function () { return MAKES; }, showNote: true,
      onPick: function () { if (modelEl) modelEl.focus(); }
    });
    if (modelEl) combo(modelEl, { getList: modelsNow, showNote: true });
  }

  window.VehiclePicker = { attach: attach, tidy: tidy, MAKES: MAKES };
})();
