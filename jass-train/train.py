"""
Offline-Training für Jass (Schieber und Molotow). Keine Grafik, nur Spielzüge.

Lernt mit Verstärkungslernen (Policy Gradient) durch Selbstspiel:
- viele Runden laufen gleichzeitig; alle Entscheidungen eines Schrittes laufen als ein Batch durch das Netz (GPU).
- Ein Netz entscheidet für alle Sitze. Jeder Sitz hat einen Stil (Eingabe ins Netz):
    0 sicher       Belohnung: eigene Punkte (wenig Striche). Im Spiel: immer die wahrscheinlichste Karte.
    1 aggressiv    Belohnung: wie sicher, aber Gegner-Punkte zählen weniger (Schieber) bzw. Gegner-Striche zählen als Plus (Molotow).
                   Im Spiel: mehr Zufall (Temperatur 1.5).
    2 wahrscheinlich  Belohnung wie sicher. Im Spiel: zieht nach Wahrscheinlichkeit (Temperatur 1).
- Weisen: das Netz entscheidet selbst, ob es ansagt (Tischweis wird über die Engine gezählt).

Beispiele:
  python3 train.py --game molotov --rounds 2000000
  python3 train.py --game schieber --rounds 2000000 --resume
  python3 train.py --game molotov --eval-only
"""
import argparse
import os
import random
import time
from contextlib import nullcontext

import torch
import torch.nn as nn

import engine as E

N_FEAT = 134
STYLES = ['sicher', 'aggressiv', 'wahrscheinlich']


class Net(nn.Module):
    def __init__(self, n_in=N_FEAT, n_hidden=256, n_out=E.N_OUT):
        super().__init__()
        self.f = nn.Sequential(
            nn.Linear(n_in, n_hidden), nn.ReLU(),
            nn.Linear(n_hidden, n_hidden), nn.ReLU(),
            nn.Linear(n_hidden, n_out),
        )

    def forward(self, x):
        return self.f(x)


def features(req, gtype):
    x = [0.0] * N_FEAT
    seat = req['seat']
    for c in req['hand']:
        x[c] = 1.0
    for c in req['seen']:
        x[36 + c] = 1.0
    plays = req['plays']
    for _, c in plays:
        x[72 + c] = 1.0
    if plays:
        x[108 + E.suit(plays[0][1])] = 1.0
    x[112 + len(plays)] = 1.0
    t = req['trump']
    x[116 + (4 if t is None else t)] = 1.0
    x[121 + (0 if gtype == 'schieber' else 1)] = 1.0
    x[123 + req['style']] = 1.0
    x[126 + req['kind']] = 1.0
    x[129] = req['trick_no'] / 9.0
    x[130] = len(req['won'][seat]) / 36.0
    x[131] = 1.0 if req['own_weis'] else 0.0
    x[132] = req['weis_pts'] / 200.0
    x[133] = req['stoeck'][seat] / 40.0
    return x


def mask_of(req):
    m = [False] * E.N_OUT
    for o in req['opts']:
        m[o] = True
    return m


def reward_for(gtype, seat, result, style, n=4):
    """Belohnung für einen Sitz (größer = besser)."""
    if gtype == 'molotov':
        mine = result[seat]
        others = sum(result[s] for s in range(n) if s != seat) / (n - 1)
        r = -mine
        if style == 1:
            r += 0.5 * others
        return r / 10.0
    # Schieber: result[seat] = Teampunkte, result[seat+1] = Gegnerpunkte
    mine = result[seat]
    opp = result[(seat + 1) % 4]
    w = 0.5 if style == 1 else 1.0
    return (mine - w * opp) / 100.0


class Runner:
    """Spielt viele Runden gleichzeitig. Jeder Schritt = ein Batch durch das Netz."""

    def __init__(self, model, gtype, device, rng, greedy_eval=False, n=4):
        self.model = model
        self.n = n
        self.gtype = gtype
        self.device = device
        self.rng = rng
        self.greedy_eval = greedy_eval

    def play(self, n_rounds, styles_fixed=None, record=False):
        gens, styles_all = [], []
        for _ in range(n_rounds):
            styles = styles_fixed or [self.rng.randrange(3) for _ in range(self.n)]
            styles_all.append(styles)
            gens.append(E.round_gen(self.gtype, styles, self.rng, self.rng.randrange(self.n), None, n=self.n))
        pend = [next(g) for g in gens]
        results = [None] * n_rounds
        records = []  # (x, mask, action, game, seat, style, kind)
        active = list(range(n_rounds))
        while active:
            reqs = [pend[i] for i in active]
            X = [features(r, self.gtype) for r in reqs]
            M = [mask_of(r) for r in reqs]
            if self.model is None:
                logits = None
            else:
                Xt = torch.tensor(X, dtype=torch.float32, device=self.device)
                with (nullcontext() if record else torch.no_grad()):
                    logits = self.model(Xt)
            acts = []
            if logits is None:
                for r in reqs:
                    acts.append(self.rng.choice(r['opts']))
            else:
                Mt = torch.tensor(M, dtype=torch.bool, device=self.device)
                masked = logits.masked_fill(~Mt, -1e9)
                if record:
                    probs = torch.softmax(masked.detach(), dim=1)  # Training: immer Temperatur 1
                else:
                    temps = []
                    for r in reqs:
                        if self.greedy_eval and r['style'] == 0:
                            temps.append(0.0)
                        elif r['style'] == 1:
                            temps.append(1.5)
                        else:
                            temps.append(1.0)
                    tt = torch.tensor(temps, device=self.device).unsqueeze(1)
                    probs = torch.softmax(masked / tt.clamp(min=1e-3), dim=1)
                    greedy = (tt.squeeze(1) == 0.0)
                    probs = torch.where(greedy.unsqueeze(1), torch.nn.functional.one_hot(masked.argmax(1), E.N_OUT).float(), probs)
                sampled = torch.multinomial(probs, 1).squeeze(1).tolist()
                acts = sampled
            new_active = []
            for j, i in enumerate(active):
                a = acts[j]
                if record:
                    r = reqs[j]
                    records.append((X[j], M[j], a, i, r['seat'], r['style'], r['kind']))
                try:
                    pend[i] = gens[i].send(a)
                    new_active.append(i)
                except StopIteration as e:
                    results[i] = e.value[0]  # Werte je Sitz
            active = new_active
        return results, styles_all, records


def ckpt_name(game, players):
    return game + ('.pt' if players == 4 else f'-{players}p.pt')


def train(args):
    device = torch.device(args.device if args.device != 'auto' else ('mps' if torch.backends.mps.is_available() else 'cpu'))
    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)
    path = os.path.join(args.out, ckpt_name(args.game, args.players))
    model = Net().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    baseline = {}
    done = 0
    if args.resume and os.path.exists(path):
        ck = torch.load(path, map_location=device)
        model.load_state_dict(ck['model'])
        opt.load_state_dict(ck['opt'])
        baseline = ck.get('baseline', {})
        done = ck.get('rounds', 0)
        print('resumed', path, 'rounds so far', done)
    runner = Runner(model, args.game, device, rng, n=args.players)
    t0 = time.time()
    step = 0
    while done < args.rounds:
        results, _, records = runner.play(args.batch, record=True)
        done += args.batch
        step += 1
        # Belohnungen je Entscheidung
        X, M, A, R, S, K, G = [], [], [], [], [], [], []
        for (x, m, a, i, seat, style, kind) in records:
            rew = reward_for(args.game, seat, results[i], style, args.players)
            key = (args.game, args.players, style)
            b = baseline.get(key, 0.0)
            X.append(x); M.append(m); A.append(a); R.append(rew - b); S.append(style); K.append(kind)
        # Baseline (gleitender Mittelwert je Stil)
        for (x, m, a, i, seat, style, kind) in records:
            key = (args.game, args.players, style)
            rew = reward_for(args.game, seat, results[i], style, args.players)
            baseline[key] = 0.99 * baseline.get(key, 0.0) + 0.01 * rew
        if not X:
            continue
        Xt = torch.tensor(X, dtype=torch.float32, device=device)
        Mt = torch.tensor(M, dtype=torch.bool, device=device)
        At = torch.tensor(A, dtype=torch.long, device=device)
        Rt = torch.tensor(R, dtype=torch.float32, device=device)
        logits = model(Xt).masked_fill(~Mt, -1e9)
        logp_all = torch.log_softmax(logits, dim=1)
        logp = logp_all.gather(1, At.unsqueeze(1)).squeeze(1)
        probs = logp_all.exp()
        ent = -(probs * logp_all.masked_fill(~Mt, 0.0)).sum(1).mean()
        loss = -(logp * Rt).mean() - args.entropy * ent
        opt.zero_grad()
        loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        if step % args.log_every == 0:
            rate = done / (time.time() - t0)
            weis_dec = [a for a, k in zip(A, K) if k == E.DEC_WEIS]
            announce = sum(1 for a in weis_dec if a == E.OUT_ANNOUNCE) / max(1, len(weis_dec))
            print(f'[{args.game}] rounds {done:>9} | {rate:7.0f} rounds/s | loss {loss.item():+.4f} | entropy {ent.item():.3f} | weis-ansagen {announce:.2f}', flush=True)
        if step % args.save_every == 0:
            torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'baseline': baseline, 'rounds': done, 'game': args.game}, path)
    torch.save({'model': model.state_dict(), 'opt': opt.state_dict(), 'baseline': baseline, 'rounds': done, 'game': args.game}, path)
    print('saved', path)
    return model


def evaluate(model, game, device, n=2000, seed=123, players=4):
    """Vergleich: trainiertes Netz gegen Zufall, je Stil (Zahlen = Striche bzw. Teampunkte, kleiner ist besser bei Molotow)."""
    rng = random.Random(seed)
    model.eval()
    out = {}
    base = Runner(None, game, device, rng, n=players)
    res_b, _, _ = base.play(n, styles_fixed=[0] * players)
    if game == 'molotov':
        out['zufall (Striche je Spieler)'] = sum(r[0] for r in res_b) / n
    else:
        out['zufall (Teampunkte)'] = sum(r[0] for r in res_b) / n
    for st in range(3):
        r = Runner(model, game, device, rng, greedy_eval=True, n=players)
        res, _, _ = r.play(n, styles_fixed=[st] * players)
        if game == 'molotov':
            out[f'netz {STYLES[st]} (Striche je Spieler)'] = sum(x[0] for x in res) / n
        else:
            out[f'netz {STYLES[st]} (Teampunkte)'] = sum(x[0] for x in res) / n
    model.train()
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--game', choices=['molotov', 'schieber'], default='molotov')
    p.add_argument('--players', type=int, choices=[3, 4], default=4, help='Spielerzahl (nur Molotow kann 3 Spieler)')
    p.add_argument('--rounds', type=int, default=200000, help='Gesamtzahl der Trainingsrunden')
    p.add_argument('--batch', type=int, default=512, help='Runden pro Gradientenschritt')
    p.add_argument('--lr', type=float, default=3e-4)
    p.add_argument('--entropy', type=float, default=0.01)
    p.add_argument('--device', default='auto', help='auto | mps | cuda | cpu')
    p.add_argument('--out', default='checkpoints')
    p.add_argument('--seed', type=int, default=1)
    p.add_argument('--log-every', type=int, default=10)
    p.add_argument('--save-every', type=int, default=50)
    p.add_argument('--resume', action='store_true')
    p.add_argument('--eval-only', action='store_true')
    args = p.parse_args()
    device = torch.device(args.device if args.device != 'auto' else ('mps' if torch.backends.mps.is_available() else 'cpu'))
    if args.eval_only:
        model = Net().to(device)
        ck = torch.load(os.path.join(args.out, ckpt_name(args.game, args.players)), map_location=device)
        model.load_state_dict(ck['model'])
        for k, v in evaluate(model, args.game, device, players=args.players).items():
            print(f'{k:40s} {v:8.2f}')
        return
    model = train(args)
    for k, v in evaluate(model, args.game, device, players=args.players).items():
        print(f'{k:40s} {v:8.2f}')


if __name__ == '__main__':
    main()
