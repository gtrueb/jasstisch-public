'use strict';
/*
 * Spiel mit verdeckten Händen gegen das Spiel mit offenen Händen.
 *
 * Engine A: Host-Sicht. Fremde Plätze haben nur Platzhalter, die Karten kommen über das Kartenschloss.
 * Engine B: gleiche Karten, alle offen (Klartext), wie im Offline-Spiel.
 * Beide bekommen dieselbe Partie. Nach jedem Schritt müssen Stand, Stiche, Weisen und Punkte gleich sein.
 * Außerdem: der Host hält nie eine fremde Karte im Klartext.
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../js/mental.js');
const MR = require('../js/mental-round.js');
const R = require('../js/rules.js');
const SchieberMod = require('../js/game.js');
const MolotovMod = require('../js/molotov.js');

const tick = () => new Promise((r) => setImmediate(r));
async function settle(pred, max) {
  for (let i = 0; i < (max || 20000); i++) {
    if (pred()) return true;
    await tick();
  }
  return pred();
}
const syncSched = (fn) => { setImmediate(fn); return 0; };

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

function cardById(id) { return R.makeDeck().find((c) => c.id === id); }

function snap(e) {
  return {
    phase: e.phase,
    trickNo: e.trickNo,
    turn: e.phase === 'play' ? e.turnSeat() : null,
    trump: e.trump,
    plays: e.plays.map((p) => p.card.id + '@' + p.seat),
    totals: JSON.stringify(e.totals),
    rounds: e.history.length,
    weis: e.weisAnn.map((a) => a.seat + ':' + a.total.pts).join(','),
    hold: !!e.hold
  };
}

function assertNoLeak(e, remoteSeats) {
  for (const s of remoteSeats) {
    for (const h of e.hands[s]) {
      assert.strictEqual(h.remote, true, 'Platz ' + s + ' ist ein Platzhalter');
      assert.ok(!('s' in h) && !('r' in h) && !('id' in h), 'keine Kartenangabe bei Platz ' + s);
    }
  }
}

// Eine Partie mit zwei Engines. gtype: 'schieber' (4 Plätze) oder 'molotov' (3 oder 4 Plätze).
async function drive(opts) {
  const { gtype, n, remoteSeats, rounds } = opts;
  const Game = gtype === 'schieber' ? SchieberMod.Game : MolotovMod.Game;
  const humanSeats = [];
  for (let s = 0; s < n; s++) humanSeats.push(s);

  const clients = {};
  remoteSeats.forEach((s) => { clients[s] = new MR.ClientSeat(s, n); });
  let round = null, truthRid = null, truthHands = null, truthS7 = null;
  const pairAtSuit = {};     // Platz -> hat K und O der aktuellen Trumpffarbe (zu Beginn der Trumpfphase)

  const remoteHooks = {
    dealHook(engine, rid) {
      const seats = [];
      for (let s = 0; s < n; s++) {
        if (remoteSeats.indexOf(s) >= 0) {
          seats.push({ ask: async (msg) => { try { return await clients[s].handle(msg); } catch (e) { return { err: e.message }; } } });
        } else {
          seats.push({ local: new M.Player(s, n) });
        }
      }
      round = new MR.Round(n, seats);
      (async () => {
        await round.begin();
        const { hands, s7 } = await round.deal();
        // Testdaten: jeder Platz kennt seine eigenen Karten (Host-Sicht bleibt unangetastet).
        truthHands = [];
        for (let s = 0; s < n; s++) {
          if (remoteSeats.indexOf(s) >= 0) {
            truthHands[s] = Object.keys(clients[s].player.cards).map((p) => cardById(R.makeDeck()[clients[s].player.cards[p]].id));
          } else {
            truthHands[s] = hands[s];
          }
        }
        truthS7 = s7;
        truthRid = rid;
        engine.setDealt(hands, { s7 }, rid);
      })().catch((err) => engine.abortRound('Test: ' + err.message));
    },
    revealCards(seat, positions) { return round.reveal(seat, positions); }
  };

  let plainRid = null;
  const plainHooks = { dealHook(engine, rid) { plainRid = rid; } };

  // Jede Engine bekommt ihren eigenen, gleich gesäten Zufallsgenerator (Kartengeber, Vorhand).
  const cfgBase = { players: n, humanSeats, sched: syncSched };
  if (gtype === 'schieber') Object.assign(cfgBase, { target: 100000, weis: true, stoeck: true });
  else Object.assign(cfgBase, { end: 'rounds', rounds: rounds, weis: true, stoeck: true });

  const A = new Game(Object.assign({}, cfgBase, { rnd: seeded(20250101), remoteSeats, dealHook: remoteHooks.dealHook, revealCards: remoteHooks.revealCards }));
  const B = new Game(Object.assign({}, cfgBase, { rnd: seeded(20250101), dealHook: plainHooks.dealHook }));

  A.startRound();
  B.startRound();

  const trumpSuit = 'R';
  const remote = (s) => remoteSeats.indexOf(s) >= 0;
  const posOf = (seat, id) => {
    const cards = clients[seat].player.cards;
    const p = Object.keys(cards).find((x) => R.makeDeck()[cards[x]].id === id);
    return Number(p);
  };
  const koCount = {};
  let steps = 0, lastCmp = null;

  async function settleBoth() {
    await settle(() => !A.pending && !B.pending && A.pendingAct.every((x) => !x) && B.pendingAct.every((x) => !x), 200000);
  }

  async function compare(label) {
    await settleBoth();
    assertNoLeak(A, remoteSeats);
    const a = snap(A), b = snap(B);
    assert.deepStrictEqual(a, b, 'Abweichung nach: ' + label);
    lastCmp = label;
  }

  while (steps++ < 20000) {
    await tick();
    if (plainRid !== null && B.phase === 'dealing' && truthRid === plainRid && A.roundId === plainRid && A.phase !== 'dealing') {
      B.setDealt(truthHands.map((h) => h.map((c) => Object.assign({}, c))), { s7: truthS7 }, plainRid);
      plainRid = null;
      await compare('Verteilung');
      continue;
    }
    if (A.phase === 'dealing' || B.phase === 'dealing' || A.phase === 'aborted') continue;
    if (A.phase === 'roundEnd' || A.phase === 'gameEnd') {
      if (A.history.length >= rounds || A.phase === 'gameEnd') break;
      for (const k of Object.keys(koCount)) delete koCount[k];   // Stöck-Zählung je Runde
      A.act(0, { type: 'next' });
      B.act(0, { type: 'next' });
      await compare('nächste Runde');
      continue;
    }
    if (A.hold) {
      A.releaseHold();
      B.releaseHold();
      await compare('Weiter nach Stich 1');
      continue;
    }
    if (A.phase === 'trump') {
      const c = A.chooser;
      // Neue Runde: die Stöck-Zählung beginnt von vorn (wie in der Engine und im Gerät)
      for (const k of Object.keys(koCount)) delete koCount[k];
      A.act(c, { type: 'trump', suit: trumpSuit });
      B.act(c, { type: 'trump', suit: trumpSuit });
      // Zu Beginn der Trumpfphase hält jeder Platz noch alle Karten.
      for (let s = 0; s < n; s++) {
        pairAtSuit[s] = truthHands[s].some((x) => x.s === trumpSuit && x.r === 'K') && truthHands[s].some((x) => x.s === trumpSuit && x.r === 'O');
      }
      await compare('Trumpf');
      continue;
    }
    if (A.phase !== 'play' || A.pending) continue;
    const seat = A.turnSeat();
    if (seat === null || A.pendingAct[seat]) continue;

    // Weis im ersten Stich
    if (A.trickNo === 0 && !A.weisDecided[seat] && A.cfg.weis) {
      const hand = truthHands[seat];
      const best = R.bestWeis(hand);
      if (best) {
        const total = R.weisTotal(hand);
        const ids = new Set(best.cards.concat(total.cards).map((c) => c.id));
        const cardsW = hand.filter((c) => ids.has(c.id));
        if (remote(seat)) {
          // Wie in der Oberfläche: das Gerät gibt die Weis-Karten selbst frei, dann wird angefragt.
          const wp = cardsW.map((c) => posOf(seat, c.id));
          clients[seat].allow(wp);
          const ok = A.requestWeis(seat, wp);
          assert.ok(ok, 'Weis wird angenommen');
          await settle(() => !A.pendingAct[seat]);
        } else {
          A.act(seat, { type: 'weis' });
        }
        B.act(seat, { type: 'weis' });
        await compare('Weis Platz ' + seat);
        continue;
      }
      // Kein Weis: die Ansage nicht melden, nur verhindern, dass der Platz später auf Weis wartet.
    }

    // Karte wählen: die kleinste erlaubte Karte nach Namen (deterministisch)
    const hand = truthHands[seat];
    const legal = (gtype === 'schieber'
      ? R.legalCards(hand, A.plays, A.trump)
      : R.legalFree(hand, A.plays)).slice().sort((x, y) => (x.id < y.id ? -1 : 1));
    const card = legal[0];

    truthHands[seat] = hand.filter((c) => c.id !== card.id);

    if (remote(seat)) {
      // Wie in der Oberfläche: das Gerät gibt die gewählte Karte frei, dann wird angefragt.
      clients[seat].allow([posOf(seat, card.id)]);
      const ok = A.requestPlay(seat, posOf(seat, card.id));
      assert.ok(ok, 'Zug wird angenommen');
      await settle(() => !A.pendingAct[seat]);
    } else {
      assert.ok(A.act(seat, { type: 'card', id: card.id }), 'lokaler Zug');
    }
    assert.ok(B.act(seat, { type: 'card', id: card.id }), 'Zug in der offenen Partie');
    await compare('Karte ' + card.id + ' von Platz ' + seat);
  }

  assert.strictEqual(A.history.length, rounds, 'alle Runden gespielt');
  assert.strictEqual(JSON.stringify(A.history), JSON.stringify(B.history), 'Rundenwertung gleich');
  assert.ok(lastCmp, 'es wurde verglichen');
  return { A, B, rounds };
}

test('Schieber: verdeckte Partie (2 Runden) gleicht der offenen Partie in jedem Schritt', { timeout: 600000 }, async () => {
  const { A } = await drive({ gtype: 'schieber', n: 4, remoteSeats: [1, 2, 3], rounds: 2 });
  assert.strictEqual(A.history[0].score.card.length, 2);
  // Jede Runde hat 36 Karten, alle gespielt
  assert.strictEqual(A.history.length, 2);
});

test('Molotow (3 Spieler): verdeckte Partie (1 Runde) gleicht der offenen Partie', { timeout: 600000 }, async () => {
  const { A } = await drive({ gtype: 'molotov', n: 3, remoteSeats: [1, 2], rounds: 1 });
  assert.strictEqual(A.history.length, 1);
});

test('Molotow (4 Spieler): verdeckte Partie (1 Runde) gleicht der offenen Partie', { timeout: 600000 }, async () => {
  const { A } = await drive({ gtype: 'molotov', n: 4, remoteSeats: [1, 2, 3], rounds: 1 });
  assert.strictEqual(A.history.length, 1);
});

test('Ungültige Anfragen eines Mitspielers werden abgelehnt', { timeout: 120000 }, async () => {
  const n = 4, remoteSeats = [1, 2, 3];
  const clients = {};
  remoteSeats.forEach((s) => { clients[s] = new MR.ClientSeat(s, n); });
  let round = null;
  const A = new SchieberMod.Game({
    humanSeats: [0, 1, 2, 3], remoteSeats, sched: syncSched, rnd: seeded(7), target: 100000,
    dealHook(engine, rid) {
      const seats = [0, 1, 2, 3].map((s) => (remoteSeats.indexOf(s) >= 0
        ? { ask: async (msg) => { try { return await clients[s].handle(msg); } catch (e) { return { err: e.message }; } } }
        : { local: new M.Player(s, n) }));
      round = new MR.Round(n, seats);
      (async () => { await round.begin(); const r = await round.deal(); engine.setDealt(r.hands, { s7: r.s7 }, rid); })();
    },
    revealCards: (seat, positions) => round.reveal(seat, positions)
  });
  A.startRound();
  await settle(() => A.phase === 'trump');
  // Trumpf wählen, damit Karten gespielt werden können
  A.act(A.chooser, { type: 'trump', suit: 'E' });
  await settle(() => A.phase === 'play' && A.turnSeat() !== null);
  const seat = A.turnSeat();
  if (remoteSeats.indexOf(seat) < 0) {
    // Platz 0 ist dran: ein fremder Platz kann nicht jetzt spielen
    assert.strictEqual(A.requestPlay(1, 1), false, 'fremder Platz ist nicht am Zug');
    return;
  }
  // Eine Position, die nicht dem Platz gehört, wird abgelehnt
  const foreign = [0, 1, 2, 3].map((x) => x).find((x) => x % 4 !== seat);
  assert.strictEqual(A.requestPlay(seat, foreign), false, 'fremde Position abgelehnt');
  // Gültige Position: das Gerät gibt sie frei, dann wird angenommen
  const pos = A.hands[seat][0].pos;
  clients[seat].allow([pos]);
  assert.strictEqual(A.requestPlay(seat, pos), true);
  // Während der Anfrage kein zweiter Zug
  assert.strictEqual(A.requestPlay(seat, pos), false, 'kein doppelter Zug');
  await settle(() => !A.pendingAct[seat]);
  assert.strictEqual(A.plays.length, 1, 'genau ein Zug');
  // Weis mit doppelter Position: abgelehnt (sonst würde eine Karte als Vierling zählen)
  const weisSeat = A.turnSeat();
  if (remoteSeats.indexOf(weisSeat) >= 0 && A.trickNo === 0) {
    const p2 = A.hands[weisSeat][0].pos;
    assert.strictEqual(A.requestWeis(weisSeat, [p2, p2, p2, p2]), false, 'doppelte Weis-Karte abgelehnt');
  }
});

test('Abbruch: eine Runde wird abgebrochen, veraltete Antworten werden verworfen', { timeout: 120000 }, async () => {
  const n = 4, remoteSeats = [1, 2, 3];
  const clients = {};
  remoteSeats.forEach((s) => { clients[s] = new MR.ClientSeat(s, n); });
  let round = null;
  let releaseReveal = null;
  const A = new SchieberMod.Game({
    humanSeats: [0, 1, 2, 3], remoteSeats, sched: syncSched, rnd: seeded(9), target: 100000,
    dealHook(engine, rid) {
      const seats = [0, 1, 2, 3].map((s) => (remoteSeats.indexOf(s) >= 0
        ? { ask: async (msg) => { try { return await clients[s].handle(msg); } catch (e) { return { err: e.message }; } } }
        : { local: new M.Player(s, n) }));
      round = new MR.Round(n, seats);
      (async () => { await round.begin(); const r = await round.deal(); engine.setDealt(r.hands, { s7: r.s7 }, rid); })();
    },
    // Aufdecken hält an, bis wir es freigeben: so kommt die Antwort "zu spät".
    revealCards: (seat, positions) => new Promise((resolve, reject) => {
      releaseReveal = () => round.reveal(seat, positions).then(resolve, reject);
    })
  });
  A.startRound();
  await settle(() => A.phase === 'trump');
  A.act(A.chooser, { type: 'trump', suit: 'R' });
  await settle(() => A.phase === 'play' && A.turnSeat() !== null);
  let seat = A.turnSeat();
  if (remoteSeats.indexOf(seat) < 0) {
    // Platz 0 spielt zuerst: wir spielen für ihn und warten auf den nächsten Remote-Zug
    const card = A.hands[0].find(() => true);
    A.act(0, { type: 'card', id: card.id });
    await settle(() => A.phase === 'play' && A.turnSeat() !== null && remoteSeats.indexOf(A.turnSeat()) >= 0);
    seat = A.turnSeat();
  }
  const roundBefore = A.roundNo, roundIdBefore = A.roundId;
  const pos = A.hands[seat][0].pos;
  A.requestPlay(seat, pos);
  // Die Runde wird abgebrochen, während die Anfrage noch offen ist.
  A.abortRound('Test-Abbruch');
  assert.strictEqual(A.phase, 'aborted');
  assert.strictEqual(A.roundId > roundIdBefore, true);
  // Jetzt die alte Antwort noch liefern: sie darf nichts ändern.
  const playsBefore = A.plays.length;
  releaseReveal();
  await tick(); await tick();
  assert.strictEqual(A.plays.length, playsBefore, 'alte Antwort ignoriert');
  // Nach dem Abbruch startet eine neue Runde mit derselben Rundennummer
  await settle(() => A.phase === 'dealing' || A.phase === 'deal' || A.phase === 'trump', 200000);
  assert.strictEqual(A.roundNo, roundBefore, 'Runde wird wiederholt, Zähler stimmt');
});
