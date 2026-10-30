export const API_ORIGIN = 'https://wheelkeepers.dpdns.org';
// Exact origins only: a shared IPFS gateway must not authorize unrelated pins.
export const STATIC_ORIGINS = ['https://wheelkeepers-a-little-hamster-a.imd.site'];

export function isExternalClient(request) {
  const origin = request.headers.get('origin');
  return !!origin && origin !== new URL(request.url).origin;
}

export function assertClientOrigin(request) {
  const origin = request.headers.get('origin');
  if (isExternalClient(request)) {
    if (!STATIC_ORIGINS.includes(origin)) throw new Error('Request origin is not allowed.');
  } else if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new Error('Request origin is not allowed.');
  }
}

export function signInOrigin(request) {
  assertClientOrigin(request);
  return new URL(request.headers.get('origin') || request.url).origin;
}

export function messageMatchesOrigin(message, origin) {
  return message.startsWith(`${new URL(origin).host} wants you to sign in with your Ethereum account:\n`)
    && message.includes(`\nURI: ${origin}\n`);
}

export function sessionSecret(request, token) {
  // Separate external bearer sessions from cookies, and bind each to its site.
  return isExternalClient(request) ? `wheelkeepers:${signInOrigin(request)}:${token}` : token;
}

export function corsResponse(request, response) {
  const headers = new Headers(response.headers);
  headers.append('Vary', 'Origin');
  if (isExternalClient(request) && STATIC_ORIGINS.includes(request.headers.get('origin'))) {
    headers.set('Access-Control-Allow-Origin', request.headers.get('origin'));
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight(request) {
  try {
    assertClientOrigin(request);
    const method = request.headers.get('access-control-request-method');
    const headers = (request.headers.get('access-control-request-headers') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!['GET', 'POST', 'DELETE'].includes(method) || headers.some(h => !['content-type', 'authorization'].includes(h))) {
      throw new Error('Preflight is not allowed.');
    }
    return corsResponse(request, new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
      'Cache-Control': 'no-store',
    } }));
  } catch {
    return corsResponse(request, Response.json({ error: 'Request origin or headers are not allowed.' }, { status: 403 }));
  }
}
