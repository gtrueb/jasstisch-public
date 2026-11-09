// Tests für die Übernahme mitten im Spiel (js/online.js): der neue Host übernimmt Punkte, Rundennummer
// und Geber aus seiner letzten Sicht. Die Spiel-Engine ist hier eine Attrappe, damit die Tests schnell laufen.
// Die echte Engine prüft tests/game-restore.test.js.
// Start: node --test tests/online-restore.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'online.js'), 'utf8');
const RULES = { weis: false, stoeck: true, lastTrick: true, undenufe: true, end: 'limit', limit: 50 };

// ----- Gefälschter Peer-Server (wie in tests/online-handover.test.js) -----
const server = new Map();

class FakeConn {
  constructor(peer) { this.peer = peer; this.open = false; this.closed = false; this.pair = null; this.h = {}; }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, a) { (this.h[ev] || []).slice().forEach((fn) => fn(a)); }
  send(msg) {
    if (!this.open || !this.pair) return;
    const other = this.pair;
    setImmediate(() => { if (other.open) other.emit('data', msg); });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.open = false;
    this.emit('close');
    if (this.pair && !this.pair.closed) this.pair.close();
  }
}

class FakePeer {
  constructor(id) {
    this.id = id || ('anon' + Math.random().toString(36).slice(2, 10));
    this.h = {}; this.conns = []; this.destroyed = false;
    setImmediate(() => {
      if (this.destroyed) return;
      if (server.has(this.id)) { this.emit('error', { type: 'unavailable-id' }); return; }
      server.set(this.id, this);
      this.emit('open', this.id);
    });
  }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, a) { (this.h[ev] || []).slice().forEach((fn) => fn(a)); }
  connect(id) {
    const host = server.get(id);
    const mine = new FakeConn(this);
    this.conns.push(mine);
    setImmediate(() => {
      if (!host || host.destroyed) { this.emit('error', { type: 'peer-unavailable' }); mine.close(); return; }
      const theirs = new FakeConn(host);
      mine.pair = theirs; theirs.pair = mine;
      host.conns.push(theirs);
      mine.open = true; theirs.open = true;
      host.emit('connection', theirs);
      mine.emit('open');
    });
    return mine;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (server.get(this.id) === this) server.delete(this.id);
    this.conns.forEach((c) => c.close());
  }
}

// ----- Attrappen für Engine und Ansicht -----
function zeros(n) { return new Array(n).fill(0); }

class FakeGame {
  constructor(cfg) {
    this.cfg = cfg; this.n = cfg.players || 4;
    this.totals = zeros(this.n); this.roundNo = 0; this.dealer = 0;
    this.history = []; this.phase = 'idle'; this.calls = [];
    this.plays = []; this.chooser = -1; this.hold = false;   // Felder, die online.js beim Warten auf Züge liest
  }
  restore(snap) {
    this.calls.push(['restore', JSON.parse(JSON.stringify(snap))]);
    this.totals = snap.totals.slice(); this.roundNo = snap.roundNo; this.dealer = snap.dealer;
  }
  // Wie die echte Engine: der Geber zählt ab der zweiten Runde weiter.
  startRound() {
    this.calls.push(['startRound']);
    this.roundNo++;
    if (this.roundNo > 1) this.dealer = (this.dealer + 1) % this.n;
    this.phase = 'play';
    if (this.cfg.onUpdate) this.cfg.onUpdate();
  }
  stateForUI(seat) {
    return { n: this.n, phase: this.phase, totals: this.totals.slice(), dealer: this.dealer, history: this.history.slice(), me: seat };
  }
  turnSeat() { return -1; }
  setHuman() {} isRemote() { return false; } stop() {} abortRound() {} act() { return false; } nextRound() {}
  setDealt() {} requestPlay() { return false; } requestWeis() { return false; } autoMove() {}
}

function fakeView(st, me, names) {
  const n = st.n;
  const rot = (a) => { const o = []; for (let i = 0; i < n; i++) o.push(a[(me + i) % n]); return o; };
  return {
    n, gtype: 'molotov', phase: st.phase, totals: rot(st.totals), dealer: (st.dealer - me + n) % n,
    history: st.history, hands: rot(zeros(n).map(() => [])), turnSeat: -1, plays: [], names: rot(names || [])
  };
}

// Eine "Browser-Kopie" mit Attrappen für Engine, Ansicht und Kartenmodule.
function realm(rs) {
  const sb = {
    Peer: FakePeer, JassMental: {}, JassMentalRound: {}, TextEncoder,
    crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, console
  };
  sb.window = sb;
  sb.JassRules = { makeDeck: () => [], weisTotal: () => 0, bestWeis: () => null };
  sb.JassTempo = { scaled: (d) => d };
  sb.JassMolotov = { DEFAULT_DELAYS: {}, Game: FakeGame };
  sb.JassGame = { DEFAULT_DELAYS: {}, Game: FakeGame };
  sb.JassView = { buildView: fakeView };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'online.js' });
  Object.assign(sb.JassOnline.timing, { connectMs: 300, retryMs: 20, electAfterFails: 2, electStepMs: 10, electMaxMs: 4000, rejoinMs: 150, beatMs: 20, silentMs: 400 });
  rs.push(sb);
  return sb;
}

async function until(cond, ms) {
  const end = Date.now() + (ms || 4000);
  while (!cond()) {
    if (Date.now() > end) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function cleanup(rs) {
  rs.forEach((r) => { try { r.JassOnline.leave(); } catch (e) {} });
  await new Promise((r) => setTimeout(r, 30));
}

// Anna hostet, Ben und Cem sind dabei. Das Spiel läuft. setup() macht den Spielstand.
async function gameInProgress(rs, setup) {
  const h = realm(rs);
  h.JassOnline.setHandlers({ onLobby() {}, onStart() {}, onRender() {}, onStatus() {} });
  h.JassOnline.createLobby('molotov', 3, 'Anna', RULES);
  await until(() => h.JassOnline.state.lobby);
  const code = h.JassOnline.state.code;
  const join = (name) => {
    const r = realm(rs);
    r.JassOnline.setHandlers({ onLobby() {}, onStart() {}, onRender() {}, onStatus() {} });
    r.JassOnline.joinLobby(code, name);
    return r;
  };
  const b = join('Ben');
  const c = join('Cem');
  await until(() => b.JassOnline.state.hostInst && c.JassOnline.state.hostInst);
  h.JassOnline.hostStart(RULES);
  const eng = h.JassOnline.state.engine;
  setup(eng);
  eng.cfg.onUpdate();                              // schickt die Sicht an die Mitspieler
  await until(() => b.JassOnline.state.lastView && c.JassOnline.state.lastView);
  return { h, b, c, eng };
}

test('Übernahme mitten im Spiel: Punkte, Rundennummer und Geber bleiben, die Runde startet neu', async () => {
  const rs = [];
  try {
    // Runde 2 läuft. Eine Runde ist fertig. Geber ist Platz 1 (das ist Ben).
    const { h, b } = await gameInProgress(rs, (e) => {
      e.totals = [10, 20, 30]; e.roundNo = 2; e.dealer = 1; e.history = [{}]; e.phase = 'play';
    });
    assert.deepEqual(b.JassOnline.state.lastView.totals, [20, 30, 10], 'Bens Sicht: Ben zuerst');
    h.JassOnline.leave();
    await until(() => b.JassOnline.state.role === 'host', 4000);
    await until(() => b.JassOnline.state.engine && b.JassOnline.state.engine.calls.some((x) => x[0] === 'startRound'), 4000);
    const be = b.JassOnline.state.engine;
    const rest = be.calls.find((x) => x[0] === 'restore')[1];
    assert.deepEqual(rest.totals, [20, 30, 10]);
    assert.equal(rest.roundNo, 1, 'eine Runde ist abgeschlossen');
    assert.equal(rest.dealer, 2, 'vor dem Neustart einen zurück, startRound zählt ihn wieder vor');
    assert.deepEqual(be.totals, [20, 30, 10]);
    assert.equal(be.roundNo, 2, 'dieselbe Runde (Nummer 2) startet neu');
    assert.equal(be.dealer, 0, 'derselbe Geber wie vorher: Ben (jetzt Platz 0)');
    // Der alte Host-Platz ist jetzt KI, nicht frei
    assert.equal(b.JassOnline.state.seats[2].kind, 'ai');
  } finally { await cleanup(rs); }
});

test('Runde ist zu Ende: die Übernahme startet die nächste Runde mit dem nächsten Geber', async () => {
  const rs = [];
  try {
    const { h, b } = await gameInProgress(rs, (e) => {
      e.totals = [10, 20, 30]; e.roundNo = 2; e.dealer = 1; e.history = [{}, {}]; e.phase = 'roundEnd';
    });
    h.JassOnline.leave();
    await until(() => b.JassOnline.state.role === 'host', 4000);
    await until(() => b.JassOnline.state.engine && b.JassOnline.state.engine.calls.some((x) => x[0] === 'startRound'), 4000);
    const be = b.JassOnline.state.engine;
    const rest = be.calls.find((x) => x[0] === 'restore')[1];
    assert.equal(rest.roundNo, 2);
    assert.equal(rest.dealer, 0, 'Geber bleibt für die Zählung, startRound zählt ihn weiter');
    assert.equal(be.roundNo, 3, 'die nächste Runde beginnt');
    assert.equal(be.dealer, 1, 'der nächste Geber ist Cem');
  } finally { await cleanup(rs); }
});

test('Spiel ist schon vorbei: keine Übernahme, die Lobby ist wieder offen', async () => {
  const rs = [];
  try {
    const { h, b } = await gameInProgress(rs, (e) => { e.phase = 'gameEnd'; });
    h.JassOnline.leave();
    await until(() => b.JassOnline.state.role === 'host', 4000);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(b.JassOnline.state.engine, null, 'kein neues Spiel gestartet');
    assert.equal(b.JassOnline.state.started, false);
  } finally { await cleanup(rs); }
});

test('Mitspieler kommt nicht zurück: nach der Wartezeit läuft die Runde mit der KI weiter', async () => {
  const rs = [];
  try {
    const { h, b, c } = await gameInProgress(rs, (e) => {
      e.totals = [0, 0, 0]; e.roundNo = 1; e.dealer = 0; e.history = []; e.phase = 'play';
    });
    c.JassOnline.leave();                               // Cem kommt nicht zurück
    h.JassOnline.leave();
    await until(() => b.JassOnline.state.role === 'host', 4000);
    await until(() => b.JassOnline.state.engine && b.JassOnline.state.engine.calls.some((x) => x[0] === 'startRound'), 3000);
    // Nach der Drehung: Ben ist Platz 0, Cem ist Platz 1, der alte Host ist Platz 2 (KI)
    const cemSeat = b.JassOnline.state.seats[1];
    assert.equal(cemSeat.name, 'Cem');
    assert.equal(cemSeat.kind, 'human', 'Cems Platz bleibt, wird aber nicht mehr gezählt');
    assert.equal(cemSeat.connected, false);
  } finally { await cleanup(rs); }
});
