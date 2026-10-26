import { getAuthorizedSession } from '@/lib/auth/authorization';
import { nativeOrderSaleHandler } from '@/lib/bulk-warehouse/http';
import { readNativeOrderForSale, recordNativeOrderSale } from '@/lib/bulk-warehouse/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const handler = nativeOrderSaleHandler({ authorize: getAuthorizedSession, read: readNativeOrderForSale, record: recordNativeOrderSale });
export const GET = handler;
export const POST = handler;
