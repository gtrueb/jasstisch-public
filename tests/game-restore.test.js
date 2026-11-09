// Tests für restore() in den echten Engines (Molotov und Schieber): Punkte, Rundennummer und Geber
// werden übernommen, und startRound() zählt den Geber so weiter, wie es sein soll.
// Start: node --test tests/game-restore.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../js/molotov.js');
const G = require('../js/game.js');

test('Molotov: restore setzt Punkte, Rundennummer und Geber', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, weis: false, players: 3 });
  g.restore({ totals: [1, 2, 3], roundNo: 2, dealer: 0 });
  assert.deepEqual(g.totals, [1, 2, 3]);
  assert.equal(g.roundNo, 2);
  g.startRound();                                       // Runde 3, Geber zählt von 0 auf 1
  assert.equal(g.roundNo, 3);
  assert.equal(g.dealer, 1);
});

test('Molotov: laufende Runde 2 mit Geber 0 startet neu mit Geber 0', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, weis: false, players: 3 });
  // So legt online.js den Snapshot an: eine Runde ist fertig, Geber der laufenden Runde ist 0,
  // also wird der Geber um eine Stelle zurückgesetzt (2), startRound() zählt ihn wieder auf 0.
  g.restore({ totals: [0, 0, 0], roundNo: 1, dealer: (0 - 1 + 3) % 3 });
  g.startRound();
  assert.equal(g.roundNo, 2);
  assert.equal(g.dealer, 0);
});

test('Molotov: restore kopiert die Punkte (keine Verbindung zum Snapshot)', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, weis: false, players: 3 });
  const snap = { totals: [4, 5, 6], roundNo: 0, dealer: 0 };
  g.restore(snap);
  g.totals[0] = 99;
  assert.deepEqual(snap.totals, [4, 5, 6]);
});

test('Schieber: restore setzt Teampunkte, Rundennummer und Geber', () => {
  const g = new G.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, target: 1000 });
  g.restore({ totals: [120, 80], roundNo: 3, dealer: 3 });
  assert.deepEqual(g.totals, [120, 80]);
  assert.equal(g.roundNo, 3);
  g.startRound();                                       // Runde 4, Geber zählt von 3 auf 0
  assert.equal(g.roundNo, 4);
  assert.equal(g.dealer, 0);
});
