'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
type Device = { id: string; name: string; created_at: string; expires_at: string; revoked_at: string | null; expired: boolean };

export default function NativeConnections({ email }: { email: string }) {
  const [devices, setDevices] = useState<Device[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState<string | null>(null), [loaded, setLoaded] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/native-warehouse-devices', { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Connections could not be loaded. Sign in again or retry.');
    const value = await response.json(); setDevices(value.devices); setLoaded(true);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/native-warehouse-devices', { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Connections could not be loaded. Sign in again or retry.');
        return response.json();
      })
      .then(value => { if (!controller.signal.aborted) { setDevices(value.devices); setLoaded(true); } })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Connections could not be loaded.'); });
    return () => controller.abort();
  }, []);
  async function revoke(device: Device) {
    if (!window.confirm(`Disconnect ${device.name}? The Warehouse app will lock at its next account check. Local inventory is not erased.`)) return;
    setBusy(device.id); setError('');
    try {
      const response = await fetch('/api/native-warehouse-devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'revoke', id: device.id }) });
      if (!response.ok) throw new Error('The connection could not be revoked. Retry after signing in.');
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : 'The connection could not be revoked.'); }
    finally { setBusy(null); }
  }
  return <main style={{ maxWidth: 820, margin: '48px auto', padding: 24, fontFamily: 'system-ui', lineHeight: 1.6 }}>
    <Link href="/">← Defy OS</Link>
    <p className="eyebrow">DEFY TCG · SHARED ACCOUNT</p>
    <h1>Warehouse connections</h1>
    <p>Signed in as <strong>{email}</strong>. Start a connection from the native Warehouse app, then confirm its matching code here.</p>
    <p>Each Mac uses this Defy account. Connections expire after 30 days. Disconnecting a Mac stops its account access without deleting the inventory stored on that computer.</p>
    {error && <p role="alert">{error} <button onClick={() => { setError(''); void load().catch(() => setError('Connections could not be loaded. Sign in again.')); }}>Retry</button></p>}
    {!loaded && !error && <p role="status">Loading connections…</p>}
    {loaded && devices.length === 0 && <p>No Warehouse connections yet.</p>}
    {devices.map(device => {
      const expired = device.expired;
      return <section key={device.id} style={{ padding: '20px 0', borderBottom: '1px solid #80808055', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
        <div><h2 style={{ fontSize: 18, margin: 0 }}>{device.name}</h2><p style={{ margin: '4px 0 0' }}>{device.revoked_at ? 'Disconnected' : expired ? 'Expired' : `Expires ${new Date(device.expires_at).toLocaleDateString()}`}</p></div>
        {!device.revoked_at && !expired && <button disabled={busy !== null} onClick={() => void revoke(device)}>{busy === device.id ? 'Disconnecting…' : 'Disconnect'}</button>}
      </section>;
    })}
  </main>;
}
