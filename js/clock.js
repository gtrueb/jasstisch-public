/*
 * Spielzeit-Timer über einen Hintergrund-Worker.
 * Browser drosseln Timer in Hintergrund-Tabs stark. Dann bleibt das Spiel stehen
 * (z. B. "Karten werden gemischt"). Worker-Timer werden kaum gedrosselt.
 * Fällt der Worker aus, wird normal setTimeout benutzt.
 */
(function (root) {
  'use strict';

  var worker = null;     // null = noch nicht gestartet, false = nicht verfügbar
  var seq = 0;
  var callbacks = {};

  function start() {
    if (worker !== null) return worker;
    try {
      var src = 'self.onmessage=function(e){setTimeout(function(){self.postMessage(e.data.id);},e.data.ms);};';
      var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      var w = new Worker(url);
      w.onmessage = function (e) {
        var cb = callbacks[e.data];
        delete callbacks[e.data];
        if (cb) cb();
      };
      w.onerror = function () {
        // Worker ausgefallen: offene Aufrufe trotzdem ausführen, danach normal weiter.
        var pending = callbacks;
        callbacks = {};
        worker = false;
        Object.keys(pending).forEach(function (k) { setTimeout(pending[k], 0); });
      };
      worker = w;
    } catch (err) {
      worker = false;
    }
    return worker;
  }

  function sched(fn, ms) {
    var w = start();
    if (!w) return setTimeout(fn, ms);
    var id = ++seq;
    callbacks[id] = fn;
    w.postMessage({ id: id, ms: ms });
    return id;
  }

  root.JassClock = { sched: sched };
})(typeof window !== 'undefined' ? window : this);
