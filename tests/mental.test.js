'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/mental.js');

// Miller-Rabin mit festen Basen (für Tests ausreichend).
function isProbablePrime(n) {
  const small = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (const p of small) { if (n % p === 0n) return n === p; }
  let d = n - 1n, s = 0;
  while (d % 2n === 0n) { d /= 2n; s++; }
  for (const a of small) {
    let x = M.modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let ok = false;
    for (let i = 1; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

test('Primzahl: P hat 2048 Bit, P und Q=(P-1)/2 sind prim', () => {
  assert.strictEqual(M.P.toString(2).length, 2048);
  assert.ok(isProbablePrime(M.P), 'P prim');
  assert.ok(isProbablePrime(M.Q), 'Q prim');
  assert.strictEqual(2n * M.Q + 1n, M.P);
});

test('Modulares Inverses und Potenzen stimmen', () => {
  assert.strictEqual(M.modpow(3n, 4n, 7n), 4n);       // 81 mod 7
  assert.strictEqual(M.modpow(2n, 10n, 1000n), 24n);  // 1024 mod 1000
  const a = 123456789n;
  assert.strictEqual((a * M.modinv(a, M.Q)) % M.Q, 1n);
  assert.throws(() => M.modinv(0n, M.Q));
});

test('36 Kartenwerte: jeder ist ein gültiges Element, verschieden, und lässt sich zurückverwandeln', () => {
  const seen = new Set();
  for (let k = 0; k < M.N; k++) {
    const v = M.encodeIndex(k);
    assert.ok(M.isElement(v), 'Karte ' + k + ' ist ein Element');
    assert.strictEqual(M.decodeValue(v), k);
    seen.add(v.toString(16));
  }
  assert.strictEqual(seen.size, 36);
  assert.strictEqual(M.decodeValue(M.encodeIndex(0) + 1n), -1);
});

test('Elemente: 0, P, P-1 (kein Quadrat) und 1 sind keine gültigen Werte', () => {
  assert.strictEqual(M.isElement(0n), false);
  assert.strictEqual(M.isElement(M.P), false);
  assert.strictEqual(M.isElement(M.P - 1n), false);
  assert.strictEqual(M.isElement(1n), false); // 1 ist das neutrale Element und kein gültiger Wert
});

test('Schlüssel: d ist das Inverse von e, h = G^e', () => {
  const key = M.genKey();
  assert.strictEqual((key.e * key.d) % M.Q, 1n);
  assert.strictEqual(key.h, M.modpow(M.G, key.e, M.P));
  assert.ok(M.isElement(key.h));
});

test('Ver- und Entschlüsseln heben sich auf, und die Schichten vertauschen sich', () => {
  const a = M.genKey(), b = M.genKey();
  const x = M.encodeIndex(17);
  const ab = M.modpow(M.modpow(x, a.e, M.P), b.e, M.P);
  const ba = M.modpow(M.modpow(x, b.e, M.P), a.e, M.P);
  assert.strictEqual(ab, ba, 'kommutativ');
  assert.strictEqual(M.modpow(M.modpow(x, a.e, M.P), a.d, M.P), x);
  const peeled = M.modpow(M.modpow(ab, a.d, M.P), b.d, M.P);
  assert.strictEqual(peeled, x);
});

// Ein kompletter Verteilablauf mit n Spielern, ohne Netzwerk.
function dealAll(n) {
  const players = [];
  for (let s = 0; s < n; s++) players.push(new M.Player(s, n));
  let L = [];
  for (let k = 0; k < M.N; k++) L.push(M.encodeIndex(k));
  for (const pl of players) L = pl.shuffle(L);
  for (const pl of players) L = pl.peelDeal(L);
  const cardsBySeat = players.map((pl) => pl.finalize(L));
  return { players, F: L, cardsBySeat };
}

test('Verteilung mit 4 Spielern: jeder Platz hat seine 9 Karten, zusammen alle 36 verschieden', () => {
  const { cardsBySeat } = dealAll(4);
  const all = [];
  cardsBySeat.forEach((cards, s) => {
    const ps = Object.keys(cards).map(Number);
    assert.strictEqual(ps.length, 9);
    ps.forEach((p) => { assert.strictEqual(p % 4, s); all.push(cards[p]); });
  });
  assert.strictEqual(new Set(all).size, 36);
  assert.deepStrictEqual(all.slice().sort((a, b) => a - b), Array.from({ length: 36 }, (_, i) => i));
});

test('Verteilung mit 3 Spielern: je 12 Karten', () => {
  const { cardsBySeat } = dealAll(3);
  const all = new Set();
  cardsBySeat.forEach((cards) => {
    assert.strictEqual(Object.keys(cards).length, 12);
    Object.values(cards).forEach((k) => all.add(k));
  });
  assert.strictEqual(all.size, 36);
});

test('Kein Beobachter ohne Schlüssel kann eine fremde Karte lesen', () => {
  const { players, F } = dealAll(4);
  // Der Host sieht F (nach dem Entfernen aller fremden Schichten). Ohne den Schlüssel des Besitzers
  // ist kein Wert eine Kartennummer.
  for (let p = 0; p < M.N; p++) {
    assert.strictEqual(M.decodeValue(F[p]), -1, 'Position ' + p + ' ist verdeckt');
  }
  // Auch mit dem falschen Schlüssel (eines anderen Spielers) bleibt sie verdeckt.
  for (let p = 0; p < M.N; p++) {
    const wrong = players[(p % 4 + 1) % 4];
    assert.strictEqual(M.decodeValue(M.modpow(F[p], wrong.key.d, M.P)), -1);
  }
});

test('Aufdecken: Besitzer beweist die Karte, der Beweis wird geprüft', async () => {
  const { players, F, cardsBySeat } = dealAll(4);
  const owner = players[2];
  const p = owner.mine[0];
  const [{ m, proof }] = await owner.revealOwn([p]);
  assert.strictEqual(M.decodeValue(m), cardsBySeat[2][p]);
  assert.strictEqual(await M.verifyReveal(m, F[p], owner.key.h, proof), true);

  // Falsche Karte mit gleichem Beweis: abgelehnt.
  const other = M.encodeIndex((cardsBySeat[2][p] + 1) % 36);
  assert.strictEqual(await M.verifyReveal(other, F[p], owner.key.h, proof), false);

  // Veränderter Beweis: abgelehnt.
  const bad = { c: proof.c, z: (proof.z + 1n) % M.Q };
  assert.strictEqual(await M.verifyReveal(m, F[p], owner.key.h, bad), false);

  // Falscher öffentlicher Schlüssel: abgelehnt.
  assert.strictEqual(await M.verifyReveal(m, F[p], players[1].key.h, proof), false);

  // Anderer verschlüsselter Wert: abgelehnt.
  assert.strictEqual(await M.verifyReveal(m, F[(p + 1) % M.N], owner.key.h, proof), false);
});

test('Besitzer kann keine fremde Position öffnen', async () => {
  const { players } = dealAll(4);
  const foreign = (players[0].mine[0] + 1) % M.N;
  await assert.rejects(players[0].revealOwn([foreign]), /Nicht meine Karte/);
});

test('Ungültige Eingaben werden abgelehnt', () => {
  const pl = new M.Player(0, 4);
  assert.throws(() => pl.shuffle([1n, 2n]), /Länge/);
  const bogus = Array.from({ length: 36 }, () => M.P);   // außerhalb des Bereichs
  assert.throws(() => M.checkElems(bogus, 36), /Kein gültiger/);
  assert.throws(() => M.checkElems(Array.from({ length: 36 }, () => M.P - 1n), 36, true), /Kein gültiger/);
  assert.doesNotThrow(() => M.checkElems(Array.from({ length: 36 }, (_, i) => M.encodeIndex(i)), 36, true));
  assert.throws(() => pl.finalize(Array.from({ length: 36 }, (_, i) => M.encodeIndex(0))), /Karte ungültig/);
  assert.throws(() => M.fromHex('xyz'), /Ungültiger/);
});

test('Drahtformat: Hex hin und zurück, Beweis hin und zurück', () => {
  const x = M.encodeIndex(5);
  assert.strictEqual(M.fromHex(M.toHex(x)), x);
  const p = { c: 12345n, z: 67890n };
  assert.deepStrictEqual(M.proofFromWire(M.proofToWire(p)), p);
});
