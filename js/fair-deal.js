/*
 * Faires Mischen nach Umbauplan v3 und v4 (K1, K2, K8).
 * Reine Funktionen ohne Netzwerk. Laufen im Browser und in Node gleich.
 *
 * Bausteine:
 *  - Zufallskette pro Partie: s_{k-1} = SHA-256(s_k). Runde r nutzt S_r = s_r.
 *  - Spieler-Commit: C_i = SHA-256("cli-commit-v1" || rid || u32be(r) || u8(i) || c_i).
 *  - Deal-Schluessel: K = SHA-256("deal-v1" || rid || u32be(r) || u8(n) || c_0 .. c_{n-1} || S_r).
 *  - Ersatzwert ohne Beleg: HMAC(S_r, "ersatz-v1" || rid || u32be(r) || u8(i)).
 *  - Permutation der 36 Karten: Fisher-Yates mit Wortstrom aus HMAC(K, u32be(block)).
 *
 * Byte-Regeln: rid sind 16 Rohbytes. Labels sind ASCII ohne Abschluss.
 * u32be ist Big-Endian. u8 ist ein Byte. Alle Hashes sind SHA-256.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FairDeal = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var subtle = (typeof crypto !== 'undefined' && crypto.subtle)
    ? crypto.subtle
    : require('node:crypto').webcrypto.subtle;

  // Kanonische Kartenreihenfolge: Index = suitIndex * 9 + rankIndex.
  var SUITS = ['R', 'S', 'L', 'E'];
  var RANKS = ['6', '7', '8', '9', '10', 'U', 'O', 'K', 'A'];
  var DECK_SIZE = SUITS.length * RANKS.length; // 36

  var enc = new TextEncoder();

  function bytes(x) {
    if (x instanceof Uint8Array) return x;
    if (typeof x === 'string') return enc.encode(x);
    throw new Error('bytes: nur Uint8Array oder String');
  }

  function concat(parts) {
    var list = parts.map(bytes);
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), off = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
    return out;
  }

  function u32be(x) {
    if (!Number.isInteger(x) || x < 0 || x > 0xffffffff) throw new Error('u32be: Wert ausserhalb');
    var b = new Uint8Array(4);
    b[0] = (x >>> 24) & 0xff; b[1] = (x >>> 16) & 0xff; b[2] = (x >>> 8) & 0xff; b[3] = x & 0xff;
    return b;
  }

  function u8(x) {
    if (!Number.isInteger(x) || x < 0 || x > 255) throw new Error('u8: Wert ausserhalb');
    return new Uint8Array([x]);
  }

  function randomBytes(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  async function sha256(data) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes(data)));
  }

  async function hmacSha256(key, data) {
    var k = await subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', k, bytes(data)));
  }

  function equalBytes(a, b) {
    if (a.length !== b.length) return false;
    var d = 0;
    for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  function toHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  // ---- Zufallskette ----

  // Erzeugt die Kette s_0..s_N. s_N ist zufaellig, s_{k-1} = H(s_k).
  // Rueckgabe: Array mit N+1 Eintraegen. Der Anker ist chain[0].
  async function buildChain(N, rand) {
    var rnd = rand || function () { return randomBytes(32); };
    var chain = new Array(N + 1);
    chain[N] = rnd();
    for (var k = N; k >= 1; k--) chain[k - 1] = await sha256(chain[k]);
    return chain;
  }

  // Prueft, ob next zum Anker passt: H(next) == prev.
  async function verifyLink(prev, next) {
    return equalBytes(await sha256(next), bytes(prev));
  }

  // ---- Commits und Deal ----

  // rid: 16 Rohbytes. r: Rundennummer (ab 1). i: Sitz (0..3). c: Spieler-Seed (32 Byte).
  async function clientCommit(rid, r, i, c) {
    return sha256(concat(['cli-commit-v1', rid, u32be(r), u8(i), c]));
  }

  // seeds: Array der Spieler-Seeds in Sitzreihenfolge (Laenge n). S_r: Serverseed der Runde.
  async function dealKey(rid, r, seeds, S_r) {
    var parts = ['deal-v1', rid, u32be(r), u8(seeds.length)];
    for (var i = 0; i < seeds.length; i++) parts.push(seeds[i]);
    parts.push(S_r);
    return sha256(concat(parts));
  }

  async function replacementSeed(S_r, rid, r, i) {
    return hmacSha256(S_r, concat(['ersatz-v1', rid, u32be(r), u8(i)]));
  }

  // Liest den Wortstrom: Wort m ist das m-te 32-Bit-Wort aus HMAC(K, u32be(floor(m/8))).
  function wordStream(K) {
    var cache = {};
    var m = 0;
    return {
      next: async function () {
        var block = Math.floor(m / 8);
        if (cache[block] === undefined) cache[block] = await hmacSha256(K, u32be(block));
        var off = (m % 8) * 4;
        var b = cache[block];
        m += 1;
        return ((b[off] << 24) >>> 0) + (b[off + 1] << 16) + (b[off + 2] << 8) + b[off + 3];
      }
    };
  }

  // Permutation der 36 Kartenindizes. Fisher-Yates von i = 35 bis 1, mit Rejection Sampling.
  async function permutation(K) {
    var perm = [];
    for (var k = 0; k < DECK_SIZE; k++) perm.push(k);
    var ws = wordStream(K);
    for (var i = DECK_SIZE - 1; i >= 1; i--) {
      var range = i + 1;
      var limit = Math.floor(4294967296 / range) * range;
      var x = await ws.next();
      while (x >= limit) x = await ws.next();
      var j = x % range;
      var tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp;
    }
    return perm;
  }

  // Verteilt die Permutation auf die Haende. 4 Spieler: je 9. 3 Spieler: je 12.
  function hands(perm, n) {
    if (n !== 3 && n !== 4) throw new Error('hands: nur 3 oder 4 Spieler');
    var size = DECK_SIZE / n;
    var out = [];
    for (var s = 0; s < n; s++) out.push(perm.slice(s * size, (s + 1) * size));
    return out;
  }

  // Ein Runde-Deal. seeds[i] ist der Spieler-Seed oder null (fehlt). Fehlende Seeds werden ersetzt.
  // Rueckgabe: K, perm, hands, status (je Sitz 'geliefert' oder 'ersatz'), seeds (mit Ersatz).
  async function dealRound(rid, r, n, seeds, S_r) {
    var used = [], status = [], i;
    for (i = 0; i < n; i++) {
      if (seeds[i]) { used.push(seeds[i]); status.push('geliefert'); }
      else { used.push(await replacementSeed(S_r, rid, r, i)); status.push('ersatz'); }
    }
    var K = await dealKey(rid, r, used, S_r);
    var perm = await permutation(K);
    return { K: K, perm: perm, hands: hands(perm, n), status: status, seeds: used };
  }

  // Nachrechnung nach der Runde. Prueft Anker, Commits, Offenlegung und den Deal.
  // Eingabe: rid, r, n, commits (je Sitz C_i), revealed (je Sitz c_i oder null), S_r, prevLink (s_{r-1}), dealtHands.
  // Rueckgabe: { ok, problems } mit Liste der Verstoesse.
  async function verifyRound(input) {
    var problems = [];
    var n = input.n, r = input.r, i;
    if (!(await verifyLink(input.prevLink, input.S_r))) problems.push('Serverseed passt nicht zur Kette');
    for (i = 0; i < n; i++) {
      if (input.revealed[i]) {
        var c = await clientCommit(input.rid, r, i, input.revealed[i]);
        if (!equalBytes(c, input.commits[i])) problems.push('Sitz ' + i + ': Seed passt nicht zum Commit');
      }
    }
    var result = await dealRound(input.rid, r, n, input.revealed, input.S_r);
    for (i = 0; i < n; i++) {
      if (!input.dealtHands || !input.dealtHands[i]) { problems.push('Sitz ' + i + ': keine Hand angegeben'); continue; }
      var a = input.dealtHands[i].slice().sort(function (x, y) { return x - y; });
      var b = result.hands[i].slice().sort(function (x, y) { return x - y; });
      if (a.length !== b.length || a.some(function (v, k) { return v !== b[k]; })) {
        problems.push('Sitz ' + i + ': Hand stimmt nicht mit dem Deal ueberein');
      }
    }
    return { ok: problems.length === 0, problems: problems, result: result };
  }

  // ---- Karten ----

  function cardIndex(suit, rank) {
    var s = SUITS.indexOf(suit), r = RANKS.indexOf(rank);
    if (s < 0 || r < 0) throw new Error('cardIndex: unbekannte Karte');
    return s * RANKS.length + r;
  }

  function cardOf(index) {
    if (!Number.isInteger(index) || index < 0 || index >= DECK_SIZE) throw new Error('cardOf: Index ausserhalb');
    return { s: SUITS[Math.floor(index / RANKS.length)], r: RANKS[index % RANKS.length] };
  }

  return {
    SUITS: SUITS,
    RANKS: RANKS,
    DECK_SIZE: DECK_SIZE,
    bytes: bytes,
    concat: concat,
    u32be: u32be,
    u8: u8,
    randomBytes: randomBytes,
    sha256: sha256,
    hmacSha256: hmacSha256,
    toHex: toHex,
    equalBytes: equalBytes,
    buildChain: buildChain,
    verifyLink: verifyLink,
    clientCommit: clientCommit,
    dealKey: dealKey,
    replacementSeed: replacementSeed,
    permutation: permutation,
    hands: hands,
    dealRound: dealRound,
    verifyRound: verifyRound,
    cardIndex: cardIndex,
    cardOf: cardOf
  };
}));
