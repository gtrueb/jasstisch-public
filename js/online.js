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
  var CODE_LEN = 4;
  var TURN_LIMIT_MS = 45000;
  var ASK_TIMEOUT_MS = 20000;
  // Wer während einer Runde ausfällt (Fehler oder keine Antwort), sitzt so viele abgeschlossene Runden als KI aus.
  var BENCH_ROUNDS = 2;
  // Zeiten (Millisekunden). Die Tests setzen sie kleiner, siehe JassOnline.timing.
  var T = {
    connectMs: 15000,      // so lange wartet ein Mitspieler auf den Verbindungsaufbau zur Lobby
    retryMs: 2000,         // Pause zwischen zwei Verbindungsversuchen
    electAfterFails: 3,    // so viele fehlgeschlagene Versuche, dann gilt der Host als weg
    electStepMs: 5000,     // Wartezeit pro Rang: Rang 0 sofort, Rang 1 nach 5 s, Rang 2 nach 10 s ...
    electMaxMs: 60000,     // danach gibt die Lobby auf
    rejoinMs: 15000,       // nach einer Übernahme mitten im Spiel: so lange wartet der neue Host auf die Mitspieler
    beatMs: 2000,          // der Host schickt alle 2 s ein Lebenszeichen ("ping")
    silentMs: 8000,        // schweigt der Host so lange, gilt er als weg (WebRTC merkt einen stillen Absturz oft erst nach 30 s)
    iceMs: 3000            // so lange wartet die Seite höchstens auf die TURN-Zugangsdaten. Dann gelten die festen Listen.
  };

  // Verbindungswege (ICE). STUN findet den direkten Weg. TURN ist ein Relais, das einspringt, wenn der
  // direkte Weg blockiert ist (zum Beispiel bei Mobilfunk oder in manchen Netzen).
  // PeerJS nimmt standardmäßig eu-0/us-0.turn.peerjs.com. Diese Namen lösen nicht mehr auf,
  // darum setzen wir die Liste selbst.
  var STUN_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  // Eigene TURN-Zugangsdaten hier eintragen. Beispiel:
  // { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:443?transport=tcp'], username: 'NAME', credential: 'PASSWORT' }
  var TURN_SERVERS = [];
  // Adresse eines eigenen Servers, der kurzlebige TURN-Zugangsdaten ausgibt (siehe turn-worker/worker.mjs).
  // Leer = keine Abfrage. Dann gelten nur STUN_SERVERS und TURN_SERVERS.
  var TURN_ENDPOINT = 'https://muddy-hill-0d39.gian-5c3.workers.dev';
  function fallbackIce() { return STUN_SERVERS.concat(TURN_SERVERS); }
  // Gültige Einträge aus der Antwort des Servers. Alles andere fällt weg.
  function iceFromJson(j) {
    var list = [];
    var raw = j && Array.isArray(j.iceServers) ? j.iceServers : [];
    raw.forEach(function (e) {
      if (!e || typeof e !== 'object') return;
      var urls = typeof e.urls === 'string' ? [e.urls] : (Array.isArray(e.urls) ? e.urls : []);
      urls = urls.filter(function (u) { return typeof u === 'string' && /^turns?:|^stuns?:/.test(u); });
      if (!urls.length) return;
      var hasTurn = urls.some(function (u) { return /^turns?:/.test(u); });
      // Ein TURN-Eintrag ohne Zugangsdaten würde den Verbindungsaufbau stoppen. Er fällt weg.
      if (hasTurn && (typeof e.username !== 'string' || typeof e.credential !== 'string')) return;
      var item = { urls: urls };
      if (typeof e.username === 'string') item.username = e.username;
      if (typeof e.credential === 'string') item.credential = e.credential;
      list.push(item);
    });
    return list;
  }
  // Holt die Verbindungswege, bevor ein Peer gebaut wird. Kommt keine Antwort rechtzeitig,
  // bleibt es bei den festen Listen. Dann gehen Lobbys wenigstens über STUN.
  function loadIce() {
    if (!TURN_ENDPOINT) return Promise.resolve(fallbackIce());
    return new Promise(function (resolve) {
      var finished = false, timer = null;
      function finish(list) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        // Die festen Listen bleiben immer dabei. Die Antwort des Servers kommt dazu.
        resolve(fallbackIce().concat(list));
      }
      timer = setTimeout(function () { finish([]); }, T.iceMs);
      try {
        fetch(TURN_ENDPOINT, { cache: 'no-store' })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (j) { finish(iceFromJson(j)); }, function () { finish([]); });
      } catch (e) { finish([]); }
    });
  }
  function peerOpts(ice) { return { config: { iceServers: ice || fallbackIce() } }; }

  var S = {
    role: null, peer: null, code: '', gtype: 'schieber', players: 4,
    seats: [], started: false, engine: null, adapter: null,
    token: '', name: '', mySeat: 0, sv: 0, lastSv: -1, lastView: null,
    hostConn: null, conn: null, lobby: null, watch: null, turnKey: '', turnSince: 0, autoAsked: false,
    onLobby: null, onStart: null, onRender: null, onStatus: null,
    // Host: laufende Runde und offene Anfragen an Mitspieler
    round: null, rid: 0, asks: {},
    // Mitspieler: eigene Runde (Schlüssel, Karten) und Merkliste für Stöck/Weis
    cseat: null, posById: {},
    // Lobby-Übernahme: Zähler für Versuche, Wahl-Nummer, Instanz-Kennung des Hosts, Regeln der Lobby
    fails: 0, electing: false, elecId: 0, inst: '', hostInst: null, rules: null,
    // Übernahme mitten im Spiel: wartet der neue Host auf die Mitspieler, und mit welchem Spielstand
    restoring: false, restoreSnap: null, restoreTimer: null,
    // Lebenszeichen: Host sendet "ping", Mitspieler merkt sich, wann zuletzt etwas vom Host kam
    beatT: null, watchT: null, lastHeard: 0,
    // Zähler für Lobby-Aktionen: ein Aufbau, der nach einem Verlassen noch wartet, bricht dann ab
    gen: 0
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

  // Hash eines Tokens (SHA-256, hex). Die Lobby zeigt nur den Hash. So kann ein neuer Host einen Platz
  // prüfen, ohne dass jemand fremde Tokens lesen kann. Braucht HTTPS oder localhost (crypto.subtle).
  function hashToken(t) {
    if (!root.crypto || !root.crypto.subtle) return Promise.reject(new Error('Sichere Verbindung (HTTPS) nötig'));
    return root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(String(t))).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

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
      code: S.code, gtype: S.gtype, players: S.players, started: S.started, rules: S.rules || null,
      seats: S.seats.map(function (s) { return { kind: s.kind, name: s.name || '', connected: !!s.connected, level: s.level || 'mittel', th: s.tokenHash || '' }; })
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

  function hostOpen(retries, ice) {
    var id = PREFIX + S.code;
    S.peer = new root.Peer(id, peerOpts(ice));
    S.peer.on('open', function () { pushLobby(); status('Lobby offen. Code: ' + S.code); });
    S.peer.on('connection', hostAccept);
    S.peer.on('error', function (e) {
      if (e.type === 'unavailable-id' && retries > 0) {
        S.peer.destroy();
        S.code = newCode();
        hostOpen(retries - 1, ice);
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

  // Anmeldung eines Mitspielers. h ist der Hash seines Tokens. Der Platz wird über den Hash gefunden.
  // So erkennt auch ein neuer Host die Plätze, ohne die geheimen Tokens zu kennen.
  function hostHello(conn, msg, h) {
    if (S.role !== 'host' || !S.peer) return;
    var i = -1, k;
    for (k = 0; k < S.seats.length; k++) {
      var st = S.seats[k];
      if (st.kind !== 'human') continue;
      if ((st.tokenHash && st.tokenHash === h) || (st.token && st.token === msg.token)) { i = k; break; }
    }
    if (i < 0 && !S.started) {
      for (k = 1; k < S.seats.length; k++) {
        if (S.seats[k].kind === 'open') { i = k; break; }
      }
      if (i >= 0) {
        S.seats[i] = { kind: 'human', name: clean(msg.name) || ('Gast ' + i), tokenHash: h, connected: true, level: 'mittel' };
      }
    }
    if (i < 0) {
      send(conn, { t: 'reject', why: S.started ? 'Das Spiel läuft schon.' : 'Lobby ist voll.' });
      return;
    }
    var seat = S.seats[i];
    if (seat.conn && seat.conn !== conn) { try { seat.conn.close(); } catch (e) {} }
    seat.conn = conn; seat.connected = true; conn.seatIndex = i;
    send(conn, { t: 'welcome', seat: i, inst: S.inst });
    if (S.started) {
      // Während einer Runde bleibt der Platz beim Gerät. Zwischen den Runden kommt er zurück.
      if (S.engine && !roundRunning() && !benched(seat)) S.engine.setHuman(i, true);
      // Offene Anfragen an diesen Platz noch einmal schicken.
      Object.keys(S.asks).forEach(function (rid) {
        var a = S.asks[rid];
        if (a.seat === i) send(conn, { t: 'mp', rid: Number(rid), msg: a.msg });
      });
      broadcast();
    }
    pushLobby();
    // Nach einer Übernahme mitten im Spiel: sind alle zurück, geht es sofort weiter
    if (S.restoring && allHumansBack()) startRestored();
  }

  function hostMsg(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      hashToken(msg.token).then(function (h) { hostHello(conn, msg, h); }, function (e) { status(e.message); });
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
    startEngine(settings, null);
  }

  // Startet die Engine. snap setzt bei einer Übernahme Punkte und Rundennummer, bevor die Runde beginnt.
  function startEngine(settings, snap) {
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
    if (snap) S.engine.restore(snap);
    S.started = true;
    S.adapter = hostAdapter();
    clearInterval(S.watch);
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
      if (seat && seat.kind === 'human' && seat.connected && seat.conn && seat.conn.open && !benched(seat)) {
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

  // Anzahl abgeschlossener Runden (Verlauf der Engine). Die Aussetzung zählt in Runden, nicht in Sekunden.
  function completedRounds() {
    return S.engine && S.engine.history ? S.engine.history.length : 0;
  }
  // Ausgesetzt: der Platz gilt noch als KI, auch wenn der Mitspieler schon wieder verbunden ist.
  function benched(s) {
    return typeof s.benchUntil === 'number' && completedRounds() < s.benchUntil;
  }

  // Platz gilt als weg (Fehler oder keine Antwort). Der Mitspieler sitzt die nächsten BENCH_ROUNDS
  // Runden als KI aus, auch wenn er sofort wieder da ist. So kann er nicht jede Runde neu abbrechen.
  function markGone(seat) {
    var s = S.seats[seat];
    if (!s || s.kind !== 'human') return;
    s.connected = false;
    if (s.conn) { try { s.conn.close(); } catch (e) {} s.conn = null; }
    s.benchUntil = completedRounds() + BENCH_ROUNDS;
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
    // Nur ein Platz, der gerade ein Mensch ist, darf ziehen. Ausgesetzte Plätze sind KI.
    if (!e.isHuman(seat)) return false;
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
    var list = S.gtype === 'molotov' ? R.legalFree(hand, plays, trump) : R.legalCards(hand, plays, trump);
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
    S.lastHeard = Date.now();
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'welcome') {
      if (msg.inst !== S.hostInst) {
        // Neuer Host (oder erster Kontakt): alte Zähler und Karten dieses Geräts verwerfen.
        S.hostInst = msg.inst; S.lastSv = -1; S.lastView = null; S.cseat = null; S.posById = {};
      }
      S.mySeat = msg.seat;
      status('Verbunden als Platz ' + (msg.seat + 1) + '.');
      return;
    }
    if (msg.t === 'bye') { hostGone(); return; }
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
    var myPeer = S.peer;
    var conn = myPeer.connect(PREFIX + S.code, { reliable: true });
    if (!conn) return;
    S.hostConn = conn;
    var opened = false, done = false, timer = null;
    var noConn = 'Keine Verbindung zu Lobby ' + S.code + ' über dieses Netz. Neuer Versuch …';
    // Jeder Versuch endet genau einmal. Danach kommt ein neuer Versuch, solange wir in der Lobby sind.
    function retry(text) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (S.role !== 'client' || S.peer !== myPeer) return;   // alte Verbindung: nichts tun
      status(text);
      // Ein Versuch, der nicht zustande kam, zählt. Das gilt auch, wenn PeerJS die Verbindung nicht von selbst schließt.
      if (!opened) {
        S.fails = (S.fails || 0) + 1;
        if (S.fails >= T.electAfterFails) startElection();
      }
      setTimeout(function () { if (S.role === 'client' && S.peer === myPeer) connectToHost(); }, T.retryMs);
    }
    // Ein Versuch, den PeerJS als "Host nicht gefunden" abbricht, endet sofort (statt erst nach 15 s).
    S.abortAttempt = function () {
      if (opened) return;
      try { conn.close(); } catch (e) {}
      retry(noConn);
    };
    // Kommt keine Verbindung zustande, sagen wir das. Vorher stand nur "Suche Lobby" da.
    timer = setTimeout(function () {
      if (opened) return;
      try { conn.close(); } catch (e) {}
      retry(noConn);
    }, T.connectMs);
    conn.on('open', function () {
      opened = true;
      clearTimeout(timer);
      S.fails = 0; S.electing = false; S.elecId++;   // Host ist da: laufende Wahl abbrechen
      status('Verbunden. Warte auf Spielstand …');
      conn.send({ t: 'hello', token: S.token, name: S.name });
    });
    conn.on('data', clientMsg);
    conn.on('close', function () {
      retry(opened ? 'Verbindung verloren. Verbinde neu …' : noConn);
    });
    conn.on('error', function () { status('Verbindung gestört …'); });
  }

  // ---------- Lobby-Übernahme, wenn der Host geht ----------
  // Der Host sagt "bye". Ohne bye merken die Mitspieler es an fehlgeschlagenen Versuchen.
  // Dann bewirbt sich zuerst der Mitspieler mit dem niedrigsten Platz. Die PeerJS-ID "jasstisch-CODE"
  // kann nur ein Gerät haben. Die anderen verbinden sich danach mit dem neuen Host.

  function hostSetRules(rules) {
    if (S.role !== 'host' || S.started) return;
    S.rules = rules || null;
    pushLobby();
  }

  function hostGone() {
    if (S.role !== 'client') return;
    startElection();
  }

  function startElection() {
    if (S.role !== 'client' || !S.lobby || S.electing) return;
    var cands = [];
    S.lobby.seats.forEach(function (s, i) { if (i > 0 && s.kind === 'human' && s.connected) cands.push(i); });
    if (cands.indexOf(S.mySeat) < 0) cands.push(S.mySeat);
    cands.sort(function (a, b) { return a - b; });
    var rank = cands.indexOf(S.mySeat);
    S.electing = true;
    var elec = ++S.elecId;
    var t0 = Date.now();
    status('Der Host ist weg. Eine neue Lobby wird gesucht …');
    setTimeout(function () { claimHost(elec, t0); }, rank * T.electStepMs);
  }

  function claimHost(elec, t0) {
    if (elec !== S.elecId || S.role !== 'client') return;
    if (Date.now() - t0 > T.electMaxMs) {
      S.electing = false;
      status('Keine neue Lobby gefunden. Die Lobby wird verlassen.');
      leave();
      return;
    }
    loadIce().then(function (ice) {
      if (elec !== S.elecId || S.role !== 'client') return;
      var p = new root.Peer(PREFIX + S.code, peerOpts(ice));
      var answered = false;
      p.on('open', function () {
        if (answered) return;
        answered = true;
        if (elec !== S.elecId || S.role !== 'client') { try { p.destroy(); } catch (e) {} return; }
        becomeHost(p);
      });
      p.on('error', function () {
        // Die ID ist schon vergeben (ein anderer ist schneller) oder das Netz hakt. Dann später noch einmal.
        if (answered) return;
        answered = true;
        try { p.destroy(); } catch (e) {}
        setTimeout(function () { claimHost(elec, t0); }, T.electStepMs);
      });
    });
  }

  function becomeHost(p) {
    var lobby = S.lobby;
    var oldPeer = S.peer;
    var k = S.mySeat;
    var n = lobby.seats.length;
    // Spielstand aus meiner letzten Sicht, bevor sie unten zurückgesetzt wird
    var snap = lobby.started ? snapshotFrom(S.lastView) : null;
    var midGame = !!(snap && !snap.over);
    S.elecId++; S.electing = false; S.fails = 0;
    try { if (oldPeer) oldPeer.destroy(); } catch (e) {}
    S.role = 'host'; S.peer = p; S.hostConn = null; S.inst = randomChars(8); S.started = false;
    S.gtype = lobby.gtype; S.players = lobby.players; S.rules = lobby.rules || null;
    // Die Plätze drehen, bis mein Platz Platz 0 ist. Der alte Host (alter Platz 0) wird frei.
    S.seats = [];
    for (var j = 0; j < n; j++) {
      var old = (j + k) % n;
      var src = lobby.seats[old];
      var seat = { kind: src.kind === 'ai' ? 'ai' : (src.kind === 'human' ? 'human' : 'open'), name: src.name || '', level: src.level || 'mittel', tokenHash: src.th || '', connected: false };
      // Der alte Host ist weg. In der Lobby wird sein Platz frei, mitten im Spiel übernimmt die KI ihn.
      if (old === 0) seat = { kind: midGame ? 'ai' : 'open', name: '', level: 'mittel', tokenHash: '', connected: false };
      S.seats.push(seat);
    }
    S.seats[0] = { kind: 'human', name: S.name, token: S.token, tokenHash: '', connected: true, level: 'mittel' };
    S.mySeat = 0;
    // Alte Zustände dieses Geräts als Client verwerfen
    S.lastSv = -1; S.lastView = null; S.cseat = null; S.posById = {};
    hashToken(S.token).then(function (h) {
      if (S.role === 'host' && S.seats[0] && S.seats[0].token === S.token) { S.seats[0].tokenHash = h; pushLobby(); }
    }, function () {});
    startBeat();
    p.on('connection', hostAccept);
    p.on('error', function (e) { status('Verbindungsfehler: ' + e.type); });
    pushLobby();
    if (midGame) {
      status('Du bist jetzt der Host. Die Mitspieler verbinden sich neu …');
      awaitRejoin(snap);
    } else if (lobby.started) {
      status('Der Spielstand konnte nicht übernommen werden. Du bist Host der Lobby ' + S.code + '. Bitte neu starten.');
    } else {
      status('Du bist jetzt der Host. Code: ' + S.code + '. Die anderen verbinden sich neu.');
    }
  }

  // Spielstand aus einer Sicht (so wie ein Mitspieler sie hat). Die Sicht ist in der Reihenfolge des
  // neuen Hosts (sein Platz = 0), also passen Punkte und Geber ohne Umrechnung.
  function snapshotFrom(v) {
    if (!v || !Array.isArray(v.totals) || typeof v.dealer !== 'number') return null;
    if (v.phase === 'gameEnd') return { over: true };
    var n = v.n || v.totals.length;
    var completed = (v.history || []).length;     // abgeschlossene Runden
    var roundEnd = v.phase === 'roundEnd';
    var snap = {
      totals: v.totals.slice(),
      roundNo: completed,
      // Läuft eine Runde, wird sie neu gestartet. startRound() zählt den Geber weiter, also einen zurück.
      // Ist die Runde schon zu Ende, kommt die nächste: der Geber bleibt, startRound() zählt ihn weiter.
      dealer: (completed >= 1 && !roundEnd) ? (v.dealer - 1 + n) % n : v.dealer
    };
    if (Array.isArray(v.plusStr)) snap.plusStr = v.plusStr.slice();
    if (Array.isArray(v.minusStr)) snap.minusStr = v.minusStr.slice();
    return snap;
  }

  // Der neue Host wartet kurz, bis die Mitspieler zurück sind. Wer nicht kommt, spielt die KI.
  function awaitRejoin(snap) {
    S.restoring = true; S.restoreSnap = snap;
    clearTimeout(S.restoreTimer);
    S.restoreTimer = setTimeout(startRestored, T.rejoinMs);
    if (allHumansBack()) startRestored();
  }

  function allHumansBack() {
    return S.seats.every(function (s) { return s.kind !== 'human' || s.connected; });
  }

  function startRestored() {
    if (!S.restoring || S.role !== 'host') return;
    S.restoring = false; clearTimeout(S.restoreTimer);
    var snap = S.restoreSnap; S.restoreSnap = null;
    startEngine(S.rules, snap);
  }

  // ---------- Öffentliche Funktionen ----------
  function leave() {
    S.gen++;   // laufende Aufbauten (Verbindungswege holen) gelten nicht mehr
    // Ein Host sagt den Mitspielern Bescheid, bevor er geht. Dann beginnt die Wahl sofort.
    if (S.role === 'host') S.seats.forEach(function (s) { if (s.conn) send(s.conn, { t: 'bye' }); });
    S.elecId++; S.electing = false; S.fails = 0; S.hostInst = null;
    clearTimeout(S.restoreTimer); S.restoring = false; S.restoreSnap = null;
    clearInterval(S.beatT); clearInterval(S.watchT); S.abortAttempt = null;
    clearInterval(S.watch);
    cancelAsks('Verlassen');
    try { if (S.engine) S.engine.stop(); } catch (e) {}
    try { if (S.peer) S.peer.destroy(); } catch (e) {}
    S.role = null; S.peer = null; S.hostConn = null; S.engine = null; S.adapter = null;
    S.started = false; S.seats = []; S.lastView = null; S.lastSv = -1; S.sv = 0; S.turnKey = ''; S.autoAsked = false;
    S.round = null; S.cseat = null; S.posById = {};
    S.lobby = null; S.rules = null; S.inst = '';
    if (S.onLobby) S.onLobby(null);
  }

  function createLobby(gtype, players, name, rules) {
    if (!ensurePeerLib()) return;
    leave();
    S.role = 'host'; S.gtype = gtype; S.players = players; S.code = newCode();
    S.token = getToken(); S.name = clean(name) || 'Du';
    S.rules = rules || null; S.inst = randomChars(8);
    S.seats = [];
    for (var i = 0; i < players; i++) S.seats.push({ kind: 'open', level: 'mittel', connected: false });
    S.seats[0] = { kind: 'human', name: S.name, token: S.token, tokenHash: '', connected: true, level: 'mittel' };
    hashToken(S.token).then(function (h) {
      if (S.role === 'host' && S.seats[0] && S.seats[0].token === S.token) { S.seats[0].tokenHash = h; pushLobby(); }
    }, function () {});
    var gen = S.gen;
    loadIce().then(function (ice) {
      if (S.gen !== gen || S.role !== 'host') return;
      hostOpen(5, ice);
    });
    startBeat();
  }

  // Host: alle paar Sekunden ein Lebenszeichen an jeden verbundenen Mitspieler.
  function startBeat() {
    clearInterval(S.beatT);
    S.beatT = setInterval(function () {
      S.seats.forEach(function (s) { if (s.conn) send(s.conn, { t: 'ping' }); });
    }, T.beatMs);
  }

  // Mitspieler: meldet sich der Host zu lange nicht, gilt er als weg. Die Verbindung wird dann neu aufgebaut.
  function startWatch() {
    clearInterval(S.watchT);
    S.lastHeard = Date.now();
    S.watchT = setInterval(function () {
      var c = S.hostConn;
      if (S.role !== 'client' || !c || !c.open) return;
      if (Date.now() - S.lastHeard > T.silentMs) {
        S.lastHeard = Date.now();
        try { c.close(); } catch (e) {}
      }
    }, T.beatMs);
  }

  function joinLobby(code, name) {
    if (!ensurePeerLib()) return;
    leave();
    S.role = 'client'; S.code = String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
    S.token = getToken(); S.name = clean(name) || 'Gast';
    S.fails = 0; S.electing = false;
    startWatch();
    var gen = S.gen;
    loadIce().then(function (ice) {
      if (S.gen !== gen || S.role !== 'client') return;
      S.peer = new root.Peer(undefined, peerOpts(ice));
      S.peer.on('open', function () { status('Suche Lobby ' + S.code + ' …'); connectToHost(); });
      S.peer.on('error', function (e) {
        if (!S.electing) status('Lobby nicht erreichbar (' + e.type + ').');
        // Der Host ist nicht (mehr) bei PeerJS gemeldet: der laufende Versuch endet sofort und zählt als gescheitert.
        if (e.type === 'peer-unavailable' && S.role === 'client' && S.lobby && S.abortAttempt) S.abortAttempt();
      });
    });
  }

  root.JassOnline = {
    createLobby: createLobby, joinLobby: joinLobby, hostStart: hostStart, leave: leave,
    hostSetLevel: hostSetLevel, hostSetPlayers: hostSetPlayers, hostSetRules: hostSetRules, timing: T,
    state: S,
    setHandlers: function (h) { S.onLobby = h.onLobby; S.onStart = h.onStart; S.onRender = h.onRender; S.onStatus = h.onStatus; }
  };
})(typeof window !== 'undefined' ? window : this);
