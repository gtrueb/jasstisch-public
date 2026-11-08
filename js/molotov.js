/*
 * Molotov: jeder für sich, kein Team. Wenigste Striche gewinnen.
 * Spielerzahl: 4 (je 9 Karten, 9 Stiche) oder 3 (je 12 Karten, 12 Stiche).
 *
 * Regeln (jassverzeichnis.ch und Angaben des Nutzers):
 * - Jede Runde beginnt in Obenabe (kein Trumpf). Wer zuerst die Farbe nicht bedienen kann,
 *   legt eine Karte einer anderen Farbe. Diese Farbe ist ab jetzt Trumpf.
 * - Farbe bedienen ist Pflicht. Ohne Farbe darf man jede Karte spielen (Untertrumpfen erlaubt).
 * - Weisen (Hand): nur im ersten Stich, nur auf dem eigenen Zug. Nur die stärkste Weisen-
 *   Kombination aller Spieler zählt. Ihr Besitzer bekommt die Punkte als Minus.
 * - Tischweis: bilden die Karten eines Stichs einen Weis, bekommt der Stichgewinner die Punkte (Plus).
 * - Stöck (König + Ober des Trumpfs, beide noch auf der Hand nach der Trumpfwahl): -20 für den Besitzer.
 * - Letzter Stich: +5.
 * - Striche = Punkte auf 10 gerundet, dann durch 10 geteilt (72 -> 7, 35 -> 4).
 * - Spielende: Limit (Standard 50 Striche) oder feste Rundenzahl (8 Runden laut Anleitung).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'), require('./ai-molotov.js'));
  else root.JassMolotov = factory(root.JassRules, root.JassAIMolotov);
})(typeof window !== 'undefined' ? window : this, function (R, AIM) {
  'use strict';

  var DEFAULT_DELAYS = { deal: 1800, aiMin: 2000, aiMax: 2900, trickShow: 4000 };
  var LIMIT_DEFAULT = 50;
  var ROUNDS_DEFAULT = 8;
  var STOECK = 20;
  var LAST_TRICK = 5;

  // Striche: Betrag auf 10 runden, dann durch 10 teilen. Vorzeichen bleibt.
  function tallies(points) {
    var sign = points < 0 ? -1 : 1;
    return sign * Math.round(Math.abs(points) / 10);
  }

  function zeros(n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(0);
    return a;
  }

  function Game(cfg) {
    cfg = cfg || {};
    this.cfg = {
      players: cfg.players === 3 ? 3 : 4,
      end: cfg.end === 'rounds' ? 'rounds' : 'limit',
      limit: cfg.limit || LIMIT_DEFAULT,
      rounds: cfg.rounds || ROUNDS_DEFAULT,
      weis: cfg.weis !== false,
      stoeck: cfg.stoeck !== false,
      lastTrick: cfg.lastTrick !== false
    };
    this.n = this.cfg.players;
    this.delays = Object.assign({}, DEFAULT_DELAYS, cfg.delays || {});
    this.sched = cfg.sched || function (fn, ms) {
      return (typeof window !== 'undefined' && window.JassClock) ? window.JassClock.sched(fn, ms) : setTimeout(fn, ms);
    };
    this.rnd = cfg.rnd || Math.random;
    this.onUpdate = cfg.onUpdate || function () {};
    this.ai = AIM.createPlayer({ level: cfg.aiLevel || 'normal' });
    this.humanSeat = 0;
    this.totals = zeros(this.n);       // Striche je Spieler (Plus minus Minus)
    this.plusStr = zeros(this.n);      // Plus-Striche je Spieler (Kartenpunkte, Tischweis, letzter Stich)
    this.minusStr = zeros(this.n);     // Minus-Striche je Spieler (Weis aus der Hand, Stöck)
    this.history = [];
    this.roundNo = 0;
    this.dealer = Math.floor(this.rnd() * this.n);
    this.phase = 'idle';               // deal | play | roundEnd | gameEnd
    this.pending = false;
    this.gameWinners = [];
    this.lastScore = null;
    this.lastEvent = null;
    this.tischEvents = [];             // [{seat, pts, trick}] je Stich mit Tischweis
  }

  Game.prototype.emit = function () { this.onUpdate(this); };

  Game.prototype.wait = function (ms, fn) {
    var self = this;
    if (this.pending) return;
    this.pending = true;
    this.sched(function () {
      self.pending = false;
      if (fn) fn();
      self.emit();
      self.tick();
    }, ms);
  };

  Game.prototype.startRound = function () {
    var n = this.n;
    this.roundNo++;
    if (this.roundNo > 1) this.dealer = (this.dealer + 1) % n;
    this.leader = (this.dealer + 1) % n;   // Vorhand spielt aus
    this.per = 36 / n;                     // Karten je Spieler (9 oder 12)
    var deck = R.shuffle(R.makeDeck(), this.rnd);
    this.hands = [];
    for (var s = 0; s < n; s++) this.hands.push(deck.slice(s * this.per, (s + 1) * this.per));
    this.trump = null;                     // null = Obenabe
    this.trumpSetBy = -1;
    this.plays = [];
    this.wonTricks = [];
    for (s = 0; s < n; s++) this.wonTricks.push([]);
    this.trickWins = zeros(n);
    this.lastWinner = -1;
    this.tisch = zeros(n);
    this.stoeck = zeros(n);
    this.stoeckPair = zeros(n).map(function () { return false; });
    this.playedKO = [];
    for (s = 0; s < n; s++) this.playedKO.push([]);
    this.trickNo = 0;
    this.lastEvent = null;
    this.weisDecided = zeros(n).map(function () { return false; });
    this.weisAnn = [];
    this.annCounter = 0;
    this.weisRes = null;                   // stärkste Weisen-Kombination (Minus für den Besitzer)
    this.tischEvents = [];
    this.phase = 'deal';
    this.emit();
    this.tick();
  };

  Game.prototype.tick = function () {
    if (this.pending) return;
    if (this.phase === 'deal') {
      this.wait(this.delays.deal, function () { this.phase = 'play'; }.bind(this));
      return;
    }
    if (this.phase !== 'play') return;

    if (this.plays.length === this.n) {
      this.wait(this.delays.trickShow, this.finishTrick.bind(this));
      return;
    }
    var seat = this.turnSeat();
    if (seat !== this.humanSeat) {
      var ms = this.delays.aiMin + Math.floor(this.rnd() * (this.delays.aiMax - this.delays.aiMin + 1));
      this.wait(ms, this.aiPlay.bind(this));
    }
  };

  // Sitz, der als Nächstes spielt. null, solange der Stich fertig angezeigt wird.
  Game.prototype.turnSeat = function () {
    if (this.plays.length >= this.n) return null;
    return (this.leader + this.plays.length) % this.n;
  };

  // Weis ansagen: nur im ersten Stich, nur auf dem eigenen Zug, nur einmal.
  Game.prototype.announceWeis = function (seat) {
    if (!this.cfg.weis || this.trickNo !== 0 || this.phase !== 'play') return false;
    if (this.turnSeat() !== seat || this.weisDecided[seat]) return false;
    this.weisDecided[seat] = true;
    var best = R.bestWeis(this.hands[seat]);
    var total = best ? R.weisTotal(this.hands[seat]) : null;
    if (best && total) this.weisAnn.push({ seat: seat, best: best, total: total, order: ++this.annCounter });
    this.lastEvent = total ? { type: 'weis', seat: seat, label: total.label, pts: total.pts } : this.lastEvent;
    return !!best;
  };

  Game.prototype.humanAnnounce = function () {
    var ok = this.announceWeis(this.humanSeat);
    this.emit();
    return ok;
  };

  Game.prototype.humanBestWeis = function () {
    return R.weisTotal(this.hands[this.humanSeat] || []);
  };

  // Ids der Karten des eigenen angesagten Weis (zum Hervorheben), sonst [].
  Game.prototype.humanWeisIds = function () {
    // Nur markieren, solange man am Zug ist und den Weis noch nicht bestätigt hat.
    if (this.phase !== 'play' || this.trickNo !== 0 || this.turnSeat() !== this.humanSeat || this.weisDecided[this.humanSeat]) return [];
    var t = R.weisTotal(this.hands[this.humanSeat] || []);
    return t ? t.cards.map(function (c) { return c.id; }) : [];
  };

  Game.prototype.playCard = function (seat, card) {
    if (this.phase !== 'play' || this.turnSeat() !== seat) return false;
    var legal = R.legalFree(this.hands[seat], this.plays);
    if (!legal.some(function (c) { return c.id === card.id; })) return false;

    // Wer im ersten Stich spielt, ohne anzusagen, verzichtet auf seinen Weis.
    if (this.trickNo === 0 && !this.weisDecided[seat]) this.weisDecided[seat] = true;
    if (this.lastEvent && (this.lastEvent.type === 'stoeck' || this.lastEvent.type === 'weis')) this.lastEvent = null;

    // Trumpf setzen: wer die Farbe nicht bedienen kann, legt eine andere Farbe.
    if (this.trump === null && this.plays.length > 0 && card.s !== this.plays[0].card.s) {
      this.setTrump(card.s, seat);
    }

    this.hands[seat] = this.hands[seat].filter(function (c) { return c.id !== card.id; });
    this.plays.push({ seat: seat, card: card });

    if (this.cfg.stoeck && this.trump !== null && card.s === this.trump && (card.r === 'K' || card.r === 'O')) {
      this.playedKO[seat].push(card.r);
      if (this.stoeckPair[seat] && this.playedKO[seat].length === 2) {
        this.stoeck[seat] += STOECK;
        this.lastEvent = { type: 'stoeck', seat: seat };
      }
    }
    this.emit();
    this.tick();
    return true;
  };

  Game.prototype.setTrump = function (suit, seat) {
    var self = this;
    this.trump = suit;
    this.trumpSetBy = seat;
    // Stöck gilt nur, wenn beide Karten nach der Trumpfwahl noch auf der Hand sind.
    this.stoeckPair = this.hands.map(function (h) {
      var k = h.some(function (c) { return c.s === suit && c.r === 'K'; });
      var o = h.some(function (c) { return c.s === suit && c.r === 'O'; });
      return k && o;
    });
    this.lastEvent = { type: 'trump', suit: suit, seat: seat };
    void self;
  };

  Game.prototype.aiPlay = function () {
    var seat = this.turnSeat();
    if (this.trickNo === 0 && !this.weisDecided[seat]) this.announceWeis(seat);
    var card = this.ai.choosePlay(this.hands[seat], this.plays, this.trump, seat);
    this.playCard(seat, card);
  };

  Game.prototype.humanPlay = function (cardId) {
    if (this.turnSeat() !== this.humanSeat || this.phase !== 'play') return false;
    var card = this.hands[this.humanSeat].filter(function (c) { return c.id === cardId; })[0];
    if (!card) return false;
    return this.playCard(this.humanSeat, card);
  };

  Game.prototype.humanLegal = function () {
    if (this.phase !== 'play' || this.turnSeat() !== this.humanSeat) return [];
    return R.legalFree(this.hands[this.humanSeat], this.plays).map(function (c) { return c.id; });
  };

  Game.prototype.finishTrick = function () {
    var cards = this.plays.map(function (p) { return p.card; });
    var w = R.winnerIndex(this.plays, this.trump);
    var winner = this.plays[w].seat;
    this.wonTricks[winner].push(cards);
    this.trickWins[winner]++;
    var tp = R.tischWeis(cards);
    if (tp > 0) {
      this.tisch[winner] += tp;
      this.tischEvents.push({ seat: winner, pts: tp, trick: this.trickNo + 1 });
    }
    this.plays = [];
    this.trickNo++;
    this.lastWinner = winner;
    this.leader = winner;
    this.lastEvent = null;
    if (this.trickNo === 1) this.weisRes = R.resolveWeisAnn(this.weisAnn);
    if (this.trickNo === this.per) this.endRound();
  };

  Game.prototype.endRound = function () {
    var self = this, n = this.n;
    var trump = this.trump;
    var card = zeros(n), bonus = zeros(n), weis = zeros(n);
    this.wonTricks.forEach(function (tricks, s) {
      tricks.forEach(function (cards) { card[s] += R.trickPoints(cards, trump); });
    });
    if (this.cfg.lastTrick) bonus[this.lastWinner] += LAST_TRICK;
    if (this.weisRes) weis[this.weisRes.seat] = this.weisRes.pts;

    // Plus und Minus werden getrennt auf Striche gerundet (wie auf der Jasstafel).
    var raw = zeros(n), t = zeros(n), ps = zeros(n), ms = zeros(n), s;
    for (s = 0; s < n; s++) {
      var plusPts = card[s] + bonus[s] + this.tisch[s];
      var minusPts = weis[s] + this.stoeck[s];
      ps[s] = tallies(plusPts);
      ms[s] = tallies(minusPts);
      this.plusStr[s] += ps[s];
      this.minusStr[s] += ms[s];
      raw[s] = plusPts - minusPts;
      t[s] = ps[s] - ms[s];
      this.totals[s] += t[s];
    }
    this.lastScore = {
      round: this.roundNo, trump: trump, n: n,
      card: card, bonus: bonus, tisch: this.tisch.slice(), weis: weis.map(function (x) { return -x; }),
      stoeck: this.stoeck.map(function (x) { return -x; }),
      raw: raw, tallies: t, plusStrokes: ps, minusStrokes: ms
    };
    this.history.push({ round: this.roundNo, trump: trump, tallies: t.slice(), totals: this.totals.slice() });

    var done;
    if (this.cfg.end === 'limit') {
      done = this.totals.some(function (x) { return x >= self.cfg.limit; });
    } else {
      done = this.roundNo >= this.cfg.rounds;
    }
    if (done) {
      var min = Math.min.apply(null, this.totals);
      this.gameWinners = [];
      this.totals.forEach(function (x, i) { if (x === min) self.gameWinners.push(i); });
      this.phase = 'gameEnd';
    } else {
      this.phase = 'roundEnd';
    }
  };

  Game.prototype.nextRound = function () {
    if (this.phase !== 'roundEnd') return false;
    this.startRound();
    return true;
  };

  Game.prototype.stateForUI = function () {
    return {
      phase: this.phase,
      n: this.n,
      trump: this.trump,
      trumpSetBy: this.trumpSetBy,
      trickNo: this.trickNo,
      plays: this.plays,
      hands: this.hands,
      trickWins: this.trickWins,
      leader: this.leader,
      dealer: this.dealer,
      totals: this.totals,
      plusStr: this.plusStr.slice(),
      minusStr: this.minusStr.slice(),
      cfg: this.cfg,
      weisAnn: this.weisAnn.map(function (a) { return { seat: a.seat, label: a.total.label, pts: a.total.pts, order: a.order }; }),
      weisRes: this.weisRes ? { seat: this.weisRes.seat, label: this.weisRes.label, pts: this.weisRes.pts, cards: this.weisRes.cards } : null,
      humanBest: this.phase === 'play' && this.trickNo === 0 && !this.weisDecided[this.humanSeat] ? this.humanBestWeis() : null,
      humanWeisDone: this.weisDecided[this.humanSeat],
      humanWeisIds: this.humanWeisIds(),
      roundTisch: this.tisch.slice(),
      roundStoeck: this.stoeck.slice(),
      tischEvents: this.tischEvents,
      lastEvent: this.lastEvent,
      lastScore: this.lastScore,
      history: this.history,
      gameWinners: this.gameWinners,
      turnSeat: this.phase === 'play' ? this.turnSeat() : null,
      legal: this.humanLegal()
    };
  };

  return { Game: Game, DEFAULT_DELAYS: DEFAULT_DELAYS, LIMIT_DEFAULT: LIMIT_DEFAULT, ROUNDS_DEFAULT: ROUNDS_DEFAULT, tallies: tallies };
});
