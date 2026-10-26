import { getAuthorizedSession } from '@/lib/auth/authorization';
import { webBulkHandler } from '@/lib/bulk-warehouse/http';
import { queueBulkCommand, readBulkInventory } from '@/lib/bulk-warehouse/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const handler = webBulkHandler({ authorize: getAuthorizedSession, inventory: readBulkInventory, queue: queueBulkCommand });
export const GET = handler;
export const POST = handler;
