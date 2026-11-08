/*
 * Jass-Regeln (Schieber). Reine Logik ohne DOM.
 * Läuft im Browser (window.JassRules) und in Node-Tests (module.exports).
 */
(function (root) {
  'use strict';

  var SUITS = ['R', 'S', 'L', 'E']; // Rosen, Schellen, Schilten, Eichel
  var SUIT_NAME = { R: 'Rosen', S: 'Schellen', L: 'Schilten', E: 'Eichel' };
  var RANKS = ['6', '7', '8', '9', '10', 'U', 'O', 'K', 'A']; // aufsteigend nach Plain-Rang
  var PTS_TRUMP = { U: 20, '9': 14, A: 11, '10': 10, K: 4, O: 3, '8': 0, '7': 0, '6': 0 };
  var PTS_PLAIN = { A: 11, '10': 10, K: 4, O: 3, U: 2, '9': 0, '8': 0, '7': 0, '6': 0 };
  // Rangfolge: höhere Zahl = stärker
  var ORDER_TRUMP = { '6': 0, '7': 1, '8': 2, '10': 3, O: 4, K: 5, A: 6, '9': 7, U: 8 };
  var ORDER_PLAIN = { '6': 0, '7': 1, '8': 2, '9': 3, '10': 4, U: 5, O: 6, K: 7, A: 8 };
  // Obenabe (ohne Trumpf): 8 zählt 8 Punkte. Summe über alle Karten = 152.
  var PTS_OBENABE = { A: 11, '10': 10, K: 4, O: 3, U: 2, '8': 8, '9': 0, '7': 0, '6': 0 };
  var SEQ_PTS = { 3: 20, 4: 50, 5: 100 };
  var WEIS_LABEL = { 5: 'Vierling', 4: '5-Blatt', 3: '4-Blatt', 2: '2× 3-Blatt', 1: '3-Blatt' };
  var LAST_TRICK_BONUS = 5;
  var MATCH_BONUS = 100;
  var STOECK_PTS = 20;

  function makeDeck() {
    var d = [];
    SUITS.forEach(function (s) {
      RANKS.forEach(function (r) { d.push({ s: s, r: r, id: s + r }); });
    });
    return d;
  }

  function shuffle(a, rnd) {
    rnd = rnd || Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // trump === null bedeutet Obenabe (kein Trumpf gesetzt)
  function cardPoints(c, trump) {
    if (trump === null || trump === undefined) return PTS_OBENABE[c.r];
    return c.s === trump ? PTS_TRUMP[c.r] : PTS_PLAIN[c.r];
  }

  function trickPoints(cards, trump) {
    var n = 0;
    cards.forEach(function (c) { n += cardPoints(c, trump); });
    return n;
  }

  // Gibt true zurück, wenn Karte c die Karte cur im Stich schlägt.
  function beats(c, cur, led, trump) {
    var ct = c.s === trump, cut = cur.s === trump;
    if (ct !== cut) return ct;
    if (ct) return ORDER_TRUMP[c.r] > ORDER_TRUMP[cur.r];
    var cl = c.s === led, curl = cur.s === led;
    if (cl !== curl) return cl;
    if (!cl) return false;
    return ORDER_PLAIN[c.r] > ORDER_PLAIN[cur.r];
  }

  // plays: [{seat, card}] in Spielreihenfolge. Gibt den Index der Gewinnerkarte zurück.
  function winnerIndex(plays, trump) {
    var led = plays[0].card.s, best = 0;
    for (var i = 1; i < plays.length; i++) {
      if (beats(plays[i].card, plays[best].card, led, trump)) best = i;
    }
    return best;
  }

  // Erlaubte Karten für den nächsten Spieler.
  function legalCards(hand, plays, trump) {
    if (!plays.length) return hand.slice();
    var led = plays[0].card.s;
    var best = null;
    plays.forEach(function (p) {
      if (p.card.s === trump && (best === null || ORDER_TRUMP[p.card.r] > ORDER_TRUMP[best.r])) best = p.card;
    });
    var trumps = hand.filter(function (c) { return c.s === trump; });
    var plain = hand.filter(function (c) { return c.s !== trump; });
    var beatsBest = function (c) { return best ? ORDER_TRUMP[c.r] > ORDER_TRUMP[best.r] : true; };

    if (led === trump) {
      if (!trumps.length) return hand.slice();
      if (trumps.length === 1 && trumps[0].r === 'U') return hand.slice(); // Buur-Ausnahme
      var beaters = trumps.filter(beatsBest);
      if (beaters.length) return beaters;               // Übertrumpfen ist Pflicht
      return plain.length ? plain : trumps;             // Untertrumpfen verboten
    }

    var follow = hand.filter(function (c) { return c.s === led; });
    if (follow.length) {
      return follow.concat(trumps.filter(beatsBest));   // Farbe bedienen oder eintrumpfen
    }
    if (!trumps.length) return hand.slice();            // Freie Wahl
    var beat2 = trumps.filter(beatsBest);               // Stechzwang
    if (beat2.length) return beat2;
    return plain.length ? plain : trumps;
  }

  function fourPts(r) {
    if (r === 'U') return 200;
    if (r === '9') return 150;
    return 100;
  }

  // Beste Folgen in einer Liste von Karten (je Farbe, Läufe zerlegen).
  function bestRunPieces(L) {
    var dp = [0], from = [null], p, n;
    for (p = 1; p <= L; p++) {
      dp[p] = dp[p - 1];
      from[p] = null;
      for (n = 3; n <= 5 && n <= p; n++) {
        var v = dp[p - n] + SEQ_PTS[n];
        if (v > dp[p]) { dp[p] = v; from[p] = n; }
      }
    }
    var pieces = [];
    p = L;
    while (p > 0) {
      if (from[p] === null) { p--; }
      else { n = from[p]; pieces.unshift({ off: p - n, n: n }); p -= n; }
    }
    return pieces;
  }

  function bestSequences(cards) {
    var total = 0, melds = [];
    SUITS.forEach(function (s) {
      var byIdx = {};
      cards.forEach(function (c) { if (c.s === s) byIdx[ORDER_PLAIN[c.r]] = c; });
      var idx = Object.keys(byIdx).map(Number).sort(function (a, b) { return a - b; });
      var i = 0;
      while (i < idx.length) {
        var j = i;
        while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
        var start = idx[i];
        bestRunPieces(j - i + 1).forEach(function (pc) {
          var cs = [];
          for (var k = 0; k < pc.n; k++) cs.push(byIdx[start + pc.off + k]);
          total += SEQ_PTS[pc.n];
          melds.push({ type: 'seq', cards: cs, pts: SEQ_PTS[pc.n], n: pc.n, top: start + pc.off + pc.n - 1, suit: s });
        });
        i = j + 1;
      }
    });
    return { pts: total, melds: melds };
  }

  // Beste Weisen-Kombination einer Hand (Vier Gleiche + Folgen, keine Karte doppelt).
  function bestMelds(hand) {
    var fours = ['9', '10', 'U', 'O', 'K', 'A'].filter(function (r) {
      return hand.filter(function (c) { return c.r === r; }).length === 4;
    });
    var best = { pts: 0, melds: [] };
    for (var mask = 0; mask < (1 << fours.length); mask++) {
      var melds = [], removed = {}, pts = 0, k;
      for (k = 0; k < fours.length; k++) {
        if (mask & (1 << k)) {
          var r = fours[k];
          var cs = hand.filter(function (c) { return c.r === r; });
          cs.forEach(function (c) { removed[c.id] = true; });
          melds.push({ type: 'four', cards: cs, pts: fourPts(r), n: 4, top: ORDER_PLAIN[r], suit: null });
          pts += fourPts(r);
        }
      }
      var rest = hand.filter(function (c) { return !removed[c.id]; });
      var seq = bestSequences(rest);
      pts += seq.pts;
      melds = melds.concat(seq.melds);
      if (pts > best.pts) best = { pts: pts, melds: melds };
    }
    return best;
  }

  /*
   * Rundenwertung.
   * wonTricks: [team0Tricks, team1Tricks], jeder Stich = Array von Karten
   * o: { trump, matchBonus, doubled, weis:[a,b], stoeck:[a,b] }
   */
  function roundScore(wonTricks, lastTeam, o) {
    var card = [0, 0], match = [0, 0], t;
    for (t = 0; t < 2; t++) {
      wonTricks[t].forEach(function (cards) { card[t] += trickPoints(cards, o.trump); });
    }
    card[lastTeam] += LAST_TRICK_BONUS;
    if (o.matchBonus) {
      if (wonTricks[0].length === 9) match[0] = MATCH_BONUS;
      else if (wonTricks[1].length === 9) match[1] = MATCH_BONUS;
    }
    var f = o.doubled ? 2 : 1;
    var total = [0, 0];
    for (t = 0; t < 2; t++) {
      total[t] = (card[t] + match[t] + (o.stoeck[t] || 0) + (o.weis[t] || 0)) * f;
    }
    return { card: card, match: match, stoeck: o.stoeck, weis: o.weis, total: total, factor: f };
  }

  // ---- Weisen-Vergleich (nur die beste Weisen-Kombination eines Spielers zählt) ----
  // Rangfolge: Vierling > 5-Blatt > 4-Blatt > 2× 3-Blatt > 3-Blatt.
  // Gleiche Klasse: höhere oberste Karte gewinnt. Beim Vierling zählt zuerst der Wert (Under 200, Nell 150).
  function weisGreater(a, b) {
    if (!a) return false;
    if (!b) return true;
    if (a.cls !== b.cls) return a.cls > b.cls;
    if (a.cls === 5 && a.pts !== b.pts) return a.pts > b.pts;
    return a.top > b.top;
  }

  // Beste Weisen-Kombination einer Hand. Gibt null zurück, wenn es keine gibt.
  function bestWeis(hand) {
    var best = null;
    function consider(c) {
      c.label = WEIS_LABEL[c.cls];
      if (weisGreater(c, best)) best = c;
    }
    ['9', '10', 'U', 'O', 'K', 'A'].forEach(function (r) {
      var cs = hand.filter(function (c) { return c.r === r; });
      if (cs.length === 4) consider({ cls: 5, pts: fourPts(r), top: ORDER_PLAIN[r], cards: cs });
    });
    var windows3 = [];
    SUITS.forEach(function (s) {
      var idx = {};
      hand.forEach(function (c) { if (c.s === s) idx[ORDER_PLAIN[c.r]] = c; });
      for (var st = 0; st <= 8; st++) {
        for (var len = 3; len <= 5 && st + len - 1 <= 8; len++) {
          var cs = [], ok = true, k;
          for (k = 0; k < len; k++) {
            if (!idx[st + k]) { ok = false; break; }
            cs.push(idx[st + k]);
          }
          if (!ok) continue;
          var cand = { cls: len === 5 ? 4 : (len === 4 ? 3 : 1), pts: SEQ_PTS[len], top: st + len - 1, cards: cs, suit: s };
          if (len === 3) windows3.push(cand);
          else consider(cand);
        }
      }
    });
    windows3.forEach(consider);
    for (var i = 0; i < windows3.length; i++) {
      for (var j = i + 1; j < windows3.length; j++) {
        var a = windows3[i], b = windows3[j];
        var disjoint = a.cards.every(function (x) {
          return !b.cards.some(function (y) { return y.id === x.id; });
        });
        if (disjoint) {
          consider({ cls: 2, pts: 40, top: Math.max(a.top, b.top), cards: a.cards.concat(b.cards) });
        }
      }
    }
    return best;
  }

  // Alle Weisen eines Spielers zusammen: Summe der Punkte (keine Karte doppelt).
  // Gewinner wird nur nach dem besten Weis bestimmt, die Punkte zählen aber alle.
  // Rückgabe null, wenn kein Weis.
  function weisTotal(hand) {
    var m = bestMelds(hand);
    if (!m.melds.length || m.pts <= 0) return null;
    var melds = m.melds.map(function (x) {
      return { label: x.type === 'four' ? 'Vierling' : (x.n + '-Blatt'), pts: x.pts, cards: x.cards };
    });
    var cards = [];
    melds.forEach(function (x) { cards = cards.concat(x.cards); });
    return {
      pts: m.pts,
      melds: melds,
      cards: cards,
      label: melds.map(function (x) { return x.label; }).join(' + ')
    };
  }

  // anns: [{seat, best, total, order}] in Ansagereihenfolge. Gleich stark: wer zuerst ansagt, gewinnt.
  // Die Punkte des Gewinners sind die Summe aller seiner Weisen (total.pts).
  function resolveWeisAnn(anns) {
    var win = null;
    anns.forEach(function (a) {
      if (!win || weisGreater(a.best, win.best)) win = a;
      else if (!weisGreater(win.best, a.best) && a.order < win.order) win = a;
    });
    return win ? { seat: win.seat, best: win.best, pts: win.total.pts, label: win.total.label, cards: win.total.cards, melds: win.total.melds } : null;
  }

  // Tischweis: Weispunkte, die die vier Karten eines Stichs bilden (Molotow).
  function tischWeis(cards) {
    return bestMelds(cards).pts;
  }

  // Molotow: jeder bedient die Farbe, wenn er kann. Sonst darf er jede Karte spielen.
  function legalFree(hand, plays) {
    if (!plays.length) return hand.slice();
    var led = plays[0].card.s;
    var follow = hand.filter(function (c) { return c.s === led; });
    return follow.length ? follow : hand.slice();
  }

  var api = {
    WEIS_LABEL: WEIS_LABEL,
    bestWeis: bestWeis,
    weisGreater: weisGreater,
    resolveWeisAnn: resolveWeisAnn,
    weisTotal: weisTotal,
    tischWeis: tischWeis,
    legalFree: legalFree,
    PTS_OBENABE: PTS_OBENABE,
    SUITS: SUITS,
    SUIT_NAME: SUIT_NAME,
    RANKS: RANKS,
    PTS_TRUMP: PTS_TRUMP,
    PTS_PLAIN: PTS_PLAIN,
    ORDER_TRUMP: ORDER_TRUMP,
    ORDER_PLAIN: ORDER_PLAIN,
    STOECK_PTS: STOECK_PTS,
    LAST_TRICK_BONUS: LAST_TRICK_BONUS,
    makeDeck: makeDeck,
    shuffle: shuffle,
    cardPoints: cardPoints,
    trickPoints: trickPoints,
    beats: beats,
    winnerIndex: winnerIndex,
    legalCards: legalCards,
    bestMelds: bestMelds,
    roundScore: roundScore
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JassRules = api;
})(typeof window !== 'undefined' ? window : this);
