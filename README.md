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
- Fällt ein Mitspieler aus, wird die Runde abgebrochen und ohne ihn neu gestartet. Er sitzt danach zwei Runden als KI aus, auch wenn er sofort wieder verbunden ist. So kann niemand jede Runde mit einem Fehler abbrechen.
- Geht der Host (Lobby verlassen, Tab zu, Verbindung weg), übernimmt der Mitspieler mit dem niedrigsten Platz die Lobby. Die anderen verbinden sich mit ihm neu. Mitten im Spiel startet die Runde neu. Punkte und Geber bleiben. Die Verlaufsliste wird nicht übernommen.
- Die Lobby zeigt nur einen Hash der Platz-Tokens, nie den Token selbst.
- Für Verbindungen über strenge Netze braucht es einen TURN-Server. Anleitung: Abschnitt „TURN einrichten (Cloudflare)“ unten.

Tests: `node --test tests/*.test.js`. Die Datei `tests/remote-game.test.js` spielt eine verdeckte und eine offene Partie gleichzeitig und vergleicht sie nach jedem Zug.

## TURN einrichten (Cloudflare)

TURN ist ein Relais. Es springt ein, wenn zwei Geräte nicht direkt verbunden werden können (zum Beispiel im Mobilfunk oder in manchen Firmennetzen). Ohne TURN bleibt die Verbindung dann bei „Suche Lobby“ hängen.

Die Zugangsdaten bleiben geheim. Sie liegen nur bei Cloudflare, nicht im Spiel-Code und nicht im Chat.

1. Cloudflare-Konto anlegen (kostenlos).
2. In der Cloudflare-Oberfläche unter Realtime → TURN einen Schlüssel anlegen. Die **Key-ID** kopieren.
3. Einen **API-Token** für diesen Schlüssel erstellen. Welche Rechte er braucht, steht in der Cloudflare-Anleitung.
4. Unter Workers & Pages einen neuen Worker anlegen. Den Inhalt von [turn-worker/worker.mjs](turn-worker/worker.mjs) einfügen und deployen.
5. Im Worker unter Einstellungen → Variablen und Secrets zwei **Secrets** anlegen:
   - `TURN_KEY_ID` = die Key-ID aus Schritt 2
   - `TURN_KEY_API_TOKEN` = der Token aus Schritt 3
   - Optional als normale Variable: `ALLOWED_ORIGIN` = nur die Herkunft, ohne Pfad und ohne `/` am Ende, z. B. `https://beispiel.example`
6. Die Adresse des Workers (z. B. `https://NAME.SUBDOMAIN.workers.dev`) in [js/online.js](js/online.js) bei `TURN_ENDPOINT` eintragen.

Grenzen:
- Jeder, der die Worker-Adresse kennt, kann Zugangsdaten holen. Dann wird Datenvolumen verbraucht. `ALLOWED_ORIGIN` hält nur Browser auf. Das Kontingent im Cloudflare-Konto im Blick behalten.
- Cloudflare nennt ein kostenloses Kontingent von 1.000 GB pro Monat. Quelle: [Cloudflare Realtime Preise](https://developers.cloudflare.com/realtime/pricing/).
- Zugangsdaten laufen nach 24 Stunden ab. Die Seite holt bei jeder Lobby neue. Eine Lobby, die länger als 24 Stunden läuft, kann den Relais-Weg verlieren. Dann hilft ein Neuladen der Seite.
- Gegen Missbrauch: In Cloudflare eine Ratenbegrenzung (Rate Limiting) für den Worker einrichten. Das ist eine Einstellung im Cloudflare-Dashboard, nicht im Code. Wie genau sie heißt, habe ich nicht geprüft.

## Zeiten

Die Zeiten stehen in `js/game.js` (`DEFAULT_DELAYS`). Sie wurden an jassli.ch angepasst:
ca. 10 bis 12 Sekunden pro Stich, ca. 2,5 bis 3 Sekunden pro Karte der KI.
Für Tests kann man `?speed=20` an die URL hängen. Dann läuft alles 20-mal schneller.
