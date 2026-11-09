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
- `molotov.html`: Molotov (jeder für sich, wenigste Striche gewinnen). Schalter „Undenufe und Slalom“: erste 6 der Runde setzt Undenufe, erstes Ass setzt Obenabe, jede andere Karte setzt Farbtrumpf. Spielt der Setzer im nächsten Stich die Gegenkarte, wechselt der Modus in jedem Stich bis Rundenende (-20 einmal für den Setzer). Gilt nur für die Runde.

## Tests

```bash
node --test tests/*.test.js
```

## Dateien

- `js/rules.js`: Regeln, erlaubte Karten, Weisen, Wertung (Schieber)
- `js/ai-schieber.js`: Computer-Gegner für Schieber (Teams)
- `js/ai-molotov.js`: Computer-Gegner für Molotov (jeder für sich). Beide haben eine `level`-Option für später.
- `js/game.js`: Ablauf Schieber (Runden, Weisen, Timer)
- `js/molotov.js`: Ablauf Molotov (Obenabe, Undenufe, Slalom, Tischweis, Striche)
- `js/ui.js`, `js/molotov-ui.js`: Oberfläche
- `assets/style.css`: Aussehen
- `assets/suits/`: Farbsymbole von Wikimedia Commons, Quellen und Lizenzen in `assets/suits/CREDITS.md`

## Online mit verdeckten Karten

Ein Spieler erstellt eine Lobby und bekommt einen Code. Die anderen geben den Code ein.
Freie Plätze füllt die KI.

Der Host sieht die Hände der Mitspieler nicht. Die Karten sind verschlüsselt:

- `js/mental.js`: Schlüssel und Verschlüsselung. Gruppe der 2048-Bit-Primzahl aus RFC 3526 (Gruppe 14). Jeder Spieler hat einen geheimen Schlüssel. Ein Beweis (Chaum-Pedersen) zeigt, dass eine offen gelegte Karte stimmt.
- `js/mental-round.js`: Ablauf einer Runde. Host-Seite (`Round`) und Gerät des Mitspielers (`ClientSeat`).
- `js/online.js`: Verbindung, Lobby, Zeitlimit. Jeder Mitspieler spielt auf seinem eigenen Gerät. Die Karten bleiben dort.

Was der Host sieht und was nicht:

- Nicht sichtbar: die Hände der Mitspieler, bis sie gespielt oder angesagt werden.
- Sichtbar: die gespielten und angesagten Karten, die Hände der KI-Plätze und die eigene Hand.

Grenzen des Vertrauens (ehrlich beschrieben):

- Ein Host, der den Originalcode nutzt, sieht die Hände der Mitspieler nicht. Jedes Gerät gibt nur die Karten frei, die es selbst spielt oder ansagt.
- Ein Host, der den Code verändert, kann die Mischschritte manipulieren und so Karten erfahren. Dagegen fehlen überprüfbare Mischschritte (eigene Aufgabe, noch nicht gebaut).
- Der Host kann den Ablauf stören, zum Beispiel Nachrichten verzögern oder die Runde abbrechen.
- Ob ein Mitspieler die Farbe bedient, prüft nur sein eigenes Gerät. Der Host kennt die Hand nicht.
- Fällt ein Mitspieler aus, wird die Runde abgebrochen und ohne ihn neu gestartet.

Tests: `node --test tests/*.test.js`. Die Datei `tests/remote-game.test.js` spielt eine verdeckte und eine offene Partie gleichzeitig und vergleicht sie nach jedem Zug.

## Zeiten

Die Zeiten stehen in `js/game.js` (`DEFAULT_DELAYS`). Sie wurden an jassli.ch angepasst:
ca. 10 bis 12 Sekunden pro Stich, ca. 2,5 bis 3 Sekunden pro Karte der KI.
Für Tests kann man `?speed=20` an die URL hängen. Dann läuft alles 20-mal schneller.
