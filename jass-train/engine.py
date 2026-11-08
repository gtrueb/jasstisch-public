"""
Jass-Engine für Training (Schieber und Molotow). Reine Python-Logik, gleiche Regeln wie js/rules.js.

Karte = Zahl 0..35: Farbe = c // 9 (0 Rosen, 1 Schellen, 2 Schilten, 3 Eichel),
Rang = c % 9 (0 = 6, 1 = 7, 2 = 8, 3 = 9, 4 = 10, 5 = Under, 6 = Ober, 7 = König, 8 = Ass).

Jede Runde ist ein Python-Generator. Er gibt Entscheidungen weiter (Trumpf, Weis, Karte)
und bekommt die Antwort per send(). So kann der Trainer viele Runden gleichzeitig laufen lassen.
"""
import random

RANK_NAMES = ['6', '7', '8', '9', '10', 'U', 'O', 'K', 'A']
PTS_TRUMP = [0, 0, 0, 14, 10, 20, 3, 4, 11]
PTS_PLAIN = [0, 0, 0, 0, 10, 2, 3, 4, 11]
PTS_OBEN = [0, 0, 8, 0, 10, 2, 3, 4, 11]
TRUMP_ORD = [0, 1, 2, 7, 3, 8, 4, 5, 6]   # Stärke im Trumpf (U > 9 > A > K > O > 10 > 8 > 7 > 6)
SEQ_PTS = {3: 20, 4: 50, 5: 100}
WEIS_CLS_NAME = {5: 'Vierling', 4: '5-Blatt', 3: '4-Blatt', 2: '2x3-Blatt', 1: '3-Blatt'}

# Entscheidungsarten (für die Ausgabeköpfe des Netzes)
DEC_TRUMP, DEC_WEIS, DEC_PLAY = 0, 1, 2
OUT_TRUMP0, OUT_SCHIEBEN, OUT_SKIP, OUT_ANNOUNCE, N_OUT = 36, 40, 41, 42, 43


def suit(c):
    return c // 9


def rank(c):
    return c % 9


def card_pts(c, trump):
    if trump is None:
        return PTS_OBEN[rank(c)]
    return PTS_TRUMP[rank(c)] if suit(c) == trump else PTS_PLAIN[rank(c)]


def beats(c, cur, led, trump):
    cs, ct = suit(c), suit(cur)
    if trump is not None:
        if (cs == trump) != (ct == trump):
            return cs == trump
        if cs == trump:
            return TRUMP_ORD[rank(c)] > TRUMP_ORD[rank(cur)]
    if (cs == led) != (ct == led):
        return cs == led
    if cs != led:
        return False
    return rank(c) > rank(cur)


def winner_index(plays, trump):
    led = suit(plays[0][1])
    best = 0
    for i in range(1, len(plays)):
        if beats(plays[i][1], plays[best][1], led, trump):
            best = i
    return best


def legal_schieber(hand, plays, trump):
    if not plays:
        return list(hand)
    led = suit(plays[0][1])
    best = None
    for _, p in plays:
        if suit(p) == trump and (best is None or TRUMP_ORD[rank(p)] > TRUMP_ORD[rank(best)]):
            best = p
    trumps = [c for c in hand if suit(c) == trump]
    plain = [c for c in hand if suit(c) != trump]

    def beats_best(c):
        return best is None or TRUMP_ORD[rank(c)] > TRUMP_ORD[rank(best)]

    if led == trump:
        if not trumps:
            return list(hand)
        if len(trumps) == 1 and rank(trumps[0]) == 5:   # Buur-Ausnahme
            return list(hand)
        b = [c for c in trumps if beats_best(c)]
        if b:
            return b
        return plain if plain else trumps
    follow = [c for c in hand if suit(c) == led]
    if follow:
        return follow + [c for c in trumps if beats_best(c)]
    if not trumps:
        return list(hand)
    b = [c for c in trumps if beats_best(c)]
    if b:
        return b
    return plain if plain else trumps


def legal_molotov(hand, plays):
    if not plays:
        return list(hand)
    led = suit(plays[0][1])
    follow = [c for c in hand if suit(c) == led]
    return follow if follow else list(hand)


def _fours_pts(r):
    return 200 if r == 5 else (150 if r == 3 else 100)


def weis_best(hand):
    """Beste Weisen-Kombination: (klasse, punkte, oberste Karte, karten) oder None."""
    best = [None]

    def better(a, b):
        if b is None:
            return True
        if a[0] != b[0]:
            return a[0] > b[0]
        if a[0] == 5 and a[1] != b[1]:
            return a[1] > b[1]
        return a[2] > b[2]

    def consider(cand):
        if better(cand, best[0]):
            best[0] = cand

    for r in range(3, 9):
        cs = [c for c in hand if rank(c) == r]
        if len(cs) == 4:
            consider((5, _fours_pts(r), r, cs))
    windows3 = []
    for s in range(4):
        idx = {rank(c): c for c in hand if suit(c) == s}
        for st in range(9):
            for ln in (3, 4, 5):
                if st + ln - 1 > 8:
                    break
                if all((st + k) in idx for k in range(ln)):
                    cards = [idx[st + k] for k in range(ln)]
                    if ln == 3:
                        windows3.append((st + 2, cards))
                    else:
                        consider(({4: 3, 5: 4}[ln], SEQ_PTS[ln], st + ln - 1, cards))
    for top, cards in windows3:
        consider((1, 20, top, cards))
    for i in range(len(windows3)):
        for j in range(i + 1, len(windows3)):
            ta, ca = windows3[i]
            tb, cb = windows3[j]
            if not any(x in cb for x in ca):
                consider((2, 40, max(ta, tb), ca + cb))
    return best[0]


def tisch_pts(cards):
    """Tischweis: Weis, den die vier Karten eines Stichs bilden (Dreiblatt 20, Vierblatt 50, Vierling)."""
    ranks = [rank(c) for c in cards]
    if len(set(ranks)) == 1 and ranks[0] >= 3:
        return _fours_pts(ranks[0])
    total = 0
    for s in range(4):
        rs = sorted(rank(c) for c in cards if suit(c) == s)
        run = 1
        for i in range(1, len(rs) + 1):
            if i < len(rs) and rs[i] == rs[i - 1] + 1:
                run += 1
            else:
                if run >= 3:
                    total += SEQ_PTS[run]
                run = 1
    return total


def round_gen(gtype, styles, rng, dealer, scores):
    """
    Spielt eine Runde. Gibt Entscheidungen als dict aus und bekommt die Antwort per send().
    Rückgabe (StopIteration.value): Rundenergebnis je Sitz, in Striche (molotov) oder Punkte (schieber).
    """
    deck = list(range(36))
    rng.shuffle(deck)
    hands = [sorted(deck[s * 9:(s + 1) * 9]) for s in range(4)]
    seen = set()
    won = [[] for _ in range(4)]          # Stichkarten je Sitz
    trick_wins = [0, 0, 0, 0]
    weis_ann = []
    weis_done = [False] * 4
    order = [0]
    stoeck = [0, 0, 0, 0]
    stoeck_pair = [False] * 4
    played_ko = [[], [], [], []]
    tisch = [0, 0, 0, 0]
    trump = None
    trump_set_by = -1
    schoben = False
    if gtype == 'schieber':
        vorhand = (dealer + 1) % 4
        chooser = vorhand
        can_schieben = True
        # Trumpfwahl (ggf. Schieben an den Partner)
        while True:
            opts = list(range(OUT_TRUMP0, OUT_TRUMP0 + 4))
            if can_schieben:
                opts.append(OUT_SCHIEBEN)
            choice = yield {'kind': DEC_TRUMP, 'seat': chooser, 'hand': hands[chooser], 'plays': [],
                            'trump': None, 'opts': opts, 'style': styles[chooser], 'stoeck': stoeck,
                            'seen': seen, 'won': won, 'weis_pts': 0, 'trick_no': 0, 'own_weis': False}
            if choice == OUT_SCHIEBEN:
                can_schieben = False
                schoben = True
                chooser = (chooser + 2) % 4
                continue
            trump = choice - OUT_TRUMP0
            trump_set_by = chooser
            break
        leader = vorhand
        for s in range(4):
            k = any(suit(c) == trump and rank(c) == 7 for c in hands[s])
            o = any(suit(c) == trump and rank(c) == 6 for c in hands[s])
            stoeck_pair[s] = k and o
    else:
        leader = (dealer + 1) % 4

    plays = []
    trick_no = 0
    for_round_led = None
    while trick_no < 9:
        plays = []
        for k in range(4):
            seat = (leader + k) % 4
            # Weisen nur im ersten Stich auf dem eigenen Zug
            if trick_no == 0 and not weis_done[seat]:
                weis_done[seat] = True
                best = weis_best(hands[seat])
                if best is not None:
                    a = yield {'kind': DEC_WEIS, 'seat': seat, 'hand': hands[seat], 'plays': plays,
                               'trump': trump, 'opts': [OUT_SKIP, OUT_ANNOUNCE], 'style': styles[seat],
                               'stoeck': stoeck, 'seen': seen, 'won': won, 'weis_pts': best[1],
                               'trick_no': trick_no, 'own_weis': False}
                    if a == OUT_ANNOUNCE:
                        order[0] += 1
                        weis_ann.append((seat, best, order[0]))
            if gtype == 'schieber':
                legal = legal_schieber(hands[seat], plays, trump)
            else:
                legal = legal_molotov(hands[seat], plays)
            card = yield {'kind': DEC_PLAY, 'seat': seat, 'hand': hands[seat], 'plays': plays,
                          'trump': trump, 'opts': legal, 'style': styles[seat], 'stoeck': stoeck,
                          'seen': seen, 'won': won, 'weis_pts': 0, 'trick_no': trick_no,
                          'own_weis': any(w[0] == seat for w in weis_ann)}
            hands[seat].remove(card)
            led = suit(plays[0][1]) if plays else None
            # Molotow: wer die Farbe nicht bedienen kann, setzt den Trumpf
            if gtype == 'molotov' and trump is None and plays and suit(card) != led:
                trump = suit(card)
                trump_set_by = seat
                for s in range(4):
                    k = any(suit(c) == trump and rank(c) == 7 for c in hands[s])
                    o = any(suit(c) == trump and rank(c) == 6 for c in hands[s])
                    stoeck_pair[s] = k and o
            plays.append((seat, card))
            seen.add(card)
            if trump is not None and suit(card) == trump and rank(card) in (6, 7):
                played_ko[seat].append(rank(card))
                if stoeck_pair[seat] and len(played_ko[seat]) == 2:
                    stoeck[seat] += 20
                    stoeck_pair[seat] = False
        cards = [c for _, c in plays]
        w = winner_index(plays, trump)
        winner = plays[w][0]
        won[winner].extend(cards)
        trick_wins[winner] += 1
        if gtype == 'molotov':
            tisch[winner] += tisch_pts(cards)
        leader = winner
        trick_no += 1

    # Weis-Gewinner: nur die stärkste Kombination zählt
    weis_res = None
    if weis_ann:
        win = None
        for seat, best, od in weis_ann:
            if win is None or _weis_better(best, win[1]):
                win = (seat, best, od)
            elif not _weis_better(win[1], best) and od < win[2]:
                win = (seat, best, od)
        weis_res = (win[0], win[1][1])

    if gtype == 'schieber':
        cp = [0, 0]
        for t in range(2):
            cp[t] = sum(card_pts(c, trump) for c in _team_cards(won, t))
        cp[winner % 2] += 5
        team = [cp[0], cp[1]]
        for s in range(4):
            team[s % 2] += stoeck[s]
        if weis_res:
            team[weis_res[0] % 2] += weis_res[1]
        doubled = 2 if trump == 2 else 1
        team = [x * doubled for x in team]
        return [team[s % 2] for s in range(4)], {'team': team, 'trump': trump}
    # molotov
    cards_pts = [sum(card_pts(c, trump) for c in won[s]) for s in range(4)]
    raw = [cards_pts[s] + tisch[s] - stoeck[s] for s in range(4)]
    if weis_res:
        raw[weis_res[0]] -= weis_res[1]
    raw[winner] += 5
    tall = [_tallies(x) for x in raw]
    return tall, {'raw': raw, 'trump': trump}


def card_pts_of(c, trump):
    return card_pts(c, trump)


def _team_cards(won, t):
    out = []
    out.extend(won[t])
    out.extend(won[t + 2])
    return out


def _weis_better(a, b):
    if a[0] != b[0]:
        return a[0] > b[0]
    if a[0] == 5 and a[1] != b[1]:
        return a[1] > b[1]
    return a[2] > b[2]


def _tallies(p):
    sign = -1 if p < 0 else 1
    return sign * ((abs(p) + 5) // 10)
