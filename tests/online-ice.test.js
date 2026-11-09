// Tests für die TURN-Zugangsdaten (js/online.js, loadIce): Ist ein Server eingetragen, holt die Seite
// die Zugangsdaten von dort und benutzt sie beim Aufbau. Kommt nichts Brauchbares rechtzeitig, bleibt es
// bei den festen Listen (STUN). Fetch ist eine Attrappe.
// Start: node --test tests/online-ice.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC0 = fs.readFileSync(path.join(__dirname, '..', 'js', 'online.js'), 'utf8');
const ENDPOINT = 'https://turn.test/ice';
// Im Test den Server eintragen. Im Spiel steht dort die echte Adresse (oder '' ohne Server).
const TURN_LINE = /var TURN_ENDPOINT = '[^']*';/;
if (!TURN_LINE.test(SRC0)) throw new Error('TURN_ENDPOINT nicht gefunden');
const SRC = SRC0.replace(TURN_LINE, "var TURN_ENDPOINT = '" + ENDPOINT + "';");

const RULES = { weis: false, stoeck: true, lastTrick: true, undenufe: true };
const ICE_JSON = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u1', credential: 'c1' }
  ]
};

// Jeder gebaute Peer (mit seinen Optionen) wird hier gesammelt.
const created = [];

class FakeConn {
  constructor() { this.h = {}; this.open = false; this.closed = false; }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, a) { (this.h[ev] || []).slice().forEach((fn) => fn(a)); }
  send() {}
  close() { this.closed = true; }
}

class FakePeer {
  constructor(id, opts) { this.id = id; this.opts = opts; this.h = {}; this.destroyed = false; created.push(this); }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, a) { (this.h[ev] || []).slice().forEach((fn) => fn(a)); }
  connect() { return new FakeConn(); }
  destroy() { this.destroyed = true; }
}

function realm(fetchImpl) {
  const sb = {
    Peer: FakePeer, JassMental: {}, JassMentalRound: {}, TextEncoder,
    crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, console,
    fetch: fetchImpl
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'online.js' });
  Object.assign(sb.JassOnline.timing, { iceMs: 100, connectMs: 300, retryMs: 20, electAfterFails: 2, electStepMs: 10, electMaxMs: 4000, rejoinMs: 150, beatMs: 20, silentMs: 400 });
  sb.JassOnline.setHandlers({ onLobby() {}, onStart() {}, onRender() {}, onStatus() {} });
  return sb;
}

async function until(cond, ms) {
  const end = Date.now() + (ms || 4000);
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function okReply(body) { return { ok: true, status: 200, json: async () => body }; }

test('Lobby erstellen holt die Zugangsdaten vom Server und benutzt sie', async () => {
  created.length = 0;
  const calls = [];
  const sb = realm(async (url, opts) => { calls.push({ url, opts }); return okReply(ICE_JSON); });
  sb.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
  await until(() => created.length === 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].opts.cache, 'no-store');
  const servers = created[0].opts.config.iceServers;
  const turn = servers.find((s) => s.username === 'u1');
  assert.ok(turn, 'die Zugangsdaten des Servers sind im Peer');
  assert.equal(turn.credential, 'c1');
  assert.ok(turn.urls.some((u) => u.startsWith('turn:turn.cloudflare.com')));
  assert.ok(servers.some((s) => s.urls.includes('stun:stun.l.google.com:19302')), 'die festen Listen bleiben dabei');
  sb.JassOnline.leave();
});

test('TURN-Eintrag ohne Zugangsdaten fällt weg, die übrigen Einträge bleiben', async () => {
  created.length = 0;
  const sb = realm(async () => okReply({
    iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'] }, { urls: ['stun:stun.cloudflare.com:3478'] }]
  }));
  try {
    sb.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
    await until(() => created.length === 1);
    const servers = created[0].opts.config.iceServers;
    // Die festen STUN-Einträge haben urls als Text, die Antwort des Servers als Liste. Beides prüfen.
    const urlsOf = (s) => [].concat(s.urls);
    const bad = servers.filter((s) => urlsOf(s).some((u) => u.startsWith('turn:')) && !(s.username && s.credential));
    assert.equal(bad.length, 0, 'kein TURN ohne Zugangsdaten');
    assert.ok(servers.some((s) => urlsOf(s).includes('stun:stun.cloudflare.com:3478')), 'der STUN-Eintrag der Antwort bleibt');
  } finally { sb.JassOnline.leave(); }
});

test('Antwort mit unbrauchbaren Einträgen: die unbrauchbaren fallen weg, sonst bleibt STUN', async () => {
  created.length = 0;
  const sb = realm(async () => okReply({ iceServers: [{ urls: 'javascript:alert(1)' }, { urls: [42] }, null] }));
  sb.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
  await until(() => created.length === 1);
  const servers = JSON.stringify(created[0].opts.config.iceServers);
  assert.ok(!servers.includes('javascript'), 'gefährlicher Eintrag ist draußen');
  assert.ok(servers.includes('stun:stun.l.google.com:19302'), 'feste STUN-Liste ist da');
  sb.JassOnline.leave();
});

test('Server antwortet nie: nach der Wartezeit geht es mit der festen Liste weiter', async () => {
  created.length = 0;
  const sb = realm(() => new Promise(() => {}));
  sb.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
  await until(() => created.length === 1, 4000);
  const servers = JSON.stringify(created[0].opts.config.iceServers);
  assert.ok(servers.includes('stun:stun.l.google.com:19302'));
  assert.ok(!servers.includes('turn.cloudflare.com'));
  sb.JassOnline.leave();
});

test('Server meldet Fehler (HTTP 500): feste Liste, kein Absturz', async () => {
  created.length = 0;
  const sb = realm(async () => ({ ok: false, status: 500, json: async () => ({}) }));
  sb.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
  await until(() => created.length === 1);
  assert.ok(JSON.stringify(created[0].opts.config.iceServers).includes('stun:stun.l.google.com:19302'));
  sb.JassOnline.leave();
});

test('Lobby wird verlassen, während die Zugangsdaten noch geholt werden: kein Peer entsteht', async () => {
  created.length = 0;
  const sb = realm(() => new Promise((r) => setTimeout(() => r(okReply(ICE_JSON)), 50)));
  sb.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
  sb.JassOnline.leave();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(created.length, 0, 'der Aufbau ist nach dem Verlassen abgebrochen');
});
