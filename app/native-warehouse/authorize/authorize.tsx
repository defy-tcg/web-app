'use client';

import Link from 'next/link';
import { useState } from 'react';
type ConnectionRequest = { id: string; name: string; code: string; expiresAt: string; approved: boolean; consumed: boolean };

export default function AuthorizeConnection({ request, email }: { request: ConnectionRequest; email: string }) {
  const [matches, setMatches] = useState(false), [approved, setApproved] = useState(request.approved), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function approve() {
    if (!matches) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/native-warehouse-devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve', requestId: request.id, verificationCode: request.code, confirmed: true }) });
      if (!response.ok) throw new Error(response.status === 409 ? 'This request expired or the account already has ten connections. Return to the app or manage existing connections.' : 'Approval failed. Sign in again or start a new connection.');
      setApproved(true);
    } catch (error) { setError(error instanceof Error ? error.message : 'Approval failed.'); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-card">
    <p className="eyebrow">DEFY TCG · WAREHOUSE</p>
    <h1>{approved ? 'Connection approved' : 'Connect your Warehouse app'}</h1>
    {approved ? <p role="status">Return to the Warehouse app to finish signing in. If it did not receive the connection, start a new sign-in there.</p> : <>
      <p>Connect <strong>{request.name}</strong> as <strong>{email}</strong>.</p>
      <p>Check that this code matches the code shown in the Warehouse app you just opened:</p>
      <p aria-label={`Connection code ${request.code}`} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 32, fontWeight: 700, letterSpacing: 3, textAlign: 'center', margin: '24px 0' }}>{request.code}</p>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 24 }}><input type="checkbox" checked={matches} onChange={event => setMatches(event.target.checked)} style={{ width: 'auto', marginTop: 6 }} />I started this connection and the code matches my Warehouse app.</label>
      <button disabled={!matches || busy} onClick={() => void approve()}>{busy ? 'Connecting…' : 'Connect Warehouse'}</button>
      <p style={{ fontSize: 14 }}>This request expires in ten minutes. If you did not start it, close this page.</p>
    </>}
    {error && <p role="alert">{error}</p>}
    <p><Link href="/native-warehouse">Manage connected Macs</Link></p>
  </section></main>;
}
