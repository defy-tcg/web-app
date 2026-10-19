'use client';
import { FEATURE_ALGORITHM, type Card, type State, type Signature } from '@/lib/warehouse/model';
export type Snapshot = { revision: number; state: State };
export type Workspace = {
  snapshot: Snapshot; catalogs: Record<string, Card[]>; busy: boolean;
  mutate: (kind: string, fields?: Record<string, unknown>) => Promise<Snapshot>;
  run: (work: () => Promise<unknown>) => Promise<void>;
  notify: (message: string) => void; progress: (message: string) => void;
};
export async function api<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  if (response.redirected || response.headers.get('content-type')?.includes('text/html')) throw new Error('Your session expired. Sign in to Defy, then reopen Warehouse OS.');
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`); return data;
}
export function imageUrl(version: string, id: string) { return `/api/warehouse/reference?version=${encodeURIComponent(version)}&id=${encodeURIComponent(id)}`; }
export async function makeSignature(blob: Blob): Promise<Signature> {
  const image = await createImageBitmap(blob);
  try { const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8; const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) throw new Error('Canvas is unavailable.'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 8, 8); ctx.drawImage(image, 0, 0, 8, 8); const rgba = ctx.getImageData(0, 0, 8, 8).data; const values: number[] = []; for (let i = 0; i < rgba.length; i += 4) values.push(rgba[i], rgba[i + 1], rgba[i + 2]); return { algorithm: FEATURE_ALGORITHM, values }; } finally { image.close(); }
}
export async function prepare(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 12_000_000) throw new Error(`${file.name}: use JPG, PNG or WebP below 12 MB.`);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(n => n.toString(16).padStart(2, '0')).join('');
  const bitmap = await createImageBitmap(file);
  try { const canvas = document.createElement('canvas'); const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio)); const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas is unavailable.'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); const image = canvas.toDataURL('image/jpeg', 0.87); if (image.length > 2_800_000) throw new Error('Preview is too large. Export a smaller Epson image.'); return { image, sha256, signature: await makeSignature(file) }; } finally { bitmap.close(); }
}
export function download(name: string, data: string, type = 'application/json') { const url = URL.createObjectURL(new Blob([data], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function csvCell(value: string) { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }
