"""Prüfungen der Molotow-Engine. Start: python3 test_molotov_engine.py"""
import random
import engine as E


def c(s, r):  # s: 0 Rosen, 1 Schellen, 2 Schilten, 3 Eichel ; r: 0..8 (6..A)
    return s * 9 + r


def play_round(seed, check=None):
    """Spielt eine Molotow-Runde mit zufälligen erlaubten Zügen. check(req) prüft jeden Zug."""
    rng = random.Random(seed)
    g = E.round_gen('molotov', [0, 0, 0, 0], rng, 0, None)
    req = next(g)
    try:
        while True:
            if check:
                check(req)
            req = g.send(rng.choice(req['opts']))
    except StopIteration as e:
        return e.value


def check_move(req):
    """Regeln bei jedem Zug: Farbzwang und freies Spiel ohne Farbe (Molotow)."""
    if req['kind'] != E.DEC_PLAY:
        return
    plays = req['plays']
    hand = req['hand']
    if plays:
        led = E.suit(plays[0][1])
        has_led = any(E.suit(x) == led for x in hand)
        if has_led:
            assert all(E.suit(o) == led for o in req['opts']), 'Farbzwang verletzt'
        else:
            assert sorted(req['opts']) == sorted(hand), 'ohne Farbe muss jede Karte erlaubt sein'


def test_tallies():
    assert E._tallies(72) == 7
    assert E._tallies(35) == 4
    assert E._tallies(5) == 1
    assert E._tallies(-35) == -4
    assert E._tallies(0) == 0


def test_tisch():
    assert E.tisch_pts([c(0, 1), c(0, 2), c(0, 3), c(1, 8)]) == 20   # Dreiblatt
    assert E.tisch_pts([c(0, 1), c(0, 2), c(0, 3), c(0, 4)]) == 50   # Vierblatt
    assert E.tisch_pts([c(0, 5), c(1, 5), c(2, 5), c(3, 5)]) == 200  # Vierling Under
    assert E.tisch_pts([c(0, 0), c(1, 4), c(2, 7), c(3, 8)]) == 0    # kein Weis


def test_rules_each_move_many_rounds():
    for seed in range(400):
        play_round(seed, check_move)


def test_card_points_total_152():
    for seed in range(400):
        _, info = play_round(seed)
        assert sum(info['card']) == 152, ('Kartenpunkte', sum(info['card']))


def test_round_tallies_match_plus_minus():
    for seed in range(200):
        tall, info = play_round(seed)
        for s in range(4):
            assert tall[s] == E._tallies(info['plus'][s]) - E._tallies(info['minus'][s])


if __name__ == '__main__':
    test_tallies()
    test_tisch()
    test_rules_each_move_many_rounds()
    test_card_points_total_152()
    test_round_tallies_match_plus_minus()
    print('alle Molotow-Prüfungen bestanden (400 Runden Farbzwang, 152 Kartenpunkte, Striche)')
