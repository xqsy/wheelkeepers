// Export only the frontend. Live features use the existing Wheelkeepers API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ORIGIN, STATIC_ORIGINS } from '../lib/hosting.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const preview = new URL(value('--preview-url') || 'http://127.0.0.1:8789');
if (!['127.0.0.1', 'localhost'].includes(preview.hostname)) throw new Error('Use a local built production preview.');
const response = await fetch(preview, { signal: AbortSignal.timeout(15000) });
const html = await response.text();
if (!response.ok || !html.includes('Wheelkeepers') || html.includes('@vite/client') || html.includes('wheelkeepers-extension-error-filter')) {
  throw new Error('Build the production app and start its local preview first.');
}
const out = path.resolve(root, value('--out') || `outputs/wheelkeepers-static-${Date.now()}`);
const relative = path.relative(root, out);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !['outputs', 'out'].includes(relative.split(path.sep)[0])) {
  throw new Error('Choose a fresh directory inside outputs/ or out/.');
}
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.mkdir(out); // Never overwrite an existing export or other user files.
await fs.cp(path.join(root, 'dist/client'), out, { recursive: true });
await fs.writeFile(path.join(out, 'index.html'), html);
await fs.writeFile(path.join(out, '404.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Wheelkeepers</title><a href="/">Return to Wheelkeepers</a></html>');
console.log(JSON.stringify({ directory: out, api: API_ORIGIN, allowedOrigins: STATIC_ORIGINS, serverIncluded: false }));
