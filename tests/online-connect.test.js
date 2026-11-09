// Tests für den Verbindungsaufbau zur Lobby (js/online.js). Ohne echten Peer-Server:
// ein gefälschter Peer und eine gefälschte Verbindung. Die Uhr ist gefälscht, damit die Wartezeit
// schnell vergeht. Der Peer wird erst gebaut, wenn die Verbindungswege geholt sind (ein kurzer Schritt),
// darum warten die Tests kurz, bevor sie den Peer ansehen.
// Start: node --test tests/online-connect.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

// online.js sucht sein Fenster unter "window", den Peer unter "Peer" und die Kartenschloss-Module.
globalThis.window = globalThis;
globalThis.JassMental = {};
globalThis.JassMentalRound = {};
// online.js hat eine Serveradresse für die TURN-Zugangsdaten. Dieser Test braucht kein Netz:
// die Abfrage scheitert sofort, der Aufbau geht mit den festen Listen weiter.
globalThis.fetch = () => Promise.reject(new Error('kein Netz im Test'));

const made = [];

class FakeConn {
  constructor(peerId) { this.peerId = peerId; this.open = false; this.closed = false; this.sent = []; this.h = {}; }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach((fn) => fn(...a)); }
  send(msg) { this.sent.push(msg); }
  close() { if (this.closed) return; this.closed = true; this.open = false; this.emit('close'); }
}

class FakePeer {
  constructor(id, opts) { this.id = id; this.opts = opts; this.conns = []; this.h = {}; this.destroyed = false; made.push(this); }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, ...a) { (this.h[ev] || []).slice().forEach((fn) => fn(...a)); }
  connect(peerId) { const c = new FakeConn(peerId); this.conns.push(c); return c; }
  destroy() { this.destroyed = true; }
}

globalThis.Peer = FakePeer;
require('../js/online.js');
const O = globalThis.JassOnline;

// Hört alle Statusmeldungen mit.
function listen() {
  const texts = [];
  O.setHandlers({ onLobby() {}, onStart() {}, onRender() {}, onStatus(s) { texts.push(s); } });
  return texts;
}

// Lässt die wartenden Schritte ablaufen (Verbindungswege holen), bevor der Test den Peer ansieht.
function flush() { return new Promise((r) => setImmediate(r)); }

test('Lobby beitreten: der Verbindungsaufbau nutzt die eigene Serverliste ohne alte PeerJS-TURN-Server', async () => {
  O.joinLobby('abcd', 'Anna');
  await flush();
  const peer = made[made.length - 1];
  const servers = JSON.stringify(peer.opts.config.iceServers);
  assert.ok(servers.includes('stun:stun.l.google.com:19302'));
  assert.ok(!servers.includes('peerjs.com'), 'alte PeerJS-TURN-Server sind noch dabei');
  O.leave();
});

test('Lobby erstellen: der Host nutzt dieselbe Serverliste und den Code als Peer-Namen', async () => {
  O.createLobby('molotov', 3, 'Anna');
  await flush();
  const host = made[made.length - 1];
  assert.match(host.id, /^jasstisch-[A-Z2-9]{4}$/);
  assert.ok(!JSON.stringify(host.opts.config.iceServers).includes('peerjs.com'));
  O.leave();
});

test('kein Verbindungsaufbau: nach 15 Sekunden klare Meldung und ein neuer Versuch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const texts = listen();
  O.joinLobby('abcd', 'Anna');
  await flush();
  const peer = made[made.length - 1];
  peer.emit('open');
  assert.equal(peer.conns.length, 1);
  assert.equal(texts.at(-1), 'Suche Lobby ABCD …');
  t.mock.timers.tick(14999);
  assert.equal(texts.at(-1), 'Suche Lobby ABCD …', 'vor Ablauf der Wartezeit keine Meldung');
  t.mock.timers.tick(1);
  assert.equal(texts.at(-1), 'Keine Verbindung zu Lobby ABCD über dieses Netz. Neuer Versuch …');
  assert.equal(peer.conns[0].closed, true);
  assert.equal(peer.conns.length, 1, 'noch kein neuer Versuch');
  t.mock.timers.tick(2000);
  assert.equal(peer.conns.length, 2, 'neuer Versuch nach 2 Sekunden');
  O.leave();
});

test('Verbindung klappt: keine Fehlermeldung, Hallo mit Name und Platz-Token wird geschickt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const texts = listen();
  O.joinLobby('abcd', 'Anna');
  await flush();
  const peer = made[made.length - 1];
  peer.emit('open');
  const conn = peer.conns[0];
  conn.open = true;
  conn.emit('open');
  assert.equal(texts.at(-1), 'Verbunden. Warte auf Spielstand …');
  assert.equal(conn.sent[0].t, 'hello');
  assert.equal(conn.sent[0].name, 'Anna');
  t.mock.timers.tick(60000);
  assert.equal(texts.at(-1), 'Verbunden. Warte auf Spielstand …');
  assert.equal(peer.conns.length, 1, 'kein zweiter Versuch');
  O.leave();
});

test('Verbindung bricht nach dem Aufbau ab: Meldung und neuer Versuch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const texts = listen();
  O.joinLobby('abcd', 'Anna');
  await flush();
  const peer = made[made.length - 1];
  peer.emit('open');
  const conn = peer.conns[0];
  conn.open = true;
  conn.emit('open');
  conn.close();
  assert.equal(texts.at(-1), 'Verbindung verloren. Verbinde neu …');
  t.mock.timers.tick(2000);
  assert.equal(peer.conns.length, 2, 'neuer Versuch nach 2 Sekunden');
  O.leave();
});
