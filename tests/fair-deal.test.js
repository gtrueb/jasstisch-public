// Tests fuer das faire Mischen (js/fair-deal.js, Umbauplan v3 und v4).
// Die Testvektoren kommen aus einer zweiten, unabhaengigen Rechnung in Python:
//   python3 tests/fair/ref_fair_deal.py  ->  tests/fair/vectors.json
// Start: node --test tests/fair-deal.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../js/fair-deal.js');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'fair', 'vectors.json'), 'utf8'));
const hex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');
const RID = hex(V.rid);

test('Zufallskette: Werte stimmen mit der Python-Referenz ueberein', async () => {
  const top = hex(V.chain.s_top);
  let used = false;
  const chain = await F.buildChain(V.chain.N, () => { used = true; return top; });
  assert.equal(used, true);
  assert.deepEqual(chain.map(toHex), V.chain.values);
});

test('Zufallskette: jedes Glied passt zum vorherigen Anker', async () => {
  const chain = V.chain.values.map(hex);
  for (let k = 1; k < chain.length; k++) {
    assert.equal(await F.verifyLink(chain[k - 1], chain[k]), true, 'Glied ' + k);
  }
  // Ein verfaelschtes Glied faellt auf.
  const fake = Uint8Array.from(chain[2]);
  fake[0] ^= 1;
  assert.equal(await F.verifyLink(chain[1], fake), false);
});

test('Spieler-Commit stimmt mit der Referenz ueberein', async () => {
  const seeds = [1, 2, 3, 4].map((x) => Uint8Array.from({ length: 32 }, () => x));
  for (let i = 0; i < 4; i++) {
    const c = await F.clientCommit(RID, 3, i, seeds[i]);
    assert.equal(toHex(c), V.round_4_players.commits[i]);
  }
});

test('Deal mit vier Spielern stimmt mit der Referenz ueberein', async () => {
  const S = hex(V.round_4_players.S_r);
  const seeds = V.round_4_players.deal.seeds.map(hex);
  const res = await F.dealRound(RID, 3, 4, seeds, S);
  assert.equal(toHex(res.K), V.round_4_players.deal.K);
  assert.deepEqual(res.perm, V.round_4_players.deal.perm);
  assert.deepEqual(res.hands, V.round_4_players.deal.hands);
  assert.deepEqual(res.status, V.round_4_players.deal.status);
});

test('Fehlender Seed: Ersatz wird deterministisch aus S_r gesetzt und stimmt mit der Referenz ueberein', async () => {
  const S = hex(V.round_4_missing_seat2.S_r);
  const seeds = V.round_4_missing_seat2.seeds_in.map((x) => (x ? hex(x) : null));
  const res = await F.dealRound(RID, 3, 4, seeds, S);
  assert.deepEqual(res.status, V.round_4_missing_seat2.deal.status);
  assert.equal(toHex(res.K), V.round_4_missing_seat2.deal.K);
  assert.deepEqual(res.perm, V.round_4_missing_seat2.deal.perm);
});

test('Deal mit drei Spielern (je 12 Karten) stimmt mit der Referenz ueberein', async () => {
  const S = hex(V.round_4_players.S_r);
  const seeds3 = V.round_3_players.deal.seeds.map(hex);
  const res = await F.dealRound(RID, 2, 3, seeds3, S);
  assert.equal(toHex(res.K), V.round_3_players.deal.K);
  assert.deepEqual(res.hands, V.round_3_players.deal.hands);
  assert.deepEqual(res.hands.map((h) => h.length), [12, 12, 12]);
});

test('Jede der 36 Karten kommt genau einmal vor', async () => {
  const seeds = [1, 2, 3, 4].map((x) => Uint8Array.from({ length: 32 }, () => x));
  const res = await F.dealRound(RID, 1, 4, seeds, Uint8Array.from({ length: 32 }, () => 9));
  const all = res.hands.flat().sort((a, b) => a - b);
  assert.deepEqual(all, Array.from({ length: 36 }, (_, i) => i));
});

test('Verteilung: Position der ersten Karte ist gleichmaessig (Chi-Quadrat)', async () => {
  const runs = 3000;
  const counts = new Array(36).fill(0);
  for (let t = 0; t < runs; t++) {
    const K = F.randomBytes(32);
    const perm = await F.permutation(K);
    counts[perm.indexOf(0)] += 1;
  }
  const expected = runs / 36;
  const chi2 = counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
  // df = 35, Schwelle 80 liegt bei p < 0.0001: ein zufaelliger Fehlalarm ist sehr unwahrscheinlich.
  assert.ok(chi2 < 80, 'Chi-Quadrat zu gross: ' + chi2.toFixed(1));
});

test('Pruefung nach der Runde: ehrlicher Deal besteht', async () => {
  const S = hex(V.round_4_players.S_r);
  const seeds = V.round_4_players.deal.seeds.map(hex);
  const res = await F.dealRound(RID, 3, 4, seeds, S);
  const out = await F.verifyRound({
    rid: RID, r: 3, n: 4,
    commits: V.round_4_players.commits.map(hex),
    revealed: seeds,
    S_r: S,
    prevLink: await F.sha256(S),
    dealtHands: res.hands,
  });
  assert.equal(out.ok, true, out.problems.join('; '));
});

test('Pruefung nach der Runde: getauschte Hand fällt auf', async () => {
  const S = hex(V.round_4_players.S_r);
  const seeds = V.round_4_players.deal.seeds.map(hex);
  const res = await F.dealRound(RID, 3, 4, seeds, S);
  const hands = res.hands.map((h) => h.slice());
  const a = hands[0][0], b = hands[1][0];
  hands[0][0] = b; hands[1][0] = a;
  const out = await F.verifyRound({
    rid: RID, r: 3, n: 4,
    commits: V.round_4_players.commits.map(hex),
    revealed: seeds, S_r: S, prevLink: await F.sha256(S),
    dealtHands: hands,
  });
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.includes('Hand')));
});

test('Pruefung nach der Runde: Seed passt nicht zum Commit, Server hat ihn ersetzt', async () => {
  const S = hex(V.round_4_players.S_r);
  const seeds = V.round_4_players.deal.seeds.map(hex);
  const res = await F.dealRound(RID, 3, 4, seeds, S);
  const fake = seeds.slice();
  fake[2] = Uint8Array.from({ length: 32 }, () => 77);
  const out = await F.verifyRound({
    rid: RID, r: 3, n: 4,
    commits: V.round_4_players.commits.map(hex),
    revealed: fake, S_r: S, prevLink: await F.sha256(S),
    dealtHands: res.hands,
  });
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.includes('Sitz 2')));
});

test('Karten: Index und Karte passen zueinander', () => {
  for (let k = 0; k < 36; k++) {
    const c = F.cardOf(k);
    assert.equal(F.cardIndex(c.s, c.r), k);
  }
  assert.deepEqual(F.cardOf(0), { s: 'R', r: '6' });
  assert.deepEqual(F.cardOf(35), { s: 'E', r: 'A' });
});

test('Eingaben werden geprueft: falsche Spielerzahl und falsche Zahlen werfen Fehler', async () => {
  await assert.rejects(F.dealRound(RID, 1, 2, [null, null], new Uint8Array(32)));
  assert.throws(() => F.u32be(-1));
  assert.throws(() => F.u8(256));
});
