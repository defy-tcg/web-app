import { createNativeHandler } from '@/lib/native-warehouse/http';
import { rateIdentity } from '@/lib/native-warehouse/policy';
import { startNativeRequest, exchangeNativeRequest, authenticateNative, revokeNativeDevice, rateNativeSession } from '@/lib/native-warehouse/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const handle = createNativeHandler({
  rateKey: request => rateIdentity(request.headers, process.env.NEON_AUTH_COOKIE_SECRET || ''),
  start: startNativeRequest,
  exchange: exchangeNativeRequest,
  sessionRate: rateNativeSession,
  session: authenticateNative,
  revoke: revokeNativeDevice,
});
export const GET = handle;
export const POST = handle;
