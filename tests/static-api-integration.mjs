// HTTP auth/CORS checks with a disposable signing key. Never submits a score.
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { API_ORIGIN, STATIC_ORIGINS } from '../lib/hosting.mjs';
import { createApiClient } from '../lib/api-client.ts';

const production = process.argv.includes('--production');
const base = new URL(production ? API_ORIGIN : process.env.WK_TEST_ORIGIN || 'http://127.0.0.1:8789');
if (!production && !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Use a local preview, or --production for the fixed Wheelkeepers API.');
const origin = STATIC_ORIGINS[0];
const wallet = privateKeyToAccount(generatePrivateKey());
let cookie, token, client;
async function call(path, { method = 'GET', data, headers = {} } = {}) {
  const response = await fetch(new URL(`/api/${path}`, base), { method, headers: {
    ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
  }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, headers: response.headers, json };
}
try {
  const before = await call('leaderboard'); assert.equal(before.status, 200);
  const options = await call('auth/verify', { method: 'OPTIONS', headers: {
    origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization',
  } });
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), origin);
  assert.equal(options.headers.get('access-control-allow-credentials'), null);
  for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
    const denied = await call('auth/session', { method, headers: { origin: 'https://foreign.invalid' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
  for (const path of ['pulse', 'leaderboard', 'leaderboard?event=latest', 'auth/session']) {
    const result = await call(path, { headers: { origin } });
    assert.equal(result.status, 200, path);
    assert.equal(result.headers.get('access-control-allow-origin'), origin);
  }
  console.log('PASS: published-origin live APIs and CORS preflight; unrelated origins rejected');

  const nativeNonce = await call('auth/nonce', { method: 'POST', data: { address: wallet.address } });
  const nativeSignature = await wallet.signMessage({ message: nativeNonce.json.message });
  const native = await call('auth/verify', { method: 'POST', data: { id: nativeNonce.json.id, signature: nativeSignature } });
  assert.equal(native.status, 200); assert.equal(native.json.token, undefined);
  cookie = native.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('auth/session', { headers: { cookie } })).json.address, wallet.address.toLowerCase());
  assert.equal((await call('auth/session', { headers: { origin, cookie } })).json.address, null, 'External clients must not use the canonical cookie');

  const nonce = await call('auth/nonce', { method: 'POST', data: { address: wallet.address }, headers: { origin } });
  assert.equal(nonce.status, 200);
  assert.ok(nonce.json.message.startsWith(new URL(origin).host));
  assert.ok(nonce.json.message.includes(`\nURI: ${origin}\n`));
  const signature = await wallet.signMessage({ message: nonce.json.message });
  const payload = { id: nonce.json.id, signature };
  assert.equal((await call('auth/verify', { method: 'POST', data: payload })).status, 401, 'Nonce cannot cross the sign-in domain');
  const external = await call('auth/verify', { method: 'POST', data: payload, headers: { origin } });
  assert.equal(external.status, 200); token = external.json.token;
  assert.equal(external.headers.get('set-cookie'), null);
  assert.equal((await call('auth/session', { headers: { origin, authorization: `Bearer ${token}` } })).json.address, wallet.address.toLowerCase());
  assert.equal((await call('auth/session', { headers: { authorization: `Bearer ${token}` } })).json.address, null);
  assert.equal((await call('auth/verify', { method: 'POST', data: payload, headers: { origin } })).status, 401);
  console.log('PASS: wallet message domain, origin-bound bearer, cookie isolation and nonce replay rejection');

  const methods = [];
  client = createApiClient({ pageOrigin: origin, fetcher: async (url, options) => {
    assert.equal(options.credentials, 'omit');
    const headers = new Headers(options.headers); headers.set('origin', origin);
    const response = await fetch(new URL(new URL(url).pathname + new URL(url).search, base), { ...options, headers });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    return response;
  } });
  const signedIn = await client.connectWallet({ request: async data => {
    methods.push(data.method);
    if (data.method === 'eth_requestAccounts') return [wallet.address];
    assert.equal(data.method, 'personal_sign');
    return wallet.signMessage({ message: { raw: data.params[0] } });
  } });
  assert.equal(signedIn.address, wallet.address.toLowerCase());
  assert.deepEqual(methods, ['eth_requestAccounts', 'personal_sign']);
  assert.equal((await client.api('auth/session')).address, wallet.address.toLowerCase());
  assert.equal((await client.api('runs', { action: 'abandon', id: crypto.randomUUID() })).ok, true);
  const after = await client.api('leaderboard');
  assert.equal(after.total, before.json.total); assert.equal(after.me, null);
  console.log('PASS: real static client signs in and sends authenticated game requests with cookies omitted; no score submitted');
} finally {
  if (client) await client.api('auth/session', undefined, 'DELETE');
  if (token) {
    const headers = { origin, authorization: `Bearer ${token}` };
    assert.equal((await call('auth/session', { method: 'DELETE', headers })).status, 200);
    assert.equal((await call('auth/session', { headers })).json.address, null);
  }
  if (cookie) {
    await call('auth/session', { method: 'DELETE', headers: { cookie } });
    assert.equal((await call('auth/session', { headers: { cookie } })).json.address, null);
  }
  console.log('Revoked all disposable test sessions.');
}
