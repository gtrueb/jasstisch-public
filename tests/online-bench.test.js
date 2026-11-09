// Tests für die Aussetzung (js/online.js): fällt ein Mitspieler mitten im Spiel aus (Fehler oder keine
// Antwort), sitzt er zwei Runden lang nur als KI-Platz aus. Kommt er sofort zurück, spielt er nicht sofort wieder mit.
// Ein Verbindungsabbruch ohne Fehler sperrt nicht.
// Die Engine ist eine Attrappe. Sie ruft den dealHook auf, so wie die echte Engine. Die Verteilung selbst ist leer.
// Start: node --test tests/online-bench.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'online.js'), 'utf8');
const RULES = { weis: false, stoeck: true, lastTrick: true, undenufe: true, end: 'limit', limit: 50 };

// ----- Gefälschter Peer-Server (wie in tests/online-restore.test.js) -----
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

// ----- Attrappen für Engine, Verteilung und Ansicht -----
class FakeGame {
  constructor(cfg) {
    this.cfg = cfg; this.n = cfg.players || 3;
    this.totals = new Array(this.n).fill(0); this.roundNo = 0; this.dealer = 0;
    this.history = []; this.phase = 'idle';
    this.human = new Set(cfg.humanSeats || []);
    this.remoteSeats = [];
    this.plays = []; this.chooser = -1; this.hold = false; this.trickNo = 0;
  }
  restore() {}
  // Wie die echte Engine: die Verteilung läuft über den dealHook.
  startRound() {
    this.roundNo++;
    if (this.roundNo > 1) this.dealer = (this.dealer + 1) % this.n;
    this.phase = 'play';
    this.cfg.dealHook(this, this.roundNo);
    if (this.cfg.onUpdate) this.cfg.onUpdate();
  }
  setHuman(seat, on) { if (on) this.human.add(seat); else this.human.delete(seat); }
  isHuman(seat) { return this.human.has(seat); }
  isRemote(seat) { return this.remoteSeats.indexOf(seat) >= 0; }
  turnSeat() { return -1; }
  stateForUI(seat) {
    return { n: this.n, phase: this.phase, totals: this.totals.slice(), dealer: this.dealer, history: this.history.slice(), me: seat };
  }
  stop() {} abortRound() {} act() { return false; } nextRound() {} setDealt() {}
  requestPlay() { return false; } requestWeis() { return false; } autoMove() {}
}

// Die Verteilung hängt absichtlich: es geht nur darum, welche Plätze mitspielen.
class FakeRound {
  constructor(n, seats) { this.n = n; this.seats = seats; }
  begin() { return new Promise(function () {}); }
  deal() { return new Promise(function () {}); }
}
class FakePlayer { constructor(t, n) { this.t = t; this.n = n; } }

// Eine "Browser-Kopie": eigene vm-Umgebung mit eigenem JassOnline.
function realm(rs) {
  const sb = {
    Peer: FakePeer, JassMental: { Player: FakePlayer }, JassMentalRound: { Round: FakeRound }, TextEncoder,
    crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, console
  };
  sb.window = sb;
  sb.JassRules = { makeDeck: () => [], weisTotal: () => 0, bestWeis: () => null };
  sb.JassTempo = { scaled: (d) => d };
  sb.JassMolotov = { DEFAULT_DELAYS: {}, Game: FakeGame };
  sb.JassGame = { DEFAULT_DELAYS: {}, Game: FakeGame };
  sb.JassView = { buildView: (st) => ({ phase: st.phase, totals: st.totals, dealer: st.dealer, history: st.history, names: [], hands: [] }) };
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

// Anna hostet ein Molotov mit 3 Plätzen. Ben und Cem sind dabei. Das Spiel läuft (Runde 1).
async function startGame(rs) {
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
  return { h, b, c, eng: h.JassOnline.state.engine };
}

test('Fehler im Spiel: Ben ist sofort wieder da, sitzt aber zwei Runden als KI aus', async () => {
  const rs = [];
  try {
    const { h, eng } = await startGame(rs);
    assert.deepEqual(Array.from(eng.remoteSeats), [1, 2], 'Runde 1: Ben und Cem spielen mit');

    // Ben antwortet mit einem Fehler. Das kostet seinen Platz für die nächsten Runden.
    h.JassOnline.state.asks[77] = { seat: 1, resolve() {}, reject() {}, timer: null };
    h.JassOnline.state.seats[1].conn.emit('data', { t: 'mpr', rid: 77, err: 'kaputt' });
    assert.equal(h.JassOnline.state.seats[1].benchUntil, 2, 'Aussetzung bis Runde mit 2 abgeschlossenen Runden');

    // Ben ist sofort wieder verbunden. Die Runde startet neu (nach dem Abbruch).
    await until(() => h.JassOnline.state.seats[1].connected && h.JassOnline.state.seats[1].conn, 4000);
    eng.startRound();
    assert.deepEqual(Array.from(eng.remoteSeats), [2], 'Ben ist da, spielt aber noch nicht mit');
    assert.equal(eng.isHuman(1), false, 'Bens Platz ist KI');

    eng.history.push({});                               // eine Runde ist fertig
    eng.startRound();
    assert.deepEqual(Array.from(eng.remoteSeats), [2], 'noch eine Runde Aussetzung');

    eng.history.push({});                               // zwei Runden sind fertig
    eng.startRound();
    assert.deepEqual(Array.from(eng.remoteSeats), [1, 2], 'jetzt spielt Ben wieder mit');
  } finally { await cleanup(rs); }
});

test('Verbindung weg ohne Fehler: Ben spielt ab der nächsten Runde wieder mit', async () => {
  const rs = [];
  try {
    const { h, eng } = await startGame(rs);
    h.JassOnline.state.seats[1].conn.close();           // nur die Leitung bricht ab, kein Fehler
    await until(() => h.JassOnline.state.seats[1].connected && h.JassOnline.state.seats[1].conn, 4000);
    assert.equal(h.JassOnline.state.seats[1].benchUntil, undefined, 'keine Aussetzung');
    eng.history.push({});
    eng.startRound();
    assert.deepEqual(Array.from(eng.remoteSeats), [1, 2], 'Ben spielt wieder mit');
  } finally { await cleanup(rs); }
});
