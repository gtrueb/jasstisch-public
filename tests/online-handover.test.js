// Tests für die Lobby-Übernahme (js/online.js): geht der Host, übernimmt ein Mitspieler.
// Jede "Browser-Kopie" ist eine eigene vm-Umgebung mit eigenem Zustand. Die Peers und der Peer-Server
// sind gefälscht. Die Zeiten sind kurz gesetzt (JassOnline.timing), damit die Tests schnell laufen.
// Start: node --test tests/online-handover.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'online.js'), 'utf8');

// ----- Gefälschter Peer-Server: jede ID nur einmal -----
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

// Eine "Browser-Kopie": eigene vm-Umgebung mit eigenem JassOnline.
function realm(rs) {
  const sb = {
    Peer: FakePeer, JassMental: {}, JassMentalRound: {}, TextEncoder,
    crypto: globalThis.crypto, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, console
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'online.js' });
  Object.assign(sb.JassOnline.timing, { connectMs: 300, retryMs: 20, electAfterFails: 2, electStepMs: 10, electMaxMs: 4000, beatMs: 20, silentMs: 400 });
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

function hostLobby(n, rs, rules) {
  const h = realm(rs);
  h.JassOnline.setHandlers({ onLobby() {}, onStart() {}, onRender() {}, onStatus() {} });
  h.JassOnline.createLobby('molotov', n, 'Anna', rules || { weis: true, stoeck: true, lastTrick: true, undenufe: true });
  return h;
}

function join(code, name, rs) {
  const r = realm(rs);
  r.JassOnline.setHandlers({ onLobby() {}, onStart() {}, onRender() {}, onStatus() {} });
  r.JassOnline.joinLobby(code, name);
  return r;
}

async function cleanup(rs) {
  rs.forEach((r) => { try { r.JassOnline.leave(); } catch (e) {} });
  await new Promise((r) => setTimeout(r, 30));
}

test('bye: der Mitspieler mit dem niedrigsten Platz wird Host, die Plätze drehen sich', async () => {
  const rs = [];
  try {
    const h = hostLobby(3, rs);
    await until(() => h.JassOnline.state.lobby);
    const code = h.JassOnline.state.code;
    const b = join(code, 'Ben', rs);
    const c = join(code, 'Cem', rs);
    await until(() => b.JassOnline.state.hostInst && c.JassOnline.state.hostInst);
    assert.equal(b.JassOnline.state.mySeat, 1);
    assert.equal(c.JassOnline.state.mySeat, 2);

    h.JassOnline.leave();                                    // schickt "bye"
    await until(() => b.JassOnline.state.role === 'host');
    await until(() => c.JassOnline.state.role === 'client' && c.JassOnline.state.mySeat === 1 &&
      c.JassOnline.state.hostInst === b.JassOnline.state.inst);

    const bs = b.JassOnline.state;
    assert.equal(bs.mySeat, 0);
    assert.equal(bs.seats[0].name, 'Ben');
    assert.equal(bs.seats[1].name, 'Cem');
    assert.equal(bs.seats[2].kind, 'open', 'der alte Host ist frei');
    assert.equal(bs.seats.filter((s) => s.kind === 'human').length, 2);
  } finally { await cleanup(rs); }
});

test('Host verschwindet ohne bye: nach zwei Fehlversuchen übernimmt der erste Mitspieler', async () => {
  const rs = [];
  try {
    const h = hostLobby(3, rs);
    await until(() => h.JassOnline.state.lobby);
    const code = h.JassOnline.state.code;
    const b = join(code, 'Ben', rs);
    const c = join(code, 'Cem', rs);
    await until(() => b.JassOnline.state.hostInst && c.JassOnline.state.hostInst);

    h.JassOnline.state.peer.destroy();                       // kein bye, der Host ist einfach weg
    await until(() => b.JassOnline.state.role === 'host', 6000);
    await until(() => c.JassOnline.state.role === 'client' && c.JassOnline.state.hostInst === b.JassOnline.state.inst, 6000);
    assert.equal(c.JassOnline.state.role, 'client', 'nur ein Host');
    assert.equal(c.JassOnline.state.mySeat, 1);
  } finally { await cleanup(rs); }
});

test('nach der Übernahme bekommt ein fremder Token keinen belegten Platz', async () => {
  const rs = [];
  try {
    const h = hostLobby(3, rs);
    await until(() => h.JassOnline.state.lobby);
    const code = h.JassOnline.state.code;
    const b = join(code, 'Ben', rs);
    const c = join(code, 'Cem', rs);
    await until(() => b.JassOnline.state.hostInst && c.JassOnline.state.hostInst);
    h.JassOnline.leave();
    await until(() => b.JassOnline.state.role === 'host');
    await until(() => c.JassOnline.state.hostInst === b.JassOnline.state.inst && c.JassOnline.state.mySeat === 1);

    const d = join(code, 'Dora', rs);                        // hat einen eigenen, neuen Token
    await until(() => d.JassOnline.state.hostInst === b.JassOnline.state.inst);
    assert.equal(d.JassOnline.state.mySeat, 2, 'Dora bekommt den freien Platz, nicht Cems');
    assert.equal(c.JassOnline.state.mySeat, 1);
  } finally { await cleanup(rs); }
});

test('Regeln: Mitspieler sehen die Regeln des Hosts und behalten sie nach der Übernahme', async () => {
  const rs = [];
  try {
    const rules = { weis: false, stoeck: true, lastTrick: true, undenufe: false };
    const h = hostLobby(3, rs, rules);
    await until(() => h.JassOnline.state.lobby);
    const b = join(h.JassOnline.state.code, 'Ben', rs);
    await until(() => b.JassOnline.state.lobby && b.JassOnline.state.lobby.rules);
    assert.deepEqual(b.JassOnline.state.lobby.rules, rules);

    h.JassOnline.hostSetRules({ weis: true, stoeck: false, lastTrick: false, undenufe: true });
    await until(() => b.JassOnline.state.lobby.rules.weis === true);

    h.JassOnline.leave();
    await until(() => b.JassOnline.state.role === 'host');
    assert.deepEqual(b.JassOnline.state.rules, { weis: true, stoeck: false, lastTrick: false, undenufe: true });
  } finally { await cleanup(rs); }
});

test('die Lobby zeigt nur Hashes der Tokens, nie einen Token', async () => {
  const rs = [];
  try {
    const h = hostLobby(3, rs);
    await until(() => h.JassOnline.state.lobby);
    const b = join(h.JassOnline.state.code, 'Ben', rs);
    await until(() => h.JassOnline.state.lobby && h.JassOnline.state.lobby.seats[1].th);
    const th = h.JassOnline.state.lobby.seats[1].th;
    assert.match(th, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(h.JassOnline.state.lobby).includes(b.JassOnline.state.token));
    assert.ok(!JSON.stringify(b.JassOnline.state.lobby).includes(b.JassOnline.state.token));
  } finally { await cleanup(rs); }
});
