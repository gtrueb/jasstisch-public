/*
 * Tempo-Schalter (langsam / normal / schnell).
 * "normal" entspricht den gemessenen Zeiten von jassli.ch.
 * Die Auswahl wird im Browser gespeichert (nur als Komfort-Einstellung).
 */
(function (root) {
  'use strict';

  var FACTORS = { langsam: 1.6, normal: 1, schnell: 0.5 };
  var KEY = 'jasstisch-tempo';

  function get() {
    try {
      var v = root.localStorage.getItem(KEY);
      return FACTORS[v] ? v : 'normal';
    } catch (e) {
      return 'normal';
    }
  }

  function set(name) {
    if (!FACTORS[name]) return;
    try { root.localStorage.setItem(KEY, name); } catch (e) { /* ignorieren */ }
    markButtons(name);
    root.dispatchEvent(new CustomEvent('jass-tempo', { detail: { name: name, factor: FACTORS[name] } }));
  }

  // Zeiten skalieren. URL-Parameter ?speed=20 bleibt zum Testen erhalten.
  function scaled(defaults) {
    var out = {};
    var urlSpeed = parseFloat(new URLSearchParams(root.location.search).get('speed'));
    var f = urlSpeed ? 1 / urlSpeed : FACTORS[get()];
    Object.keys(defaults).forEach(function (k) { out[k] = Math.round(defaults[k] * f); });
    return out;
  }

  function markButtons(name) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (b) {
      var on = b.getAttribute('data-speed') === name;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    markButtons(get());
    Array.prototype.forEach.call(document.querySelectorAll('[data-speed]'), function (b) {
      b.addEventListener('click', function () { set(b.getAttribute('data-speed')); });
    });
  });

  root.JassTempo = { FACTORS: FACTORS, get: get, set: set, scaled: scaled };
})(window);
