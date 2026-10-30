import { env } from 'cloudflare:workers';
import { cookies } from 'next/headers';
import type { WheelEvent } from './game';
import { assertClientOrigin, isExternalClient, sessionSecret, corsResponse } from './hosting.mjs';
export function database() {
  if (!env.DB) throw new Error('Leaderboard storage is unavailable. Practice mode still works.');
  return env.DB;
}
export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
}
export async function sessionToken(req: Request) {
  if (isExternalClient(req)) {
    const authorization = req.headers.get('authorization') || '';
    return /^Bearer [a-f0-9-]{72}$/.test(authorization) ? authorization.slice(7) : undefined;
  }
  return (await cookies()).get('wk_session')?.value;
}
export async function identity(req: Request) {
  const token = await sessionToken(req);
  if (!token) return null;
  const row = await database().prepare('SELECT address FROM sessions WHERE token = ? AND expires > ?').bind(await digest(sessionSecret(req, token)), Date.now()).first<{address: string}>();
  return row?.address || null;
}
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
export function sameOrigin(req: Request) {
  assertClientOrigin(req);
}
export async function apiResponse(req: Request, handler: (req: Request) => Promise<Response>) {
  try { sameOrigin(req); } catch { return corsResponse(req, json({ error: 'Request origin is not allowed.' }, 403)); }
  return corsResponse(req, await handler(req));
}
export async function body(req: Request) {
  sameOrigin(req); const raw = await req.text();
  if (raw.length > 100000) throw new Error('Request too large.');
  return JSON.parse(raw);
}
export type Pulse = { available: boolean; rpm: number | null; height: string | null; source: string;
  receivedAt: string | null; state: string; seed: number; transaction: string | null; event?: WheelEvent | null };
let cached: { until: number; data: Pulse } | null = null;
export async function pulse(): Promise<Pulse> {
  if (cached && cached.until > Date.now()) return cached.data;
  try {
    const response = await fetch('https://api.squeekchain.com/v1/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('API unavailable');
    const d = await response.json() as any, m = d.measurement;
    const fresh = m?.freshness === 'online' && m?.provenance === 'hardware' && Date.now() - Date.parse(m.receivedAt) < Math.min(Number(m.staleAfterSeconds) || 120, 120) * 1000;
    const anchor = d.builder?.status === 'available' ? d.builder.anchor : null;
    if (!anchor || !/^\d+$/.test(anchor.blockHeight) || !/^0x[0-9a-f]{64}$/i.test(anchor.transactionHash)) throw new Error('Incomplete data');
    const hash = await digest(anchor.blockHeight + ':' + anchor.transactionHash);
    const data: Pulse = { available: !!fresh, rpm: fresh && Number.isFinite(m.rpmMilli) ? m.rpmMilli / 1000 : null,
      height: anchor.blockHeight, source: fresh ? 'Squeekchain hardware feed' : 'Last settled Squeekchain block',
      receivedAt: m?.receivedAt || null, state: fresh ? m.rpmMilli > 0 ? 'running' : 'resting' : 'stale',
      seed: parseInt(hash.slice(0, 8), 16), transaction: anchor.transactionHash };
    cached = { until: Date.now() + 8000, data }; return data;
  } catch {
    const hash = await digest('wheelkeepers-practice-' + new Date().toISOString().slice(0, 10));
    return { available: false, rpm: null, height: null, source: 'Daily practice course', receivedAt: null,
      state: 'unavailable', seed: parseInt(hash.slice(0, 8), 16), transaction: null };
  }
}
