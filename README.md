# Jasstisch

Kleines Jass-Spiel im Browser. Gegen den Computer. Keine Installation nötig.

## Starten

Doppelklick auf `index.html` oder den lokalen Server starten:

```bash
cd jasstisch
python3 -m http.server 8765
```

Dann im Browser öffnen: http://localhost:8765/

## Spiele

- `schieber.html`: Schieber (4 Spieler, zwei Teams, Trumpf wird gewählt)
- `molotov.html`: Molotov (jeder für sich, wenigste Striche gewinnen)

## Tests

```bash
node --test tests/*.test.js
```

## Dateien

- `js/rules.js`: Regeln, erlaubte Karten, Weisen, Wertung (Schieber)
- `js/ai.js`: Computer-Gegner
- `js/game.js`: Ablauf Schieber (Runden, Timer)
- `js/molotov.js`: Ablauf Molotov
- `js/ui.js`, `js/molotov-ui.js`: Oberfläche
- `assets/style.css`: Aussehen

## Zeiten

Die Zeiten stehen in `js/game.js` (`DEFAULT_DELAYS`). Sie wurden an jassli.ch angepasst:
ca. 10 bis 12 Sekunden pro Stich, ca. 2,5 bis 3 Sekunden pro Karte der KI.
Für Tests kann man `?speed=20` an die URL hängen. Dann läuft alles 20-mal schneller.
