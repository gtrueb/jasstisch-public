'use strict';
/*
 * Weis mit verdeckten Karten: das Gerät legt die Karten offen, nach denen der Rang (bestWeis)
 * und die Summe (weisTotal) bestimmt werden. Diese Vereinigung muss dasselbe Ergebnis liefern
 * wie die volle Hand. Die alte Variante (nur die Summen-Karten) ist nachweislich falsch.
 */
const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/rules.js');

function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sameBest(a, b) {
  if (!a || !b) return a === b;
  return a.cls === b.cls && a.pts === b.pts && a.top === b.top;
}

test('Weis: Vereinigung aus bester Kombination und Summe liefert dasselbe Ergebnis wie die volle Hand', () => {
  const rnd = seeded(4242);
  let withWeis = 0, unionMismatch = 0, totalOnlyMismatch = 0;
  for (let i = 0; i < 20000; i++) {
    const deck = R.shuffle(R.makeDeck(), rnd);
    const hand = deck.slice(0, 9);
    const best = R.bestWeis(hand);
    const total = R.weisTotal(hand);
    if (!best) continue;
    withWeis++;

    // Richtige Variante: beide Kartenmengen zusammen
    const ids = new Set(best.cards.concat(total.cards).map((c) => c.id));
    const union = hand.filter((c) => ids.has(c.id));
    if (!sameBest(R.bestWeis(union), best) || R.weisTotal(union).pts !== total.pts) unionMismatch++;

    // Alte Variante: nur die Summen-Karten (kann den Rang verfälschen)
    const onlyTotal = total.cards;
    const bt = R.bestWeis(onlyTotal);
    if (!sameBest(bt, best)) totalOnlyMismatch++;
  }
  assert.ok(withWeis > 1000, 'genug Hände mit Weis geprüft: ' + withWeis);
  assert.strictEqual(unionMismatch, 0, 'Vereinigung stimmt immer');
  assert.ok(totalOnlyMismatch > 0, 'die alte Variante war falsch (Nachweis für die Änderung)');
});
