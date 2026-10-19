import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import '../warehouse/warehouse.css';
export const dynamic = 'force-dynamic';
export default async function OperatingSystems() { if (!await getAuthorizedSession()) redirect('/auth/sign-in'); return <main className="rw-hub"><p className="rw-eyebrow">DEFY TCG / WORKSPACES</p><h1>Choose your operating system.</h1><p>One sign-in. Separate workflows and inventory.</p><div className="rw-hub-grid"><Link href="/" className="rw-panel"><span className="rw-badge">STORE</span><h2>Defy Store OS</h2><p>Your existing sales, pricing, Shopify and store inventory.</p><strong>Open Store OS →</strong></Link><Link href="/warehouse" className="rw-panel"><span className="rw-badge">WAREHOUSE · PILOT</span><h2>Rift Warehouse OS</h2><p>Scan batches, review exact printings, assign storage positions and pick orders.</p><strong>Open Warehouse OS →</strong></Link></div><p className="rw-note">Warehouse stock is separate. Existing Sites inventory is not migrated.</p></main>; }
