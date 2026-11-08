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

test('tallies: round to 10, then divide by 10', () => {
  assert.equal(M.tallies(72), 7);
  assert.equal(M.tallies(35), 4);
  assert.equal(M.tallies(157), 16);
  assert.equal(M.tallies(0), 0);
});

test('trump is set by the first player who cannot follow suit', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {} });
  g.phase = 'play';
  g.trump = null;
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K')], [c('E', '6')], [c('L', '8')]];
  g.leader = 1;
  g.plays = [];
  g.trickNo = 1;
  g.weisShown = true;
  assert.equal(g.playCard(1, c('E', 'K')), true);  // Vorhand führt Eichel
  assert.equal(g.trump, null);
  assert.equal(g.playCard(2, c('E', '6')), true);  // Eichel bedient
  assert.equal(g.trump, null);
  assert.equal(g.playCard(3, c('L', '8')), true);  // Seat 3 hat keine Eichel -> Schilten wird Trumpf
  assert.equal(g.trump, 'L');
  assert.equal(g.trumpSetBy, 3);
});

test('after trump is set, a player must still follow suit when able', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {} });
  g.phase = 'play';
  g.trump = 'L';
  g.hands = [[c('E', 'A'), c('S', '7')], [], [], []];
  g.leader = 3;
  g.plays = [{ seat: 3, card: c('E', 'K') }];
  g.trickNo = 1;
  g.weisShown = true;
  assert.equal(g.humanPlay('S7'), false);
  assert.equal(g.humanPlay('EA'), true);
});

test('full AI games finish: 9 tricks, 36 distinct cards per round, winner has fewest tallies', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const g = new M.Game({ end: seed % 2 ? 'limit' : 'rounds', limit: 50, rounds: 9, rnd: seeded(seed), sched: (fn) => fn(), delays: {} });
    g.humanSeat = -1;
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
    if (g.cfg.end === 'rounds') assert.equal(g.history.length, 9);
  }
});

test('round tallies match rounded card points plus bonuses', () => {
  const g = new M.Game({ rnd: seeded(7), sched: (fn) => fn(), delays: {}, end: 'rounds', rounds: 1 });
  g.humanSeat = -1;
  g.startRound(); // mit sofortiger Ausführung läuft die ganze Runde durch
  assert.equal(g.phase, 'gameEnd');
  const sc = g.lastScore;
  sc.raw.forEach((p, i) => assert.equal(g.history[0].tallies[i], Math.round(p / 10)));
  // Kartenpunkte aller Spieler zusammen: 152 (alle Karten) bei festem Trumpf, sonst 120 ohne Trumpf
  const sumCards = sc.card.reduce((a, b) => a + b, 0);
  assert.ok(sumCards === 152 || sumCards === 120, 'card points total ' + sumCards);
});
