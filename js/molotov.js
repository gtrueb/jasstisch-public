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
  var SLALOM = 20;                       // Bonus (Minus) für den Setzer, wenn der Modus wechselt

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
      aiLevel: cfg.aiLevel || 'normal',
      aiLevels: cfg.aiLevels || {},
      players: cfg.players === 3 ? 3 : 4,
      end: cfg.end === 'rounds' ? 'rounds' : 'limit',
      limit: cfg.limit || LIMIT_DEFAULT,
      rounds: cfg.rounds || ROUNDS_DEFAULT,
      weis: cfg.weis !== false,
      stoeck: cfg.stoeck !== false,
      lastTrick: cfg.lastTrick !== false,
      undenufe: cfg.undenufe !== false   // Standard: an. 6 setzt Undenufe, Ass setzt Obenabe, Wechsel = Slalom
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
    this.humanSeats = (cfg.humanSeats || [0]).slice();
    this.totals = zeros(this.n);       // Striche je Spieler (Plus minus Minus)
    this.plusStr = zeros(this.n);      // Plus-Striche je Spieler (Kartenpunkte, Tischweis, letzter Stich)
    this.minusStr = zeros(this.n);     // Minus-Striche je Spieler (Weis aus der Hand, Stöck)
    this.history = [];
    this.roundNo = 0;
    this.dealer = Math.floor(this.rnd() * this.n);
    this.phase = 'idle';               // deal | play | roundEnd | gameEnd
    this.pending = false;
    this.hold = false;             // Pause nach dem ersten Stich (Weis zeigen)
    this.gameWinners = [];
    this.lastScore = null;
    this.lastEvent = null;
    this.tischEvents = [];             // [{seat, pts, trick}] je Stich mit Tischweis
    // Verdeckte Karten (Online): siehe js/game.js
    this.remoteSeats = (cfg.remoteSeats || []).slice();
    this.dealHook = cfg.dealHook || null;
    this.revealCards = cfg.revealCards || null;
    this.roundId = 0;
    this.dealerBefore = this.dealer;
    this.hands = [];
    for (var i = 0; i < this.n; i++) this.hands.push([]);
    this.pendingAct = zeros(this.n).map(function () { return false; });
    this.abortReason = '';
  }

  Game.prototype.emit = function () { this.onUpdate(this); };

  Game.prototype.isRemote = function (seat) { return this.remoteSeats.indexOf(seat) >= 0; };

  Game.prototype.hasPlaceholder = function (seat, pos) {
    return (this.hands[seat] || []).some(function (h) { return h.remote && h.pos === pos; });
  };

  // Altes Spiel beenden (z. B. beim Reset): keine weiteren Timer mehr.
  Game.prototype.stop = function () { this.stopped = true; };

  // Übernahme durch einen neuen Host (siehe js/online.js): Punkte und Rundennummer setzen, bevor die Runde startet.
  // snap.dealer ist so gesetzt, dass startRound() den richtigen Geber ergibt.
  Game.prototype.restore = function (snap) {
    this.totals = snap.totals.slice();
    this.roundNo = snap.roundNo;
    this.dealer = snap.dealer;
    if (snap.plusStr && this.plusStr) this.plusStr = snap.plusStr.slice();
    if (snap.minusStr && this.minusStr) this.minusStr = snap.minusStr.slice();
  };

  // Pause: Spiel hält an, bis "Weiter" gedrückt wird oder 5 Sekunden vorbei sind.
  Game.prototype.holdWeis = function () {
    var self = this, rid = this.roundId;
    this.hold = true;
    this.sched(function () { if (self.hold && rid === self.roundId) self.releaseHold(); }, 5000);
  };

  Game.prototype.releaseHold = function () {
    if (!this.hold) return;
    this.hold = false;
    this.emit();
    this.tick();
  };

  Game.prototype.wait = function (ms, fn) {
    var self = this, rid = this.roundId;
    if (this.pending || this.stopped) return;
    this.pending = true;
    this.sched(function () {
      if (self.stopped || rid !== self.roundId) return;   // alte Runde: nichts mehr tun
      self.pending = false;
      if (fn) fn();
      self.emit();
      self.tick();
    }, ms);
  };

  Game.prototype.startRound = function () {
    this.hold = false;
    this.roundId++;
    var n = this.n, s;
    this.dealerBefore = this.dealer;
    this.roundNo++;
    if (this.roundNo > 1) this.dealer = (this.dealer + 1) % n;
    this.leader = (this.dealer + 1) % n;   // Vorhand spielt aus
    this.per = 36 / n;                     // Karten je Spieler (9 oder 12)
    this.pendingAct = zeros(n).map(function () { return false; });
    this.hands = [];
    for (s = 0; s < n; s++) this.hands.push([]);
    this.resetRoundState();
    if (this.dealHook) {
      this.phase = 'dealing';
      this.emit();
      this.dealHook(this, this.roundId);
      return;
    }
    var deck = R.shuffle(R.makeDeck(), this.rnd);
    var hands = [];
    for (s = 0; s < n; s++) hands.push(deck.slice(s * this.per, (s + 1) * this.per));
    this.setDealt(hands, null, this.roundId);
  };

  // Karten sind verteilt (lokal oder verdeckt). Ab hier läuft das Spiel.
  Game.prototype.setDealt = function (hands, info, rid) {
    if (rid !== undefined && rid !== this.roundId) return false;
    this.hands = hands;
    this.phase = 'deal';
    this.emit();
    this.tick();
    return true;
  };

  // Runde abbrechen (siehe js/game.js). Punkte bleiben, neue Runde nach 3 s.
  Game.prototype.abortRound = function (reason) {
    if (this.phase === 'aborted' || this.phase === 'roundEnd' || this.phase === 'gameEnd') return;
    this.roundId++;
    this.pending = false;
    this.hold = false;
    this.roundNo--;
    this.dealer = this.dealerBefore;
    this.phase = 'aborted';
    this.abortReason = reason || '';
    this.hands = [];
    for (var s = 0; s < this.n; s++) this.hands.push([]);
    this.pendingAct = zeros(this.n).map(function () { return false; });
    this.emit();
    var self = this;
    this.sched(function () { if (!self.stopped && self.phase === 'aborted') self.startRound(); }, 3000);
  };

  // Alle Rundenwerte zurücksetzen (vor jeder Verteilung).
  Game.prototype.resetRoundState = function () {
    var n = this.n, s;
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
    // Undenufe/Obenabe gilt nur für diese Runde (Start: Obenabe, kein Modus gesetzt)
    this.modeSet = null;                   // null | 'obenabe' | 'undenufe'
    this.slalomBonus = zeros(n);           // -20 je Slalom (Minus für den Setzer)
    this.slalomEvents = [];
    this.setTrick = -1;                    // Stich, in dem der Modus gesetzt wurde
    this.setSeat = -1;                     // Setzer des Modus
    this.slalomStart = false;              // true, sobald der Setzer im Stich danach die Gegenkarte ausgespielt hat
  };

  Game.prototype.tick = function () {
    if (this.pending || this.hold) return;
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
    if (!this.isHuman(seat)) {
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
    if (this.turnSeat() !== seat || this.weisDecided[seat] || this.isRemote(seat)) return false;
    return this.applyWeis(seat, this.hands[seat]);
  };

  // Weis mit bekannten Karten werten (lokal oder offen gelegt).
  Game.prototype.applyWeis = function (seat, cards) {
    this.weisDecided[seat] = true;
    var seen = {};
    cards = cards.filter(function (c) { if (seen[c.id]) return false; seen[c.id] = true; return true; });
    var best = R.bestWeis(cards);
    var total = best ? R.weisTotal(cards) : null;
    if (best && total) this.weisAnn.push({ seat: seat, best: best, total: total, order: ++this.annCounter });
    this.lastEvent = total ? { type: 'weis', seat: seat, label: total.label, pts: total.pts } : this.lastEvent;
    return !!best;
  };

  // Fremder Platz sagt Weis an: Weis-Karten offen legen, dann werten (siehe js/game.js).
  Game.prototype.requestWeis = function (seat, positions) {
    if (!this.cfg.weis || this.phase !== 'play' || this.trickNo !== 0 || !this.isRemote(seat)) return false;
    if (this.turnSeat() !== seat || this.weisDecided[seat] || this.pendingAct[seat] || !this.revealCards) return false;
    if (!positions || !positions.length || new Set(positions).size !== positions.length) return false;
    if (!positions.every(function (p) { return this.hasPlaceholder(seat, p); }, this)) return false;
    this.pendingAct[seat] = true;
    var self = this, rid = this.roundId;
    this.revealCards(seat, positions).then(function (cards) {
      if (rid !== self.roundId) return;
      self.pendingAct[seat] = false;
      self.announceRevealed(seat, cards);
    }, function (err) {
      if (rid !== self.roundId) return;
      self.pendingAct[seat] = false;
      self.abortRound(err && err.message ? err.message : 'Fehler beim Weis');
    });
    return true;
  };

  Game.prototype.announceRevealed = function (seat, cards) {
    if (this.phase !== 'play' || this.trickNo !== 0 || this.turnSeat() !== seat || this.weisDecided[seat]) return false;
    var ok = this.applyWeis(seat, cards);
    this.emit();
    return ok;
  };

  // Karte spielen (lokaler Platz).
  Game.prototype.playCard = function (seat, card) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || this.isRemote(seat)) return false;
    var legal = R.legalFree(this.hands[seat], this.plays);
    if (!legal.some(function (c) { return c.id === card.id; })) return false;
    return this.commitPlay(seat, card, {}, function () {
      this.hands[seat] = this.hands[seat].filter(function (c) { return c.id !== card.id; });
    }.bind(this));
  };

  // Gemeinsamer Teil jedes Zuges. Die Trumpfwahl läuft vor dem Entfernen der Karte (wie bisher).
  Game.prototype.commitPlay = function (seat, card, claims, removeFromHand) {
    // Wer im ersten Stich spielt, ohne anzusagen, verzichtet auf seinen Weis.
    if (this.trickNo === 0 && !this.weisDecided[seat]) this.weisDecided[seat] = true;
    if (this.lastEvent && (this.lastEvent.type === 'stoeck' || this.lastEvent.type === 'weis')) this.lastEvent = null;

    // Trumpf setzen: wer die Farbe nicht bedienen kann, legt eine andere Farbe.
    // Mit Undenufe-Regel: die erste Abweichung der Runde mit einer 6 setzt Undenufe, mit einem Ass Obenabe.
    // Jede andere Karte setzt Farbtrumpf (kein Modus mehr für diese Runde).
    if (this.trump === null && !this.modeSet && this.plays.length > 0 && card.s !== this.plays[0].card.s) {
      if (this.cfg.undenufe && (card.r === '6' || card.r === 'A')) {
        this.setMode(card.r === '6' ? 'undenufe' : 'obenabe', seat);
      } else {
        this.setTrump(card.s, seat);
      }
    }

    // Slalom: nur der Stich direkt nach dem Setzen zählt. Der Setzer (er gewinnt den Setzstich) spielt
    // dort die Gegenkarte aus (6 nach Ass, Ass nach 6). Dann wechselt der Modus in jedem Stich bis Rundenende.
    if (this.cfg.undenufe && this.modeSet && !this.slalomStart && this.plays.length === 0 &&
        this.trickNo === this.setTrick + 1 && seat === this.setSeat) {
      var opp = this.modeSet === 'undenufe' ? 'A' : '6';
      if (card.r === opp) this.startSlalom(seat);
    }

    removeFromHand();
    this.plays.push({ seat: seat, card: card });

    if (this.cfg.stoeck && this.trump !== null && card.s === this.trump && (card.r === 'K' || card.r === 'O')) {
      this.playedKO[seat].push(card.r);
      // Stöck: K und O des Trumpfs nach der Trumpfwahl gespielt (auch die Trumpfkarte selbst).
      // Dann waren beide schon bei der Trumpfwahl auf der Hand. Das prüft jeder aus den offenen Karten.
      if (this.playedKO[seat].length === 2) {
        this.stoeck[seat] += STOECK;
        this.lastEvent = { type: 'stoeck', seat: seat };
      }
    }
    this.emit();
    this.tick();
    return true;
  };

  // Karte eines fremden Platzes: erst offen legen, dann spielen (siehe js/game.js).
  Game.prototype.requestPlay = function (seat, pos, claims) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || !this.isRemote(seat)) return false;
    if (this.pendingAct[seat] || !this.revealCards || !this.hasPlaceholder(seat, pos)) return false;
    this.pendingAct[seat] = true;
    var self = this, rid = this.roundId;
    this.revealCards(seat, [pos]).then(function (cards) {
      if (rid !== self.roundId) return;
      self.pendingAct[seat] = false;
      self.playRemote(seat, pos, cards[0], claims);
    }, function (err) {
      if (rid !== self.roundId) return;
      self.pendingAct[seat] = false;
      self.abortRound(err && err.message ? err.message : 'Fehler beim Ausspielen');
    });
    return true;
  };

  Game.prototype.playRemote = function (seat, pos, card, claims) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || !this.isRemote(seat)) return false;
    if (!this.hasPlaceholder(seat, pos) || !card || !card.id) return false;
    return this.commitPlay(seat, card, claims || {}, function () {
      this.hands[seat] = this.hands[seat].filter(function (h) { return !(h.remote && h.pos === pos); });
    }.bind(this));
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

  // Undenufe (true) oder Obenabe ohne Farbtrumpf. Nur dann gelten die Undenufe-Punkte und die Rangfolge.
  Game.prototype.undenufeNow = function () {
    return this.trump === null && this.modeSet === 'undenufe';
  };

  // Modus setzen (erste 6 oder Ass der Runde). Der Setzer gewinnt diesen Stich.
  Game.prototype.setMode = function (mode, seat) {
    this.modeSet = mode;
    this.trumpSetBy = seat;
    this.setTrick = this.trickNo;
    this.setSeat = seat;
    this.lastEvent = { type: 'mode', seat: seat, mode: mode };
  };

  // Slalom beginnt: der Setzer bekommt einmal -20 (zählt wie ein Stöck). Ab jetzt wechselt der Modus jeden Stich.
  Game.prototype.startSlalom = function (seat) {
    this.slalomStart = true;
    this.slalomBonus[seat] += SLALOM;
    var next = this.modeSet === 'undenufe' ? 'obenabe' : 'undenufe';
    this.slalomEvents.push({ seat: seat, trick: this.trickNo + 1, mode: next });
    this.lastEvent = { type: 'slalom', seat: seat, mode: next };
  };

  // Modus eines Stichs (Rangfolge und Sieger): 'undenufe' oder 'obenabe'. Null, wenn Farbtrumpf gilt.
  // Im Slalom: ab dem Stich nach dem Setzen wechselt der Modus in jedem Stich.
  Game.prototype.trickMode = function (t) {
    if (this.trump !== null) return null;
    var base = this.modeSet === 'undenufe' ? 'undenufe' : 'obenabe';
    if (!this.modeSet || t < this.setTrick) return 'obenabe';   // vor dem Setzen: kein Modus, normale Rangfolge
    if (!this.slalomStart || t < this.setTrick + 1 || (t - this.setTrick - 1) % 2 !== 0) return base;
    return base === 'undenufe' ? 'obenabe' : 'undenufe';
  };

  Game.prototype.trickUndenufe = function (t) {
    return this.trickMode(t === undefined ? this.trickNo : t) === 'undenufe';
  };

  Game.prototype.aiPlay = function () {
    var seat = this.turnSeat();
    if (this.isHuman(seat)) return;   // Platz wurde inzwischen von einem Menschen übernommen
    if (this.trickNo === 0 && !this.weisDecided[seat]) this.announceWeis(seat);
    var card = this.aiFor(seat).choosePlay(this.hands[seat], this.plays, this.trump, seat, this.trickUndenufe());
    this.playCard(seat, card);
  };



  Game.prototype.finishTrick = function () {
    var cards = this.plays.map(function (p) { return p.card; });
    var und = this.trickUndenufe();
    var w = R.winnerIndex(this.plays, this.trump, und);
    // Die Setzkarte (6 oder Ass) gewinnt ihren Stich: sie kann nicht übertrumpft werden.
    if (this.trump === null && this.setTrick === this.trickNo && this.setSeat >= 0) {
      for (var i = 0; i < this.plays.length; i++) if (this.plays[i].seat === this.setSeat) w = i;
    }
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
    // Pause ganz am Ende: nach dem ersten Stich mit Weis
    if (this.trickNo === 1 && this.weisRes) this.holdWeis();
  };

  Game.prototype.endRound = function () {
    var self = this, n = this.n;
    var trump = this.trump;
    // Kartenpunkte: alle Stiche mit dem Modus am Rundenende (wie der Farbtrumpf). So ergeben sie immer 152.
    var und = this.undenufeNow();
    var card = zeros(n), bonus = zeros(n), weis = zeros(n);
    for (var cs = 0; cs < n; cs++) {
      this.wonTricks[cs].forEach(function (tr) { card[cs] += R.trickPoints(tr, trump, und); });
    }
    if (this.cfg.lastTrick) bonus[this.lastWinner] += LAST_TRICK;
    if (this.weisRes) weis[this.weisRes.seat] = this.weisRes.pts;

    // Jasstafel: Kartenpunkte (mit letztem Stich) einmal gerundet. Tischweis, Weis und Stöck
    // sind immer glatte Striche (durch 10 teilbar) und werden direkt eingetragen.
    var raw = zeros(n), t = zeros(n), ps = zeros(n), ms = zeros(n), s;
    for (s = 0; s < n; s++) {
      var plusPts = card[s] + bonus[s] + this.tisch[s];
      var minusPts = weis[s] + this.stoeck[s] + this.slalomBonus[s];
      ps[s] = tallies(card[s] + bonus[s]) + Math.round(this.tisch[s] / 10);
      ms[s] = Math.round(minusPts / 10);
      this.plusStr[s] += ps[s];
      this.minusStr[s] += ms[s];
      raw[s] = plusPts - minusPts;
      t[s] = ps[s] - ms[s];
      this.totals[s] += t[s];
    }
    this.lastScore = {
      round: this.roundNo, trump: trump, n: n,
      mode: trump !== null ? trump : (this.modeSet || 'obenabe'),
      slalom: this.slalomBonus.map(function (x) { return -x; }),
      card: card, bonus: bonus, tisch: this.tisch.slice(), weis: weis.map(function (x) { return -x; }),
      stoeck: this.stoeck.map(function (x) { return -x; }),
      raw: raw, tallies: t, plusStrokes: ps, minusStrokes: ms,
      weisSeat: this.weisRes ? this.weisRes.seat : -1,
      weisLabel: this.weisRes ? this.weisRes.label : '',
      weisPts: this.weisRes ? this.weisRes.pts : 0,
      weisCards: this.weisRes ? (this.weisRes.cards || []) : []
    };
    var modeNow = trump !== null ? trump : (this.modeSet || "obenabe");
    this.history.push({ round: this.roundNo, trump: trump, mode: modeNow, tallies: t.slice(), totals: this.totals.slice() });

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

  // KI für einen Platz (Stufe je Platz aus cfg.aiLevels, sonst die Standardstufe).
  Game.prototype.aiFor = function (seat) {
    var lvl = (this.cfg.aiLevels && this.cfg.aiLevels[seat]) || this.cfg.aiLevel || 'normal';
    if (!this.ais) this.ais = {};
    if (!this.ais[lvl]) this.ais[lvl] = AIM.createPlayer({ level: lvl });
    return this.ais[lvl];
  };

  // Zug für einen Platz automatisch ausführen (bei Zeitüberschreitung eines Menschen).
  Game.prototype.autoMove = function (seat) {
    if (this.hold) return this.releaseHold();
    if (this.phase === 'roundEnd') return this.nextRound();
    if (this.isRemote(seat)) return false;   // Karten dieses Platzes kennt nur sein Gerät
    if (this.phase === 'trump' && this.chooser === seat) {
      var d = this.aiFor(seat).chooseTrump(this.hands[seat], { canSchieben: this.canSchieben });
      if (d.action === 'schieben') return this.schiebenBy(seat);
      return this.trumpBy(seat, d.suit);
    }
    if (this.phase === 'play' && this.turnSeat() === seat) {
      var card = this.aiFor(seat).choosePlay(this.hands[seat], this.plays, this.trump, seat, this.trickUndenufe());
      return this.playCard(seat, card);
    }
    return false;
  };

  Game.prototype.isHuman = function (seat) { return this.humanSeats.indexOf(seat) >= 0; };

  // Platz für einen Menschen setzen oder freigeben (bei Verbindungsverlust übernimmt die KI).
  Game.prototype.setHuman = function (seat, on) {
    var i = this.humanSeats.indexOf(seat);
    if (on && i < 0) this.humanSeats.push(seat);
    if (!on && i >= 0) this.humanSeats.splice(i, 1);
    this.tick();
  };

  Game.prototype.announceBy = function (seat) {
    var ok = this.announceWeis(seat);
    this.emit();
    return ok;
  };

  Game.prototype.playBy = function (seat, cardId) {
    if (this.turnSeat() !== seat || this.phase !== 'play') return false;
    var card = this.hands[seat].filter(function (c) { return c.id === cardId; })[0];
    if (!card) return false;
    return this.playCard(seat, card);
  };

  // Eine Aktion eines Platzes ausführen. Gibt true zurück, wenn sie gültig war.
  Game.prototype.act = function (seat, a) {
    if (!a || typeof a !== 'object') return false;
    if (a.type === 'card') return this.playBy(seat, a.id);
    if (a.type === 'weis') return this.announceBy(seat);
    if (a.type === 'release') return this.releaseHold();
    if (a.type === 'next') return this.nextRound();
    return false;
  };

  Game.prototype.humanAnnounce = function () { return this.announceBy(this.humanSeat); };
  Game.prototype.humanPlay = function (cardId) { return this.playBy(this.humanSeat, cardId); };
  Game.prototype.humanLegal = function () { return this.legalFor(this.humanSeat); };

  Game.prototype.legalFor = function (seat) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || this.plays.length === 4) return [];
    if (this.isRemote(seat)) return [];   // wird auf dem Gerät des Spielers berechnet
    return R.legalFree(this.hands[seat], this.plays).map(function (c) { return c.id; });
  };

  Game.prototype.humanWeisIds = function (seat) {
    if (seat === undefined) seat = this.humanSeat;
    if (this.phase !== 'play' || this.trickNo !== 0 || this.turnSeat() !== seat || this.weisDecided[seat]) return [];
    if (this.isRemote(seat)) return [];
    var t = R.weisTotal(this.hands[seat] || []);
    return t ? t.cards.map(function (c) { return c.id; }) : [];
  };

  Game.prototype.humanBestWeis = function (seat) {
    if (seat === undefined) seat = this.humanSeat;
    if (this.isRemote(seat)) return null;
    return R.weisTotal(this.hands[seat] || []);
  };

  Game.prototype.stateForUI = function (seat) {
    if (seat === undefined) seat = this.humanSeat;
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
      humanBest: this.phase === 'play' && this.trickNo === 0 && !this.weisDecided[seat] ? this.humanBestWeis(seat) : null,
      humanWeisDone: this.weisDecided[seat],
      me: seat,
      humanWeisIds: this.humanWeisIds(seat),
      weisHold: !!this.hold,
      abortReason: this.abortReason,
      roundTisch: this.tisch.slice(),
      roundStoeck: this.stoeck.slice(),
      tischEvents: this.tischEvents,
      lastEvent: this.lastEvent,
      lastScore: this.lastScore,
      history: this.history,
      gameWinners: this.gameWinners,
      turnSeat: this.phase === 'play' ? this.turnSeat() : null,
      humanSeats: this.humanSeats.slice(),
      // Während des Spiels der Modus des laufenden Stichs; nach der Runde der Typ, der gewertet wurde.
      undenufe: this.phase === 'play' ? this.trickUndenufe() : this.undenufeNow(),
      modeSet: this.modeSet,
      slalomBonus: this.slalomBonus.slice(),
      legal: this.legalFor(seat)
    };
  };

  return { Game: Game, DEFAULT_DELAYS: DEFAULT_DELAYS, LIMIT_DEFAULT: LIMIT_DEFAULT, ROUNDS_DEFAULT: ROUNDS_DEFAULT, tallies: tallies };
});
