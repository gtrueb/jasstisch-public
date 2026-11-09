// Tests für die Molotow-Regel: Ist eine Farbe Trumpf, darf man deren Karten immer spielen,
// auch wenn man die ausgespielte Farbe bedienen kann. (js/rules.js, legalFree)
// Start: node --test tests/molotov-trumpf.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');

const card = (id, s, r) => ({ id, s, r });
const led = (s) => [{ seat: 0, card: card(99, s, '8') }];
const ids = (list) => list.map((c) => c.id);

test('Trumpf darf man auch spielen, wenn man die Farbe bedienen kann', () => {
  // Trumpf ist Eichel. Rose wurde ausgespielt. Auf der Hand: Eichel und Rose.
  const hand = [card(1, 'eichel', 'A'), card(2, 'rose', '7'), card(3, 'schelle', 'K')];
  assert.deepEqual(ids(R.legalFree(hand, led('rose'), 'eichel')), [1, 2]);
});

test('ohne Trumpf: wer die Farbe bedienen kann, muss sie spielen', () => {
  const hand = [card(1, 'eichel', 'A'), card(2, 'rose', '7')];
  assert.deepEqual(ids(R.legalFree(hand, led('rose'), null)), [2]);
  assert.deepEqual(ids(R.legalFree(hand, led('rose'))), [2]);
});

test('Farbe nicht bedienbar: jede Karte ist erlaubt', () => {
  const hand = [card(1, 'eichel', 'A'), card(2, 'schelle', '7')];
  assert.deepEqual(ids(R.legalFree(hand, led('rose'), 'eichel')), [1, 2]);
});

test('Trumpf ist die ausgespielte Farbe: nur diese Karten sind erlaubt', () => {
  const hand = [card(1, 'eichel', 'A'), card(2, 'rose', '7'), card(3, 'schelle', 'K')];
  assert.deepEqual(ids(R.legalFree(hand, led('eichel'), 'eichel')), [1]);
});

test('Ausspielen: jede Karte ist erlaubt', () => {
  const hand = [card(1, 'eichel', 'A'), card(2, 'rose', '7')];
  assert.deepEqual(ids(R.legalFree(hand, [], 'eichel')), [1, 2]);
});

// Stich: Rose wurde ausgespielt, dann hat Platz 1 mit Eichel K gestochen.
const trumped = [{ seat: 0, card: card(99, 'rose', '8') }, { seat: 1, card: card(98, 'eichel', 'K') }];

test('Nach einem Stich mit Trumpf: bedienen oder höheren Trumpf legen, kein Untertrumpfen', () => {
  // Hand: Rose 7 (bedient), Eichel 10 (niedriger, verboten), Eichel A (höher, erlaubt)
  const hand = [card(2, 'rose', '7'), card(3, 'eichel', '10'), card(4, 'eichel', 'A')];
  assert.deepEqual(ids(R.legalFree(hand, trumped, 'eichel')), [2, 4]);
});

test('Nach einem Stich mit Trumpf, ohne Farbe: Untertrumpfen verboten, andere Karten erlaubt', () => {
  // Hand: Schelle 7 (frei), Eichel 10 (zu niedrig), Eichel 9 (höher, erlaubt)
  const hand = [card(5, 'schelle', '7'), card(3, 'eichel', '10'), card(6, 'eichel', '9')];
  assert.deepEqual(ids(R.legalFree(hand, trumped, 'eichel')), [5, 6]);
});

test('Nach einem Stich mit Trumpf, ohne Farbe, nur niedrige Trümpfe: alles bleibt erlaubt', () => {
  const hand = [card(7, 'eichel', '6')];
  assert.deepEqual(ids(R.legalFree(hand, trumped, 'eichel')), [7]);
});

test('Noch kein Trumpf im Stich: abstechen mit jedem Trumpf erlaubt', () => {
  const onlyRose = [{ seat: 0, card: card(99, 'rose', '8') }];
  const hand = [card(5, 'schelle', '7'), card(3, 'eichel', '10')];
  assert.deepEqual(ids(R.legalFree(hand, onlyRose, 'eichel')), [5, 3]);
});
