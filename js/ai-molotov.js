/*
 * Computer-Gegner für Molotov (jeder für sich, kein Partner).
 * Ziel: wenig Striche. Also möglichst keine Stiche mit vielen Punkten gewinnen,
 * Punkte auf andere Spieler "schmieren".
 * createPlayer({ level }) gibt einen Gegner zurück. "level" ist für spätere
 * Schwierigkeitsstufen vorgesehen. Heute gibt es nur "normal".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.JassAIMolotov = factory(root.JassRules);
})(typeof window !== 'undefined' ? window : this, function (R) {
  'use strict';

  var LEVELS = {
    leicht: { randomP: 0.4 },
    mittel: { randomP: 0.12 },
    schwer: { randomP: 0 },
    normal: { randomP: 0.12 }
  };

  function suitCount(hand, s) {
    return hand.filter(function (c) { return c.s === s; }).length;
  }

  // Punkte zuerst (hohe Punkte loswerden), bei Gleichstand höherer Rang zuerst.
  function dumpOrder(a, b, trump) {
    var pa = R.cardPoints(a, trump), pb = R.cardPoints(b, trump);
    if (pa !== pb) return pb - pa;
    return R.ORDER_PLAIN[b.r] - R.ORDER_PLAIN[a.r];
  }

  function createPlayer(opts) {
    opts = opts || {};
    var level = LEVELS[opts.level] ? opts.level : 'normal';
    var cfg = LEVELS[level];

    function choosePlay(hand, plays, trump, seat) {
      if (cfg.randomP && Math.random() < cfg.randomP) {
        var all = R.legalFree(hand, plays);
        return all[Math.floor(Math.random() * all.length)];
      }
      var legal = R.legalFree(hand, plays);
      if (legal.length === 1) return legal[0];

      // Ausspielen: niedrigste Karte, bei Obenabe/Trumpf sonst die Farbe mit den meisten Karten
      if (!plays.length) {
        return legal.slice().sort(function (a, b) {
          var pa = R.cardPoints(a, trump), pb = R.cardPoints(b, trump);
          if (pa !== pb) return pa - pb;
          return R.ORDER_PLAIN[a.r] - R.ORDER_PLAIN[b.r];
        })[0];
      }

      var led = plays[0].card.s;
      // Noch kein Trumpf und keine Karte der ausgespielten Farbe: die Karte setzt den Trumpf.
      if (!trump && !hand.some(function (c) { return c.s === led; })) {
        var bestS = null, bestN = -1, bestPts = -1;
        R.SUITS.forEach(function (s) {
          if (s === led) return;
          var n = suitCount(hand, s);
          if (n === 0) return;
          var pts = hand.filter(function (c) { return c.s === s; })
            .reduce(function (acc, c) { return acc + R.cardPoints(c, null); }, 0);
          if (n > bestN || (n === bestN && pts > bestPts)) { bestN = n; bestS = s; bestPts = pts; }
        });
        // Wenig Punkte in dieser Farbe abgeben
        return hand.filter(function (c) { return c.s === bestS; })
          .sort(function (a, b) { return R.cardPoints(a, null) - R.cardPoints(b, null); })[0];
      }

      var w = R.winnerIndex(plays, trump);
      var winnerCard = plays[w].card;
      var pts = R.trickPoints(plays.map(function (p) { return p.card; }), trump);
      var wins = legal.filter(function (c) { return R.beats(c, winnerCard, led, trump); });
      var loses = legal.filter(function (c) { return wins.indexOf(c) < 0; });

      // Karten, die den Stich nicht gewinnen, sind gut: dann Punkte auf den Gewinner schieben.
      if (loses.length) {
        return loses.slice().sort(function (a, b) { return dumpOrder(a, b, trump); })[0];
      }
      // Muss gewinnen: möglichst billig, damit der Stich wenig Punkte bringt.
      return wins.slice().sort(function (a, b) {
        var pa = R.cardPoints(a, trump), pb = R.cardPoints(b, trump);
        if (pa !== pb) return pa - pb;
        return R.ORDER_PLAIN[a.r] - R.ORDER_PLAIN[b.r];
      })[0];
    }

    return { level: level, choosePlay: choosePlay };
  }

  return { createPlayer: createPlayer };
});
