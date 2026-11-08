// Tests für die Jass-Regeln. Start: node --test tests/rules.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../js/rules.js');
const AIS = require('../js/ai-schieber.js');
const AI = AIS.createPlayer();
const { Game } = require('../js/game.js');

const c = (s, r) => ({ s, r, id: s + r });
const ids = (cards) => cards.map((x) => x.id).sort();

test('deck has 36 cards and 152 card points', () => {
  const d = R.makeDeck();
  assert.equal(d.length, 36);
  let plain = 0, trump = 0;
  d.forEach((x) => { plain += R.cardPoints(x, 'X'); trump += R.cardPoints(x, x.s === 'R' ? 'R' : 'X'); });
  // Summe über alle Karten bei Trumpf Rosen: 62 (Trumpffarbe) + 3 * 30
  assert.equal(trump, 152);
});

test('trick winner: trump beats led suit, buur beats 9 in trump', () => {
  const plays = [
    { seat: 0, card: c('E', 'A') },
    { seat: 1, card: c('R', '6') }, // Trumpf
    { seat: 2, card: c('R', 'U') }, // Buur
    { seat: 3, card: c('R', '9') },
  ];
  assert.equal(R.winnerIndex(plays, 'R'), 2);
});

test('plain suit: highest of led suit wins, off-suit ignored', () => {
  const plays = [
    { seat: 0, card: c('E', '10') },
    { seat: 1, card: c('S', 'A') },
    { seat: 2, card: c('E', 'K') },
    { seat: 3, card: c('E', '9') },
  ];
  assert.equal(R.winnerIndex(plays, 'R'), 2);
});

test('must follow suit when able (plain led)', () => {
  const hand = [c('E', '7'), c('S', 'A'), c('L', 'K')];
  const plays = [{ seat: 0, card: c('E', 'A') }];
  assert.deepEqual(ids(R.legalCards(hand, plays, 'R')), ids([c('E', '7')]));
});

test('free choice when neither led suit nor trump', () => {
  const hand = [c('S', 'A'), c('L', 'K')];
  const plays = [{ seat: 0, card: c('E', 'A') }];
  assert.equal(R.legalCards(hand, plays, 'R').length, 2);
});

test('Stechzwang: no led suit, has trump -> must trump', () => {
  const hand = [c('S', 'A'), c('R', '7')];
  const plays = [{ seat: 0, card: c('E', 'A') }];
  assert.deepEqual(ids(R.legalCards(hand, plays, 'R')), ids([c('R', '7')]));
});

test('Untertrumpfen verboten: must play plain if cannot overtrump', () => {
  const hand = [c('R', '7'), c('S', 'A')];
  const plays = [{ seat: 0, card: c('E', 'A') }, { seat: 1, card: c('R', 'K') }];
  // Rosen K ist Trumpf; Rosen 7 kann nicht überbieten -> nur Nicht-Trumpf
  assert.deepEqual(ids(R.legalCards(hand, plays, 'R')), ids([c('S', 'A')]));
});

test('overtrump is mandatory when possible', () => {
  const hand = [c('R', 'O'), c('R', '7'), c('S', 'A')];
  const plays = [{ seat: 0, card: c('R', '10') }];
  // Trumpf wurde ausgespielt (10), Ober schlägt 10 -> nur Ober (und Trumpf-Karten, die schlagen)
  assert.deepEqual(ids(R.legalCards(hand, plays, 'R')), ids([c('R', 'O')]));
});

test('trump led: only trumps when able; buur-exception', () => {
  const hand = [c('R', 'U'), c('S', 'A'), c('E', '7')];
  const plays = [{ seat: 0, card: c('R', '6') }];
  // Buur ist einzige Trumpfkarte -> Ausnahme: alles erlaubt
  assert.equal(R.legalCards(hand, plays, 'R').length, 3);
  const hand2 = [c('R', 'U'), c('R', '7'), c('S', 'A')];
  assert.equal(R.legalCards(hand2, plays, 'R').length, 2); // Buur und Rosen 7 müssen gespielt werden
});

test('melds: sequence 3/4/5 and split of long run', () => {
  assert.equal(R.bestMelds([c('R', 'K'), c('R', 'O'), c('R', 'U')]).pts, 20);
  assert.equal(R.bestMelds([c('R', 'A'), c('R', 'K'), c('R', 'O'), c('R', 'U')]).pts, 50);
  assert.equal(R.bestMelds([c('R', 'A'), c('R', 'K'), c('R', 'O'), c('R', 'U'), c('R', '10')]).pts, 100);
  // 8 Karten in Folge: 5er (100) + 3er (20) = 120
  const run8 = ['6', '7', '8', '9', '10', 'U', 'O', 'K'].map((r) => c('R', r));
  assert.equal(R.bestMelds(run8).pts, 120);
});

test('melds: four of a kind values', () => {
  const four = (r) => ['R', 'S', 'L', 'E'].map((s) => c(s, r));
  assert.equal(R.bestMelds(four('U')).pts, 200);
  assert.equal(R.bestMelds(four('9')).pts, 150);
  assert.equal(R.bestMelds(four('A')).pts, 100);
  assert.equal(R.bestMelds(four('8')).pts, 0);
});

test('melds: card used only once (four + sequence overlap)', () => {
  // 4x Ober + Rosen K,U: Rosen Ober wird nur einmal gezählt (Vier Gleiche = 100, keine Folge möglich)
  const hand = [c('R', 'O'), c('S', 'O'), c('L', 'O'), c('E', 'O'), c('R', 'K'), c('R', 'U')];
  const best = R.bestMelds(hand);
  const used = best.melds.flatMap((m) => m.cards.map((x) => x.id));
  assert.equal(new Set(used).size, used.length);
  assert.equal(best.pts, 100);
  // Mit Rosen O, K, U, 10 und 4x Ober: Folge (20/50) nutzt Rosen O nicht doppelt
  const hand2 = [c('R', 'O'), c('S', 'O'), c('L', 'O'), c('E', 'O'), c('R', 'K'), c('R', 'U'), c('R', '10')];
  const best2 = R.bestMelds(hand2);
  const used2 = best2.melds.flatMap((m) => m.cards.map((x) => x.id));
  assert.equal(new Set(used2).size, used2.length);
  assert.equal(best2.pts, 100); // 4x Ober (100) gewinnt gegen Rosen Folge ohne Ober
});

test('weis: best Weis ranking: Vierling > 5-Blatt > 4-Blatt > 2x3 > 3-Blatt', () => {
  const four = (r) => ['R', 'S', 'L', 'E'].map((s) => c(s, r));
  const cls = (h) => R.bestWeis(h).cls;
  assert.equal(cls([c('R', 'K'), c('R', 'O'), c('R', 'U'), c('R', '10'), c('R', '9')]), 4); // 5-Blatt
  assert.equal(R.bestWeis(four('6')), null); // Vier Sechser zählen nicht
  const v = R.bestWeis(four('A'));
  assert.equal(v.cls, 5); // Vierling
  // 4-Blatt + 3-Blatt: nur das 4-Blatt zählt
  const h43 = [c('R', 'K'), c('R', 'O'), c('R', 'U'), c('R', '10'), c('S', 'A'), c('S', 'K'), c('S', 'O')];
  assert.equal(R.bestWeis(h43).cls, 3);
  assert.equal(R.bestWeis(h43).pts, 50);
  // zwei 3-Blatt
  const h2x3 = [c('R', 'K'), c('R', 'O'), c('R', 'U'), c('S', '7'), c('S', '8'), c('S', '9')];
  assert.equal(R.bestWeis(h2x3).cls, 2);
  assert.equal(R.bestWeis(h2x3).pts, 40);
  // einzelnes 3-Blatt
  assert.equal(R.bestWeis([c('R', '7'), c('R', '8'), c('R', '9')]).cls, 1);
  assert.equal(R.bestWeis([c('R', '7'), c('S', '8')]), null);
});

test('weis: same class -> higher top card wins (7-8-9 beats 6-7-8)', () => {
  const a = { seat: 0, order: 1, best: R.bestWeis([c('R', '7'), c('R', '8'), c('R', '9')]) };
  const b = { seat: 1, order: 2, best: R.bestWeis([c('S', '6'), c('S', '7'), c('S', '8')]) };
  assert.equal(R.resolveWeisAnn([a, b]).seat, 0);
  assert.equal(R.resolveWeisAnn([b, a]).seat, 0);
});

test('weis: same cards -> first announcer wins', () => {
  const best = R.bestWeis([c('R', '7'), c('R', '8'), c('R', '9')]);
  const first = { seat: 2, order: 1, best };
  const second = { seat: 3, order: 2, best: R.bestWeis([c('S', '7'), c('S', '8'), c('S', '9')]) };
  assert.equal(R.resolveWeisAnn([second, first]).seat, 2);
});

test('weis: higher class beats higher top card', () => {
  const fourBlatt = { seat: 0, order: 2, best: R.bestWeis([c('R', '6'), c('R', '7'), c('R', '8'), c('R', '9')]) };
  const threeBlatt = { seat: 1, order: 1, best: R.bestWeis([c('S', 'A'), c('S', 'K'), c('S', 'O')]) };
  assert.equal(R.resolveWeisAnn([threeBlatt, fourBlatt]).seat, 0);
});

test('obenabe: card points sum to 152 without trump', () => {
  const sum = R.makeDeck().reduce((a, x) => a + R.cardPoints(x, null), 0);
  assert.equal(sum, 152);
});

test('round score: 157 base, last trick bonus, schilten doubles', () => {
  // Alle Karten in 9 Stichen verteilen
  const deck = R.makeDeck();
  const tricks = [];
  for (let i = 0; i < 9; i++) tricks.push(deck.slice(i * 4, i * 4 + 4));
  const team0 = tricks.filter((_, i) => i % 2 === 0);
  const team1 = tricks.filter((_, i) => i % 2 === 1);
  const base = R.roundScore([team0, team1], 0, { trump: 'R', weis: [0, 0], stoeck: [0, 0] });
  assert.equal(base.card[0] + base.card[1], 157);
  const dbl = R.roundScore([team0, team1], 0, { trump: 'L', doubled: true, weis: [0, 0], stoeck: [0, 0] });
  assert.equal(dbl.total[0] + dbl.total[1], 314);
});

test('AI trump: schieben when weak and allowed', () => {
  const weak = [c('R', '6'), c('S', '7'), c('L', '8'), c('E', '6'), c('R', '7'), c('S', '8'), c('L', '7'), c('E', '7'), c('R', '8')];
  assert.equal(AI.chooseTrump(weak, { canSchieben: true }).action, 'schieben');
  assert.equal(AI.chooseTrump(weak, { canSchieben: false }).action, 'choose');
});

function seededRnd(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

test('full AI games finish: 9 tricks per round, every card played once', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const game = new Game({
      target: 1000,
      rnd: seededRnd(seed),
      sched: (fn) => fn(), // sofortige Ausführung, keine Wartezeit
      delays: {},
      schellen7: seed % 2 === 0,
      matchBonus: seed % 3 === 0
    });
    game.humanSeat = -1; // alle Sitze sind KI
    game.startRound();
    let guard = 0;
    while (game.phase !== 'gameEnd' && guard++ < 500) {
      if (game.phase === 'roundEnd') {
        // Karten-Erhaltung: 9 Stiche, 36 verschiedene Karten
        const won = game.wonTricks;
        assert.equal(won[0].length + won[1].length, 9, 'trick count');
        const ids = new Set(won.flat().flat().map((x) => x.id));
        assert.equal(ids.size, 36, 'every card played once');
        game.nextRound();
      } else break;
    }
    assert.equal(game.phase, 'gameEnd', 'seed ' + seed + ' did not finish, phase=' + game.phase);
    assert.ok(game.gameWinner === 0 || game.gameWinner === 1);
    assert.ok(Math.max(game.totals[0], game.totals[1]) >= 1000);
    game.history.forEach((h) => {
      const base = h.score.factor === 2 ? 314 : 157;
      const sumCard = h.score.card[0] + h.score.card[1];
      assert.equal(sumCard, 157, 'card points per round must be 157');
      assert.ok(h.score.total[0] + h.score.total[1] >= base, 'round total too low');
    });
  }
});

test('human play rejects illegal cards and accepts legal ones', () => {
  const game = new Game({ target: 1000, rnd: () => 0.5, sched: () => {}, delays: {} });
  game.phase = 'play';
  game.trump = 'R';
  game.hands = [[], [], [], []];
  game.hands[0] = [c('E', 'A'), c('S', '7')];
  game.hands[1] = [c('E', 'K')];
  game.hands[2] = [c('E', '6')];
  game.hands[3] = [c('E', '8')];
  game.leader = 0;
  game.plays = [];
  game.trickNo = 1;
  game.weisShown = true;
  assert.equal(game.humanPlay('E7'), false);        // nicht in der Hand
  assert.equal(game.humanPlay('S7'), true);         // Führung: alles erlaubt
  assert.equal(game.hands[0].some((x) => x.id === 'S7'), false); // Karte wurde gespielt

  // Legalitäts-Tor: Eichel wurde ausgespielt, Spieler hat Eichel-Ass -> Schellen-7 ist verboten
  const g2 = new Game({ target: 1000, rnd: () => 0.5, sched: () => {}, delays: {} });
  g2.phase = 'play';
  g2.trump = 'R';
  g2.hands = [[c('E', 'A'), c('S', '7')], [], [], []];
  g2.leader = 3;
  g2.plays = [{ seat: 3, card: c('E', 'K') }];
  g2.trickNo = 1;
  g2.weisShown = true;
  assert.equal(g2.turnSeat(), 0);
  assert.equal(g2.humanPlay('S7'), false);          // Farbzwang verletzt
  assert.equal(g2.humanPlay('EA'), true);           // Eichel bedienen ist erlaubt
});
