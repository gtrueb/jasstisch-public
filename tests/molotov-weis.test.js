// Tests für Molotow-Weisen: Folgen bis 9 Blatt (6-Blatt 150, 7-Blatt 200, 8-Blatt 250, 9-Blatt 300).
// Schieber bleibt bei 5 Blatt. (js/rules.js: weisTotal, bestWeis, resolveWeisAnn mit opts.molo)
// Start: node --test tests/molotov-weis.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');

const RANKS = ['6', '7', '8', '9', '10', 'U', 'O', 'K', 'A'];
const MOLO = { molo: true };
let nextId = 1;
const card = (s, r) => ({ id: nextId++, s, r });
// Eine Folge in einer Farbe: len Karten ab Rang-Index from.
const run = (s, from, len) => RANKS.slice(from, from + len).map((r) => card(s, r));

test('Molotow: 6-Blatt gibt 150 Weispunkte', () => {
  const t = R.weisTotal(run('E', 0, 6), MOLO);
  assert.equal(t.pts, 150);
  assert.equal(t.label, '6-Blatt');
});

test('Molotow: 7-Blatt gibt 200 Weispunkte', () => {
  const t = R.weisTotal(run('E', 0, 7), MOLO);
  assert.equal(t.pts, 200);
  assert.equal(t.label, '7-Blatt');
});

test('Molotow: 8-Blatt gibt 250 Weispunkte', () => {
  const t = R.weisTotal(run('E', 0, 8), MOLO);
  assert.equal(t.pts, 250);
  assert.equal(t.label, '8-Blatt');
});

test('Molotow: 9-Blatt gibt 300 Weispunkte', () => {
  const t = R.weisTotal(run('E', 0, 9), MOLO);
  assert.equal(t.pts, 300);
  assert.equal(t.label, '9-Blatt');
});

test('Molotow: 5-Blatt bleibt bei 100 Weispunkten', () => {
  const t = R.weisTotal(run('E', 0, 5), MOLO);
  assert.equal(t.pts, 100);
  assert.equal(t.label, '5-Blatt');
});

test('Molotow: 6-Blatt und 3-Blatt in anderer Farbe zählen zusammen (150 + 20)', () => {
  const hand = [...run('E', 0, 6), ...run('R', 0, 3)];
  assert.equal(R.weisTotal(hand, MOLO).pts, 170);
});

test('Schieber (ohne Option) zählt bei 6 Karten nur 5-Blatt: 100 Punkte', () => {
  const t = R.weisTotal(run('E', 0, 6));
  assert.equal(t.pts, 100);
  assert.equal(t.label, '5-Blatt');
});

test('bestWeis (Molotow): die längste Folge wird angesagt', () => {
  const best = R.bestWeis(run('E', 0, 7), MOLO);
  assert.equal(best.n, 7);
  assert.equal(best.label, '7-Blatt');
});

test('Gleiche Klasse: 6-Blatt schlägt 5-Blatt, auch wenn die oberste Karte tiefer liegt', () => {
  // A: Eichel 6 bis U (oberste Karte U). B: Schellen 10 bis Ass (oberste Karte Ass, also höher).
  const handA = run('E', 0, 6);
  const handB = run('S', 4, 5);
  const anns = [
    { seat: 1, best: R.bestWeis(handB, MOLO), total: R.weisTotal(handB, MOLO), order: 1 },
    { seat: 0, best: R.bestWeis(handA, MOLO), total: R.weisTotal(handA, MOLO), order: 2 }
  ];
  const win = R.resolveWeisAnn(anns);
  assert.equal(win.seat, 0, 'das 6-Blatt gewinnt');
  assert.equal(win.pts, 150);
});
