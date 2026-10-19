import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Choose an OS · Defy TCG', robots: { index: false, follow: false } };
export default async function OperatingSystems() { if (!await getAuthorizedSession()) redirect('/auth/sign-in'); return <main style={{maxWidth:850,padding:'80px 24px',margin:'auto'}}><p>DEFY TCG / WORKSPACES</p><h1 style={{fontSize:36,fontWeight:750,lineHeight:1.2,margin:'16px 0'}}>Choose your operating system.</h1><p>One sign-in. Separate workflows and inventory.</p><section style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))',gap:24,marginTop:32}}><Link href="/" style={{padding:28,border:'1px solid #888',borderRadius:20,textDecoration:'none',color:'inherit'}}><h2 style={{fontSize:22,fontWeight:700}}>Defy Store OS</h2><p>Your current store, sales, pricing, Shopify and inventory.</p></Link><Link href="/warehouse" style={{padding:28,border:'1px solid #888',borderRadius:20,textDecoration:'none',color:'inherit'}}><h2 style={{fontSize:22,fontWeight:700}}>Rift Warehouse OS</h2><p>Scan batches, review cards, assign warehouse serials and pick orders. Isolated pilot inventory.</p></Link></section></main>; }
