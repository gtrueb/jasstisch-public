// Tests für Molotov. Start: node --test tests/molotov.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');
const M = require('../js/molotov.js');

const c = (s, r) => ({ s, r, id: s + r });

function seeded(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

test('tallies: round to 10, then divide by 10, sign kept', () => {
  assert.equal(M.tallies(72), 7);
  assert.equal(M.tallies(35), 4);
  assert.equal(M.tallies(157), 16);
  assert.equal(M.tallies(0), 0);
  assert.equal(M.tallies(-72), -7);
});

test('trump is set by the first player who cannot follow suit', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, weis: false });
  g.phase = 'play';
  g.trump = null;
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K')], [c('E', '6')], [c('L', '8')]];
  g.leader = 1;
  g.plays = [];
  g.trickNo = 1;
  assert.equal(g.playCard(1, c('E', 'K')), true);  // Vorhand führt Eichel
  assert.equal(g.trump, null);
  assert.equal(g.playCard(2, c('E', '6')), true);  // Eichel bedient
  assert.equal(g.trump, null);
  assert.equal(g.playCard(3, c('L', '8')), true);  // Seat 3 hat keine Eichel -> Schilten wird Trumpf
  assert.equal(g.trump, 'L');
  assert.equal(g.trumpSetBy, 3);
});

test('free play without the led suit: any card, including undertrump (Untertrumpfen erlaubt)', () => {
  const hand = [c('R', '6'), c('S', 'A')];
  const plays = [{ seat: 0, card: c('E', 'A') }, { seat: 1, card: c('R', 'K') }];
  assert.equal(R.legalFree(hand, plays).length, 2);
  // mit Eichel auf der Hand: Eichel bedienen ist Pflicht
  assert.deepEqual(R.legalFree([c('E', '7'), c('S', 'A')], plays).map((x) => x.id), ['E7']);
});

test('Weisen only on own turn in trick 1, and only once', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, weis: true });
  g.phase = 'play';
  g.trump = null;
  g.hands = [[c('R', '7'), c('R', '8'), c('R', '9'), c('S', 'A')], [], [], []];
  g.weisDecided = [false, false, false, false];
  g.weisAnn = [];
  g.annCounter = 0;
  g.leader = 1;             // Seat 1 beginnt, Seat 0 ist dran wenn plays 3 Karten hat
  g.plays = [];
  g.trickNo = 0;
  assert.equal(g.announceWeis(0), false);      // nicht am Zug
  g.plays = [{ seat: 1, card: c('E', 'K') }, { seat: 2, card: c('E', '6') }, { seat: 3, card: c('E', '7') }];
  g.leader = 1;
  assert.equal(g.announceWeis(0), true);        // am Zug, 3-Blatt Rosen
  assert.equal(g.announceWeis(0), false);       // nur einmal
  assert.equal(g.weisAnn[0].best.label, '3-Blatt');
});

test('Molotow Weis is minus for the single best player only', () => {
  const g = new M.Game({ rnd: seeded(3), sched: (fn) => fn(), delays: {}, end: 'rounds', rounds: 1, weis: true, stoeck: false, lastTrick: false });
  g.humanSeats = [];
  g.startRound();
  assert.equal(g.phase, 'gameEnd');
  const sc = g.lastScore;
  const weisTotal = sc.weis.reduce((a, b) => a + b, 0);
  assert.ok(weisTotal === 0 || g.weisRes !== null);
  if (g.weisRes) assert.equal(sc.weis[g.weisRes.seat], -g.weisRes.pts);
});

test('full AI games finish: 9 tricks, 36 distinct cards per round, winner has fewest tallies', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = new M.Game({ end: seed % 2 ? 'limit' : 'rounds', limit: 50, rounds: 8, rnd: seeded(seed), sched: (fn) => fn(), delays: {} });
    g.humanSeats = [];
    g.startRound();
    let guard = 0;
    while (g.phase !== 'gameEnd' && guard++ < 200) {
      if (g.phase === 'roundEnd') {
        const won = g.wonTricks.flat();
        assert.equal(won.length, 9, 'tricks per round');
        const ids = new Set(won.flat().map((x) => x.id));
        assert.equal(ids.size, 36, 'every card once');
        g.nextRound();
      } else break;
    }
    assert.equal(g.phase, 'gameEnd', 'seed ' + seed + ' did not finish, phase=' + g.phase);
    const min = Math.min(...g.totals);
    g.gameWinners.forEach((w) => assert.equal(g.totals[w], min));
    if (g.cfg.end === 'limit') assert.ok(Math.max(...g.totals) >= 50);
    if (g.cfg.end === 'rounds') assert.equal(g.history.length, 8);
  }
});

test('round tallies match rounded raw points, and card points total 152', () => {
  const g = new M.Game({ rnd: seeded(7), sched: (fn) => fn(), delays: {}, end: 'rounds', rounds: 1 });
  g.humanSeats = [];
  g.startRound();
  assert.equal(g.phase, 'gameEnd');
  const sc = g.lastScore;
  sc.plusStrokes.forEach((ps, i) => assert.equal(g.history[0].tallies[i], ps - sc.minusStrokes[i]));
  assert.equal(sc.card.reduce((a, b) => a + b, 0), 152);
});
