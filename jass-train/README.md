# Jass-Training (offline, GPU)

Lernt Jass nur aus Spielzügen. Keine Grafik. Läuft komplett offline.
Auf dem Mac nutzt es automatisch die GPU (Apple Metal, `mps`). Sonst CPU oder CUDA.

## Installation (einmal, mit Internet)

```bash
python3 -m pip install torch numpy
```

## Training

```bash
cd jass-train
python3 train.py --game molotov --rounds 2000000     # Molotow
python3 train.py --game schieber --rounds 2000000    # Schieber
python3 train.py --game molotov --rounds 4000000 --resume   # weiter trainieren
python3 train.py --game molotov --players 3 --rounds 2000000   # Molotow zu dritt (12 Karten je Spieler)
```

Checkpoints liegen in `checkpoints/` (4 Spieler: `molotov.pt`, 3 Spieler: `molotov-3p.pt`). Nach dem Training gibt es einen Vergleich
(trainiertes Netz gegen Zufall, je Stil).

Nur auswerten:
```bash
python3 train.py --game molotov --eval-only
```

## Was gelernt wird

- Karten spielen (immer nur erlaubte Karten, das Netz wählt aus den erlaubten)
- Trumpf wählen und Schieben (Schieber)
- Weis ansagen oder nicht (beide Spiele)
- Drei Stile. Der Stil ist eine Eingabe ins Netz und ändert die Belohnung:
  - `sicher`: Belohnung = eigene Punkte. Im Spiel immer die wahrscheinlichste Karte.
  - `aggressiv`: Gegnerpunkte zählen weniger (Schieber) bzw. Gegner-Striche sind Plus (Molotow). Im Spiel mehr Zufall.
  - `wahrscheinlich`: wie sicher, aber im Spiel nach Wahrscheinlichkeit gezogen.

## Ehrliche Grenzen

- Es wird Verstärkungslernen (Policy Gradient) mit einem Netz verwendet. Die Taktiken entstehen aus der Belohnung, nicht aus fest eingebauten Regeln.
- Die Stile unterscheiden sich über Belohnung und Zufall. Das ist keine fertige „Strategie-Bibliothek“.
- Die Gegner im Spiel (js/ai-*.js) sind noch die alten Heuristiken. Ein trainiertes Netz ist noch nicht ins Spiel eingebaut.
- Schieber: der Schellen-7-Sonderfall ist im Training nicht enthalten.

## Molotow zu dritt

Nach jassverzeichnis.ch: 3 Spieler bekommen je 12 Karten (alle 36 Karten), also 12 Stiche.
Die Regeln sind sonst gleich. Die Engine prüft das mit `python3 test_molotov_engine.py`.
