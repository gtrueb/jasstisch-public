/*
 * Sicht pro Spieler. Der Host rechnet den vollen Spielstand und gibt jedem Spieler
 * eine eigene Ansicht: der eigene Platz ist immer Platz 0 (unten), die Hände der
 * anderen sind nur Anzahl (null-Karten), die Namen gehören zu den Plätzen.
 * Reine Funktion, läuft im Browser und in Node-Tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JassView = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function rotArr(arr, off, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(arr[(off + i) % n]);
    return out;
  }

  // Ansicht für den Platz "me". gtype: 'schieber' | 'molotov'. names: Namen je Platz (Originalreihenfolge).
  function buildView(st, me, names, gtype) {
    var n = st.hands.length;
    var sm = function (s) { return (s === null || s === undefined || s < 0) ? s : (s - me + n) % n; };
    var teamOff = me % 2;
    var tm = function (t) { return (t - teamOff + 2) % 2; };
    var v = {};
    v.gtype = gtype;
    v.n = n;
    v.me = 0;
    v.names = rotArr(names || [], me, n);
    v.hands = rotArr(st.hands, me, n).map(function (h, i) {
      return i === 0 ? h : h.map(function () { return null; });
    });
    v.phase = st.phase;
    v.trump = st.trump;
    v.trickNo = st.trickNo;
    v.plays = st.plays.map(function (p) { return { seat: sm(p.seat), card: p.card }; });
    v.trickWins = rotArr(st.trickWins, me, n);
    v.leader = sm(st.leader);
    v.turnSeat = sm(st.turnSeat);
    v.dealer = sm(st.dealer);
    v.vorhand = sm(st.vorhand);
    v.chooser = sm(st.chooser);
    v.canSchieben = st.canSchieben;
    v.schellen7Holder = sm(st.schellen7Holder);
    v.trumpSetBy = sm(st.trumpSetBy);
    v.weisAnn = (st.weisAnn || []).map(function (a) { return Object.assign({}, a, { seat: sm(a.seat) }); });
    v.weisRes = st.weisRes ? Object.assign({}, st.weisRes, { seat: sm(st.weisRes.seat) }) : null;
    v.weisHold = st.weisHold;
    v.humanBest = st.humanBest;
    v.humanWeisDone = st.humanWeisDone;
    v.humanWeisIds = st.humanWeisIds || [];
    v.legal = st.legal || [];
    v.tischEvents = (st.tischEvents || []).map(function (e) { return Object.assign({}, e, { seat: sm(e.seat) }); });
    v.lastEvent = st.lastEvent ? Object.assign({}, st.lastEvent, { seat: sm(st.lastEvent.seat) }) : null;
    v.cfg = st.cfg;
    v.history = st.history || [];
    v.gameWinners = st.gameWinners || [];

    if (gtype === 'schieber') {
      // Teams: Platz 0+2 gegen 1+3. Das eigene Team ist immer Team 0.
      v.totals = rotArr(st.totals, teamOff, 2);
      v.target = st.target;
      v.teamNames = [v.names[0] + ' & ' + v.names[2], v.names[1] + ' & ' + v.names[3]];
      v.history = (st.history || []).map(function (h) {
        return Object.assign({}, h, { totals: rotArr(h.totals, teamOff, 2), score: rotScore(h.score, teamOff, ['card', 'match', 'stoeck', 'weis', 'total']) });
      });
      v.lastScore = st.lastScore ? rotScore(st.lastScore, teamOff, ['card', 'match', 'stoeck', 'weis', 'total']) : null;
      if (v.lastScore && st.lastScore) v.lastScore.weisSeat = sm(st.lastScore.weisSeat);
      v.gameWinner = (st.gameWinner === null || st.gameWinner === undefined) ? null : tm(st.gameWinner);
    } else {
      v.totals = rotArr(st.totals, me, n);
      v.plusStr = st.plusStr ? rotArr(st.plusStr, me, n) : undefined;
      v.minusStr = st.minusStr ? rotArr(st.minusStr, me, n) : undefined;
      v.roundTisch = st.roundTisch ? rotArr(st.roundTisch, me, n) : undefined;
      v.roundStoeck = st.roundStoeck ? rotArr(st.roundStoeck, me, n) : undefined;
      v.history = (st.history || []).map(function (h) {
        return Object.assign({}, h, { totals: rotArr(h.totals, me, n), tallies: rotArr(h.tallies, me, n) });
      });
      v.lastScore = st.lastScore ? rotScore(st.lastScore, me, ['card', 'bonus', 'tisch', 'weis', 'stoeck', 'raw', 'tallies', 'plusStrokes', 'minusStrokes'], n) : null;
      if (v.lastScore && st.lastScore) v.lastScore.weisSeat = sm(st.lastScore.weisSeat);
      v.gameWinners = (st.gameWinners || []).map(sm);
      v.trumpSetBy = sm(st.trumpSetBy);
    }
    return v;

    function rotScore(sc, off, keys, len) {
      var out = Object.assign({}, sc);
      keys.forEach(function (k) {
        if (Array.isArray(sc[k])) out[k] = rotArr(sc[k], off, len || 2);
      });
      return out;
    }
  }

  return { buildView: buildView, rotArr: rotArr };
});
