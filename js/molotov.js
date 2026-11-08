/*
 * Molotov: jeder für sich, kein Team. Wenigste Punkte gewinnen.
 *
 * Regeln (nach Angaben des Nutzers):
 * - Kein Trumpf am Anfang. Wer die Farbe nicht bedienen kann, legt eine Karte
 *   einer anderen Farbe. Diese Farbe ist ab jetzt Trumpf.
 * - Punkte pro Runde: Kartenpunkte + 5 für den letzten Stich + eigene Weisen + eigenes Stöck.
 * - Striche (Tallies): Punkte auf 10 runden, dann durch 10 teilen. 72 -> 7, 35 -> 4.
 * - Spielende: Punktelimit (Standard 50 Striche) oder feste Rundenzahl.
 *   Gewinner ist, wer am wenigsten Striche hat.
 * - Weisen und Stöck zählen nur für den Spieler, der sie hat.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./rules.js'), require('./ai.js'));
  else root.JassMolotov = factory(root.JassRules, root.JassAI);
})(typeof window !== 'undefined' ? window : this, function (R, AI) {
  'use strict';

  var DEFAULT_DELAYS = { deal: 1800, weis: 3000, aiMin: 2300, aiMax: 3200, trickShow: 2000, trump: 0 };
  var LIMIT_DEFAULT = 50;

  function tallies(points) {
    return Math.round(points / 10);
  }

  function Game(cfg) {
    cfg = cfg || {};
    this.cfg = {
      end: cfg.end === 'rounds' ? 'rounds' : 'limit',
      limit: cfg.limit || LIMIT_DEFAULT,
      rounds: cfg.rounds || 9,
      weis: cfg.weis !== false,
      stoeck: cfg.stoeck !== false,
      lastTrick: cfg.lastTrick !== false
    };
    this.delays = Object.assign({}, DEFAULT_DELAYS, cfg.delays || {});
    this.sched = cfg.sched || function (fn, ms) { return setTimeout(fn, ms); };
    this.rnd = cfg.rnd || Math.random;
    this.onUpdate = cfg.onUpdate || function () {};
    this.humanSeat = 0;
    this.n = 4;
    this.totals = [0, 0, 0, 0];   // Striche je Spieler
    this.points = [0, 0, 0, 0];   // Punkte je Spieler (ungerundet, gesamt)
    this.history = [];
    this.roundNo = 0;
    this.dealer = Math.floor(this.rnd() * 4);
    this.phase = 'idle';           // deal | play | roundEnd | gameEnd
    this.pending = false;
    this.gameWinners = [];
    this.lastScore = null;
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
    this.roundNo++;
    if (this.roundNo > 1) this.dealer = (this.dealer + 1) % 4;
    this.leader = (this.dealer + 1) % 4;   // Vorhand spielt aus
    var deck = R.shuffle(R.makeDeck(), this.rnd);
    this.hands = [0, 1, 2, 3].map(function (s) { return deck.slice(s * 9, s * 9 + 9); });
    this.trump = null;
    this.trumpSetBy = -1;
    this.plays = [];
    this.wonTricks = [[], [], [], []];   // Karten je Spieler
    this.trickWins = [0, 0, 0, 0];
    this.lastWinner = -1;
    this.stoeck = [0, 0, 0, 0];
    this.stoeckPair = [false, false, false, false];
    this.playedKO = [[], [], [], []];
    this.meldsBySeat = this.cfg.weis ? this.hands.map(function (h) { return R.bestMelds(h).melds; }) : [[], [], [], []];
    this.weisPts = this.meldsBySeat.map(function (ms) { return ms.reduce(function (a, m) { return a + m.pts; }, 0); });
    this.weisShown = false;
    this.trickNo = 0;
    this.lastEvent = null;
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

    if (this.trickNo === 0 && this.plays.length === 0 && !this.weisShown && this.cfg.weis) {
      this.weisShown = true;
      this.wait(this.delays.weis, null);
      return;
    }
    if (this.plays.length === 4) {
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
    if (this.plays.length >= 4) return null;
    return (this.leader + this.plays.length) % 4;
  };

  Game.prototype.playCard = function (seat, card) {
    if (this.phase !== 'play' || this.turnSeat() !== seat) return false;
    var legal = R.legalCards(this.hands[seat], this.plays, this.trump);
    if (!legal.some(function (c) { return c.id === card.id; })) return false;

    if (this.lastEvent && this.lastEvent.type === 'stoeck') this.lastEvent = null;

    // Trumpf setzen: wer nicht bedienen kann, legt eine andere Farbe.
    if (this.trump === null && this.plays.length > 0 && card.s !== this.plays[0].card.s) {
      this.setTrump(card.s, seat);
    }

    this.hands[seat] = this.hands[seat].filter(function (c) { return c.id !== card.id; });
    this.plays.push({ seat: seat, card: card });

    if (this.cfg.stoeck && this.trump && card.s === this.trump && (card.r === 'K' || card.r === 'O')) {
      this.playedKO[seat].push(card.r);
      if (this.stoeckPair[seat] && this.playedKO[seat].length === 2) {
        this.stoeck[seat] += R.STOECK_PTS;
        this.lastEvent = { type: 'stoeck', seat: seat };
      }
    }
    this.emit();
    this.tick();
    return true;
  };

  Game.prototype.setTrump = function (suit, seat) {
    this.trump = suit;
    this.trumpSetBy = seat;
    this.stoeckPair = this.hands.map(function (h) {
      var k = h.some(function (c) { return c.s === suit && c.r === 'K'; });
      var o = h.some(function (c) { return c.s === suit && c.r === 'O'; });
      return k && o;
    });
    this.lastEvent = { type: 'trump', suit: suit, seat: seat };
  };

  Game.prototype.aiPlay = function () {
    var seat = this.turnSeat();
    var card = AI.choosePlay(this.hands[seat], this.plays, this.trump, seat, { solo: true });
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
    return R.legalCards(this.hands[this.humanSeat], this.plays, this.trump).map(function (c) { return c.id; });
  };

  Game.prototype.finishTrick = function () {
    var w = R.winnerIndex(this.plays, this.trump);
    var winner = this.plays[w].seat;
    this.wonTricks[winner].push(this.plays.map(function (p) { return p.card; }));
    this.trickWins[winner]++;
    this.lastWinner = winner;
    this.plays = [];
    this.trickNo++;
    this.leader = winner;
    this.lastEvent = null;
    if (this.trickNo === 9) this.endRound();
  };

  Game.prototype.endRound = function () {
    var self = this;
    var trump = this.trump;
    var raw = [0, 0, 0, 0];
    var cardPts = [0, 0, 0, 0];
    var bonus = [0, 0, 0, 0];
    this.wonTricks.forEach(function (tricks, s) {
      tricks.forEach(function (cards) { cardPts[s] += R.trickPoints(cards, trump); });
    });
    if (this.cfg.lastTrick) bonus[this.lastWinner] += R.LAST_TRICK_BONUS;
    var weis = this.weisPts.slice();
    var stoeck = this.stoeck.slice();
    for (var s = 0; s < 4; s++) raw[s] = cardPts[s] + bonus[s] + weis[s] + stoeck[s];

    var t = raw.map(tallies);
    for (s = 0; s < 4; s++) {
      this.totals[s] += t[s];
      this.points[s] += raw[s];
    }
    this.lastScore = { card: cardPts, bonus: bonus, weis: weis, stoeck: stoeck, raw: raw, tallies: t, trump: trump, round: this.roundNo };
    this.history.push({ round: this.roundNo, trump: trump, tallies: t.slice(), totals: this.totals.slice() });

    var done = false;
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
      trump: this.trump,
      trumpSetBy: this.trumpSetBy,
      trickNo: this.trickNo,
      plays: this.plays,
      hands: this.hands,
      trickWins: this.trickWins,
      leader: this.leader,
      dealer: this.dealer,
      totals: this.totals,
      points: this.points,
      cfg: this.cfg,
      meldsBySeat: this.meldsBySeat,
      weisPts: this.weisPts,
      lastEvent: this.lastEvent,
      lastScore: this.lastScore,
      history: this.history,
      gameWinners: this.gameWinners,
      turnSeat: this.phase === 'play' ? this.turnSeat() : null,
      legal: this.humanLegal()
    };
  };

  return { Game: Game, DEFAULT_DELAYS: DEFAULT_DELAYS, LIMIT_DEFAULT: LIMIT_DEFAULT, tallies: tallies };
});
