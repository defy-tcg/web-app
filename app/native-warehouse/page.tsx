import { redirect } from 'next/navigation';
import { getAuthorizedSession } from '@/lib/auth/authorization';
import NativeConnections from './connections';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Warehouse connections · Defy', robots: { index: false, follow: false } };
export default async function Page() {
  const session = await getAuthorizedSession();
  if (!session) redirect('/auth/sign-in?returnTo=%2Fnative-warehouse');
  return <NativeConnections email={session.user.email || ''} />;
}
