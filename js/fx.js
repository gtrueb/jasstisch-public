/*
 * Gemeinsame Effekte: Meldungen (oben eingeblendet) und Animation, wenn ein Stich
 * zum Gewinner fliegt. Wird von Schieber und Molotow benutzt.
 */
(function (root) {
  'use strict';

  // Richtung, in die die Karten fliegen (Pixel), je nach Platz des Gewinners.
  var OFFSET = { bottom: [0, 190], top: [0, -190], left: [-190, 0], right: [190, 0] };

  function toast(text, kind) {
    var box = document.getElementById('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = text;
    box.appendChild(el);
    setTimeout(function () { el.classList.add('out'); }, 2600);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3100);
  }

  // slots: die bisherigen Stich-Karten (DOM-Knoten), winnerPos: 'bottom' | 'top' | 'left' | 'right'
  function fly(box, slots, winnerPos) {
    var off = OFFSET[winnerPos] || OFFSET.bottom;
    slots.forEach(function (slot) {
      slot.classList.add('flying');
      box.appendChild(slot);
    });
    // Erst nach einem Frame losschicken, damit die Animation startet.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        slots.forEach(function (slot) {
          slot.style.transform = 'translate(' + off[0] + 'px, ' + off[1] + 'px) scale(0.6)';
          slot.style.opacity = '0';
        });
      });
    });
    setTimeout(function () {
      slots.forEach(function (slot) { if (slot.parentNode) slot.parentNode.removeChild(slot); });
    }, 750);
  }

  root.JassFX = { toast: toast, fly: fly, OFFSET: OFFSET };
})(window);
