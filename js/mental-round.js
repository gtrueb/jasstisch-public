/*
 * Ablauf einer Runde mit verdeckten Karten (Host-Seite). Der Host ruft die Schritte auf und
 * prüft jede Antwort. Er sieht nie den Klartext einer fremden Karte, nur offen gelegte Karten
 * (gespielt oder angesagt) und Beweise.
 *
 * seats[s] ist entweder { local: Player } (Host oder KI, Schlüssel liegt hier)
 * oder { ask: function(msg) -> Promise<Antwort> } (Mensch über das Netz).
 *
 * Ablauf:
 *   begin   : jeder Platz nennt seinen öffentlichen Schlüssel h
 *   deal    : Mischen (jeder verschlüsselt und mischt), dann fremde Schichten entfernen,
 *             dann bekommt jeder Platz seine eigenen Karten zum Entschlüsseln
 *   reveal  : Besitzer legt Karten offen (Klartext + Beweis), der Host prüft
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mental.js'), require('./rules.js'));
  else root.JassMentalRound = factory(root.JassMental, root.JassRules);
})(typeof window !== 'undefined' ? window : this, function (M, R) {
  'use strict';

  function Round(n, seats) {
    if (seats.length !== n) throw new Error('Platzzahl stimmt nicht');
    this.n = n;
    this.seats = seats;
    this.deck = R.makeDeck();   // kartennummer k -> Karte
    this.pub = [];              // öffentlicher Schlüssel je Platz
    this.F = null;              // Endstand nach der Verteilung
    this.cache = {};            // Position -> Kartennummer (nur bereits offen gelegte Karten)
  }

  Round.prototype._ask = async function (s, msg) {
    var reply = await this.seats[s].ask(msg);
    if (!reply || typeof reply !== 'object') throw new Error('Keine Antwort von Platz ' + (s + 1));
    if (reply.err) throw new Error(reply.err);
    return reply;
  };

  Round.prototype.begin = async function () {
    for (var s = 0; s < this.n; s++) {
      if (this.seats[s].local) { this.pub[s] = this.seats[s].local.key.h; continue; }
      var reply = await this._ask(s, { op: 'begin' });
      var h = M.fromHex(reply.h);
      if (!M.isElement(h)) throw new Error('Schlüssel von Platz ' + (s + 1) + ' ungültig');
      this.pub[s] = h;
    }
  };

  // Ein Schritt (mischen oder fremde Schicht entfernen) an einem Platz.
  Round.prototype._step = async function (s, op, L) {
    var seat = this.seats[s];
    if (seat.local) return op === 'shuffle' ? seat.local.shuffle(L) : seat.local.peelDeal(L);
    var reply = await this._ask(s, { op: op, list: M.toWire(L) });
    var out = M.fromWire(reply.list, M.N);
    M.checkElems(out, M.N);
    return out;
  };

  // Verteilung. Ergebnis: Karten je Platz. Fremde Plätze bekommen nur Platzhalter ({pos, remote}).
  // opts.s7Check: Schellen-7-Angaben der Mitspieler offen legen und prüfen (nur mit eingeschalteter Regel).
  Round.prototype.deal = async function (opts) {
    var n = this.n, s, L = [];
    for (var k = 0; k < M.N; k++) L.push(M.encodeIndex(k));
    for (s = 0; s < n; s++) L = await this._step(s, 'shuffle', L);
    for (s = 0; s < n; s++) L = await this._step(s, 'peel', L);
    this.F = L;

    var hands = [], s7 = [];
    // Kartennummern der lokalen Plätze (Host, KI). Eine Karte darf nur einmal vorkommen,
    // auch über lokale und fremde Plätze hinweg (siehe reveal).
    this.localKnown = {};
    for (s = 0; s < n; s++) {
      var positions = M.positionsOf(s, n);
      if (this.seats[s].local) {
        var cards = this.seats[s].local.finalize(L);
        positions.forEach(function (p) {
          var kk = cards[p];
          if (this.localKnown[kk] !== undefined) throw new Error('Karte kommt doppelt vor');
          this.localKnown[kk] = p;
        }, this);
        hands[s] = positions.map(function (p) { return this.deck[cards[p]]; }, this);
        s7[s] = !!(opts && opts.s7Check) && hands[s].some(function (c) { return c.s === 'S' && c.r === '7'; });
        continue;
      }
      var reply = await this._ask(s, { op: 'final', list: M.toWire(L) });
      if (reply.ok !== true) throw new Error('Austeilung bei Platz ' + (s + 1) + ' fehlgeschlagen');
      hands[s] = positions.map(function (p) { return { pos: p, remote: true, seat: s }; });
      s7[s] = !!reply.s7 && !!(opts && opts.s7Check);
      if (s7[s]) {
        // Schellen-7 nur glauben, wenn die Karte offen gelegt und geprüft ist.
        var p7 = reply.s7pos;
        if (!Number.isInteger(p7) || p7 % n !== s) throw new Error('Schellen-7 Angabe falsch');
        var c7 = (await this.reveal(s, [p7]))[0];
        if (!(c7.s === 'S' && c7.r === '7')) throw new Error('Schellen-7 Angabe falsch');
      }
    }
    return { hands: hands, s7: s7 };
  };

  // Karten an den Positionen von Platz s offen legen (Klartext wird geprüft). Gibt Karten zurück.
  Round.prototype.reveal = async function (s, positions) {
    var self = this, n = this.n;
    positions.forEach(function (p) {
      if (!Number.isInteger(p) || p < 0 || p >= M.N || p % n !== s) throw new Error('Karte gehört nicht zu diesem Platz');
    });
    if (new Set(positions).size !== positions.length) throw new Error('Doppelte Karte angefragt');
    var need = positions.filter(function (p, i) { return self.cache[p] === undefined && positions.indexOf(p) === i; });
    if (need.length) {
      var items;
      if (this.seats[s].local) {
        items = await this.seats[s].local.revealOwn(need);
      } else {
        var reply = await this._ask(s, { op: 'reveal', pos: need });
        if (!Array.isArray(reply.items) || reply.items.length !== need.length) throw new Error('Aufdecken fehlgeschlagen');
        items = reply.items.map(function (it) { return { m: M.fromHex(it.m), proof: M.proofFromWire(it.proof) }; });
      }
      for (var i = 0; i < need.length; i++) {
        var p = need[i];
        var ok = await M.verifyReveal(items[i].m, this.F[p], this.pub[s], items[i].proof);
        if (!ok) throw new Error('Beweis für eine Karte von Platz ' + (s + 1) + ' ist falsch');
        var k = M.decodeValue(items[i].m);
        // Jede Karte gibt es nur einmal. Doppelte Karten zeigen Betrug beim Mischen.
        for (var q in this.cache) {
          if (this.cache[q] === k) throw new Error('Karte kommt doppelt vor');
        }
        if (this.localKnown && this.localKnown[k] !== undefined && this.localKnown[k] !== p) {
          throw new Error('Karte kommt doppelt vor');
        }
        this.cache[p] = k;
      }
    }
    return positions.map(function (p) { return self.deck[self.cache[p]]; });
  };

  // Anzahl bereits offen gelegter Karten (am Rundenende sollten es alle 36 sein).
  Round.prototype.revealedCount = function () { return Object.keys(this.cache).length; };

  /*
   * Gegenstelle auf dem Gerät eines Mitspielers. Antwortet auf die Aufträge des Hosts mit
   * den eigenen Daten. Der Schlüssel bleibt auf diesem Gerät.
   */
  function ClientSeat(seat, n) {
    this.seat = seat;
    this.n = n;
    this.player = null;
    this.deck = R.makeDeck();
    this.allowed = {};   // Positionen, die dieses Gerät selbst gespielt oder angesagt hat (nur die darf es offen legen)
  }

  // Vor einem eigenen Zug oder Weis aufrufen: nur diese Karten dürfen offen gelegt werden.
  ClientSeat.prototype.allow = function (positions) {
    var self = this;
    positions.forEach(function (p) { self.allowed[p] = true; });
  };

  ClientSeat.prototype.handle = async function (msg) {
    if (!msg || typeof msg !== 'object') throw new Error('Ungültige Anfrage');
    if (msg.op === 'begin') {
      this.player = new M.Player(this.seat, this.n);
      return { h: M.toHex(this.player.key.h) };
    }
    if (!this.player) throw new Error('Keine Runde gestartet');
    if (msg.op === 'shuffle' || msg.op === 'peel') {
      var L = M.fromWire(msg.list, M.N);
      M.checkElems(L, M.N);
      var out = msg.op === 'shuffle' ? this.player.shuffle(L) : this.player.peelDeal(L);
      return { list: M.toWire(out) };
    }
    if (msg.op === 'final') {
      var F = M.fromWire(msg.list, M.N);
      M.checkElems(F, M.N);
      var cards = this.player.finalize(F);
      var s7pos = -1;
      for (var p in cards) {
        var c = this.deck[cards[p]];
        if (c.s === 'S' && c.r === '7') s7pos = Number(p);
      }
      // Die Schellen-7 darf der Host bei Bedarf prüfen (nur wenn die Regel gilt).
      if (s7pos >= 0) this.allowed[s7pos] = true;
      return { ok: true, s7: s7pos >= 0, s7pos: s7pos };
    }
    if (msg.op === 'reveal') {
      if (!Array.isArray(msg.pos) || msg.pos.length === 0) throw new Error('Ungültige Positionen');
      var self = this;
      msg.pos.forEach(function (p) {
        // Nur Karten, die dieses Gerät selbst angekündigt hat. Alles andere wird verweigert.
        if (!self.allowed[p]) throw new Error('Nicht angefragt');
      });
      var items = await this.player.revealOwn(msg.pos);
      msg.pos.forEach(function (p) { delete self.allowed[p]; });
      return { items: items.map(function (it) { return { m: M.toHex(it.m), proof: M.proofToWire(it.proof) }; }) };
    }
    throw new Error('Unbekannter Auftrag');
  };

  var api = { Round: Round, ClientSeat: ClientSeat };
  return api;
});
