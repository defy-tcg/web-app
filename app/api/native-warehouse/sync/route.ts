import { nativeSyncHandler } from '@/lib/bulk-warehouse/http';
import { syncBulkWarehouse } from '@/lib/bulk-warehouse/store';
import { authenticateNative, rateNativeSession } from '@/lib/native-warehouse/store';
import { parseNativeBearer, rateIdentity } from '@/lib/native-warehouse/policy';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const POST = nativeSyncHandler({
  async authorize(request) {
    const header = request.headers.get('authorization');
    if (!parseNativeBearer(header)) return null;
    await rateNativeSession(rateIdentity(request.headers, process.env.NEON_AUTH_COOKIE_SECRET || ''));
    return authenticateNative(header!);
  },
  sync: syncBulkWarehouse,
});
