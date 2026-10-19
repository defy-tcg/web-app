'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
/** Store OS launcher; other workspaces own their navigation. */
export default function WorkspaceLauncher() {
  const pathname = usePathname();
  if (pathname !== '/') return null;
  return <Link href="/os" aria-label="Switch between Defy Store OS and Rift Warehouse OS" style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 25, padding: '10px 15px', background: '#15332b', color: '#fff', border: '1px solid #6b9278', borderRadius: 24, fontSize: 12, fontWeight: 650, textDecoration: 'none', boxShadow: '0 4px 15px #0002' }}>⇄ Switch OS</Link>;
}
