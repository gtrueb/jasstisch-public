// Tests für die Sicht pro Spieler. Start: node --test tests/view.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../js/view.js');
const G = require('../js/game.js');

test('own hand is open, other hands are only counted, seats rotate to me', () => {
  const st = { hands: [[1], [2, 3], [4], [5, 6]], trickWins: [0, 1, 2, 3], totals: [10, 20, 30, 40], history: [],
    plays: [{ seat: 3, card: 9 }], turnSeat: 1, leader: 0, dealer: 0, vorhand: 1, chooser: 1, trumpSetBy: -1,
    phase: 'play', trump: 0, trickNo: 0, canSchieben: false, weisAnn: [], weisRes: null, weisHold: false,
    tischEvents: [], lastEvent: null, cfg: {}, gameWinners: [], lastScore: null, gameWinner: null, target: 1000,
    legal: [2], humanBest: null, humanWeisIds: [], humanWeisDone: false, schellen7Holder: -1 };
  const v = V.buildView(st, 1, ['A', 'B', 'C', 'D'], 'schieber');
  assert.deepEqual(v.hands[0], [2, 3]);            // eigene Hand offen
  assert.deepEqual(v.hands[1], [null]);            // andere nur als Anzahl
  assert.deepEqual(v.hands[2], [null, null]);
  assert.equal(v.names[0], 'B');                   // mein Name steht unten
  assert.deepEqual(v.plays, [{ seat: 2, card: 9 }]);
  assert.equal(v.turnSeat, 0);                     // ich bin am Zug
  assert.deepEqual(v.teamNames, ['B & D', 'C & A']);
});

test('no hidden card leaks into the view of another player', () => {
  const g = new G.Game({ rnd: () => 0.37, sched: () => {}, delays: {}, humanSeats: [] });
  g.startRound();
  for (let me = 0; me < 4; me++) {
    const v = V.buildView(g.stateForUI(me), me, ['a', 'b', 'c', 'd'], 'schieber');
    const own = v.hands[0].map((c) => c.id);
    v.hands.slice(1).forEach((h) => h.forEach((c) => assert.equal(c, null)));
    assert.ok(own.every((id) => g.hands[me].some((c) => c.id === id)));
  }
});
