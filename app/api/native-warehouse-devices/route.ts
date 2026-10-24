import { getAuthorizedSession } from '@/lib/auth/authorization';
import { nativeFailure, nativeJSON, onlyKeys, readNativeBody, rejectCrossSite } from '@/lib/native-warehouse/http';
import { NativeError, requestID } from '@/lib/native-warehouse/policy';
import { approveNativeRequest, listNativeDevices, revokeNativeDevice } from '@/lib/native-warehouse/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    rejectCrossSite(request);
    const session = await getAuthorizedSession();
    if (!session) throw new NativeError(401, 'Sign in with an authorized Defy account.');
    return nativeJSON({ devices: await listNativeDevices(session.user.id) });
  } catch (error) { return nativeFailure(error); }
}
export async function POST(request: Request) {
  try {
    rejectCrossSite(request, true);
    const session = await getAuthorizedSession();
    if (!session) throw new NativeError(401, 'Sign in with an authorized Defy account.');
    const body = await readNativeBody(request);
    if (body.action === 'approve') {
      onlyKeys(body, ['action', 'requestId', 'verificationCode', 'confirmed']);
      if (body.confirmed !== true || typeof body.verificationCode !== 'string') throw new NativeError(400, 'Confirm the code shown in your Warehouse app.');
      await approveNativeRequest(requestID(body.requestId), body.verificationCode, session.user.id);
      return nativeJSON({ approved: true });
    }
    if (body.action === 'revoke') {
      onlyKeys(body, ['action', 'id']);
      await revokeNativeDevice(requestID(body.id), session.user.id);
      return nativeJSON({ revoked: true });
    }
    throw new NativeError(400, 'Unsupported connection action.');
  } catch (error) { return nativeFailure(error); }
}
