/*
 * Computer-Gegner für Schieber (Teams: Partner sitzen sich gegenüber).
 * createPlayer({ level }) gibt einen Gegner zurück. "level" ist für spätere
 * Schwierigkeitsstufen vorgesehen. Heute gibt es nur "normal".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'));
  else root.JassAISchieber = factory(root.JassRules);
})(typeof window !== 'undefined' ? window : this, function (R) {
  'use strict';

  // Stufen: randomP = Anteil zufälliger Züge (leicht macht mehr Fehler, schwer spielt immer nach Regel)
  var LEVELS = {
    leicht: { trumpThreshold: 75, randomP: 0.4 },
    mittel: { trumpThreshold: 75, randomP: 0.12 },
    schwer: { trumpThreshold: 75, randomP: 0 },
    normal: { trumpThreshold: 75, randomP: 0.12 }
  };

  function trumpScore(hand, s) {
    var sc = 0, n = 0;
    var has = function (r) { return hand.some(function (c) { return c.s === s && c.r === r; }); };
    hand.forEach(function (c) {
      if (c.s === s) { n++; sc += R.PTS_TRUMP[c.r] + 6; }
    });
    if (has('U')) sc += 15;
    if (has('9')) sc += 10;
    if (has('U') && has('9')) sc += 5;
    if (n >= 4) sc += 10;
    return sc;
  }

  // Tiefster Wert zuerst, bei Gleichstand tiefster Rang; Trümpfe am Schluss.
  function dumpSort(a, b, trump) {
    var pa = R.cardPoints(a, trump), pb = R.cardPoints(b, trump);
    if (pa !== pb) return pa - pb;
    var ta = a.s === trump ? 1 : 0, tb = b.s === trump ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return R.ORDER_PLAIN[a.r] - R.ORDER_PLAIN[b.r];
  }

  function chooseLead(hand, trump, legal) {
    var trumps = hand.filter(function (c) { return c.s === trump; });
    var hasTop = trumps.some(function (c) { return c.r === 'U'; }) && trumps.some(function (c) { return c.r === '9'; });
    if (trumps.length >= 3 && hasTop) {
      return trumps.slice().sort(function (a, b) { return R.ORDER_TRUMP[b.r] - R.ORDER_TRUMP[a.r]; })[0];
    }
    var plain = legal.filter(function (c) { return c.s !== trump; });
    var aces = plain.filter(function (c) { return c.r === 'A'; });
    if (aces.length) return aces[0];
    var kings = plain.filter(function (c) { return c.r === 'K'; });
    if (kings.length) return kings[0];
    var pool = plain.length ? plain : legal;
    return pool.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
  }

  function createPlayer(opts) {
    opts = opts || {};
    var level = LEVELS[opts.level] ? opts.level : 'normal';
    var cfg = LEVELS[level];

    function chooseTrump(hand, o) {
      if (cfg.randomP && Math.random() < cfg.randomP) {
        return { action: 'choose', suit: R.SUITS[Math.floor(Math.random() * 4)], score: 0 };
      }
      var best = null, bestScore = -1;
      R.SUITS.forEach(function (s) {
        var sc = trumpScore(hand, s);
        if (sc > bestScore) { bestScore = sc; best = s; }
      });
      if (bestScore < cfg.trumpThreshold && o && o.canSchieben) {
        return { action: 'schieben', suit: null, score: bestScore };
      }
      return { action: 'choose', suit: best, score: bestScore };
    }

    // seat: Sitz des Spielers. Partner ist (seat + 2) % 4.
    function choosePlay(hand, plays, trump, seat) {
      if (cfg.randomP && Math.random() < cfg.randomP) {
        var all = R.legalCards(hand, plays, trump);
        return all[Math.floor(Math.random() * all.length)];
      }
      var legal = R.legalCards(hand, plays, trump);
      if (legal.length === 1) return legal[0];
      if (!plays.length) return chooseLead(hand, trump, legal);

      var w = R.winnerIndex(plays, trump);
      var winner = plays[w];
      var lead = plays[0].card.s;
      var pts = R.trickPoints(plays.map(function (p) { return p.card; }), trump);
      var last = plays.length === 3;
      var partnerWins = winner.seat === (seat + 2) % 4;
      var wins = legal.filter(function (c) { return R.beats(c, winner.card, lead, trump); });

      if (partnerWins) {
        if (last) return legal.slice().sort(function (a, b) { return dumpSort(b, a, trump); })[0];
        return legal.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
      }
      if (wins.length && (last || pts >= 10)) {
        return wins.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
      }
      return legal.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
    }

    return { level: level, chooseTrump: chooseTrump, choosePlay: choosePlay, trumpScore: trumpScore };
  }

  return { createPlayer: createPlayer, trumpScore: trumpScore };
});
