// Tests für den Cloudflare-Worker (turn-worker/worker.mjs). Cloudflare selbst wird hier nicht gefragt:
// fetch ist eine Attrappe, die die Anfrage aufschreibt und eine Antwort zurückgibt.
// Start: node --test tests/turn-worker.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKER = pathToFileURL(path.join(__dirname, '..', 'turn-worker', 'worker.mjs')).href;
const ENV = { TURN_KEY_ID: 'KEY123', TURN_KEY_API_TOKEN: 'GEHEIM', ALLOWED_ORIGIN: 'https://spiel.example' };

// Zeichnet jede Anfrage an Cloudflare auf und antwortet mit "reply".
function fakeFetch(reply, calls) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return reply;
  };
}

test('ohne Secrets: der Worker sagt, dass er nicht eingerichtet ist', async () => {
  const { default: worker } = await import(WORKER);
  const res = await worker.fetch(new Request('https://w.example/', { method: 'GET' }), {});
  assert.equal(res.status, 500);
});

test('GET: fragt Cloudflare mit Bearer-Token und ttl, gibt die Antwort mit CORS weiter', async () => {
  const { default: worker } = await import(WORKER);
  const calls = [];
  const body = JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(new Response(body, { status: 201 }), calls);
  try {
    const res = await worker.fetch(new Request('https://w.example/', { method: 'GET' }), ENV);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://spiel.example');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(await res.text(), body);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/KEY123/credentials/generate-ice-servers');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer GEHEIM');
    assert.equal(JSON.parse(calls[0].opts.body).ttl, 86400);
  } finally { globalThis.fetch = realFetch; }
});

test('Cloudflare lehnt ab: der Worker meldet einen Fehler, gibt keine Daten weiter', async () => {
  const { default: worker } = await import(WORKER);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(new Response('no', { status: 403 }), []);
  try {
    const res = await worker.fetch(new Request('https://w.example/', { method: 'GET' }), ENV);
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes('iceServers'));
  } finally { globalThis.fetch = realFetch; }
});

test('OPTIONS (Browser-Vorabfrage) wird beantwortet, POST wird abgelehnt', async () => {
  const { default: worker } = await import(WORKER);
  const pre = await worker.fetch(new Request('https://w.example/', { method: 'OPTIONS' }), ENV);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /GET/);
  const post = await worker.fetch(new Request('https://w.example/', { method: 'POST' }), ENV);
  assert.equal(post.status, 405);
});

test('ALLOWED_ORIGIN mit Pfad: nur die Herkunft zählt; ungültiger Wert: kein CORS-Header', async () => {
  const { default: worker } = await import(WORKER);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"iceServers":[]}', { status: 201 });
  try {
    const withPath = await worker.fetch(new Request('https://w.example/', { method: 'GET' }),
      { TURN_KEY_ID: 'K', TURN_KEY_API_TOKEN: 'T', ALLOWED_ORIGIN: 'https://spiel.example/jasstisch/' });
    assert.equal(withPath.headers.get('Access-Control-Allow-Origin'), 'https://spiel.example');
    const broken = await worker.fetch(new Request('https://w.example/', { method: 'GET' }),
      { TURN_KEY_ID: 'K', TURN_KEY_API_TOKEN: 'T', ALLOWED_ORIGIN: 'kein gueltiger wert' });
    assert.equal(broken.headers.get('Access-Control-Allow-Origin'), null);
  } finally { globalThis.fetch = realFetch; }
});

test('ohne ALLOWED_ORIGIN antwortet der Worker mit "*"', async () => {
  const { default: worker } = await import(WORKER);
  const env = { TURN_KEY_ID: 'K', TURN_KEY_API_TOKEN: 'T' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(new Response('{"iceServers":[]}', { status: 201 }), []);
  try {
    const res = await worker.fetch(new Request('https://w.example/', { method: 'GET' }), env);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  } finally { globalThis.fetch = realFetch; }
});
