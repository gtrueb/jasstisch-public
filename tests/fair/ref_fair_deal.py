#!/usr/bin/env python3
"""Unabhaengige Referenz fuer js/fair-deal.js (Umbauplan v3 K1, K2, K8).

Schreibt tests/fair/vectors.json mit festen Eingaben und den erwarteten Ergebnissen.
Die JavaScript-Tests vergleichen ihre Ausgabe mit dieser Datei.
Nur Standardbibliothek. Start: python3 tests/fair/ref_fair_deal.py
"""
import hashlib
import hmac
import json
import os

SUITS = ["R", "S", "L", "E"]
RANKS = ["6", "7", "8", "9", "10", "U", "O", "K", "A"]
DECK = len(SUITS) * len(RANKS)


def sha256(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update(p)
    return h.digest()


def hmac_sha256(key, data):
    return hmac.new(key, data, hashlib.sha256).digest()


def u32be(x):
    return x.to_bytes(4, "big")


def u8(x):
    return bytes([x])


def client_commit(rid, r, i, c):
    return sha256(b"cli-commit-v1", rid, u32be(r), u8(i), c)


def deal_key(rid, r, seeds, s_r):
    return sha256(b"deal-v1", rid, u32be(r), u8(len(seeds)), *seeds, s_r)


def replacement_seed(s_r, rid, r, i):
    return hmac_sha256(s_r, b"ersatz-v1" + rid + u32be(r) + u8(i))


def permutation(k):
    words = {}

    def word(m):
        block = m // 8
        if block not in words:
            words[block] = hmac_sha256(k, u32be(block))
        off = (m % 8) * 4
        return int.from_bytes(words[block][off:off + 4], "big")

    perm = list(range(DECK))
    m = 0
    for i in range(DECK - 1, 0, -1):
        rng = i + 1
        limit = (2 ** 32 // rng) * rng
        x = word(m)
        m += 1
        while x >= limit:
            x = word(m)
            m += 1
        j = x % rng
        perm[i], perm[j] = perm[j], perm[i]
    return perm


def hands(perm, n):
    size = DECK // n
    return [perm[s * size:(s + 1) * size] for s in range(n)]


def chain(n_max, s_top):
    vals = [None] * (n_max + 1)
    vals[n_max] = s_top
    for k in range(n_max, 0, -1):
        vals[k - 1] = sha256(vals[k])
    return vals


def deal_round(rid, r, n, seeds, s_r):
    used, status = [], []
    for i in range(n):
        if seeds[i] is not None:
            used.append(seeds[i])
            status.append("geliefert")
        else:
            used.append(replacement_seed(s_r, rid, r, i))
            status.append("ersatz")
    k = deal_key(rid, r, used, s_r)
    perm = permutation(k)
    return {
        "seeds": [s.hex() for s in used],
        "status": status,
        "K": k.hex(),
        "perm": perm,
        "hands": hands(perm, n),
    }


def main():
    rid = bytes(range(16))
    s_top = bytes([0x42]) * 32
    s_r3 = bytes([0x17]) * 32
    seeds4 = [bytes([i + 1]) * 32 for i in range(4)]
    seeds3 = [bytes([0x30 + i]) * 32 for i in range(3)]

    commits4 = [client_commit(rid, 3, i, seeds4[i]).hex() for i in range(4)]
    commits3 = [client_commit(rid, 2, i, seeds3[i]).hex() for i in range(3)]

    vec = {
        "rid": rid.hex(),
        "chain": {
            "N": 4,
            "s_top": s_top.hex(),
            "values": [v.hex() for v in chain(4, s_top)],
        },
        "round_4_players": {
            "r": 3,
            "S_r": s_r3.hex(),
            "commits": commits4,
            "deal": deal_round(rid, 3, 4, seeds4, s_r3),
        },
        "round_4_missing_seat2": {
            "r": 3,
            "S_r": s_r3.hex(),
            "seeds_in": [seeds4[0].hex(), seeds4[1].hex(), None, seeds4[3].hex()],
            "deal": deal_round(rid, 3, 4, [seeds4[0], seeds4[1], None, seeds4[3]], s_r3),
        },
        "round_3_players": {
            "r": 2,
            "S_r": s_r3.hex(),
            "commits": commits3,
            "deal": deal_round(rid, 2, 3, seeds3, s_r3),
        },
        "card_order": {"suits": SUITS, "ranks": RANKS},
    }

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "vectors.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(vec, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("geschrieben:", out)


if __name__ == "__main__":
    main()
