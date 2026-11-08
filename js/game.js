/*
 * Spielablauf für Schieber: Runden, Trumpfwahl, Stiche, Wertung.
 * Keine Anzeige hier. Die Oberfläche (ui.js) liest den Zustand und
 * ruft humanChooseTrump / humanSchieben / humanPlay auf.
 */
(function (root) {
  'use strict';

  var R = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.JassRules;
  var AI = (typeof module === 'object' && module.exports) ? require('./ai.js') : root.JassAI;

  // Zeiten in Millisekunden. Auf jassli.ch gemessen: ca. 10-12 s pro Stich, KI-Karte ca. 2.5-3 s.
  var DEFAULT_DELAYS = { deal: 1800, weis: 3000, aiMin: 2300, aiMax: 3200, trickShow: 2000, trump: 3500 };

  function Game(cfg) {
    cfg = cfg || {};
    this.cfg = {
      target: cfg.target || 1000,
      weis: cfg.weis !== false,
      stoeck: cfg.stoeck !== false,
      matchBonus: !!cfg.matchBonus,
      schilten2: cfg.schilten2 !== false,
      schellen7: !!cfg.schellen7
    };
    this.delays = Object.assign({}, DEFAULT_DELAYS, cfg.delays || {});
    this.sched = cfg.sched || function (fn, ms) { return setTimeout(fn, ms); };
    this.rnd = cfg.rnd || Math.random;
    this.onUpdate = cfg.onUpdate || function () {};
    this.humanSeat = 0;
    this.totals = [0, 0];
    this.history = [];
    this.roundNo = 0;
    this.dealer = Math.floor(this.rnd() * 4);
    this.phase = 'idle';   // idle | trump | play | roundEnd | gameEnd
    this.timer = null;
    this.gameWinner = null;
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
    this.vorhand = (this.dealer + 1) % 4;
    var deck = R.shuffle(R.makeDeck(), this.rnd);
    this.hands = [0, 1, 2, 3].map(function (s) { return deck.slice(s * 9, s * 9 + 9); });
    this.trump = null;
    this.plays = [];
    this.schellen7Holder = -1;
    this.wonTricks = [[], []];
    this.trickWins = [0, 0, 0, 0];
    this.lastTeam = null;
    this.stoeck = [0, 0];
    this.stoeckPair = [false, false, false, false];
    this.playedKO = [[], [], [], []];
    this.weisRes = null;
    this.meldsBySeat = null;
    this.weisShown = false;
    this.leader = this.vorhand;
    this.trickNo = 0;
    this.lastEvent = null;

    var holder = -1;
    if (this.cfg.schellen7) {
      this.hands.forEach(function (h, s) {
        if (h.some(function (c) { return c.s === 'S' && c.r === '7'; })) holder = s;
      });
    }
    // Schellen-7 bestimmt den Trumpf statt der Vorhand. Schieben bleibt erlaubt.
    this.schellen7Holder = holder;
    this.chooser = holder >= 0 ? holder : this.vorhand;
    this.canSchieben = true;
    this.phase = 'deal';
    this.emit();
    this.tick();
  };

  // Ruft den nächsten automatischen Schritt auf (KI oder Timer).
  Game.prototype.tick = function () {
    if (this.pending) return;
    if (this.phase === 'deal') {
      this.wait(this.delays.deal, function () { this.phase = 'trump'; }.bind(this));
      return;
    }
    if (this.phase === 'trump') {
      if (this.chooser !== this.humanSeat) this.wait(this.delays.trump, this.aiTrump.bind(this));
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

  Game.prototype.aiTrump = function () {
    var d = AI.chooseTrump(this.hands[this.chooser], { canSchieben: this.canSchieben });
    if (d.action === 'schieben') {
      this.doSchieben();
    } else {
      this.setTrump(d.suit);
    }
  };

  Game.prototype.humanChooseTrump = function (suit) {
    if (this.phase !== 'trump' || this.chooser !== this.humanSeat) return false;
    this.setTrump(suit);
    this.emit();
    this.tick();
    return true;
  };

  Game.prototype.doSchieben = function () {
    if (!this.canSchieben) return false;
    this.canSchieben = false;
    this.lastEvent = { type: 'schieben', seat: this.chooser };
    this.chooser = (this.chooser + 2) % 4;
    this.emit();
    this.tick();
    return true;
  };

  Game.prototype.humanSchieben = function () {
    if (this.phase !== 'trump' || this.chooser !== this.humanSeat) return false;
    return this.doSchieben();
  };

  Game.prototype.setTrump = function (suit) {
    var self = this;
    this.trump = suit;
    this.phase = 'play';
    this.hands.forEach(function (h, s) {
      var k = h.some(function (c) { return c.s === suit && c.r === 'K'; });
      var o = h.some(function (c) { return c.s === suit && c.r === 'O'; });
      self.stoeckPair[s] = k && o;
    });
    this.meldsBySeat = this.hands.map(function (h) { return self.cfg.weis ? R.bestMelds(h).melds : []; });
    this.weisRes = R.resolveWeis(this.meldsBySeat, suit, this.vorhand % 2);
    this.lastEvent = { type: 'trump', suit: suit, seat: this.chooser };
  };

  // Karte spielen. Gibt false zurück, wenn die Karte nicht erlaubt ist.
  Game.prototype.playCard = function (seat, card) {
    if (this.phase !== 'play' || this.turnSeat() !== seat) return false;
    if (this.lastEvent && this.lastEvent.type === 'stoeck') this.lastEvent = null;
    var legal = R.legalCards(this.hands[seat], this.plays, this.trump);
    var ok = legal.some(function (c) { return c.id === card.id; });
    if (!ok) return false;

    this.hands[seat] = this.hands[seat].filter(function (c) { return c.id !== card.id; });
    this.plays.push({ seat: seat, card: card });

    if (this.cfg.stoeck && card.s === this.trump && (card.r === 'K' || card.r === 'O')) {
      this.playedKO[seat].push(card.r);
      if (this.stoeckPair[seat] && this.playedKO[seat].length === 2) {
        this.stoeck[seat % 2] += R.STOECK_PTS;
        this.lastEvent = { type: 'stoeck', seat: seat };
      }
    }
    this.emit();
    this.tick();
    return true;
  };

  Game.prototype.aiPlay = function () {
    var seat = this.turnSeat();
    var card = AI.choosePlay(this.hands[seat], this.plays, this.trump, seat);
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
    return R.legalCards(this.hands[this.humanSeat], this.plays, this.trump).map(function (c) { return c.id; });
  };

  Game.prototype.finishTrick = function () {
    var w = R.winnerIndex(this.plays, this.trump);
    var winner = this.plays[w].seat;
    this.wonTricks[winner % 2].push(this.plays.map(function (p) { return p.card; }));
    this.trickWins[winner]++;
    this.plays = [];
    this.trickNo++;
    this.leader = winner;
    this.lastEvent = null;
    if (this.trickNo === 9) {
      this.lastTeam = winner % 2;
      this.endRound();
    }
  };

  Game.prototype.endRound = function () {
    var sc = R.roundScore(this.wonTricks, this.lastTeam, {
      trump: this.trump,
      matchBonus: this.cfg.matchBonus,
      doubled: this.cfg.schilten2 && this.trump === 'L',
      weis: this.weisRes ? this.weisRes.pts : [0, 0],
      stoeck: this.stoeck
    });
    this.totals[0] += sc.total[0];
    this.totals[1] += sc.total[1];
    this.history.push({ round: this.roundNo, dealer: this.dealer, trump: this.trump, score: sc, totals: this.totals.slice() });
    this.lastScore = sc;

    var t = this.totals, tg = this.cfg.target;
    var over0 = t[0] >= tg, over1 = t[1] >= tg;
    if (over0 && over1 && t[0] === t[1]) {
      this.phase = 'roundEnd';
    } else if (over0 || over1) {
      this.gameWinner = (over0 && over1) ? (t[0] > t[1] ? 0 : 1) : (over0 ? 0 : 1);
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
      chooser: this.chooser,
      schellen7Holder: this.schellen7Holder,
      canSchieben: this.canSchieben,
      trickNo: this.trickNo,
      plays: this.plays,
      hands: this.hands,
      trickWins: this.trickWins,
      vorhand: this.vorhand,
      dealer: this.dealer,
      totals: this.totals,
      target: this.cfg.target,
      weisRes: this.weisRes,
      meldsBySeat: this.meldsBySeat,
      lastEvent: this.lastEvent,
      lastScore: this.lastScore,
      history: this.history,
      gameWinner: this.gameWinner,
      turnSeat: this.phase === 'play' ? this.turnSeat() : null,
      legal: this.humanLegal()
    };
  };

  var api = { Game: Game, DEFAULT_DELAYS: DEFAULT_DELAYS };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JassGame = api;
})(typeof window !== 'undefined' ? window : this);
