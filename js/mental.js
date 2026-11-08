/*
 * Verdeckte Karten für Online-Jass ("Mental Poker"). Der Host kann die Hände nicht lesen.
 *
 * Idee:
 * - Jeder Spieler hat einen geheimen Schlüssel e (Verschlüsselung x^e mod P) und d = e^-1 mod Q.
 * - Die 36 Karten sind Zahlen in der Gruppe der Quadrate mod P (P = 2Q+1, sichere Primzahl, RFC 3526).
 * - Alle Spieler verschlüsseln und mischen die Karten nacheinander. Danach entfernt jeder außer dem
 *   Besitzer seine Schicht. Eine Karte bleibt also nur für ihren Besitzer lesbar.
 * - Wird eine Karte gespielt oder angesagt, legt der Besitzer sie offen. Mit einem Chaum-Pedersen-
 *   Beweis zeigt er, dass die offene Karte wirklich die verschlüsselte war.
 *
 * Reine Funktionen, läuft im Browser (window.JassMental) und in Node-Tests (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JassMental = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  // RFC 3526, Gruppe 14 (2048 Bit). Geprüft: P und Q = (P-1)/2 sind Primzahlen.
  var P_HEX = 'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF';
  var P = BigInt('0x' + P_HEX);
  var Q = (P - 1n) / 2n;
  var G = 4n;          // 2^2, also ein Quadrat und damit Element der Ordnung Q
  var N = 36;          // Karten im Spiel
  var CR = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : require('crypto').webcrypto;

  function toHex(x) { return x.toString(16); }

  function fromHex(s) {
    if (typeof s !== 'string' || !/^[0-9a-f]{1,700}$/.test(s)) throw new Error('Ungültiger Wert');
    return BigInt('0x' + s);
  }

  function toWire(list) { return list.map(toHex); }

  function fromWire(list, len) {
    if (!Array.isArray(list) || (len !== undefined && list.length !== len)) throw new Error('Falsche Länge');
    return list.map(fromHex);
  }

  function modpow(b, e, m) {
    var r = 1n;
    b = ((b % m) + m) % m;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % m;
      e >>= 1n;
      if (e > 0n) b = (b * b) % m;
    }
    return r;
  }

  // Modulares Inverses (m muss prim sein). Wirft einen Fehler, wenn es keins gibt.
  function modinv(a, m) {
    var t = 0n, newT = 1n, r = m, newR = ((a % m) + m) % m;
    while (newR !== 0n) {
      var q = r / newR;
      var tmp = t - q * newT; t = newT; newT = tmp;
      tmp = r - q * newR; r = newR; newR = tmp;
    }
    if (r !== 1n) throw new Error('Kein Inverses');
    return ((t % m) + m) % m;
  }

  // Gleichverteilte Zufallszahl in [0, n). 64 Extrabits machen die Verzerrung vernachlässigbar.
  function randBelow(n) {
    var bytes = Math.ceil(n.toString(2).length / 8) + 8;
    var a = new Uint8Array(bytes);
    CR.getRandomValues(a);
    var hex = '';
    for (var i = 0; i < bytes; i++) hex += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return BigInt('0x' + hex) % n;
  }

  // Ist x ein Element der Untergruppe der Ordnung Q (Quadrate), ungleich der 1 (neutrales Element)?
  function isElement(x) {
    return typeof x === 'bigint' && x > 1n && x < P && modpow(x, Q, P) === 1n;
  }

  // Netz-Eingaben prüfen. Nur Bereich (schnell). Die Gruppenzugehörigkeit wird am Ende beim
  // Entschlüsseln geprüft: eine Karte ist nur gültig, wenn sie eine der 36 Kartennummern ergibt.
  // Mit strict=true zusätzlich die volle Prüfung (teuer, nur für öffentliche Schlüssel).
  function checkElems(list, len, strict) {
    if (!Array.isArray(list) || list.length !== len) throw new Error('Falsche Länge');
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (typeof x !== 'bigint' || x <= 0n || x >= P) throw new Error('Kein gültiger Kartenwert');
      if (strict && !isElement(x)) throw new Error('Kein gültiger Kartenwert');
    }
    return list;
  }

  // Der Verschlüsselungs-Exponent e ist 256 Bit lang (schneller). d = e^-1 mod Q ist voll lang.
  var E_BITS = 256n;
  function genKey() {
    var e = 2n + randBelow((1n << E_BITS) - 3n);
    return { e: e, d: modinv(e, Q), h: modpow(G, e, P) };
  }

  // Karte k (0..35) <-> Zahl. (k+2)^2 mod P ist ein Quadrat und ergibt 36 verschiedene Werte.
  var CODE_VAL = [];
  var VAL_CODE = {};
  for (var k = 0; k < N; k++) {
    var m0 = BigInt((k + 2) * (k + 2)) % P;
    CODE_VAL.push(m0);
    VAL_CODE[toHex(m0)] = k;
  }
  function encodeIndex(k) { return CODE_VAL[k]; }
  function decodeValue(x) {
    var k = VAL_CODE[toHex(x)];
    return k === undefined ? -1 : k;
  }

  function randomPermutation(len) {
    var a = [];
    for (var i = 0; i < len; i++) a.push(i);
    for (i = len - 1; i > 0; i--) {
      var j = Number(randBelow(BigInt(i + 1)));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---- Beweis, dass V = m^e und h = G^e mit demselben e (Chaum-Pedersen, Fiat-Shamir) ----
  async function challenge(parts) {
    var data = new TextEncoder().encode(parts.map(toHex).join('|'));
    var buf = await CR.subtle.digest('SHA-256', data);
    var bytes = new Uint8Array(buf), hex = '';
    for (var i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return BigInt('0x' + hex) % Q;
  }

  async function proveDL(m, V, e, h) {
    var w = 1n + randBelow(Q - 1n);
    var t1 = modpow(m, w, P), t2 = modpow(G, w, P);
    var c = await challenge([G, h, m, V, t1, t2]);
    var z = (w + c * e) % Q;
    return { c: c, z: z };
  }

  async function verifyDL(m, V, h, proof) {
    var inRange = function (x) { return typeof x === 'bigint' && x > 0n && x < P; };
    if (!inRange(m) || !inRange(V) || !inRange(h)) return false;
    if (!proof || typeof proof.c !== 'bigint' || typeof proof.z !== 'bigint') return false;
    var c = proof.c, z = proof.z;
    if (c < 0n || c >= Q || z < 0n || z >= Q) return false;
    var negc = (Q - c) % Q;
    var t1 = (modpow(m, z, P) * modpow(V, negc, P)) % P;
    var t2 = (modpow(G, z, P) * modpow(h, negc, P)) % P;
    var c2 = await challenge([G, h, m, V, t1, t2]);
    return c2 === c;
  }

  function proofToWire(p) { return { c: toHex(p.c), z: toHex(p.z) }; }
  function proofFromWire(p) {
    if (!p || typeof p !== 'object') throw new Error('Beweis fehlt');
    return { c: fromHex(p.c), z: fromHex(p.z) };
  }

  function positionsOf(seat, n) {
    var out = [];
    for (var p = 0; p < N; p++) if (p % n === seat) out.push(p);
    return out;
  }

  // Ein Spieler mit eigenem Schlüssel. Die Methoden rechnen nur mit eigenen Daten.
  function Player(seat, n) {
    this.seat = seat;
    this.n = n;
    this.key = genKey();
    this.mine = positionsOf(seat, n);   // Kartenpositionen, die diesem Platz gehören
    this.F = null;                      // Endstand der Verschlüsselung, den dieser Spieler gesehen hat
    this.cards = null;                  // Position -> Kartennummer, nur für die eigenen Positionen
  }

  // Die Eingaben kommen aus dem Netz und werden dort einmal geprüft (checkElems). Hier nur Länge.

  // Alle 36 Karten verschlüsseln und zufällig umordnen (Schritt dieses Platzes im Mischen).
  Player.prototype.shuffle = function (vals) {
    if (vals.length !== N) throw new Error('Falsche Länge');
    var e = this.key.e;
    var enc = vals.map(function (x) { return modpow(x, e, P); });
    var perm = randomPermutation(N);
    return perm.map(function (i) { return enc[i]; });
  };

  // Fremde Schichten entfernen: alle Positionen außer den eigenen.
  Player.prototype.peelDeal = function (vals) {
    if (vals.length !== N) throw new Error('Falsche Länge');
    var self = this;
    return vals.map(function (x, p) {
      return (p % self.n === self.seat) ? x : modpow(x, self.key.d, P);
    });
  };

  // Eigene Karten entschlüsseln. Wirft einen Fehler, wenn eine Karte nicht zum Kartensatz gehört.
  Player.prototype.finalize = function (vals) {
    if (vals.length !== N) throw new Error('Falsche Länge');
    var self = this, cards = {}, seen = {};
    this.mine.forEach(function (p) {
      var k = decodeValue(modpow(vals[p], self.key.d, P));
      if (k < 0 || seen[k]) throw new Error('Karte ungültig');
      seen[k] = true;
      cards[p] = k;
    });
    this.F = vals;
    this.cards = cards;
    return cards;
  };

  // Eigene Karten offenlegen: Klartext und Beweis. Nur für Positionen, die dem Platz gehören.
  Player.prototype.revealOwn = async function (positions) {
    if (!this.F) throw new Error('Kein Endstand vorhanden');
    var self = this;
    var out = [];
    for (var i = 0; i < positions.length; i++) {
      var p = positions[i];
      if (self.mine.indexOf(p) < 0) throw new Error('Nicht meine Karte');
      var V = self.F[p];
      var m = modpow(V, self.key.d, P);
      if (decodeValue(m) < 0) throw new Error('Karte ungültig');
      var proof = await proveDL(m, V, self.key.e, self.key.h);
      out.push({ m: m, proof: proof });
    }
    return out;
  };

  // Prüft eine offene Karte gegen den Endstand und den öffentlichen Schlüssel des Besitzers.
  async function verifyReveal(m, V, h, proof) {
    if (decodeValue(m) < 0) return false;   // m muss eine der 36 Karten sein
    return verifyDL(m, V, h, proof);
  }

  var api = {
    P: P, Q: Q, G: G, N: N,
    toHex: toHex, fromHex: fromHex, toWire: toWire, fromWire: fromWire,
    modpow: modpow, modinv: modinv, randBelow: randBelow,
    isElement: isElement, checkElems: checkElems,
    genKey: genKey,
    encodeIndex: encodeIndex, decodeValue: decodeValue,
    randomPermutation: randomPermutation,
    proveDL: proveDL, verifyDL: verifyDL, verifyReveal: verifyReveal,
    proofToWire: proofToWire, proofFromWire: proofFromWire,
    positionsOf: positionsOf,
    Player: Player
  };
  return api;
});
