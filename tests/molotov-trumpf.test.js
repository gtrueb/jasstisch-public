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
