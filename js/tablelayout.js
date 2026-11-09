/*
 * Gemeinsame Hilfen für den Tisch (Handy und Desktop):
 * - avatar(seed, ai): fester, zufällig wirkender Avatar je Platz. KI und Menschen sehen anders aus.
 * - isPhone(): schmaler Bildschirm (wie in den CSS-Regeln, bis 680 px).
 * - handRows(n): wie viele Karten in welcher Reihe liegen. Auf dem Handy ab 7 Karten zwei Reihen,
 *   damit jede Karte ein großes Antippfeld hat.
 */
(function (root) {
  'use strict';

  // Einfacher, fester Hash: gleicher Name und Platz geben immer den gleichen Avatar.
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // KI: eckiger Kopf mit Antenne und Roboter-Augen. Mensch: runder Kopf mit Haaren.
  function avatar(seed, ai) {
    var h = hash(String(seed));
    var hue = h % 360;
    var variant = (h >>> 9) % 3;
    var bg = 'hsl(' + hue + ',60%,88%)';
    var fg = 'hsl(' + hue + ',45%,34%)';
    var svg;
    if (ai) {
      var eyes = variant === 0
        ? '<rect x="15" y="19" width="6" height="6" rx="1.5" fill="#fff"/><rect x="27" y="19" width="6" height="6" rx="1.5" fill="#fff"/>'
        : variant === 1
          ? '<circle cx="18" cy="22" r="3.2" fill="#fff"/><circle cx="30" cy="22" r="3.2" fill="#fff"/>'
          : '<rect x="14" y="21" width="9" height="3" rx="1.5" fill="#fff"/><rect x="25" y="21" width="9" height="3" rx="1.5" fill="#fff"/>';
      svg = '<svg viewBox="0 0 48 48" aria-hidden="true">' +
        '<rect width="48" height="48" fill="' + bg + '"/>' +
        '<line x1="24" y1="8" x2="24" y2="13" stroke="' + fg + '" stroke-width="2"/>' +
        '<circle cx="24" cy="7" r="2.6" fill="' + fg + '"/>' +
        '<rect x="10" y="13" width="28" height="24" rx="6" fill="' + fg + '"/>' + eyes +
        '<rect x="18" y="30" width="12" height="3" rx="1.5" fill="#fff"/>' +
        '<rect x="13" y="39" width="22" height="7" rx="2.5" fill="' + fg + '" opacity="0.55"/>' +
        '</svg>';
    } else {
      var hair = variant === 0
        ? '<path d="M13 20 Q24 4 35 20 Q30 13 24 14 Q18 13 13 20Z" fill="' + fg + '"/>'
        : variant === 1
          ? '<path d="M12 23 Q24 5 36 23 L36 17 Q24 2 12 17Z" fill="' + fg + '"/>'
          : '<circle cx="24" cy="15" r="7.5" fill="' + fg + '"/>';
      svg = '<svg viewBox="0 0 48 48" aria-hidden="true">' +
        '<rect width="48" height="48" fill="' + bg + '"/>' +
        '<circle cx="24" cy="22" r="10" fill="#f3d7b8"/>' + hair +
        '<path d="M8 48 Q24 27 40 48Z" fill="' + fg + '"/>' +
        '</svg>';
    }
    return svg;
  }

  function isPhone() {
    return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 680px)').matches;
  }

  // Anzahl Karten je Reihe. Auf dem Handy ab 7 Karten zwei Reihen (oben weniger, unten mehr).
  function handRows(n, phone) {
    if (!phone || n <= 6) return [n];
    var top = Math.ceil(n / 2);
    return [top, n - top];
  }

  root.JassTable = { avatar: avatar, isPhone: isPhone, handRows: handRows };
})(typeof window !== 'undefined' ? window : this);
