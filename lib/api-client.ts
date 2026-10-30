import { API_ORIGIN } from './hosting.mjs';

const unavailable = 'The game server is unavailable. Practice is still open. Please try again later.';
type ClientOptions = { pageOrigin: string; apiOrigin?: string; fetcher?: typeof fetch; storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> };

export function createApiClient({ pageOrigin, apiOrigin = API_ORIGIN, fetcher = fetch, storage }: ClientOptions) {
  const external = !!apiOrigin && pageOrigin !== apiOrigin;
  const base = external ? apiOrigin : '';
  const key = `wk-session:${apiOrigin}`;
  let token: string | null = null;
  try { token = external ? storage?.getItem(key) || null : null; } catch {}
  function remember(value: string | null) {
    token = value;
    try { if (value) storage?.setItem(key, value); else storage?.removeItem(key); } catch {}
  }
  async function api(path: string, data?: unknown, method?: string): Promise<any> {
    const headers = new Headers({ Accept: 'application/json' });
    if (data !== undefined) headers.set('Content-Type', 'application/json');
    if (external && token) headers.set('Authorization', `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetcher(`${base}/api/${path}`, {
        method: method || (data === undefined ? 'GET' : 'POST'), headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        credentials: external ? 'omit' : 'same-origin', cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new Error(unavailable); }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(unavailable);
    let result: any;
    try { result = await response.json(); } catch { throw new Error(unavailable); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(unavailable);
    if (!response.ok) {
      if (response.status === 401 && external) remember(null);
      throw new Error(typeof result.error === 'string' ? result.error : unavailable);
    }
    if (path === 'auth/verify' && external) {
      if (typeof result.token !== 'string' || !/^[a-f0-9-]{72}$/.test(result.token)) throw new Error(unavailable);
      remember(result.token);
    }
    if (path === 'auth/session' && (method === 'DELETE' || !result.address)) remember(null);
    return result;
  }
  async function connectWallet(provider: { request: (data: any) => Promise<any> }) {
    const service = await api('auth/session');
    if (external && service.authMode !== 'bearer') throw new Error(unavailable);
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts?.[0]) throw new Error('No wallet selected.');
    const nonce = await api('auth/nonce', { address: accounts[0] });
    const hex = '0x' + Array.from(new TextEncoder().encode(nonce.message), b => b.toString(16).padStart(2, '0')).join('');
    const signature = await provider.request({ method: 'personal_sign', params: [hex, accounts[0]] });
    return api('auth/verify', { id: nonce.id, signature });
  }
  return { api, connectWallet };
}

let client: ReturnType<typeof createApiClient> | undefined;
export function gameApi() {
  if (!client) {
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch {}
    client = createApiClient({ pageOrigin: window.location.origin,
      apiOrigin: process.env.NODE_ENV === 'development' ? '' : API_ORIGIN, storage });
  }
  return client;
}

export function api(path: string, data?: unknown, method?: string) { return gameApi().api(path, data, method); }
