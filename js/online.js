/*
 * Online-Spiel über WebRTC (PeerJS). Der Host führt den Spielablauf aus. Die Karten der Mitspieler
 * sind verschlüsselt (js/mental.js, js/mental-round.js). Jeder Mitspieler hält seinen Schlüssel
 * und seine Karten auf seinem Gerät.
 *
 * Vertrauen (ehrlich beschrieben):
 * - Ein Host, der den Originalcode nutzt, sieht die Hände der Mitspieler nicht. Jedes Gerät gibt nur
 *   die Karten frei, die es selbst spielt oder ansagt, und Karten werden mit Beweis geprüft.
 * - Ein Host, der den Code verändert, kann die Mischschritte manipulieren und so Karten erfahren.
 *   Das würde überprüfbare Mischschritte verhindern, die noch fehlen.
 * - Ob ein Mitspieler die Farbe bedient, prüft nur sein Gerät.
 * - Ein Mitspieler, der bei Rundenbeginn nicht verbunden ist, wird durch eine KI ersetzt. Deren Karten kennt der Host.
 *
 * Fällt ein Mitspieler während einer Runde aus, wird die Runde abgebrochen und neu gestartet.
 * Mit demselben Token (sessionStorage) bekommt man den Platz zurück, gilt aber erst ab der nächsten Runde.
 */
(function (root) {
  'use strict';

  var PREFIX = 'jasstisch-';
  var ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // ohne I, O, 0, 1
  var CODE_LEN = 10;
  var TURN_LIMIT_MS = 45000;
  var ASK_TIMEOUT_MS = 20000;

  var S = {
    role: null, peer: null, code: '', gtype: 'schieber', players: 4,
    seats: [], started: false, engine: null, adapter: null,
    token: '', name: '', mySeat: 0, sv: 0, lastSv: -1, lastView: null,
    hostConn: null, conn: null, lobby: null, watch: null, turnKey: '', turnSince: 0, autoAsked: false,
    onLobby: null, onStart: null, onRender: null, onStatus: null,
    // Host: laufende Runde und offene Anfragen an Mitspieler
    round: null, rid: 0, asks: {},
    // Mitspieler: eigene Runde (Schlüssel, Karten) und Merkliste für Stöck/Weis
    cseat: null, posById: {}
  };

  var DECK = null;
  function deck() { if (!DECK) DECK = root.JassRules.makeDeck(); return DECK; }

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16); }
  function status(text) { if (S.onStatus) S.onStatus(text); }

  function randomChars(len) {
    var a = new Uint32Array(len), out = '';
    crypto.getRandomValues(a);
    for (var i = 0; i < len; i++) out += ALPH[a[i] % ALPH.length];
    return out;
  }
  function newCode() { return randomChars(CODE_LEN); }

  function getToken() {
    try {
      var t = sessionStorage.getItem('jasstisch-token');
      if (!t) {
        t = randomChars(24) + randomChars(24);
        sessionStorage.setItem('jasstisch-token', t);
      }
      return t;
    } catch (e) {
      return randomChars(24) + randomChars(24);
    }
  }

  function ensurePeerLib() {
    if (typeof root.Peer === 'undefined') {
      status('Online-Spiel braucht eine Internetverbindung (PeerJS wurde nicht geladen).');
      return false;
    }
    if (!root.JassMental || !root.JassMentalRound) {
      status('Kartenschloss-Modul fehlt (js/mental.js).');
      return false;
    }
    return true;
  }

  // ---------- Namen und Lobby (Host) ----------
  function seatName(i) {
    var s = S.seats[i];
    if (!s) return '';
    if (s.kind === 'ai') return 'Computer (' + (s.level || 'mittel') + ')';
    if (s.kind === 'open') return 'frei';
    return s.name || ('Spieler ' + (i + 1));
  }
  function names() {
    var out = [];
    for (var i = 0; i < S.seats.length; i++) out.push(seatName(i));
    return out;
  }
  function publicLobby() {
    return {
      code: S.code, gtype: S.gtype, players: S.players, started: S.started,
      seats: S.seats.map(function (s) { return { kind: s.kind, name: s.name || '', connected: !!s.connected, level: s.level || 'mittel' }; })
    };
  }

  function send(conn, msg) {
    if (conn && conn.open) conn.send(msg);
  }
  function pushLobby() {
    S.seats.forEach(function (s) { if (s.conn) send(s.conn, { t: 'lobby', lobby: publicLobby() }); });
    S.lobby = publicLobby();
    if (S.onLobby) S.onLobby(S.lobby);
  }

  function hostOpen(retries) {
    var id = PREFIX + S.code;
    S.peer = new root.Peer(id);
    S.peer.on('open', function () { pushLobby(); status('Lobby offen. Code: ' + S.code); });
    S.peer.on('connection', hostAccept);
    S.peer.on('error', function (e) {
      if (e.type === 'unavailable-id' && retries > 0) {
        S.peer.destroy();
        S.code = newCode();
        hostOpen(retries - 1);
      } else {
        status('Verbindungsfehler: ' + e.type);
      }
    });
  }

  function hostAccept(conn) {
    conn.on('data', function (msg) { hostMsg(conn, msg); });
    conn.on('close', function () { hostClosed(conn); });
    conn.on('error', function () { hostClosed(conn); });
  }

  // Läuft gerade eine Runde (Karten werden verteilt oder gespielt)?
  function roundRunning() {
    var e = S.engine;
    return !!e && ['dealing', 'deal', 'trump', 'play', 'aborted'].indexOf(e.phase) >= 0;
  }

  function hostMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      var i = -1, k;
      for (k = 0; k < S.seats.length; k++) {
        if (S.seats[k].token && S.seats[k].token === msg.token) { i = k; break; }
      }
      if (i < 0 && !S.started) {
        for (k = 1; k < S.seats.length; k++) {
          if (S.seats[k].kind === 'open') { i = k; break; }
        }
        if (i >= 0) {
          S.seats[i] = { kind: 'human', name: clean(msg.name) || ('Gast ' + i), token: msg.token, connected: true, level: 'mittel' };
        }
      }
      if (i < 0) {
        send(conn, { t: 'reject', why: S.started ? 'Das Spiel läuft schon.' : 'Lobby ist voll.' });
        return;
      }
      var seat = S.seats[i];
      if (seat.conn && seat.conn !== conn) { try { seat.conn.close(); } catch (e) {} }
      seat.conn = conn; seat.connected = true; conn.seatIndex = i;
      send(conn, { t: 'welcome', seat: i });
      if (S.started) {
        // Während einer Runde bleibt der Platz beim Gerät. Zwischen den Runden kommt er zurück.
        if (S.engine && !roundRunning()) S.engine.setHuman(i, true);
        // Offene Anfragen an diesen Platz noch einmal schicken.
        Object.keys(S.asks).forEach(function (rid) {
          var a = S.asks[rid];
          if (a.seat === i) send(conn, { t: 'mp', rid: Number(rid), msg: a.msg });
        });
        broadcast();
      }
      pushLobby();
      return;
    }
    if (msg.t === 'mpr') {
      // Antwort eines Mitspielers auf eine Anfrage
      var a = S.asks[msg.rid];
      if (!a || a.seat !== conn.seatIndex) return;
      delete S.asks[msg.rid];
      clearTimeout(a.timer);
      if (msg.err) {
        // Fehler kostet den Platz die Runde: er wird ersetzt, damit niemand Runden beliebig abbricht.
        markGone(conn.seatIndex);
        a.resolve({ err: String(msg.err) });
      } else {
        a.resolve(msg.reply);
      }
      return;
    }
    if (msg.t === 'act') {
      if (!S.started || !S.engine || conn.seatIndex === undefined) return;
      applyRemoteAct(conn.seatIndex, msg.action);   // Engine prüft Zug, Besitz, Trumpf usw.
      return;
    }
  }

  function hostClosed(conn) {
    var i = conn.seatIndex;
    if (i === undefined || !S.seats[i] || S.seats[i].conn !== conn) return;
    S.seats[i].connected = false;
    S.seats[i].conn = null;
    // Mitten in der Runde bleibt der Platz, bis die Anfrage ausläuft. Dann wird die Runde abgebrochen.
    if (S.started && S.engine && !roundRunning()) S.engine.setHuman(i, false);   // KI übernimmt ab der nächsten Runde
    pushLobby();
  }

  // Lobby-Einstellungen vom Host
  function hostSetLevel(i, level) {
    if (S.seats[i] && S.seats[i].kind !== 'human') { S.seats[i].level = level; pushLobby(); }
  }
  // Spielerzahl ändern (nur Host, nur Molotow, nur vor dem Start). Gibt false zurück, wenn abgelehnt.
  function hostSetPlayers(n) {
    if (S.role !== 'host' || S.started || S.gtype !== 'molotov') return false;
    for (var i = n; i < S.seats.length; i++) {
      if (S.seats[i].kind === 'human') { status('Platz ' + (i + 1) + ' ist besetzt.'); return false; }
    }
    S.players = n;
    S.seats = S.seats.slice(0, n);
    while (S.seats.length < n) S.seats.push({ kind: 'open', level: 'mittel', connected: false });
    pushLobby();
    return true;
  }

  // ---------- Host: Spiel starten ----------
  function hostStart(settings) {
    if (S.started) return;
    S.seats.forEach(function (s) { if (s.kind === 'open') { s.kind = 'ai'; s.connected = false; } });
    var humanSeats = [], aiLevels = {};
    S.seats.forEach(function (s, i) {
      if (s.kind === 'human') humanSeats.push(i);
      else { aiLevels[i] = s.level || 'mittel'; }
    });
    var delays = root.JassTempo.scaled(S.gtype === 'molotov' ? root.JassMolotov.DEFAULT_DELAYS : root.JassGame.DEFAULT_DELAYS);
    var cfg = Object.assign({}, settings, {
      humanSeats: humanSeats, aiLevels: aiLevels, delays: delays, onUpdate: onEngineUpdate,
      dealHook: hostDeal, revealCards: hostReveal
    });
    if (S.gtype === 'molotov') {
      cfg.players = S.players;
      S.engine = new root.JassMolotov.Game(cfg);
    } else {
      S.engine = new root.JassGame.Game(cfg);
    }
    S.started = true;
    S.adapter = hostAdapter();
    S.watch = setInterval(watchTurns, 1000);
    pushLobby();
    if (S.onStart) S.onStart(S.adapter);
    S.engine.startRound();
  }

  // Verdeilen: Mitspieler (verbunden) bekommen verdeckte Karten, alle anderen Plätze lokal.
  function hostDeal(engine, rid) {
    var n = engine.n || 4;
    var remote = [];
    for (var s = 1; s < n; s++) {
      var seat = S.seats[s];
      if (seat && seat.kind === 'human' && seat.connected && seat.conn && seat.conn.open) {
        remote.push(s);
        engine.setHuman(s, true);
      } else {
        engine.setHuman(s, false);
      }
    }
    engine.remoteSeats = remote;
    var seats = [];
    for (var t = 0; t < n; t++) {
      if (remote.indexOf(t) >= 0) seats.push({ ask: makeAsk(t) });
      else seats.push({ local: new root.JassMental.Player(t, n) });   // Host und KI: Schlüssel hier
    }
    var round = new root.JassMentalRound.Round(n, seats);
    S.round = round;
    round.begin().then(function () {
      return round.deal({ s7Check: !!engine.cfg.schellen7 });
    }).then(function (res) {
      if (rid !== engine.roundId || S.round !== round) return;
      engine.setDealt(res.hands, { s7: res.s7 }, rid);
    }).catch(function (err) {
      if (rid !== engine.roundId) return;
      hostAbort(err && err.message ? err.message : 'Verteilung fehlgeschlagen');
    });
  }

  // Karten offen legen lassen (Engine ruft das auf, wenn ein Mitspieler spielt oder ansagt).
  function hostReveal(seat, positions) {
    if (!S.round) return Promise.reject(new Error('Keine Runde'));
    return S.round.reveal(seat, positions);
  }

  // Platz gilt als weg (z. B. keine Antwort). Ab der nächsten Runde übernimmt die KI.
  function markGone(seat) {
    var s = S.seats[seat];
    if (!s || s.kind !== 'human') return;
    s.connected = false;
    if (s.conn) { try { s.conn.close(); } catch (e) {} s.conn = null; }
    if (S.engine && !roundRunning()) S.engine.setHuman(seat, false);
    pushLobby();
  }

  // Anfrage an einen Mitspieler. Antwort kommt als Promise. Nach 20 s ohne Antwort: Platz gilt als weg.
  function makeAsk(seat) {
    return function (msg) {
      return new Promise(function (resolve, reject) {
        S.rid++;
        var rid = S.rid;
        var timer = setTimeout(function () {
          delete S.asks[rid];
          markGone(seat);
          reject(new Error('Platz ' + (seat + 1) + ' antwortet nicht'));
        }, ASK_TIMEOUT_MS);
        S.asks[rid] = { seat: seat, msg: msg, resolve: resolve, reject: reject, timer: timer };
        var s = S.seats[seat];
        if (s && s.conn && s.conn.open) s.conn.send({ t: 'mp', rid: rid, msg: msg });
      });
    };
  }

  function cancelAsks(reason) {
    var old = S.asks;
    S.asks = {};
    Object.keys(old).forEach(function (rid) {
      clearTimeout(old[rid].timer);
      old[rid].reject(new Error(reason));
    });
  }

  // Runde abbrechen: laufende Anfragen verwerfen, Engine startet neu (Punkte bleiben).
  function hostAbort(reason) {
    cancelAsks('Runde abgebrochen');
    S.round = null;
    if (S.engine) S.engine.abortRound(reason);
    status('Runde abgebrochen: ' + reason);
  }

  // Aktion eines Platzes weiterleiten. Fremde Plätze: Karten erst offen legen lassen.
  // Gibt false zurück, wenn die Aktion ungültig ist (dann bleibt der Zug offen).
  function applyRemoteAct(seat, a) {
    var e = S.engine;
    if (!e || !a || typeof a !== 'object') return false;
    if (e.isRemote(seat)) {
      if (a.type === 'card') return e.requestPlay(seat, Number(a.pos)) === true;
      if (a.type === 'weis') return e.requestWeis(seat, Array.isArray(a.positions) ? a.positions.map(Number) : []) === true;
    }
    return e.act(seat, a) === true;   // Trumpf, Schieben, Weiter, nächste Runde
  }

  function onEngineUpdate() {
    broadcast();
    checkTurnKey();
    if (S.onRender && S.adapter) S.onRender(S.adapter);
  }

  // Jedem verbundenen Menschen (außer dem Host) seine Sicht schicken.
  function broadcast() {
    if (!S.engine) return;
    S.sv++;
    var nm = names();
    S.seats.forEach(function (s, i) {
      if (i === 0 || s.kind !== 'human' || !s.conn || !s.conn.open) return;
      var view = root.JassView.buildView(S.engine.stateForUI(i), i, nm, S.gtype);
      send(s.conn, { t: 'state', sv: S.sv, view: view });
    });
  }

  function turnSeatNow() {
    var st = S.engine;
    if (!st) return -1;
    if (st.phase === 'trump') return st.chooser;
    if (st.phase === 'play') return st.turnSeat();
    return -1;
  }

  // Zeitlimit: hängt ein Platz zu lange, zieht die KI (bei Mitspielern: sein Gerät) den Zug.
  function checkTurnKey() {
    var e = S.engine;
    if (!e) return;
    var key = [e.phase, e.trickNo, e.plays.length, e.turnSeat ? e.turnSeat() : '', e.chooser, e.hold ? 1 : 0, e.history.length].join('|');
    if (key !== S.turnKey) { S.turnKey = key; S.turnSince = Date.now(); S.autoAsked = false; }
  }
  function watchTurns() {
    if (!S.engine) return;
    checkTurnKey();
    if (Date.now() - S.turnSince < TURN_LIMIT_MS) return;
    var e = S.engine;
    if (e.phase === 'roundEnd') { S.turnSince = Date.now(); e.nextRound(); return; }
    var seat = turnSeatNow();
    if (seat < 0) return;
    if (e.isRemote(seat)) {
      if (S.autoAsked) return;
      S.autoAsked = true;
      makeAsk(seat)({ op: 'auto' }).then(function (r) {
        if (!r || r.err) { hostAbort(r && r.err ? r.err : 'Platz antwortet nicht'); return; }
        if (!applyRemoteAct(seat, r)) hostAbort('Ungültiger Zug von Platz ' + (seat + 1));
      }, function (err) {
        hostAbort(err && err.message ? err.message : 'Platz antwortet nicht');
      });
      return;
    }
    if (S.seats[seat] && S.seats[seat].kind === 'human') {
      S.turnSince = Date.now();
      e.autoMove(seat);
    }
  }

  function hostAdapter() {
    var e = S.engine;
    return {
      online: true, role: 'host', humanSeat: 0, delays: e.delays,
      stateForUI: function () { return root.JassView.buildView(e.stateForUI(0), 0, names(), S.gtype); },
      humanPlay: function (id) { return e.act(0, { type: 'card', id: id }); },
      humanChooseTrump: function (suit) { return e.act(0, { type: 'trump', suit: suit }); },
      humanSchieben: function () { return e.act(0, { type: 'schieben' }); },
      humanAnnounce: function () { return e.act(0, { type: 'weis' }); },
      releaseHold: function () { return e.act(0, { type: 'release' }); },
      nextRound: function () { return e.act(0, { type: 'next' }); },
      stop: function () { leave(); }
    };
  }

  // ---------- Mitspieler ----------

  // Ansicht ergänzen: eigene Karten, erlaubte Karten, Weis. Die eigenen Karten kennt nur dieses Gerät.
  function overlay(view) {
    var cards = S.cseat && S.cseat.player ? S.cseat.player.cards : null;
    var d = deck();
    S.posById = {};
    if (cards) Object.keys(cards).forEach(function (p) { S.posById[d[cards[p]].id] = Number(p); });
    var hand = [];
    if (cards && view.hands && view.hands[0]) {
      view.hands[0].forEach(function (h) {
        if (h && h.pos !== undefined && cards[h.pos] !== undefined) hand.push(d[cards[h.pos]]);
      });
    }
    view.hands[0] = hand;

    var mine = view.phase === 'play' && view.turnSeat === 0 && view.plays.length < (view.n || 4);
    view.legal = mine ? legalIds(hand, view.plays, view.trump) : [];
    view.humanBest = (view.phase === 'play' && view.trickNo === 0 && !view.humanWeisDone) ? root.JassRules.weisTotal(hand) : null;
    // Weis-Karten: alle Karten, nach denen Rang und Punkte bestimmt werden (Rang und Summe getrennt).
    var weisCards = [];
    if (view.humanBest) {
      var best = root.JassRules.bestWeis(hand);
      var seen = {};
      (best ? best.cards : []).concat(view.humanBest.cards).forEach(function (c) {
        if (!seen[c.id]) { seen[c.id] = true; weisCards.push(c); }
      });
    }
    view.humanWeisIds = weisCards.map(function (c) { return c.id; });
    return view;
  }

  function legalIds(hand, plays, trump) {
    var R = root.JassRules;
    var list = S.gtype === 'molotov' ? R.legalFree(hand, plays) : R.legalCards(hand, plays, trump);
    return list.map(function (c) { return c.id; });
  }

  // Zug, wenn der Platz keine Zeit mehr hat (Anfrage "auto"): die KI dieses Geräts wählt.
  function clientAuto() {
    var v = S.lastView;
    if (!v || !S.cseat || !S.cseat.player) throw new Error('Keine Karten auf diesem Gerät');
    var ai = S.gtype === 'molotov' ? root.JassAIMolotov : root.JassAISchieber;
    var player = ai.createPlayer({ level: 'mittel' });
    var hand = v.hands[0] || [];
    if (v.phase === 'trump') {
      var d = player.chooseTrump(hand, { canSchieben: v.canSchieben });
      return d.action === 'schieben' ? { type: 'schieben' } : { type: 'trump', suit: d.suit };
    }
    if (v.phase === 'play') {
      var card = player.choosePlay(hand, v.plays, v.trump, 0);
      var pos = S.posById[card.id];
      if (pos === undefined) throw new Error('Karte nicht auf diesem Gerät');
      S.cseat.allow([pos]);
      return { type: 'card', pos: pos };
    }
    throw new Error('Kein Zug nötig');
  }

  // Anfragen des Hosts an dieses Gerät (siehe js/mental-round.js ClientSeat).
  function clientMp(msg) {
    var rid = msg.rid, req = msg.msg || {};
    if (req.op === 'auto') {
      try { sendMpr(rid, clientAuto(), null); } catch (e) { sendMpr(rid, null, e.message); }
      return;
    }
    if (req.op === 'begin') {
      S.cseat = new root.JassMentalRound.ClientSeat(S.mySeat, S.players);
      S.posById = {};
    }
    if (!S.cseat) { sendMpr(rid, null, 'Keine Runde gestartet'); return; }
    S.cseat.handle(req).then(function (reply) {
      sendMpr(rid, reply, null);
    }, function (err) {
      sendMpr(rid, null, err && err.message ? err.message : 'Fehler');
    });
  }

  function sendMpr(rid, reply, err) {
    send(S.hostConn, { t: 'mpr', rid: rid, reply: reply, err: err || null });
  }

  function clientAdapter() {
    function sendAct(a) { if (S.hostConn && S.hostConn.open) S.hostConn.send({ t: 'act', action: a }); }
    return {
      online: true, role: 'client', humanSeat: S.mySeat, delays: {},
      stateForUI: function () { return S.lastView; },
      humanPlay: function (id) {
        var pos = S.posById[id];
        if (pos === undefined || !S.cseat) return false;
        S.cseat.allow([pos]);   // nur diese Karte darf der Host jetzt offen legen lassen
        sendAct({ type: 'card', pos: pos });
        return true;
      },
      humanChooseTrump: function (suit) { sendAct({ type: 'trump', suit: suit }); return true; },
      humanSchieben: function () { sendAct({ type: 'schieben' }); return true; },
      humanAnnounce: function () {
        var positions = (S.lastView.humanWeisIds || []).map(function (id) { return S.posById[id]; }).filter(function (p) { return p !== undefined; });
        if (!positions.length || !S.cseat) return false;
        S.cseat.allow(positions);
        sendAct({ type: 'weis', positions: positions });
        return true;
      },
      releaseHold: function () { sendAct({ type: 'release' }); return true; },
      nextRound: function () { sendAct({ type: 'next' }); return true; },
      stop: function () { leave(); }
    };
  }

  function clientMsg(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'welcome') { S.mySeat = msg.seat; status('Verbunden als Platz ' + (msg.seat + 1) + '.'); return; }
    if (msg.t === 'reject') { status(msg.why); return; }
    if (msg.t === 'lobby') {
      S.lobby = msg.lobby;
      S.gtype = msg.lobby.gtype; S.players = msg.lobby.players;
      if (S.onLobby) S.onLobby(msg.lobby);
      if (msg.lobby.started && !S.adapter) {
        S.adapter = clientAdapter();
        if (S.onStart) S.onStart(S.adapter);
      }
      return;
    }
    if (msg.t === 'mp') { clientMp(msg); return; }
    if (msg.t === 'state') {
      if (msg.sv <= S.lastSv) return;   // alte Nachricht
      S.lastSv = msg.sv;
      S.lastView = overlay(msg.view);
      if (S.onRender && S.adapter) S.onRender(S.adapter);
    }
  }

  function connectToHost() {
    if (!S.peer || S.peer.destroyed) return;
    var conn = S.peer.connect(PREFIX + S.code, { reliable: true });
    if (!conn) return;
    S.hostConn = conn;
    conn.on('open', function () {
      status('Verbunden. Warte auf Spielstand …');
      conn.send({ t: 'hello', token: S.token, name: S.name });
    });
    conn.on('data', clientMsg);
    var myPeer = S.peer;
    conn.on('close', function () {
      if (S.role !== 'client' || S.peer !== myPeer) return;   // alte Verbindung: nichts tun
      status('Verbindung verloren. Verbinde neu …');
      setTimeout(function () { if (S.role === 'client' && S.peer === myPeer) connectToHost(); }, 2000);
    });
    conn.on('error', function () { status('Verbindung gestört …'); });
  }

  // ---------- Öffentliche Funktionen ----------
  function leave() {
    clearInterval(S.watch);
    cancelAsks('Verlassen');
    try { if (S.engine) S.engine.stop(); } catch (e) {}
    try { if (S.peer) S.peer.destroy(); } catch (e) {}
    S.role = null; S.peer = null; S.hostConn = null; S.engine = null; S.adapter = null;
    S.started = false; S.seats = []; S.lastView = null; S.lastSv = -1; S.sv = 0; S.turnKey = ''; S.autoAsked = false;
    S.round = null; S.cseat = null; S.posById = {};
    S.lobby = null;
    if (S.onLobby) S.onLobby(null);
  }

  function createLobby(gtype, players, name) {
    if (!ensurePeerLib()) return;
    leave();
    S.role = 'host'; S.gtype = gtype; S.players = players; S.code = newCode();
    S.token = getToken(); S.name = clean(name) || 'Du';
    S.seats = [];
    for (var i = 0; i < players; i++) S.seats.push({ kind: 'open', level: 'mittel', connected: false });
    S.seats[0] = { kind: 'human', name: S.name, token: S.token, connected: true, level: 'mittel' };
    hostOpen(5);
  }

  function joinLobby(code, name) {
    if (!ensurePeerLib()) return;
    leave();
    S.role = 'client'; S.code = String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
    S.token = getToken(); S.name = clean(name) || 'Gast';
    S.peer = new root.Peer();
    S.peer.on('open', function () { status('Suche Lobby ' + S.code + ' …'); connectToHost(); });
    S.peer.on('error', function (e) { status('Lobby nicht erreichbar (' + e.type + ').'); });
  }

  root.JassOnline = {
    createLobby: createLobby, joinLobby: joinLobby, hostStart: hostStart, leave: leave,
    hostSetLevel: hostSetLevel, hostSetPlayers: hostSetPlayers,
    state: S,
    setHandlers: function (h) { S.onLobby = h.onLobby; S.onStart = h.onStart; S.onRender = h.onRender; S.onStatus = h.onStatus; }
  };
})(typeof window !== 'undefined' ? window : this);
