import { createHash } from 'node:crypto';

export const BULK_PROTOCOL = 1;
export const BULK_EVENT_LIMIT = 250;
export const BULK_COMMAND_LIMIT = 100;
// Native fulfillment supports 100 order lines of up to 500 exact copies.
export const BULK_ORDER_COPY_LIMIT = 50_000;
export const BULK_BODY_LIMIT = 2_000_000;
export const WORKSPACES = ['riftbound', 'mtg', 'pokemon'] as const;
export type Workspace = typeof WORKSPACES[number];
export class BulkError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export type CopyData = {
  fingerprint: string; masterId: string; serial: string; name: string;
  setName: string; cardNumber: string; rarity: string; sku: string;
  condition: string; finish: string; language: string; status: string;
  available: boolean; location: string; tcgplayerUrl: string | null;
  imageUrl: string | null; costCents: number | null; listPriceCents: number | null;
};
export type OrderData = {
  fingerprint: string; reference: string; status: string; copyIds: string[];
  createdAt: string; storeCommandId: string | null;
};
export type BulkEvent = { sequence: number; entityId: string } & (
  { kind: 'copy'; data: CopyData } | { kind: 'order'; data: OrderData } |
  { kind: 'delete' | 'order_delete'; data: null }
);
export type BulkReceipt = { commandId: string; status: 'applied' | 'rejected'; message: string; appliedSequence: number };
export type SyncInput = {
  protocol: 1; warehouseId: string; workspace: Workspace; name: string; after: number;
  events: BulkEvent[]; receipts: BulkReceipt[];
};
export type CommandSale = {
  unitPriceCents: number; unitCostCents: number | null; soldAt: string;
  channel: string; paymentMethod: string; taxCents: number; discountCents: number;
};
export type CommandInput = {
  requestId: string; kind: 'remove' | 'sale'; warehouseId: string;
  copies: { copyId: string; expectedFingerprint: string }[];
  note: string; sale: CommandSale | null;
};
export type NativeOrderSaleInput = {
  requestId: string; warehouseId: string; orderId: string; expectedFingerprint: string; copyIds: string[]; note: string;
  sale: { subtotalCents: number; discountCents: number; taxCents: number; totalCostCents: number | null;
    soldAt: string; channel: string; paymentMethod: string };
};
export type BulkCopy = { warehouseId: string; copyId: string; sequence: number; data: CopyData; pending: boolean };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BulkError(400, 'A JSON object is required.');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new BulkError(400, 'Unsupported request field.');
}
export function boundedText(value: unknown, max = 300, optional = false): string {
  if (optional && (value === undefined || value === null)) return '';
  // Python's native journal counts Unicode code points. Keep the wire contract
  // identical so a supplementary character cannot make a durable batch fail.
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!optional && !value.trim())) throw new BulkError(400, 'A required text field is missing or too long.');
  return value;
}
export function uuid(value: unknown): string {
  const text = boundedText(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(text)) throw new BulkError(400, 'Invalid request or warehouse identifier.');
  return text;
}
export function integer(value: unknown, min = 0, max = 2_000_000_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new BulkError(400, 'Invalid quantity, sequence, or amount.');
  return value;
}
function nullableMoney(value: unknown): number | null { return value === null || value === undefined ? null : integer(value); }
function fingerprint(value: unknown): string {
  const text = boundedText(value, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new BulkError(400, 'A current card comparison is required.');
  return text;
}
function https(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = boundedText(value, 2000);
  try { const url = new URL(text); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); return text; }
  catch { throw new BulkError(400, 'Card links must use HTTPS.'); }
}
export function parseCopy(value: unknown): CopyData {
  const v = object(value);
  exactKeys(v, ['fingerprint', 'masterId', 'serial', 'name', 'setName', 'cardNumber', 'rarity', 'sku', 'condition', 'finish', 'language', 'status', 'available', 'location', 'tcgplayerUrl', 'imageUrl', 'costCents', 'listPriceCents']);
  if (typeof v.available !== 'boolean') throw new BulkError(400, 'Physical availability is required.');
  return {
    fingerprint: fingerprint(v.fingerprint), masterId: boundedText(v.masterId, 200), serial: boundedText(v.serial, 160), name: boundedText(v.name, 500),
    setName: boundedText(v.setName, 300, true), cardNumber: boundedText(v.cardNumber, 80, true), rarity: boundedText(v.rarity, 100, true), sku: boundedText(v.sku, 250, true),
    condition: boundedText(v.condition, 100, true), finish: boundedText(v.finish, 100, true), language: boundedText(v.language, 100, true),
    status: boundedText(v.status, 60), available: v.available, location: boundedText(v.location, 500, true),
    tcgplayerUrl: https(v.tcgplayerUrl), imageUrl: https(v.imageUrl), costCents: nullableMoney(v.costCents), listPriceCents: nullableMoney(v.listPriceCents),
  };
}
export function parseOrder(value: unknown): OrderData {
  const v = object(value);
  exactKeys(v, ['fingerprint', 'reference', 'status', 'copyIds', 'createdAt', 'storeCommandId']);
  if (!Array.isArray(v.copyIds) || v.copyIds.length > BULK_ORDER_COPY_LIMIT) throw new BulkError(400, 'A bounded native order card list is required.');
  const copyIds = v.copyIds.map(id => boundedText(id, 160));
  if (new Set(copyIds).size !== copyIds.length) throw new BulkError(400, 'A physical copy can appear only once in an order.');
  const createdAt = boundedText(v.createdAt, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) {
    throw new BulkError(400, 'Use the native order creation timestamp in ISO format.');
  }
  return { fingerprint: fingerprint(v.fingerprint), reference: boundedText(v.reference, 300, true), status: boundedText(v.status, 60),
    copyIds, createdAt, storeCommandId: v.storeCommandId === null || v.storeCommandId === undefined ? null : uuid(v.storeCommandId) };
}
export function parseSync(value: unknown): SyncInput {
  const v = object(value);
  exactKeys(v, ['protocol', 'warehouseId', 'workspace', 'name', 'after', 'events', 'receipts']);
  if (v.protocol !== BULK_PROTOCOL || !WORKSPACES.includes(v.workspace as Workspace)) throw new BulkError(400, 'Unsupported warehouse protocol or workspace.');
  if (!Array.isArray(v.events) || v.events.length > BULK_EVENT_LIMIT || !Array.isArray(v.receipts) || v.receipts.length > BULK_COMMAND_LIMIT) throw new BulkError(400, 'The sync batch is too large.');
  const after = integer(v.after), events: BulkEvent[] = v.events.map((raw, index) => {
    const event = object(raw); exactKeys(event, ['sequence', 'kind', 'entityId', 'data']);
    const sequence = integer(event.sequence, 1);
    if (sequence !== after + index + 1) throw new BulkError(409, 'The warehouse change sequence has a gap. Retry the saved batch.');
    const entityId = boundedText(event.entityId, 160);
    if (event.kind === 'copy') return { sequence, entityId, kind: 'copy', data: parseCopy(event.data) };
    if (event.kind === 'order') return { sequence, entityId, kind: 'order', data: parseOrder(event.data) };
    if (event.kind !== 'delete' && event.kind !== 'order_delete') throw new BulkError(400, 'Unsupported warehouse change type.');
    if (event.data !== null) throw new BulkError(400, 'A deleted card or order must have an empty payload.');
    return { sequence, entityId, kind: event.kind, data: null };
  });
  const receiptIds = new Set<string>();
  const receipts: BulkReceipt[] = v.receipts.map(raw => {
    const r = object(raw); exactKeys(r, ['commandId', 'status', 'message', 'appliedSequence']);
    const commandId = uuid(r.commandId);
    if (receiptIds.has(commandId) || !['applied', 'rejected'].includes(String(r.status))) throw new BulkError(400, 'Invalid warehouse receipt.');
    receiptIds.add(commandId);
    return { commandId, status: r.status as BulkReceipt['status'], message: boundedText(r.message, 500, true), appliedSequence: integer(r.appliedSequence) };
  });
  return { protocol: 1, warehouseId: uuid(v.warehouseId), workspace: v.workspace as Workspace, name: boundedText(v.name, 160), after, events, receipts };
}
export function parseCommand(value: unknown): CommandInput {
  const v = object(value);
  exactKeys(v, ['requestId', 'kind', 'warehouseId', 'copies', 'note', 'sale']);
  if (!['remove', 'sale'].includes(String(v.kind)) || !Array.isArray(v.copies) || !v.copies.length || v.copies.length > BULK_COMMAND_LIMIT) throw new BulkError(400, 'Select 1–100 cards for one warehouse action.');
  const seen = new Set<string>();
  const copies = v.copies.map(raw => {
    const c = object(raw); exactKeys(c, ['copyId', 'expectedFingerprint']);
    const copyId = boundedText(c.copyId, 160);
    if (seen.has(copyId)) throw new BulkError(400, 'A physical card can only be selected once.');
    seen.add(copyId); return { copyId, expectedFingerprint: fingerprint(c.expectedFingerprint) };
  }).sort((a, b) => a.copyId < b.copyId ? -1 : a.copyId > b.copyId ? 1 : 0);
  let sale: CommandSale | null = null;
  if (v.kind === 'sale') {
    const s = object(v.sale); exactKeys(s, ['unitPriceCents', 'unitCostCents', 'soldAt', 'channel', 'paymentMethod', 'taxCents', 'discountCents']);
    const unitPriceCents = integer(s.unitPriceCents, 1, 20_000_000), subtotal = unitPriceCents * copies.length;
    const soldAt = boundedText(s.soldAt, 40); const date = new Date(soldAt);
    if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 300_000 || date.getTime() < Date.UTC(2000, 0, 1)) throw new BulkError(400, 'Use a valid sale date.');
    sale = { unitPriceCents, unitCostCents: nullableMoney(s.unitCostCents), soldAt: date.toISOString(), channel: boundedText(s.channel, 100), paymentMethod: boundedText(s.paymentMethod, 100), taxCents: integer(s.taxCents, 0, 20_000_000), discountCents: integer(s.discountCents, 0, subtotal) };
  } else if (v.sale !== undefined && v.sale !== null) throw new BulkError(400, 'A stock removal is not a sale.');
  return { requestId: uuid(v.requestId), warehouseId: uuid(v.warehouseId), kind: v.kind as CommandInput['kind'], copies, note: boundedText(v.note, 500, true), sale };
}
export function orderSaleQuery(url: URL) {
  for (const key of url.searchParams.keys()) {
    if (!['warehouseId', 'orderId'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new BulkError(400, 'Unsupported native order parameter.');
  }
  return { warehouseId: uuid(url.searchParams.get('warehouseId')), orderId: boundedText(url.searchParams.get('orderId'), 160) };
}
export function parseNativeOrderSale(value: unknown): NativeOrderSaleInput {
  const v = object(value);
  exactKeys(v, ['requestId', 'warehouseId', 'orderId', 'expectedFingerprint', 'copyIds', 'note', 'sale']);
  if (!Array.isArray(v.copyIds) || !v.copyIds.length || v.copyIds.length > BULK_ORDER_COPY_LIMIT) throw new BulkError(400, 'Select a native order containing 1–50,000 physical copies.');
  const copyIds = v.copyIds.map(id => boundedText(id, 160)).sort();
  if (new Set(copyIds).size !== copyIds.length) throw new BulkError(400, 'An order cannot contain duplicate physical copy IDs.');
  const s = object(v.sale);
  exactKeys(s, ['subtotalCents', 'discountCents', 'taxCents', 'totalCostCents', 'soldAt', 'channel', 'paymentMethod']);
  const subtotalCents = integer(s.subtotalCents);
  const soldAt = boundedText(s.soldAt, 40), date = new Date(soldAt);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 300_000 || date.getTime() < Date.UTC(2000, 0, 1)) throw new BulkError(400, 'Enter the actual sale date.');
  return { requestId: uuid(v.requestId), warehouseId: uuid(v.warehouseId), orderId: boundedText(v.orderId, 160),
    expectedFingerprint: fingerprint(v.expectedFingerprint), copyIds, note: boundedText(v.note, 500, true),
    sale: { subtotalCents, discountCents: integer(s.discountCents, 0, subtotalCents), taxCents: integer(s.taxCents),
      totalCostCents: nullableMoney(s.totalCostCents), soldAt: date.toISOString(), channel: boundedText(s.channel, 100), paymentMethod: boundedText(s.paymentMethod, 100) } };
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export async function readBulkBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new BulkError(415, 'JSON is required.');
  const length = Number(request.headers.get('content-length') || 0);
  if (!Number.isFinite(length) || length < 0 || length > BULK_BODY_LIMIT) throw new BulkError(413, 'The sync batch is too large.');
  if (!request.body) throw new BulkError(400, 'JSON is required.');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > BULK_BODY_LIMIT) { await reader.cancel(); throw new BulkError(413, 'The sync batch is too large.'); } chunks.push(value); } }
  finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BulkError(400, 'Invalid JSON.'); }
}
