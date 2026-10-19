'use client';
import './reference-manager.css';
import { useEffect, useState } from 'react';
import { features } from '@/lib/warehouse/image-features';
import type { State } from '@/lib/warehouse/model';
import type { ReferencePlan, ReferenceResult } from '@/lib/warehouse/reference-index';

type Snapshot = { revision: number; state: State };
async function request<T>(query: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/warehouse' + query, { method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal });
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Sign in again to continue catalog maintenance.');
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Catalog preparation could not be saved.');
  return value as T;
}

/** Runs only missing catalog work, never a per-batch rebuild. Saved results survive reloads. */
export default function ReferenceManager({ version, pending, details, onActivated, onReady }: {
  version: string | null; pending: boolean; details: boolean; onActivated: (value: Snapshot) => void; onReady: (version: string) => void;
}) {
  const [plan, setPlan] = useState<ReferencePlan | null>(null);
  const [progress, setProgress] = useState(''); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!version) return;
    const controller = new AbortController(); const signal = controller.signal;
    async function prepare() {
      setError('');
      let next = await request<ReferencePlan>('?index=' + version, undefined, signal);
      if (signal.aborted) return; setPlan(next);
      const total = next.work.length;
      for (let start = 0; start < total; start += 4) {
        if (signal.aborted) return;
        setProgress(`Preparing new catalog images ${Math.min(start + 4, total)}/${total}. Saved once for all batches and devices.`);
        const results = await Promise.all(next.work.slice(start, start + 4).map(async (work): Promise<ReferenceResult> => {
          try {
            const response = await fetch(`/api/warehouse/reference?version=${version}&id=${encodeURIComponent(work.masterId)}`, {
              signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: 'force-cache',
            });
            if (response.redirected || response.status === 401 || response.status === 403) throw new Error('Session expired');
            if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) return { sourceKey: work.sourceKey, error: 'Reference image unavailable' };
            return { sourceKey: work.sourceKey, signature: await features(await response.blob()) };
          } catch (cause) {
            if (signal.aborted || (cause instanceof Error && cause.message === 'Session expired')) throw cause;
            return { sourceKey: work.sourceKey, error: 'Reference image unavailable' };
          }
        }));
        await request('', { kind: 'saveReferenceResults', catalogVersion: version, results }, signal);
      }
      if (total > 0) next = await request<ReferencePlan>('?index=' + version, undefined, signal);
      if (signal.aborted) return; setPlan(next); setProgress(''); if (next.ready) onReady(version!);
      if (pending && next.ready) {
        // Re-read the revision: other devices may have received cards while images were prepared.
        for (let attempt = 0; attempt < 3; attempt++) {
          const snapshot = await request<Snapshot>('', undefined, signal);
          if (snapshot.state.pendingCatalog !== version) { onActivated(snapshot); return; }
          try {
            const activated = await request<Snapshot>('', { kind: 'activateCatalog', catalogVersion: version,
              expectedRevision: snapshot.revision, operationId: crypto.randomUUID() }, signal);
            if (!signal.aborted) onActivated(activated); return;
          } catch (cause) {
            if (attempt === 2 || !(cause instanceof Error) || !/another device|refresh|changed/i.test(cause.message)) throw cause;
          }
        }
      }
    }
    void prepare().catch(cause => { if (!signal.aborted) { setProgress(''); setError(cause instanceof Error ? cause.message : 'Catalog preparation stopped.'); } });
    return () => controller.abort();
  }, [version, pending, retry, onActivated, onReady]);
  if (!version) return null;
  if (plan?.version !== version && !error) return <p className="rw-index-status" role="status">Loading the saved recognition index…</p>;
  return <section className="rw-index-status" aria-label="Saved recognition index">
    <strong>{progress ? 'Catalog update preparing' : plan?.ready ? 'Recognition index ready' : 'Catalog preparation needs attention'}</strong>
    <p>{progress || (plan ? `${plan.prepared.toLocaleString()} exact-printing references saved · ${plan.manualOnly.toLocaleString()} eligible printings require manual image review. Uploads are matched automatically using the saved index.` : '')}</p>
    {pending && <p>The previous active catalog stays in use until this update is prepared. Existing batches keep their original catalog.</p>}
    {error && <p role="alert">{error} Saved work is retained.</p>}
    {details && <><p>Catalog maintenance only. Keep this page open during a new catalog update; returning resumes saved work. No preparation is required for normal batches.</p>
      {error && <button onClick={() => setRetry(n => n + 1)}>Resume catalog update</button>}
      {!progress && (plan?.failed || 0) > 0 && <button onClick={() => {
        void request('', { kind: 'retryUnavailableReferences', catalogVersion: version }).then(() => setRetry(n => n + 1)).catch(e => setError(e.message));
      }}>Retry unavailable source images</button>}
    </>}
  </section>;
}
