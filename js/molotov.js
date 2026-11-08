/*
 * Molotov: jeder für sich, kein Team. Wenigste Striche gewinnen.
 *
 * Regeln:
 * - Jede Runde beginnt in Obenabe (kein Trumpf). Wer zuerst die Farbe nicht bedienen kann,
 *   legt eine Karte einer anderen Farbe. Diese Farbe ist ab jetzt Trumpf.
 * - Farbe bedienen ist Pflicht. Ohne Farbe darf man jede Karte spielen (Untertrumpfen erlaubt).
 * - Weisen (Handkarten): nur im ersten Stich, nur auf dem eigenen Zug. Nur die stärkste Weisen-
 *   Kombination aller Spieler zählt. Ihr Besitzer bekommt die Punkte als Minus.
 * - Tischweis: bilden die vier Karten eines Stichs einen Weis, bekommt der Stichgewinner die Punkte (Plus).
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

  var DEFAULT_DELAYS = { deal: 1800, aiMin: 2300, aiMax: 3200, trickShow: 2000 };
  var LIMIT_DEFAULT = 50;
  var ROUNDS_DEFAULT = 8;
  var STOECK = 20;
  var LAST_TRICK = 5;

  // Striche: Betrag auf 10 runden, dann durch 10 teilen. Vorzeichen bleibt.
  function tallies(points) {
    var sign = points < 0 ? -1 : 1;
    return sign * Math.round(Math.abs(points) / 10);
  }

  function Game(cfg) {
    cfg = cfg || {};
    this.cfg = {
      end: cfg.end === 'rounds' ? 'rounds' : 'limit',
      limit: cfg.limit || LIMIT_DEFAULT,
      rounds: cfg.rounds || ROUNDS_DEFAULT,
      weis: cfg.weis !== false,
      stoeck: cfg.stoeck !== false,
      lastTrick: cfg.lastTrick !== false
    };
    this.delays = Object.assign({}, DEFAULT_DELAYS, cfg.delays || {});
    this.sched = cfg.sched || function (fn, ms) { return setTimeout(fn, ms); };
    this.rnd = cfg.rnd || Math.random;
    this.onUpdate = cfg.onUpdate || function () {};
    this.ai = AIM.createPlayer({ level: cfg.aiLevel || 'normal' });
    this.humanSeat = 0;
    this.totals = [0, 0, 0, 0];   // Striche je Spieler
    this.history = [];
    this.roundNo = 0;
    this.dealer = Math.floor(this.rnd() * 4);
    this.phase = 'idle';          // deal | play | roundEnd | gameEnd
    this.pending = false;
    this.gameWinners = [];
    this.lastScore = null;
    this.lastEvent = null;
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
    this.trump = null;                     // null = Obenabe
    this.trumpSetBy = -1;
    this.plays = [];
    this.wonTricks = [[], [], [], []];
    this.trickWins = [0, 0, 0, 0];
    this.lastWinner = -1;
    this.tisch = [0, 0, 0, 0];             // Tischweis-Punkte je Spieler (Plus)
    this.stoeck = [0, 0, 0, 0];            // Stöck je Spieler (Minus)
    this.stoeckPair = [false, false, false, false];
    this.playedKO = [[], [], [], []];
    this.trickNo = 0;
    this.lastEvent = null;
    this.weisDecided = [false, false, false, false];
    this.weisAnn = [];
    this.annCounter = 0;
    this.weisRes = null;                   // stärkste Weisen-Kombination (Minus für den Besitzer)
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

  // Weis ansagen: nur im ersten Stich, nur auf dem eigenen Zug, nur einmal.
  Game.prototype.announceWeis = function (seat) {
    if (!this.cfg.weis || this.trickNo !== 0 || this.phase !== 'play') return false;
    if (this.turnSeat() !== seat || this.weisDecided[seat]) return false;
    this.weisDecided[seat] = true;
    var best = R.bestWeis(this.hands[seat]);
    if (best) this.weisAnn.push({ seat: seat, best: best, order: ++this.annCounter });
    this.lastEvent = best ? { type: 'weis', seat: seat, label: best.label, pts: best.pts } : this.lastEvent;
    return !!best;
  };

  Game.prototype.humanAnnounce = function () {
    var ok = this.announceWeis(this.humanSeat);
    this.emit();
    return ok;
  };

  Game.prototype.humanBestWeis = function () {
    return R.bestWeis(this.hands[this.humanSeat] || []);
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

    if (this.cfg.stoeck && this.trump && card.s === this.trump && (card.r === 'K' || card.r === 'O')) {
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
    this.trump = suit;
    this.trumpSetBy = seat;
    // Stöck gilt nur, wenn beide Karten nach der Trumpfwahl noch auf der Hand sind.
    this.stoeckPair = this.hands.map(function (h) {
      var k = h.some(function (c) { return c.s === suit && c.r === 'K'; });
      var o = h.some(function (c) { return c.s === suit && c.r === 'O'; });
      return k && o;
    });
    this.lastEvent = { type: 'trump', suit: suit, seat: seat };
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
    if (this.phase !== 'play' || this.turnSeat() !== this.humanSeat || this.plays.length === 4) return [];
    return R.legalFree(this.hands[this.humanSeat], this.plays).map(function (c) { return c.id; });
  };

  Game.prototype.finishTrick = function () {
    var cards = this.plays.map(function (p) { return p.card; });
    var w = R.winnerIndex(this.plays, this.trump);
    var winner = this.plays[w].seat;
    this.wonTricks[winner].push(cards);
    this.trickWins[winner]++;
    this.tisch[winner] += R.tischWeis(cards);
    this.plays = [];
    this.trickNo++;
    this.lastWinner = winner;
    this.leader = winner;
    this.lastEvent = null;
    if (this.trickNo === 1) this.weisRes = R.resolveWeisAnn(this.weisAnn);
    if (this.trickNo === 9) this.endRound();
  };

  Game.prototype.endRound = function () {
    var self = this;
    var trump = this.trump;
    var card = [0, 0, 0, 0], bonus = [0, 0, 0, 0], weis = [0, 0, 0, 0];
    this.wonTricks.forEach(function (tricks, s) {
      tricks.forEach(function (cards) { card[s] += R.trickPoints(cards, trump); });
    });
    if (this.cfg.lastTrick) bonus[this.lastWinner] += LAST_TRICK;
    if (this.weisRes) weis[this.weisRes.seat] = this.weisRes.pts;

    var raw = [0, 0, 0, 0], t = [0, 0, 0, 0], s;
    for (s = 0; s < 4; s++) {
      raw[s] = card[s] + bonus[s] + this.tisch[s] - weis[s] - this.stoeck[s];
      t[s] = tallies(raw[s]);
      this.totals[s] += t[s];
    }
    this.lastScore = {
      round: this.roundNo, trump: trump,
      card: card, bonus: bonus, tisch: this.tisch.slice(), weis: weis.map(function (x) { return -x; }),
      stoeck: this.stoeck.map(function (x) { return -x; }),
      raw: raw, tallies: t
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
      trump: this.trump,
      trumpSetBy: this.trumpSetBy,
      trickNo: this.trickNo,
      plays: this.plays,
      hands: this.hands,
      trickWins: this.trickWins,
      leader: this.leader,
      dealer: this.dealer,
      totals: this.totals,
      cfg: this.cfg,
      weisAnn: this.weisAnn.map(function (a) { return { seat: a.seat, label: a.best.label, pts: a.best.pts, order: a.order }; }),
      weisRes: this.weisRes ? { seat: this.weisRes.seat, label: this.weisRes.label, pts: this.weisRes.pts } : null,
      humanBest: this.phase === 'play' && this.trickNo === 0 && !this.weisDecided[this.humanSeat] ? this.humanBestWeis() : null,
      humanWeisDone: this.weisDecided[this.humanSeat],
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
