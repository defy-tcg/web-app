import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import ScannerConnections from './scanner-connections';
export const dynamic='force-dynamic';
export const metadata={title:'Mac Scanner · Rift Warehouse',robots:{index:false,follow:false}};
export default async function Page(){if(!await getAuthorizedSession())redirect('/auth/sign-in');return <ScannerConnections/>;}
