import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../lib/api-client.ts';
import { API_ORIGIN, STATIC_ORIGINS } from '../lib/hosting.mjs';

const json = value => Response.json(value);
const token = '12345678-1234-4234-8234-123456789012'.repeat(2);
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('an IPFS static client uses the real API and a tab session, never third-party cookies', async () => {
  const calls = [], saved = storage();
  const client = createApiClient({ pageOrigin: STATIC_ORIGINS[0], storage: saved, fetcher: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('auth/verify')) return json({ address: '0xabc', token });
    if (url.endsWith('auth/session')) return json({ address: options.method === 'DELETE' ? null : '0xabc' });
    return json({ rows: [] });
  } });
  await client.api('leaderboard');
  assert.equal(calls[0].url, API_ORIGIN + '/api/leaderboard');
  assert.equal(calls[0].options.credentials, 'omit');
  await client.api('auth/verify', { signature: 'test' });
  await client.api('runs', { action: 'start' });
  assert.equal(calls.at(-1).options.headers.get('authorization'), `Bearer ${token}`);
  const reloaded = createApiClient({ pageOrigin: STATIC_ORIGINS[0], storage: saved, fetcher: async (_, options) => {
    assert.equal(options.headers.get('authorization'), `Bearer ${token}`);
    return json({ address: '0xabc' });
  } });
  await reloaded.api('auth/session');
  await client.api('auth/session', undefined, 'DELETE');
  await client.api('leaderboard');
  assert.equal(calls.at(-1).options.headers.has('authorization'), false);
});

test('canonical and local development clients keep same-origin HttpOnly cookie authentication', async () => {
  for (const apiOrigin of [API_ORIGIN, '']) {
    const client = createApiClient({ pageOrigin: API_ORIGIN, apiOrigin, storage: { getItem() { throw new Error('Do not read bearer storage'); } }, fetcher: async (url, options) => {
      assert.equal(url, '/api/auth/session');
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.headers.has('authorization'), false);
      return json({ address: null });
    } });
    await client.api('auth/session');
  }
});

test('gateway HTML, malformed JSON and unreachable APIs give a readable error before any wallet prompt', async () => {
  for (const fetcher of [
    async () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }),
    async () => new Response('{invalid', { headers: { 'content-type': 'application/json' } }),
    async () => { throw new TypeError('Failed to fetch'); },
    async () => json({ address: null }),
  ]) {
    let prompts = 0;
    const client = createApiClient({ pageOrigin: STATIC_ORIGINS[0], fetcher });
    await assert.rejects(client.connectWallet({ request: async () => { prompts++; return []; } }), /game server is unavailable/);
    assert.equal(prompts, 0);
  }
});

test('healthy static sign-in checks the service, then requests only account access and a message signature', async () => {
  const steps = [];
  const client = createApiClient({ pageOrigin: STATIC_ORIGINS[0], fetcher: async (url, options) => {
    const path = url.split('/api/')[1]; steps.push(path);
    if (path === 'auth/session') return json({ address: null, authMode: 'bearer' });
    if (path === 'auth/nonce') return json({ id: 'nonce', message: 'Sign in to Wheelkeepers' });
    if (path === 'auth/verify') return json({ address: '0xabc', token });
    assert.fail(path);
  } });
  await client.connectWallet({ request: async data => { steps.push(data.method); return data.method === 'eth_requestAccounts' ? ['0xabc'] : 'signature'; } });
  assert.deepEqual(steps, ['auth/session', 'eth_requestAccounts', 'auth/nonce', 'personal_sign', 'auth/verify']);
});
