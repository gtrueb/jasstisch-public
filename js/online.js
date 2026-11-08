/*
 * Online-Spiel über WebRTC (PeerJS). Der Host führt die Engine aus und ist die einzige
 * Wahrheit. Jeder Mitspieler bekommt nur seine eigene Sicht (js/view.js).
 * Aktionen der Mitspieler werden vom Host geprüft (game.act). Fällt ein Mensch aus,
 * übernimmt eine KI den Platz. Mit demselben Token (sessionStorage) bekommt man den Platz zurück.
 */
(function (root) {
  'use strict';

  var PREFIX = 'jasstisch-';
  var ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // ohne I, O, 0, 1
  var CODE_LEN = 10;
  var TURN_LIMIT_MS = 45000;

  var S = {
    role: null, peer: null, code: '', gtype: 'schieber', players: 4,
    seats: [], started: false, engine: null, adapter: null,
    token: '', name: '', mySeat: 0, sv: 0, lastSv: -1, lastView: null,
    hostConn: null, conn: null, lobby: null, watch: null, turnKey: '', turnSince: 0,
    onLobby: null, onStart: null, onRender: null, onStatus: null
  };

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
        if (S.engine) S.engine.setHuman(i, true);
        broadcast();
      }
      pushLobby();
      return;
    }
    if (msg.t === 'act') {
      if (!S.started || !S.engine || conn.seatIndex === undefined) return;
      S.engine.act(conn.seatIndex, msg.action);   // Engine prüft Zug, Karte, Trumpf usw.
      return;
    }
  }

  function hostClosed(conn) {
    var i = conn.seatIndex;
    if (i === undefined || !S.seats[i] || S.seats[i].conn !== conn) return;
    S.seats[i].connected = false;
    S.seats[i].conn = null;
    if (S.started && S.engine) S.engine.setHuman(i, false);   // KI übernimmt sofort
    pushLobby();
  }

  // Lobby-Einstellungen vom Host
  function hostSetLevel(i, level) {
    if (S.seats[i] && S.seats[i].kind !== 'human') { S.seats[i].level = level; pushLobby(); }
  }
  function hostSetPlayers(n) {
    if (S.started || S.gtype !== 'molotov') return;
    for (var i = n; i < S.seats.length; i++) if (S.seats[i].kind === 'human') return;
    S.players = n;
    S.seats = S.seats.slice(0, n);
    while (S.seats.length < n) S.seats.push({ kind: 'open', level: 'mittel', connected: false });
    pushLobby();
  }

  // ---------- Host: Spiel starten und Sichten senden ----------
  function hostStart(settings) {
    if (S.started) return;
    S.seats.forEach(function (s) { if (s.kind === 'open') { s.kind = 'ai'; s.connected = false; } });
    var humanSeats = [], aiLevels = {};
    S.seats.forEach(function (s, i) {
      if (s.kind === 'human') humanSeats.push(i);
      else { aiLevels[i] = s.level || 'mittel'; }
    });
    var delays = root.JassTempo.scaled(S.gtype === 'molotov' ? root.JassMolotov.DEFAULT_DELAYS : root.JassGame.DEFAULT_DELAYS);
    var cfg = Object.assign({}, settings, { humanSeats: humanSeats, aiLevels: aiLevels, delays: delays, onUpdate: onEngineUpdate });
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

  // Zeitlimit: hängt ein Mensch zu lange, zieht die KI für ihn.
  function checkTurnKey() {
    var e = S.engine;
    if (!e) return;
    var key = [e.phase, e.trickNo, e.plays.length, e.turnSeat ? e.turnSeat() : '', e.chooser, e.hold ? 1 : 0, e.history.length].join('|');
    if (key !== S.turnKey) { S.turnKey = key; S.turnSince = Date.now(); }
  }
  function watchTurns() {
    if (!S.engine) return;
    checkTurnKey();
    if (Date.now() - S.turnSince < TURN_LIMIT_MS) return;
    var seat = turnSeatNow();
    if (seat >= 0 && S.seats[seat] && S.seats[seat].kind === 'human') {
      S.turnSince = Date.now();
      S.engine.autoMove(seat);
    } else if (S.engine.phase === 'roundEnd' || S.engine.phase === 'gameEnd') {
      if (S.engine.phase === 'roundEnd') { S.turnSince = Date.now(); S.engine.nextRound(); }
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
  function clientAdapter() {
    function sendAct(a) { if (S.hostConn && S.hostConn.open) S.hostConn.send({ t: 'act', action: a }); }
    return {
      online: true, role: 'client', humanSeat: S.mySeat, delays: {},
      stateForUI: function () { return S.lastView; },
      humanPlay: function (id) { sendAct({ type: 'card', id: id }); return true; },
      humanChooseTrump: function (suit) { sendAct({ type: 'trump', suit: suit }); return true; },
      humanSchieben: function () { sendAct({ type: 'schieben' }); return true; },
      humanAnnounce: function () { sendAct({ type: 'weis' }); return true; },
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
    if (msg.t === 'state') {
      if (msg.sv <= S.lastSv) return;   // alte Nachricht
      S.lastSv = msg.sv;
      S.lastView = msg.view;
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
    try { if (S.engine) S.engine.stop(); } catch (e) {}
    try { if (S.peer) S.peer.destroy(); } catch (e) {}
    S.role = null; S.peer = null; S.hostConn = null; S.engine = null; S.adapter = null;
    S.started = false; S.seats = []; S.lastView = null; S.lastSv = -1; S.sv = 0; S.turnKey = '';
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
