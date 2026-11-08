'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/mental.js');
const MR = require('../js/mental-round.js');
const R = require('../js/rules.js');

// Baut eine Runde: Platz 0 ist lokal (Host), alle anderen sind Mitspieler mit eigenem Gerät.
// tamper[s](msg, reply) darf die Antwort von Platz s verfälschen (für Betrugstests).
// autoAllow (Standard): das Gerät gibt die angefragten Karten frei, als hätte der Spieler sie gespielt.
// autoAllow: false prüft, dass das Gerät ungefragte Karten verweigert.
function makeTable(n, opts) {
  opts = opts || {};
  const autoAllow = opts.autoAllow !== false;
  const seats = [];
  const clients = [];
  const log = [];
  for (let s = 0; s < n; s++) {
    if (s === 0) {
      seats.push({ local: new M.Player(0, n) });
      clients.push(null);
      continue;
    }
    const client = new MR.ClientSeat(s, n);
    clients.push(client);
    seats.push({
      ask: async (msg) => {
        log.push({ seat: s, op: msg.op });
        if (autoAllow && msg.op === 'reveal') client.allow(msg.pos);
        let reply;
        try {
          reply = await client.handle(msg);
        } catch (e) {
          reply = { err: e.message };
        }
        if (opts.tamper && opts.tamper[s]) reply = await opts.tamper[s](msg, reply, client);
        return reply;
      }
    });
  }
  return { round: new MR.Round(n, seats), seats, clients, log };
}

function cardIds(cards) { return cards.map((c) => c.id).sort(); }
function fullDeckIds() { return R.makeDeck().map((c) => c.id).sort(); }

test('Runde mit 4 Plätzen: jeder bekommt 9 Karten, zusammen alle 36', async () => {
  const { round } = makeTable(4);
  await round.begin();
  const { hands, s7 } = await round.deal();
  assert.strictEqual(hands.length, 4);
  let all = [];
  for (let s = 0; s < 4; s++) {
    assert.strictEqual(hands[s].length, 9);
    if (s === 0) {
      all = all.concat(hands[s]);
    } else {
      hands[s].forEach((h) => { assert.strictEqual(h.remote, true); assert.strictEqual(h.seat, s); });
      const cards = await round.reveal(s, hands[s].map((h) => h.pos));
      all = all.concat(cards);
    }
  }
  assert.strictEqual(new Set(all.map((c) => c.id)).size, 36);
  assert.deepStrictEqual(cardIds(all), fullDeckIds());
  assert.strictEqual(s7.length, 4);
});

test('Der Host kennt vor dem Aufdecken keine Karte eines Mitspielers', async () => {
  const { round } = makeTable(4);
  await round.begin();
  const { hands, s7 } = await round.deal();
  for (let s = 1; s < 4; s++) {
    // Die Platzhalter tragen nur Positionen, keine Kartennamen.
    assert.ok(hands[s].every((h) => !('s' in h) && !('r' in h) && !('id' in h)));
  }
  // Offen liegt höchstens die Schellen-7 (die Regel verlangt, dass sie bekannt ist).
  assert.strictEqual(round.revealedCount(), s7.slice(1).some(Boolean) ? 1 : 0);
  // Die Hände der Mitspieler enthalten keinen Kartennamen (die eigene Hand des Hosts darf er sehen).
  const json = JSON.stringify(hands.slice(1));
  for (const card of R.makeDeck()) {
    assert.ok(json.indexOf('"' + card.id + '"') < 0, 'Karte ' + card.id + ' steht nicht im Host-Zustand');
  }
});

test('Mit 3 Plätzen: je 12 Karten und alle 36 vorhanden', async () => {
  const { round } = makeTable(3);
  await round.begin();
  const { hands } = await round.deal();
  let all = [];
  for (let s = 0; s < 3; s++) {
    assert.strictEqual(hands[s].length, 12);
    if (s === 0) all = all.concat(hands[s]);
    else all = all.concat(await round.reveal(s, hands[s].map((h) => h.pos)));
  }
  assert.deepStrictEqual(cardIds(all), fullDeckIds());
});

test('Karte spielen: Platz legt sie offen, Host prüft und merkt sie sich', async () => {
  const { round, log } = makeTable(4);
  await round.begin();
  const { hands } = await round.deal();
  const before = round.revealedCount();
  // Eine Karte, die noch verdeckt ist (die Schellen-7 kann schon offen liegen)
  const pos = hands[2].map((h) => h.pos).find((p) => round.cache[p] === undefined);
  const [card] = await round.reveal(2, [pos]);
  assert.ok(card.s && card.r && card.id);
  const logBefore = log.length;
  const [again] = await round.reveal(2, [pos]);
  assert.strictEqual(again.id, card.id);
  assert.strictEqual(log.length, logBefore, 'zweites Mal ohne neue Anfrage');
  assert.strictEqual(round.revealedCount(), before + 1);
});

test('Platz darf nur eigene Positionen öffnen', async () => {
  const { round } = makeTable(4);
  await round.begin();
  await round.deal();
  await assert.rejects(round.reveal(2, [1]), /gehört nicht zu diesem Platz/);
});

test('Betrug: doppelte Karte beim Mischen fällt spätestens beim Aufdecken auf (immer)', { timeout: 300000 }, async () => {
  // Die Kopie kann bei einem Mitspieler, bei einem anderen Mitspieler oder beim Host liegen.
  // Jeder dieser Fälle muss auffallen. Wir wiederholen, damit alle Lagen vorkommen.
  for (let attempt = 0; attempt < 6; attempt++) {
    const tamper = {
      1: async (msg, reply) => {
        if (msg.op !== 'shuffle') return reply;
        const list = reply.list.slice();
        list[5] = list[6];       // zwei gleiche verschlüsselte Karten
        return { list };
      }
    };
    const { round } = makeTable(4, { tamper });
    await round.begin();
    await assert.rejects(async () => {
      const { hands } = await round.deal();
      for (let s = 1; s < 4; s++) await round.reveal(s, hands[s].map((h) => h.pos));
    }, /doppelt|ungültig|Beweis/, 'Versuch ' + attempt);
  }
});

test('Host kennt die eigenen Kartennummern (für die Dublettenprüfung)', async () => {
  const { round } = makeTable(4);
  await round.begin();
  const { hands } = await round.deal();
  const known = Object.values(round.localKnown);
  assert.strictEqual(known.length, 9, 'neun eigene Karten');
  assert.strictEqual(new Set(known.map(String)).size, 9);
  // Die Positionen stimmen mit den eigenen Karten des Hosts überein
  const own = hands[0].map((c) => R.makeDeck().findIndex((d) => d.id === c.id));
  assert.strictEqual(new Set(own).size, 9);
  assert.ok(Object.keys(round.localKnown).every((k) => Number(round.localKnown[k]) % 4 === 0));
});

test('Betrug: zufälliger Wert statt Karte fällt bei der Verteilung auf', async () => {
  const tamper = {
    1: async (msg, reply) => {
      if (msg.op !== 'shuffle') return reply;
      const list = reply.list.slice();
      list[0] = M.toHex(M.modpow(M.G, 123456789n, M.P));  // gültige Gruppenzahl, aber keine Karte
      return { list };
    }
  };
  const { round } = makeTable(4, { tamper });
  await round.begin();
  await assert.rejects(round.deal(), /Karte ungültig/);
});

test('Betrug: falsche Karte mit falschem Beweis wird abgelehnt', async () => {
  let armed = false;
  const tamper = {
    2: async (msg, reply) => {
      if (!armed || msg.op !== 'reveal') return reply;
      const items = reply.items.slice();
      // Anderen Kartenwert anbieten, aber den echten Beweis lassen.
      items[0] = { m: M.toHex(M.encodeIndex(0)), proof: items[0].proof };
      return { items };
    }
  };
  const { round } = makeTable(4, { tamper });
  await round.begin();
  const { hands } = await round.deal();
  armed = true;
  const pos = hands[2].find((h) => !round.cache[h.pos] && round.cache[h.pos] !== 0).pos;
  await assert.rejects(round.reveal(2, [pos]), /Beweis/);
});

test('Betrug: Beweis aus einer anderen Position wird abgelehnt', async () => {
  let armed = false;
  const tamper = {
    3: async (msg, reply, client) => {
      if (!armed || msg.op !== 'reveal' || msg.pos.length !== 1) return reply;
      // Beweis für eine andere eigene Position verwenden.
      const other = client.player.mine.find((p) => p !== msg.pos[0]);
      const r2 = await client.player.revealOwn([other]);
      return { items: [{ m: M.toHex(r2[0].m), proof: M.proofToWire(r2[0].proof) }] };
    }
  };
  const { round } = makeTable(4, { tamper });
  await round.begin();
  const { hands } = await round.deal();
  armed = true;
  await assert.rejects(round.reveal(3, [hands[3][0].pos]), /Beweis|doppelt/);
});

test('Schellen-7: Angabe wird durch Aufdecken geprüft', async () => {
  // Wir suchen eine Runde, in der ein Mitspieler die Schellen-7 hat.
  for (let attempt = 0; attempt < 30; attempt++) {
    const { round } = makeTable(4);
    await round.begin();
    const { s7 } = await round.deal({ s7Check: true });
    const holder = s7.findIndex((x, i) => i > 0 && x);
    if (holder > 0) {
      assert.strictEqual(s7[holder], true);
      return;
    }
  }
  assert.fail('keine Runde mit Schellen-7 bei einem Mitspieler gefunden');
});

test('Schellen-7: falsche Angabe (Position ohne S7) wird abgelehnt', async () => {
  const tamper = {
    1: async (msg, reply, client) => {
      if (msg.op !== 'final') return reply;
      // Lügen: behaupten, eine andere Karte sei die Schellen-7.
      const p = client.player.mine[0];
      return { ok: true, s7: true, s7pos: p };
    }
  };
  let rejected = false;
  for (let attempt = 0; attempt < 5 && !rejected; attempt++) {
    const { round } = makeTable(4, { tamper });
    await round.begin();
    try {
      await round.deal({ s7Check: true });
    } catch (e) {
      rejected = /Schellen-7/.test(e.message);
    }
  }
  assert.ok(rejected, 'falsche Schellen-7-Angabe wird in den meisten Runden sofort erkannt');
});

test('Nur lokale Plätze (kein Netz) funktionieren auch', async () => {
  const n = 4;
  const seats = [0, 1, 2, 3].map((s) => ({ local: new M.Player(s, n) }));
  const round = new MR.Round(n, seats);
  await round.begin();
  const { hands } = await round.deal();
  const all = hands.reduce((acc, h) => acc.concat(h), []);
  assert.deepStrictEqual(cardIds(all), fullDeckIds());
});

test('Ungültiger Schlüssel eines Mitspielers wird beim Start abgelehnt', async () => {
  const tamper = {
    1: async (msg, reply) => {
      if (msg.op !== 'begin') return reply;
      return { h: '1' };   // 1 ist kein Element der Gruppe
    }
  };
  const { round } = makeTable(4, { tamper });
  await assert.rejects(round.begin(), /Schlüssel/);
});

test('Gerät gibt nur angefragte Karten frei: ungefragte Aufdeck-Anfrage wird verweigert', async () => {
  const { round, clients } = makeTable(4, { autoAllow: false });
  await round.begin();
  const { hands } = await round.deal();
  // Ein modifizierter Host fragt alle 9 Karten eines Mitspielers ab, ohne dass gespielt wird.
  const all = hands[2].map((h) => h.pos);
  await assert.rejects(round.reveal(2, all), /Nicht angefragt/);
  assert.strictEqual(round.revealedCount(), 0, 'nichts offen gelegt');
  // Erst wenn das Gerät die Karte angekündigt hat, wird sie offen gelegt.
  clients[2].allow([all[0]]);
  const [card] = await round.reveal(2, [all[0]]);
  assert.ok(card.id);
  // Danach ist die Freigabe verbraucht: dieselbe Karte nicht noch einmal.
  assert.strictEqual(round.revealedCount(), 1);
});

test('Schellen-7 wird ohne eingeschaltete Regel nicht offen gelegt', async () => {
  // Ohne s7Check (Standard) darf der Host die Schellen-7 nicht aufdecken: keine Information.
  for (let attempt = 0; attempt < 10; attempt++) {
    const { round } = makeTable(4, { autoAllow: false });
    await round.begin();
    const { s7 } = await round.deal();
    assert.deepStrictEqual(s7, [false, false, false, false]);
    assert.strictEqual(round.revealedCount(), 0);
  }
});

test('Doppelte Positionen in einer Aufdeck-Anfrage werden abgelehnt', async () => {
  const { round } = makeTable(4);
  await round.begin();
  const { hands } = await round.deal();
  const p = hands[1][0].pos;
  await assert.rejects(round.reveal(1, [p, p]), /Doppelte/);
});
