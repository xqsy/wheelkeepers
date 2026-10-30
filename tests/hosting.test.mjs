import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ORIGIN, STATIC_ORIGINS, assertClientOrigin, preflight, sessionSecret, messageMatchesOrigin } from '../lib/hosting.mjs';

const origin = STATIC_ORIGINS[0];
const req = (headers = {}, method = 'GET') => new Request(`${API_ORIGIN}/api/auth/session`, { method, headers });

test('only exact published origins can use the API; shared gateways, suffix tricks and opaque origins fail', () => {
  assert.doesNotThrow(() => assertClientOrigin(req()));
  assert.doesNotThrow(() => assertClientOrigin(req({ origin: API_ORIGIN, 'sec-fetch-site': 'same-origin' })));
  assert.doesNotThrow(() => assertClientOrigin(req({ origin, 'sec-fetch-site': 'cross-site' })));
  for (const value of ['null', 'https://foreign.invalid', 'https://imd.site', origin + '.foreign.invalid', origin.replace('https:', 'http:')]) {
    assert.throws(() => assertClientOrigin(req({ origin: value })));
  }
  assert.throws(() => assertClientOrigin(req({ 'sec-fetch-site': 'cross-site' })));
});

test('CORS preflight permits bearer JSON requests without sharing cookies or granting a wildcard', () => {
  const response = preflight(req({ origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' }, 'OPTIONS'));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.match(response.headers.get('vary'), /Origin/);
  for (const headers of [
    { origin: 'https://foreign.invalid', 'access-control-request-method': 'POST' },
    { origin, 'access-control-request-method': 'PUT' },
    { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-admin' },
  ]) assert.equal(preflight(req(headers, 'OPTIONS')).status, 403);
});

test('external sessions and sign-in messages cannot be replayed as the main site session', () => {
  const external = req({ origin });
  assert.notEqual(sessionSecret(external, 'token'), sessionSecret(req(), 'token'));
  const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n0x123\n\nURI: ${origin}\nVersion: 1`;
  assert.equal(messageMatchesOrigin(message, origin), true);
  assert.equal(messageMatchesOrigin(message, API_ORIGIN), false);
});
