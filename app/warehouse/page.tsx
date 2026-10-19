import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import WarehouseClient from './warehouse-client';
import './warehouse.css';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Rift Warehouse OS · Defy TCG', description: 'Separate card intake, Mastersheet, storage and order-picking workspace.', robots: { index: false, follow: false } };
export default async function WarehousePage() { if (!await getAuthorizedSession()) redirect('/auth/sign-in'); return <WarehouseClient />; }
