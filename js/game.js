/*
 * Spielablauf für Schieber: Runden, Trumpfwahl, Weisen, Stiche, Wertung.
 * Keine Anzeige hier. Die Oberfläche (ui.js) liest den Zustand und ruft
 * humanChooseTrump / humanSchieben / humanAnnounce / humanPlay auf.
 */
(function (root) {
  'use strict';

  var R = (typeof module === 'object' && module.exports) ? require('./rules.js') : root.JassRules;
  var AIS = (typeof module === 'object' && module.exports) ? require('./ai-schieber.js') : root.JassAISchieber;

  // Zeiten in Millisekunden. Auf jassli.ch gemessen: ca. 10-12 s pro Stich, KI-Karte ca. 2.5-3 s.
  var DEFAULT_DELAYS = { deal: 1800, aiMin: 2000, aiMax: 2900, trickShow: 4000, trump: 3500 };

  function Game(cfg) {
    cfg = cfg || {};
    this.cfg = {
      aiLevel: cfg.aiLevel || 'normal',
      aiLevels: cfg.aiLevels || {},
      target: cfg.target || 1000,
      weis: cfg.weis !== false,
      stoeck: cfg.stoeck !== false,
      matchBonus: !!cfg.matchBonus,
      schilten2: cfg.schilten2 !== false,
      schellen7: !!cfg.schellen7
    };
    this.delays = Object.assign({}, DEFAULT_DELAYS, cfg.delays || {});
    this.sched = cfg.sched || function (fn, ms) {
      return (typeof window !== 'undefined' && window.JassClock) ? window.JassClock.sched(fn, ms) : setTimeout(fn, ms);
    };
    this.rnd = cfg.rnd || Math.random;
    this.onUpdate = cfg.onUpdate || function () {};
    this.ai = AIS.createPlayer({ level: cfg.aiLevel || 'normal' });
    this.humanSeat = 0;
    this.humanSeats = (cfg.humanSeats || [0]).slice();
    this.totals = [0, 0];
    this.history = [];
    this.roundNo = 0;
    this.dealer = Math.floor(this.rnd() * 4);
    this.phase = 'idle';   // idle | deal | trump | play | roundEnd | gameEnd
    this.pending = false;
    this.hold = false;             // Pause nach dem ersten Stich (Weis zeigen)
    this.gameWinner = null;
    this.lastEvent = null;
    // Verdeckte Karten (Online): Plätze, deren Karten dieser Engine nicht bekannt sind.
    this.remoteSeats = (cfg.remoteSeats || []).slice();
    this.dealHook = cfg.dealHook || null;      // function(engine, rid): verteilt verdeckt, ruft setDealt auf
    this.revealCards = cfg.revealCards || null; // function(seat, positions) -> Promise<Karten>
    this.roundId = 0;                          // erhöht sich bei jeder neuen Runde und jedem Abbruch
    this.dealerBefore = this.dealer;
    this.hands = [[], [], [], []];
    this.pendingAct = [false, false, false, false];
    this.abortReason = '';
  }

  Game.prototype.emit = function () { this.onUpdate(this); };

  // Platz, dessen Karten dieser Engine nicht bekannt sind (Mensch über das Netz).
  Game.prototype.isRemote = function (seat) { return this.remoteSeats.indexOf(seat) >= 0; };

  // Hat der fremde Platz noch einen Platzhalter an dieser Kartenposition?
  Game.prototype.hasPlaceholder = function (seat, pos) {
    return (this.hands[seat] || []).some(function (h) { return h.remote && h.pos === pos; });
  };

  // Altes Spiel beenden (z. B. beim Reset): keine weiteren Timer mehr.
  Game.prototype.stop = function () { this.stopped = true; };

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
    this.dealerBefore = this.dealer;
    this.roundNo++;
    if (this.roundNo > 1) this.dealer = (this.dealer + 1) % 4;
    this.vorhand = (this.dealer + 1) % 4;
    this.trump = null;
    this.plays = [];
    this.wonTricks = [[], []];
    this.trickWins = [0, 0, 0, 0];
    this.lastTeam = null;
    this.stoeck = [0, 0];
    this.stoeckPair = [false, false, false, false];
    this.playedKO = [[], [], [], []];
    this.leader = this.vorhand;
    this.trickNo = 0;
    this.lastEvent = null;
    // Weisen: nur im ersten Stich, nur auf dem eigenen Zug.
    this.weisDecided = [false, false, false, false];
    this.weisAnn = [];       // [{seat, best, order}] in Ansagereihenfolge
    this.annCounter = 0;
    this.weisRes = null;     // Gewinner der Weisen, nach dem ersten Stich
    this.lastScore = null;
    this.pendingAct = [false, false, false, false];
    this.canSchieben = true;
    this.schellen7Holder = -1;
    this.chooser = this.vorhand;
    this.hands = [[], [], [], []];

    if (this.dealHook) {
      // Verdeckte Verteilung (Online). Die Engine macht weiter, sobald setDealt aufgerufen wird.
      this.phase = 'dealing';
      this.emit();
      this.dealHook(this, this.roundId);
      return;
    }
    var deck = R.shuffle(R.makeDeck(), this.rnd);
    var hands = [0, 1, 2, 3].map(function (s) { return deck.slice(s * 9, s * 9 + 9); });
    this.setDealt(hands, null, this.roundId);
  };

  // Karten sind verteilt. hands[s]: Karten (lokale Plätze) oder Platzhalter (fremde Plätze).
  // info.s7[s]: Platz s hat die Schellen-7 (nur mit cfg.schellen7 wichtig).
  Game.prototype.setDealt = function (hands, info, rid) {
    if (rid !== undefined && rid !== this.roundId) return false;
    this.hands = hands;
    var holder = -1;
    if (this.cfg.schellen7) {
      var s7 = (info && info.s7) || hands.map(function (h) {
        return h.some(function (c) { return c.s === 'S' && c.r === '7'; });
      });
      for (var s = 0; s < 4; s++) if (s7[s]) holder = s;
    }
    // Schellen-7 bestimmt den Trumpf statt der Vorhand. Schieben bleibt erlaubt.
    this.schellen7Holder = holder;
    this.chooser = holder >= 0 ? holder : this.vorhand;
    this.canSchieben = true;
    this.phase = 'deal';
    this.emit();
    this.tick();
    return true;
  };

  // Runde abbrechen (z. B. Verbindung weg, Beweis falsch). Punkte bleiben. Neue Runde nach 3 s.
  Game.prototype.abortRound = function (reason) {
    if (this.phase === 'aborted' || this.phase === 'roundEnd' || this.phase === 'gameEnd') return;
    this.roundId++;
    this.pending = false;
    this.hold = false;
    this.roundNo--;
    this.dealer = this.dealerBefore;
    this.phase = 'aborted';
    this.abortReason = reason || '';
    this.hands = [[], [], [], []];
    this.pendingAct = [false, false, false, false];
    this.emit();
    var self = this;
    this.sched(function () { if (!self.stopped && self.phase === 'aborted') self.startRound(); }, 3000);
  };

  // Ruft den nächsten automatischen Schritt auf (KI oder Timer).
  Game.prototype.tick = function () {
    if (this.pending || this.hold) return;
    if (this.phase === 'deal') {
      this.wait(this.delays.deal, function () { this.phase = 'trump'; }.bind(this));
      return;
    }
    if (this.phase === 'trump') {
      if (!this.isHuman(this.chooser)) this.wait(this.delays.trump, this.aiTrump.bind(this));
      return;
    }
    if (this.phase !== 'play') return;

    if (this.plays.length === 4) {
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
    if (this.plays.length >= 4) return null;
    return (this.leader + this.plays.length) % 4;
  };

  // Weis ansagen. Nur im ersten Stich auf dem eigenen Zug, nur einmal.
  Game.prototype.announceWeis = function (seat) {
    if (!this.cfg.weis || this.trickNo !== 0 || this.phase !== 'play') return false;
    if (this.turnSeat() !== seat || this.weisDecided[seat] || this.isRemote(seat)) return false;
    return this.applyWeis(seat, this.hands[seat]);
  };

  // Weis mit den Karten dieses Platzes werten. Die Karten sind bekannt (lokal oder offen gelegt).
  Game.prototype.applyWeis = function (seat, cards) {
    this.weisDecided[seat] = true;
    // Jede Karte nur einmal zählen (sonst würde eine Karte als Vierling gewertet).
    var seen = {};
    cards = cards.filter(function (c) { if (seen[c.id]) return false; seen[c.id] = true; return true; });
    var best = R.bestWeis(cards);
    var total = best ? R.weisTotal(cards) : null;
    if (best) this.weisAnn.push({ seat: seat, best: best, total: total, order: ++this.annCounter });
    this.lastEvent = total ? { type: 'weis', seat: seat, label: total.label, pts: total.pts } : this.lastEvent;
    return !!best;
  };

  // Fremder Platz sagt Weis an: die Weis-Karten werden offen gelegt, dann gewertet.
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

  Game.prototype.aiTrump = function () {
    var d = this.aiFor(this.chooser).chooseTrump(this.hands[this.chooser], { canSchieben: this.canSchieben });
    if (d.action === 'schieben') {
      this.doSchieben();
    } else {
      this.setTrump(d.suit);
    }
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


  Game.prototype.setTrump = function (suit) {
    this.trump = suit;
    this.phase = 'play';
    this.stoeckPair = this.hands.map(function (h) {
      var k = h.some(function (c) { return c.s === suit && c.r === 'K'; });
      var o = h.some(function (c) { return c.s === suit && c.r === 'O'; });
      return k && o;
    });
    this.lastEvent = { type: 'trump', suit: suit, seat: this.chooser };
  };

  // Karte spielen (lokaler Platz). Gibt false zurück, wenn die Karte nicht erlaubt ist.
  Game.prototype.playCard = function (seat, card) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || this.isRemote(seat)) return false;
    var legal = R.legalCards(this.hands[seat], this.plays, this.trump);
    if (!legal.some(function (c) { return c.id === card.id; })) return false;
    return this.commitPlay(seat, card, {}, function () {
      this.hands[seat] = this.hands[seat].filter(function (c) { return c.id !== card.id; });
    }.bind(this));
  };

  // Gemeinsamer Teil jedes Zuges: Karte auf den Stich, Stöck prüfen.
  // claims.stoeck (fremder Platz): Besitzer hält K und O des Trumpfs (bei der zweiten Karte gilt es).
  Game.prototype.commitPlay = function (seat, card, claims, removeFromHand) {
    // Wer im ersten Stich spielt, ohne anzusagen, verzichtet auf seinen Weis.
    if (this.trickNo === 0 && !this.weisDecided[seat]) this.weisDecided[seat] = true;
    if (this.lastEvent && (this.lastEvent.type === 'stoeck' || this.lastEvent.type === 'weis')) this.lastEvent = null;

    removeFromHand();
    this.plays.push({ seat: seat, card: card });

    if (this.cfg.stoeck && this.trump && card.s === this.trump && (card.r === 'K' || card.r === 'O')) {
      this.playedKO[seat].push(card.r);
      // Stöck: K und O des Trumpfs nach der Trumpfwahl gespielt. Dann hatte der Platz beide schon
      // bei der Trumpfwahl auf der Hand (Karten verschwinden nur durch Spielen). Das prüft jeder
      // selbst aus den offenen Karten, ohne Angabe des Geräts.
      if (this.playedKO[seat].length === 2) {
        this.stoeck[seat % 2] += R.STOECK_PTS;
        this.lastEvent = { type: 'stoeck', seat: seat };
      }
    }
    this.emit();
    this.tick();
    return true;
  };

  // Karte eines fremden Platzes: erst offen legen (cfg.revealCards), dann spielen.
  // pos: Kartenposition aus der verdeckten Verteilung. claims: z. B. {stoeck: true}.
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

  // Offen gelegte Karte eines fremden Platzes spielen. Der Zug selbst wurde schon geprüft (Besitz, Zug).
  // Die Regel "Farbe bedienen" kann der Host nicht prüfen (er kennt die Hand nicht). Das prüft das Gerät des Spielers.
  Game.prototype.playRemote = function (seat, pos, card, claims) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || !this.isRemote(seat)) return false;
    if (!this.hasPlaceholder(seat, pos) || !card || !card.id) return false;
    return this.commitPlay(seat, card, claims || {}, function () {
      this.hands[seat] = this.hands[seat].filter(function (h) { return !(h.remote && h.pos === pos); });
    }.bind(this));
  };

  Game.prototype.aiPlay = function () {
    var seat = this.turnSeat();
    if (this.isHuman(seat)) return;   // Platz wurde inzwischen von einem Menschen übernommen
    if (this.trickNo === 0 && !this.weisDecided[seat]) this.announceWeis(seat);
    var card = this.aiFor(seat).choosePlay(this.hands[seat], this.plays, this.trump, seat);
    this.playCard(seat, card);
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
    if (this.trickNo === 1) this.weisRes = R.resolveWeisAnn(this.weisAnn);
    if (this.trickNo === 9) {
      this.lastTeam = winner % 2;
      this.endRound();
    }
    // Pause ganz am Ende: nach dem ersten Stich mit Weis
    if (this.trickNo === 1 && this.weisRes) this.holdWeis();
  };

  Game.prototype.endRound = function () {
    var sc = R.roundScore(this.wonTricks, this.lastTeam, {
      trump: this.trump,
      matchBonus: this.cfg.matchBonus,
      doubled: this.cfg.schilten2 && this.trump === 'L',
      weis: [0, 0],
      stoeck: this.stoeck
    });
    // Nur der Spieler mit der stärksten Weisen-Kombination zählt. Sein Team bekommt die Punkte.
    var weis = [0, 0];
    if (this.weisRes) weis[this.weisRes.seat % 2] = this.weisRes.pts * sc.factor;
    sc.weis = weis;
    sc.total = [0, 1].map(function (t) { return (sc.card[t] + sc.match[t] + sc.stoeck[t]) * sc.factor + weis[t]; });
    this.totals[0] += sc.total[0];
    this.totals[1] += sc.total[1];
    this.history.push({ round: this.roundNo, dealer: this.dealer, trump: this.trump, score: sc, totals: this.totals.slice() });
    sc.weisSeat = this.weisRes ? this.weisRes.seat : -1;
    sc.weisLabel = this.weisRes ? this.weisRes.label : '';
    sc.weisPts = this.weisRes ? this.weisRes.pts : 0;
    sc.weisCards = this.weisRes ? (this.weisRes.cards || []) : [];
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

  // KI für einen Platz (Stufe je Platz aus cfg.aiLevels, sonst die Standardstufe).
  Game.prototype.aiFor = function (seat) {
    var lvl = (this.cfg.aiLevels && this.cfg.aiLevels[seat]) || this.cfg.aiLevel || 'normal';
    if (!this.ais) this.ais = {};
    if (!this.ais[lvl]) this.ais[lvl] = AIS.createPlayer({ level: lvl });
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
      var card = this.aiFor(seat).choosePlay(this.hands[seat], this.plays, this.trump, seat);
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

  Game.prototype.trumpBy = function (seat, suit) {
    if (this.phase !== 'trump' || this.chooser !== seat) return false;
    if (['R', 'S', 'L', 'E'].indexOf(suit) < 0) return false;
    this.setTrump(suit);
    this.emit();
    this.tick();
    return true;
  };

  Game.prototype.schiebenBy = function (seat) {
    if (this.phase !== 'trump' || this.chooser !== seat) return false;
    return this.doSchieben();
  };

  // Eine Aktion eines Platzes ausführen. Gibt true zurück, wenn sie gültig war.
  Game.prototype.act = function (seat, a) {
    if (!a || typeof a !== 'object') return false;
    if (a.type === 'card') return this.playBy(seat, a.id);
    if (a.type === 'trump') return this.trumpBy(seat, a.suit);
    if (a.type === 'schieben') return this.schiebenBy(seat);
    if (a.type === 'weis') return this.announceBy(seat);
    if (a.type === 'release') return this.releaseHold();
    if (a.type === 'next') return this.nextRound();
    return false;
  };

  Game.prototype.humanAnnounce = function () { return this.announceBy(this.humanSeat); };
  Game.prototype.humanChooseTrump = function (suit) { return this.trumpBy(this.humanSeat, suit); };
  Game.prototype.humanSchieben = function () { return this.schiebenBy(this.humanSeat); };
  Game.prototype.humanPlay = function (cardId) { return this.playBy(this.humanSeat, cardId); };
  Game.prototype.humanLegal = function () { return this.legalFor(this.humanSeat); };

  Game.prototype.legalFor = function (seat) {
    if (this.phase !== 'play' || this.turnSeat() !== seat || this.plays.length === 4) return [];
    if (this.isRemote(seat)) return [];   // wird auf dem Gerät des Spielers berechnet
    return R.legalCards(this.hands[seat], this.plays, this.trump).map(function (c) { return c.id; });
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
      trump: this.trump,
      chooser: this.chooser,
      schellen7Holder: this.schellen7Holder,
      canSchieben: this.canSchieben,
      trickNo: this.trickNo,
      plays: this.plays,
      hands: this.hands,
      trickWins: this.trickWins,
      vorhand: this.vorhand,
      leader: this.leader,
      dealer: this.dealer,
      totals: this.totals,
      target: this.cfg.target,
      cfg: this.cfg,
      weisAnn: this.weisAnn.map(function (a) { return { seat: a.seat, label: a.total.label, pts: a.total.pts, order: a.order }; }),
      weisRes: this.weisRes ? { seat: this.weisRes.seat, label: this.weisRes.label, pts: this.weisRes.pts, cards: this.weisRes.cards } : null,
      humanBest: this.phase === 'play' && this.trickNo === 0 && !this.weisDecided[seat] ? this.humanBestWeis(seat) : null,
      humanWeisDone: this.weisDecided[seat],
      me: seat,
      humanWeisIds: this.humanWeisIds(seat),
      weisHold: !!this.hold,
      abortReason: this.abortReason,
      lastEvent: this.lastEvent,
      lastScore: this.lastScore,
      history: this.history,
      gameWinner: this.gameWinner,
      turnSeat: this.phase === 'play' ? this.turnSeat() : null,
      humanSeats: this.humanSeats.slice(),
      legal: this.legalFor(seat)
    };
  };

  var api = { Game: Game, DEFAULT_DELAYS: DEFAULT_DELAYS };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JassGame = api;
})(typeof window !== 'undefined' ? window : this);
