import { BulkError, orderSaleQuery, parseCommand, parseNativeOrderSale, parseSync, readBulkBody } from './model.ts';
import { inventoryQuery } from './store.ts';
import { NativeError } from '../native-warehouse/policy.ts';

export const bulkHeaders = { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
export function bulkJSON(value: unknown, status = 200) { return Response.json(value, { status, headers: bulkHeaders }); }
export function bulkFailure(error: unknown) {
  return error instanceof BulkError || error instanceof NativeError ? bulkJSON({ error: error.message }, error.status) : bulkJSON({ error: 'Bulk Warehouse is temporarily unavailable. Retry your saved request.' }, 503);
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new BulkError(403, 'Cross-site request rejected.');
}
type NativeDeps = {
  authorize: (request: Request) => Promise<{ account: { id: string } } | null>;
  sync: (owner: string, input: ReturnType<typeof parseSync>) => Promise<unknown>;
};
export function nativeSyncHandler(deps: NativeDeps) {
  return async (request: Request) => {
    try {
      if (request.method !== 'POST') throw new BulkError(405, 'Use POST for warehouse synchronization.');
      const url = new URL(request.url);
      if (url.search || request.headers.get('origin') || request.headers.get('sec-fetch-site') === 'cross-site') throw new BulkError(403, 'Use the approved Warehouse Manager connection.');
      const session = await deps.authorize(request);
      if (!session) throw new BulkError(401, 'Sign in to Warehouse Manager with an approved account.');
      return bulkJSON(await deps.sync(session.account.id, parseSync(await readBulkBody(request))));
    } catch (error) { return bulkFailure(error); }
  };
}
type WebDeps = {
  authorize: () => Promise<{ user: { id: string } } | null>;
  inventory: (filters: ReturnType<typeof inventoryQuery>) => Promise<unknown>;
  queue: (actor: string, input: ReturnType<typeof parseCommand>) => Promise<unknown>;
};
export function webBulkHandler(deps: WebDeps) {
  return async (request: Request) => {
    try {
      if (!['GET', 'POST'].includes(request.method)) throw new BulkError(405, 'Method not allowed.');
      if (request.headers.has('authorization')) throw new BulkError(401, 'Use your signed-in Store OS session.');
      if (request.method === 'POST') sameOrigin(request);
      const session = await deps.authorize();
      if (!session) throw new BulkError(401, 'Sign in with an approved account.');
      if (request.method === 'GET') return bulkJSON(await deps.inventory(inventoryQuery(new URL(request.url))));
      if (new URL(request.url).search) throw new BulkError(400, 'Unsupported action parameter.');
      return bulkJSON(await deps.queue(session.user.id, parseCommand(await readBulkBody(request))));
    } catch (error) { return bulkFailure(error); }
  };
}
type OrderSaleDeps = {
  authorize: () => Promise<{ user: { id: string } } | null>;
  read: (input: ReturnType<typeof orderSaleQuery>) => Promise<unknown>;
  record: (actor: string, input: ReturnType<typeof parseNativeOrderSale>) => Promise<unknown>;
};
export function nativeOrderSaleHandler(deps: OrderSaleDeps) {
  return async (request: Request) => {
    try {
      if (!['GET', 'POST'].includes(request.method)) throw new BulkError(405, 'Method not allowed.');
      if (request.headers.has('authorization')) throw new BulkError(401, 'Use your signed-in Store OS session.');
      if (request.method === 'POST') sameOrigin(request);
      const session = await deps.authorize();
      if (!session) throw new BulkError(401, 'Sign in with an approved account.');
      if (request.method === 'GET') return bulkJSON(await deps.read(orderSaleQuery(new URL(request.url))));
      if (new URL(request.url).search) throw new BulkError(400, 'Unsupported action parameter.');
      return bulkJSON(await deps.record(session.user.id, parseNativeOrderSale(await readBulkBody(request))));
    } catch (error) { return bulkFailure(error); }
  };
}
