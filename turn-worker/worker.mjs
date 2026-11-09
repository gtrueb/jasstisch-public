// Cloudflare Worker: gibt kurzlebige TURN-Zugangsdaten aus.
// Der geheime Schlüssel bleibt im Worker (als Secret in der Cloudflare-Oberfläche). Er steht nicht im Spiel-Code.
// Einrichtung: siehe README.md, Abschnitt "TURN einrichten (Cloudflare)".
//
// Benötigte Secrets (in Cloudflare eintragen, nicht in dieser Datei):
//   TURN_KEY_ID          die Key-ID des TURN-Schlüssels (Cloudflare Realtime)
//   TURN_KEY_API_TOKEN   der API-Token für diesen Schlüssel (geheim)
// Optional (Umgebungsvariable):
//   ALLOWED_ORIGIN       die Adresse, von der die Seite geladen wird, z. B. https://beispiel.example
//                        Ohne sie antwortet der Worker jedem Browser.

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
// Lebensdauer der Zugangsdaten: 24 Stunden (86400 s). Cloudflare erlaubt höchstens 48 Stunden.
// Die Seite holt bei jeder Lobby neue Daten. Eine sehr lange Sitzung kann trotzdem alte Daten behalten.
const TTL_SECONDS = 86400;

// Nur die Herkunft zählt (Adresse ohne Pfad). Ungültiger Wert: kein CORS-Header, der Browser lässt nichts durch.
function allowedOrigin(env) {
  if (!env.ALLOWED_ORIGIN) return '*';
  try { return new URL(env.ALLOWED_ORIGIN).origin; } catch (e) { return null; }
}

function corsHeaders(env) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
  const origin = allowedOrigin(env);
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return new Response('Nur GET erlaubt', { status: 405, headers: cors });
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      return new Response('Worker ist noch nicht eingerichtet (Secrets fehlen)', { status: 500, headers: cors });
    }
    const url = `${API}/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`;
    let upstream;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL_SECONDS })
      });
    } catch (e) {
      return new Response('Cloudflare ist gerade nicht erreichbar', { status: 502, headers: cors });
    }
    if (!upstream.ok) {
      return new Response('Cloudflare hat keine Zugangsdaten geliefert (HTTP ' + upstream.status + ')', { status: 502, headers: cors });
    }
    const body = await upstream.text();
    return new Response(body, {
      status: 200,
      headers: Object.assign({}, cors, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    });
  }
};
