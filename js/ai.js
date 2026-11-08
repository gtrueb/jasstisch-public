/*
 * Einfache Computer-Gegner für Schieber.
 * Nutzt die Regel-Logik aus rules.js.
 */
(function (root) {
  'use strict';

  var R = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.JassRules;

  var TRUMP_THRESHOLD = 75;

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

  // Entscheidet Trumpf oder Schieben.
  function chooseTrump(hand, opts) {
    var best = null, bestScore = -1;
    R.SUITS.forEach(function (s) {
      var sc = trumpScore(hand, s);
      if (sc > bestScore) { bestScore = sc; best = s; }
    });
    if (bestScore < TRUMP_THRESHOLD && opts && opts.canSchieben) {
      return { action: 'schieben', suit: null, score: bestScore };
    }
    return { action: 'choose', suit: best, score: bestScore };
  }

  function rankOf(c) { return R.ORDER_PLAIN[c.r]; }

  // Tiefster Wert zuerst, bei Gleichstand tiefster Rang; Trümpfe am Schluss.
  function dumpSort(a, b, trump) {
    var pa = R.cardPoints(a, trump), pb = R.cardPoints(b, trump);
    if (pa !== pb) return pa - pb;
    var ta = a.s === trump ? 1 : 0, tb = b.s === trump ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return rankOf(a) - rankOf(b);
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

  // Wählt eine Karte für Sitz "seat". opts.solo = true: jeder spielt für sich (Molotov).
  function choosePlay(hand, plays, trump, seat, opts) {
    var solo = !!(opts && opts.solo);
    var legal = R.legalCards(hand, plays, trump);
    if (legal.length === 1) return legal[0];
    if (!plays.length) return chooseLead(hand, trump, legal);

    // Noch kein Trumpf und die Farbe kann nicht bedient werden: diese Karte setzt den Trumpf.
    if (!trump) {
      var led0 = plays[0].card.s;
      if (!hand.some(function (c) { return c.s === led0; })) {
        var bestS = null, bestSc = -1;
        R.SUITS.forEach(function (s) {
          if (s === led0 || !hand.some(function (c) { return c.s === s; })) return;
          var sc = trumpScore(hand, s);
          if (sc > bestSc) { bestSc = sc; bestS = s; }
        });
        return hand.filter(function (c) { return c.s === bestS; })
          .sort(function (a, b) { return dumpSort(a, b, null); })[0];
      }
    }

    var w = R.winnerIndex(plays, trump);
    var winner = plays[w];
    var lead = plays[0].card.s;
    var pts = R.trickPoints(plays.map(function (p) { return p.card; }), trump);
    var last = plays.length === 3;
    var partnerWins = !solo && winner.seat === (seat + 2) % 4;
    var wins = legal.filter(function (c) { return R.beats(c, winner.card, lead, trump); });

    if (partnerWins) {
      if (last) {
        // Partner gewinnt sicher: Punkte abgeben
        return legal.slice().sort(function (a, b) { return dumpSort(b, a, trump); })[0];
      }
      return legal.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
    }
    if (wins.length && (last || pts >= 10)) {
      return wins.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
    }
    return legal.slice().sort(function (a, b) { return dumpSort(a, b, trump); })[0];
  }

  var api = { chooseTrump: chooseTrump, choosePlay: choosePlay, trumpScore: trumpScore };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JassAI = api;
})(typeof window !== 'undefined' ? window : this);
