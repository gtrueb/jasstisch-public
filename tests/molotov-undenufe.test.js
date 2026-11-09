// Tests für die Undenufe-Regel (Molotov): Undenufe, Obenabe, Slalom.
// Start: node --test tests/molotov-undenufe.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');
const M = require('../js/molotov.js');

const c = (s, r) => ({ s, r, id: s + r });
const SUITS = ['E', 'S', 'R', 'L'];
const RANKS = ['6', '7', '8', '9', '10', 'U', 'O', 'K', 'A'];
const deck = () => SUITS.flatMap((s) => RANKS.map((r) => c(s, r)));

// Spiel mit Vorhand auf Platz 1, Stich 1 (trickNo 0). Hände setzt jeder Test selbst.
function game(opts) {
  const g = new M.Game(Object.assign({ rnd: () => 0.5, sched: () => {}, delays: {}, weis: false }, opts || {}));
  g.resetRoundState();                                 // wie beim Rundenstart
  g.phase = 'play';
  g.trump = null;
  g.trickNo = 0;
  g.plays = [];
  g.leader = 1;
  return g;
}

function play(g, seat, card) {
  assert.equal(g.playCard(seat, card), true, card.id + ' von Platz ' + seat);
}

// Stich 1: Platz 1 führt Eichel. Platz 2 hat keine Eichel und setzt mit R6 (Undenufe).
// Platz 2 gewinnt den Stich, obwohl Platz 0 Eichel bedient.
function trick1(g) {
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K'), c('R', '9')], [c('R', '6'), c('S', 'A'), c('L', '8')], [c('S', '8'), c('L', '9')]];
  play(g, 1, c('E', 'K'));
  play(g, 2, c('R', '6'));
  play(g, 3, c('S', '8'));
  play(g, 0, c('E', 'A'));
  g.finishTrick();
}

test('Undenufe: die 6 sticht am höchsten, Obenabe: das Ass', () => {
  const plays = [{ seat: 0, card: c('E', 'A') }, { seat: 1, card: c('E', '6') }];
  assert.equal(R.winnerIndex(plays, null, true), 1);   // Undenufe: 6 gewinnt
  assert.equal(R.winnerIndex(plays, null, false), 0);  // Obenabe: Ass gewinnt
});

test('Undenufe: alle 36 Karten ergeben 152 Punkte, wie Obenabe', () => {
  assert.equal(R.trickPoints(deck(), null, true), 152);
  assert.equal(R.trickPoints(deck(), null, false), 152);
});

test('erste 6 setzt Undenufe, das ist kein Slalom', () => {
  const g = game();
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K')], [c('R', '6')], [c('S', 'A')]];
  play(g, 1, c('E', 'K'));                             // Vorhand führt Eichel
  play(g, 2, c('R', '6'));                             // 6 ohne Eichel -> Undenufe
  assert.equal(g.trump, null);
  assert.equal(g.modeSet, 'undenufe');
  assert.equal(g.undenufeNow(), true);
  assert.deepEqual(g.slalomBonus, [0, 0, 0, 0]);
  assert.equal(g.slalomStart, false);
  assert.equal(g.lastEvent.type, 'mode');
});

test('der Setzer gewinnt seinen Setzstich, auch wenn andere die Farbe bedienen', () => {
  const g = game();
  trick1(g);
  assert.equal(g.wonTricks[2].length, 1);
  assert.equal(g.leader, 2);
});

test('Slalom: der Setzer spielt im nächsten Stich die Gegenkarte (Ass nach 6), -20 einmal', () => {
  const g = game();
  trick1(g);
  play(g, 2, c('S', 'A'));                             // Gegenkarte zur 6 -> Slalom
  assert.equal(g.slalomStart, true);
  assert.deepEqual(g.slalomBonus, [0, 0, 20, 0]);
  assert.equal(g.lastEvent.type, 'slalom');
  assert.equal(g.lastEvent.seat, 2);
  assert.equal(g.trickUndenufe(1), false);             // Stich 2 ist Obenabe (Wechsel)
  play(g, 3, c('L', '9'));
  play(g, 0, c('S', '7'));
  play(g, 1, c('R', '9'));
  g.finishTrick();
  assert.equal(g.slalomBonus[2], 20);                  // nicht noch einmal
});

test('Slalom wechselt in jedem Stich bis Rundenende, egal wer ausspielt', () => {
  const g = game();
  trick1(g);
  play(g, 2, c('S', 'A'));
  play(g, 3, c('L', '9'));
  play(g, 0, c('S', '7'));
  play(g, 1, c('R', '9'));
  g.finishTrick();
  // Stich 0 = Setzstich (Undenufe), danach jeder Stich wechselt
  const modes = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((t) => g.trickUndenufe(t));
  assert.deepEqual(modes, [true, false, true, false, true, false, true, false, true]);
  assert.equal(g.slalomBonus[2], 20);
});

test('kein Slalom: die Gegenkarte im nächsten Stich fehlt, der Modus bleibt', () => {
  const g = game();
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K'), c('R', '9')], [c('R', '6'), c('S', 'A'), c('L', '8')], [c('S', '8'), c('L', '9')]];
  play(g, 1, c('E', 'K'));
  play(g, 2, c('R', '6'));
  play(g, 3, c('S', '8'));
  play(g, 0, c('E', 'A'));
  g.finishTrick();
  play(g, 2, c('L', '8'));                             // keine Gegenkarte -> kein Slalom
  assert.equal(g.slalomStart, false);
  assert.deepEqual(g.slalomBonus, [0, 0, 0, 0]);
  play(g, 3, c('L', '9'));
  play(g, 0, c('S', '7'));
  play(g, 1, c('R', '9'));
  g.finishTrick();
  assert.equal(g.undenufeNow(), true);
  assert.equal(g.trickUndenufe(2), true);
  assert.equal(g.trickUndenufe(3), true);              // bleibt Undenufe bis Rundenende
});

test('vor dem ersten Setzen gilt kein Modus: frühere Stiche sind Obenabe', () => {
  const g = game();
  // Stich 0 und 1 ohne Abweichung (alle bedienen), Stich 1 setzt erst mit S6
  g.hands = [[c('E', '8'), c('R', '9')], [c('E', 'K'), c('L', '7')], [c('E', 'A'), c('R', '7')], [c('E', '7'), c('S', '6')]];
  play(g, 1, c('E', 'K'));
  play(g, 2, c('E', 'A'));
  play(g, 3, c('E', '7'));
  play(g, 0, c('E', '8'));
  g.finishTrick();                                     // Stich 0: Obenabe, kein Modus
  play(g, 2, c('R', '7'));
  play(g, 3, c('S', '6'));                             // erste Abweichung der Runde: 6 setzt Undenufe
  play(g, 0, c('R', '9'));
  play(g, 1, c('L', '7'));
  g.finishTrick();
  assert.equal(g.setTrick, 1);
  assert.equal(g.modeSet, 'undenufe');
  assert.equal(g.trickUndenufe(0), false);             // vor dem Setzen: Obenabe
  assert.equal(g.trickUndenufe(1), true);              // Setzstich: Undenufe
});

test('andere Karte als 6 oder Ass setzt Farbtrumpf, kein Modus', () => {
  const g = game();
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K'), c('R', '9')], [c('R', 'K'), c('S', 'A')], [c('S', '8'), c('L', '9')]];
  play(g, 1, c('E', 'K'));
  play(g, 2, c('R', 'K'));                             // Rosen-König ohne Eichel -> Farbtrumpf Rosen
  assert.equal(g.trump, 'R');
  assert.equal(g.trumpSetBy, 2);
  assert.ok(!g.modeSet);
});

test('Undenufe aus: eine 6 setzt wie bisher einen Farbtrumpf', () => {
  const g = game({ undenufe: false });
  g.hands = [[c('E', 'A'), c('S', '7')], [c('E', 'K')], [c('R', '6')], [c('S', 'A')]];
  play(g, 1, c('E', 'K'));
  play(g, 2, c('R', '6'));
  assert.equal(g.trump, 'R');
  assert.equal(g.trumpSetBy, 2);
  assert.ok(!g.modeSet);
});

test('neue Runde: Modus ist wieder Obenabe, Slalom-Bonus ist leer', () => {
  const g = game();
  g.modeSet = 'undenufe';
  g.slalomBonus = [0, 0, 0, 20];
  g.slalomStart = true;
  g.resetRoundState();
  assert.equal(g.modeSet, null);
  assert.equal(g.slalomStart, false);
  assert.deepEqual(g.slalomBonus, [0, 0, 0, 0]);
});

test('Slalom-Minus steht im Rundenergebnis: -20 zeigt als 2 Striche', () => {
  const g = new M.Game({ rnd: () => 0.5, sched: () => {}, delays: {}, end: 'rounds', rounds: 2, weis: false });
  g.resetRoundState();
  g.wonTricks = [[], [], [], []];
  g.trickNo = 9;
  g.lastWinner = 0;
  g.slalomBonus = [0, 0, 0, 20];
  g.roundNo = 1;
  g.endRound();
  assert.equal(g.lastScore.slalom[3], -20);
  assert.equal(g.lastScore.minusStrokes[3], 2);
  assert.equal(g.lastScore.mode, 'obenabe');
});

test('Runde: Kartenpunkte + letzter Stich = 157, Tischweis kommt obendrauf (60 Runden)', () => {
  const seeded = (seed) => {
    let s = seed;
    return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  };
  for (let seed = 1; seed <= 60; seed++) {
    const g = new M.Game({ rnd: seeded(seed), sched: (fn) => fn(), delays: {}, end: 'rounds', rounds: 1, weis: false });
    g.humanSeats = [];
    g.startRound();
    const sc = g.lastScore;
    const cardBonus = sc.card.reduce((a, b) => a + b, 0) + sc.bonus.reduce((a, b) => a + b, 0);
    assert.equal(cardBonus, 157, 'Runde mit Seed ' + seed);
  }
});
