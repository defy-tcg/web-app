import { createHash, randomUUID } from "node:crypto";
import type { Catalog, CatalogCard, SinglesIntakeRow } from "./types.ts";

export class SinglesError extends Error {
  code: string;
  retryable: boolean;
  uncertain: boolean;
  constructor(code: string, message: string, retryable = false, uncertain = false) {
    super(message);
    this.name = "SinglesError";
    this.code = code;
    this.retryable = retryable;
    this.uncertain = uncertain;
  }
}

const CONDITIONS = { "Near Mint": "NM", "Lightly Played": "LP", "Moderately Played": "MP", "Heavily Played": "HP", Damaged: "DMG" } as const;
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const LEASE_MS = 120_000;
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface PlannedSingle extends SinglesIntakeRow { card: CatalogCard; sku: string; catalogId: string }
export interface SinglesPreview { rows: PlannedSingle[]; totalQuantity: number; totalCostCents: number; totalPriceCents: number }

export function previewSingles(rows: SinglesIntakeRow[], catalog: Catalog): SinglesPreview {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) throw new SinglesError("INVALID_ROWS", "Provide between 1 and 100 singles rows.");
  const cards = new Map(catalog.cards.map(card => [card.key, card]));
  if (cards.size !== catalog.cards.length) throw new SinglesError("CATALOG_INVALID", "The catalog contains duplicate identities. Refresh it before receiving.");
  const identities = new Set<string>();
  const planned = rows.map((row, index) => {
    if (!row || typeof row !== "object") throw new SinglesError("INVALID_ROW", `Row ${index + 1} is invalid.`);
    const card = cards.get(row.cardKey);
    if (!card || card.language !== "English" || !Number.isSafeInteger(card.productId) || card.productId < 1 || !card.finish) throw new SinglesError("UNKNOWN_CARD", `Row ${index + 1} does not match an English catalog printing.`);
    if (!Object.hasOwn(CONDITIONS, row.condition)) throw new SinglesError("INVALID_CONDITION", `Row ${index + 1} needs a supported condition.`);
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 100_000) throw new SinglesError("INVALID_QUANTITY", `Row ${index + 1} needs a whole quantity between 1 and 100,000.`);
    for (const field of ["costCents", "priceCents"] as const) {
      if (!Number.isSafeInteger(row[field]) || row[field] < 0 || row[field] > 100_000_000) throw new SinglesError("INVALID_MONEY", `Row ${index + 1} needs a nonnegative ${field === "costCents" ? "cost" : "sale price"} in whole cents.`);
    }
    const condition = CONDITIONS[row.condition as keyof typeof CONDITIONS];
    const identity = JSON.stringify([card.productId, card.finish, card.language, row.condition]);
    if (identities.has(identity)) throw new SinglesError("DUPLICATE_IDENTITY", `Row ${index + 1} repeats the same card, finish, language, and condition. Combine its quantities first.`);
    identities.add(identity);
    return { cardKey: row.cardKey, condition: row.condition, quantity: row.quantity, costCents: row.costCents, priceCents: row.priceCents, card: { ...card },
      sku: `DEFY-RFB-S${card.productId}-${digest(card.finish).slice(0, 12).toUpperCase()}-EN-${condition}`,
      catalogId: `single:riftbound:${card.productId}:${encodeURIComponent(card.finish)}:English:${condition}` };
  });
  const total = (field: "quantity" | "costCents" | "priceCents") => planned.reduce((sum, row) => sum + (field === "quantity" ? row.quantity : row[field] * row.quantity), 0);
  return { rows: planned, totalQuantity: total("quantity"), totalCostCents: total("costCents"), totalPriceCents: total("priceCents") };
}

export interface SinglesConnectionStatus {
  configured: boolean; ready: boolean; shop: string; locationId: string; locationName: string; currencyCode: string;
  canPublish: boolean; blockers: string[]; publicationBlockers: string[];
}
export interface SinglesContext {
  shopId: string; shop: string; locationId: string; locationName: string; currencyCode: string;
  receivingNamespace: string; publicationIds: string[];
}
export interface SingleProduct { productId: string; variantId: string; inventoryItemId: string; sku: string }
export interface ReceiptRow extends PlannedSingle {
  product?: SingleProduct; metadataApplied?: boolean; activated?: boolean; activationStartedAt?: number;
  adjustmentStartedAt?: number; adjustmentId?: string; adjustmentRejected?: string; published?: boolean;
}
export interface SinglesReceipt {
  version: 1; requestId: string; fingerprint: string; startedAt: number; status: "pending" | "complete" | "rejected";
  publish: boolean; context: SinglesContext; rows: ReceiptRow[];
  terminalError?: { code: string; message: string; retryable: boolean; uncertain: boolean };
}
interface PreflightRejection {
  version: 1; preflightRejected: true; requestId: string; fingerprint: string; status: "rejected";
  publish: boolean; rows: SinglesIntakeRow[];
  terminalError: { code: string; message: string; retryable: false; uncertain: false };
}
type StoredReceipt = SinglesReceipt | PreflightRejection;
export interface JournalLock {
  version: 1; requestId: string; fingerprint: string; owner: string | null; expiresAt: number;
}
export interface Snapshot<T> { value: T | null; digest: string | null }
export interface SinglesAdapter {
  preflight(publish: boolean): Promise<SinglesContext>;
  now(): Promise<number>;
  read<T>(key: string): Promise<Snapshot<T>>;
  cas<T>(key: string, snapshot: Snapshot<T>, value: T): Promise<boolean>;
  resolve(row: PlannedSingle, context: SinglesContext, previous?: SingleProduct): Promise<SingleProduct>;
  metadata(row: PlannedSingle, item: SingleProduct): Promise<void>;
  activate(row: ReceiptRow, context: SinglesContext, requestId: string, index: number): Promise<void>;
  adjust(row: ReceiptRow, context: SinglesContext, requestId: string, index: number): Promise<string>;
  publish(row: ReceiptRow, context: SinglesContext): Promise<void>;
}
export interface SinglesReceiveInput { requestId: string; rows: SinglesIntakeRow[]; publish: boolean }
export interface SinglesResult {
  requestId: string; status: "complete" | "pending" | "rejected"; completedRows: number; totalRows: number;
  rows: { cardKey: string; condition: string; quantity: number; sku: string; productId?: string; variantId?: string; inventoryItemId?: string; adjustmentId?: string; received: boolean; published: boolean }[];
  error?: { code: string; message: string; retryable: boolean; uncertain: boolean };
}

const receiptKey = (requestId: string) => `r_${digest(requestId).slice(0, 60)}`;
const LOCK_KEY = "intake_journal_v1";
const fingerprintFor = (rows: SinglesIntakeRow[], publish: boolean) => digest(JSON.stringify({ rows: Array.isArray(rows) ? rows.map(row => row && ({ cardKey: row.cardKey, condition: row.condition, quantity: row.quantity, costCents: row.costCents, priceCents: row.priceCents })) : rows, publish }));
function result(receipt: SinglesReceipt, error?: unknown): SinglesResult {
  const failure = error instanceof SinglesError ? error : error ? new SinglesError("SHOPIFY_UNAVAILABLE", "Shopify did not confirm this receipt. Retry the same saved request.", true, true) : undefined;
  return { requestId: receipt.requestId, status: receipt.status, completedRows: receipt.rows.filter(row => row.adjustmentId && (!receipt.publish || row.published)).length, totalRows: receipt.rows.length,
    rows: receipt.rows.map(row => ({ cardKey: row.cardKey, condition: row.condition, quantity: row.quantity, sku: row.sku, ...row.product, adjustmentId: row.adjustmentId, received: Boolean(row.adjustmentId), published: Boolean(row.published) })),
    ...(receipt.terminalError ? { error: receipt.terminalError } : failure ? { error: { code: failure.code, message: failure.message, retryable: failure.retryable, uncertain: failure.uncertain } } : {}) };
}

function validateReceipt(value: SinglesReceipt, requestId: string, fingerprint: string) {
  if (value.version !== 1 || value.requestId !== requestId || !Array.isArray(value.rows) || !value.rows.length || value.rows.length > 100 || !value.context?.shopId || !value.context?.locationId || !["pending", "complete", "rejected"].includes(value.status) || !Number.isFinite(value.startedAt) || typeof value.publish !== "boolean" || value.fingerprint !== fingerprintFor(value.rows, value.publish)) throw new SinglesError("RECEIPT_INVALID", "The durable receipt is damaged. Keep this request ID for owner review.", false, true);
  if (value.fingerprint !== fingerprint) throw new SinglesError("REQUEST_CONFLICT", "This request ID already belongs to different cards, quantities, costs, prices, or publish settings. Restore its original contents.", false, true);
  if (value.status === "complete" && value.rows.some(row => !row.adjustmentId || (value.publish && !row.published))) throw new SinglesError("RECEIPT_INVALID", "The completed receipt is missing confirmed inventory or publication results.", false, true);
  if (value.status === "rejected" && (!value.terminalError || value.rows.some(row => (row.adjustmentStartedAt && !row.adjustmentRejected) || row.adjustmentId))) throw new SinglesError("RECEIPT_INVALID", "The rejected receipt contains an inconsistent inventory result.", false, true);
}

const isPreflightRejection = (value: StoredReceipt): value is PreflightRejection => "preflightRejected" in value && value.preflightRejected === true;
function validateStored(value: StoredReceipt, requestId: string, fingerprint: string) {
  if (!isPreflightRejection(value)) return validateReceipt(value, requestId, fingerprint);
  if (value.version !== 1 || value.status !== "rejected" || value.requestId !== requestId || !value.terminalError || value.fingerprint !== fingerprintFor(value.rows, value.publish)) throw new SinglesError("RECEIPT_INVALID", "The saved preflight rejection is damaged. Keep its request ID for owner review.", false, true);
  if (value.fingerprint !== fingerprint) throw new SinglesError("REQUEST_CONFLICT", "This request ID already belongs to different intake contents. Use the original saved request.", false, true);
}
function preflightResult(receipt: PreflightRejection): SinglesResult {
  return { requestId: receipt.requestId, status: "rejected", completedRows: 0, totalRows: receipt.rows.length, rows: [], error: receipt.terminalError };
}
async function clearTerminalLock(adapter: SinglesAdapter, requestId: string, fingerprint: string) {
  try {
    const stale = await adapter.read<JournalLock>(LOCK_KEY);
    if (stale.value?.requestId === requestId && stale.value.fingerprint === fingerprint) await adapter.cas(LOCK_KEY, stale, { version: 1, requestId: "", fingerprint: "", owner: null, expiresAt: 0 });
  } catch { /* The next intake also repairs terminal journal reservations. */ }
}

async function rejectBeforeReservation(adapter: SinglesAdapter, input: SinglesReceiveInput, fingerprint: string, error: SinglesError): Promise<SinglesResult> {
  const key = receiptKey(input.requestId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await adapter.read<StoredReceipt>(key);
    if (current.value) {
      validateStored(current.value, input.requestId, fingerprint);
      if (isPreflightRejection(current.value)) return preflightResult(current.value);
      // Another worker may have reserved this ID while preflight was checking it.
      return result(current.value, current.value.status === "pending" ? new SinglesError("RECEIPT_PENDING", "This request is already reserved. Retry its original contents after restoring the connection.", true, true) : undefined);
    }
    const lock = await adapter.read<JournalLock>(LOCK_KEY);
    if (lock.value?.requestId === input.requestId && lock.value.fingerprint !== fingerprint) throw new SinglesError("REQUEST_CONFLICT", "The reserved request ID has different contents.", false, true);
    const rejected: PreflightRejection = { version: 1, preflightRejected: true, requestId: input.requestId, fingerprint, status: "rejected", publish: input.publish, rows: input.rows,
      terminalError: { code: error.code, message: `${error.message} No stock was received. Edit the unreceived row to try again.`, retryable: false, uncertain: false } };
    // The receipt key is also the stock worker's first CAS fence. Only one can win;
    // a worker that loses this reservation cannot create products or adjust inventory.
    if (await adapter.cas(key, current, rejected)) {
      const verified = await adapter.read<StoredReceipt>(key);
      if (!verified.value) throw new SinglesError("RECEIPT_UNCERTAIN", "The rejected request could not be confirmed. Retry the same request.", true, true);
      validateStored(verified.value, input.requestId, fingerprint);
      if (!isPreflightRejection(verified.value)) throw new SinglesError("RECEIPT_UNCERTAIN", "The rejected request changed unexpectedly. Retry the same request.", true, true);
      await clearTerminalLock(adapter, input.requestId, fingerprint);
      return preflightResult(verified.value);
    }
  }
  throw new SinglesError("RECEIPT_BUSY", "This request changed during preflight. Retry its original contents.", true, true);
}

/** The adapter is injectable for fault/retry tests. Production credentials are loaded only on invocation. */
export async function receiveSingles(input: SinglesReceiveInput, catalog: Catalog, injectedAdapter?: SinglesAdapter): Promise<SinglesResult> {
  if (!input || typeof input.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)) throw new SinglesError("INVALID_REQUEST_ID", "Use a unique request ID of 16–100 letters, numbers, underscores, or dashes.");
  if (typeof input.publish !== "boolean") throw new SinglesError("INVALID_PUBLISH", "Choose whether this receipt should publish its cards.");
  // Fingerprint only submitted fields, before consulting a refreshed catalog. Recovery uses the frozen card snapshot.
  const fingerprint = fingerprintFor(input.rows, input.publish);
  const adapter = injectedAdapter ?? await (await import("./shopify.ts")).createSinglesAdapter();
  const key = receiptKey(input.requestId);
  const initial = await adapter.read<StoredReceipt>(key);
  if (initial.value) {
    validateStored(initial.value, input.requestId, fingerprint);
    if (initial.value.status === "complete" || initial.value.status === "rejected") {
      // A worker can finish the receipt and lose the response to its journal unlock.
      await clearTerminalLock(adapter, input.requestId, fingerprint);
      return isPreflightRejection(initial.value) ? preflightResult(initial.value) : result(initial.value);
    }
  }
  let saved: Snapshot<SinglesReceipt> = { value: initial.value as SinglesReceipt | null, digest: initial.digest };
  let preview: SinglesPreview | null = null;
  let context: SinglesContext;
  try {
    preview = saved.value ? null : previewSingles(input.rows, catalog);
    if (input.publish && (saved.value?.rows ?? preview!.rows).some(row => row.priceCents <= 0)) throw new SinglesError("PRICE_REQUIRED", "Every published single needs a sale price greater than zero.");
    context = await adapter.preflight(input.publish);
  } catch (error) {
    if (!saved.value && Array.isArray(input.rows) && error instanceof SinglesError && !error.retryable && !error.uncertain) return rejectBeforeReservation(adapter, input, fingerprint, error);
    throw error;
  }
  if (saved.value && (context.shopId !== saved.value.context.shopId || context.locationId !== saved.value.context.locationId)) throw new SinglesError("CONNECTION_CHANGED", "This receipt belongs to a different Shopify shop or location. Restore its original connection before retrying.", false, true);
  const owner = randomUUID();
  let lock: Snapshot<JournalLock>;
  let now = await adapter.now();
  for (let attempt = 0; ; attempt++) {
    lock = await adapter.read<JournalLock>(LOCK_KEY);
    if (lock.value) {
      if (lock.value.version !== 1) throw new SinglesError("JOURNAL_INVALID", "The singles transaction journal needs owner review.", false, true);
      if (lock.value.requestId && lock.value.requestId !== input.requestId) {
        const prior = await adapter.read<StoredReceipt>(receiptKey(lock.value.requestId));
        if ((prior.value?.status === "complete" || prior.value?.status === "rejected") && prior.value.requestId === lock.value.requestId && prior.value.fingerprint === lock.value.fingerprint) {
          validateStored(prior.value, lock.value.requestId, lock.value.fingerprint);
          if (await adapter.cas(LOCK_KEY, lock, { version: 1, requestId: "", fingerprint: "", owner: null, expiresAt: 0 })) { now = await adapter.now(); continue; }
        }
        throw new SinglesError("OTHER_RECEIPT_PENDING", `Finish pending singles request ${lock.value.requestId} before starting another.`, true, true);
      }
      if (lock.value.requestId === input.requestId && lock.value.fingerprint !== fingerprint) throw new SinglesError("REQUEST_CONFLICT", "This pending request ID has different contents.", false, true);
      if (lock.value.owner && lock.value.expiresAt > now) throw new SinglesError("RECEIPT_BUSY", "This receipt is still processing. Retry the same request shortly.", true, true);
    }
    const value: JournalLock = { version: 1, requestId: input.requestId, fingerprint, owner, expiresAt: now + LEASE_MS };
    if (await adapter.cas(LOCK_KEY, lock, value)) break;
    if (attempt >= 3) throw new SinglesError("RECEIPT_BUSY", "Another singles receipt is reserving the journal. Retry the same request.", true);
  }

  let receipt = saved.value;
  let confirmedTerminal = receipt?.status === "complete" || receipt?.status === "rejected";
  let failure: unknown;
  try {
    // Re-read after acquiring the execution lease; another invocation may have completed while we waited.
    const reserved = await adapter.read<StoredReceipt>(key);
    if (reserved.value && isPreflightRejection(reserved.value)) {
      validateStored(reserved.value, input.requestId, fingerprint);
      confirmedTerminal = true;
      return preflightResult(reserved.value);
    }
    saved = { value: reserved.value, digest: reserved.digest };
    if (saved.value) {
      validateReceipt(saved.value, input.requestId, fingerprint);
      receipt = saved.value;
      confirmedTerminal = receipt.status === "complete" || receipt.status === "rejected";
    } else {
      receipt = { version: 1, requestId: input.requestId, fingerprint, startedAt: now, status: "pending", publish: input.publish, context, rows: preview!.rows };
      if (!await adapter.cas(key, saved, receipt)) throw new SinglesError("RECEIPT_BUSY", "The receipt changed while reserving it. Retry the same request.", true, true);
      saved = await adapter.read<SinglesReceipt>(key);
      if (!saved.value) throw new SinglesError("RECEIPT_UNCERTAIN", "The reserved receipt could not be read back. Retry the same request.", true, true);
    }

    const guard = async () => {
      const current = await adapter.read<JournalLock>(LOCK_KEY);
      const clock = await adapter.now();
      if (!current.value || current.value.owner !== owner || current.value.requestId !== input.requestId || current.value.expiresAt - clock < 30_000) throw new SinglesError("LEASE_EXPIRED", "This receipt paused at its time limit. Retry the same request to continue.", true, true);
      if (current.value.expiresAt - clock < 90_000 && !await adapter.cas(LOCK_KEY, current, { ...current.value, expiresAt: clock + LEASE_MS })) throw new SinglesError("LEASE_EXPIRED", "The receipt execution lease changed. Retry the same saved request.", true, true);
    };
    const persist = async () => {
      await guard();
      if (!await adapter.cas(key, saved, receipt!)) throw new SinglesError("RECEIPT_CONFLICT", "The receipt changed during processing. Retry its original request.", true, true);
      saved = await adapter.read<SinglesReceipt>(key);
      if (!saved.value) throw new SinglesError("RECEIPT_UNCERTAIN", "The saved receipt could not be confirmed. Retry the same request.", true, true);
      confirmedTerminal = saved.value.status === "complete" || saved.value.status === "rejected";
    };
    for (let index = 0; index < receipt.rows.length && receipt.status === "pending"; index++) {
      const row = receipt.rows[index];
      if (row.adjustmentId && (!receipt.publish || row.published)) continue;
      if (row.adjustmentRejected) throw new SinglesError("ADJUSTMENT_REJECTED", row.adjustmentRejected);
      await guard();
      const item = await adapter.resolve(row, receipt.context, row.product);
      row.product = item;
      await persist();
      if (!row.metadataApplied) { await guard(); await adapter.metadata(row, item); row.metadataApplied = true; await persist(); }
      if (!row.activated) {
        if (row.activationStartedAt && await adapter.now() - row.activationStartedAt >= RETRY_WINDOW) throw new SinglesError("ACTIVATION_REVIEW", "An old inventory activation needs owner review before this receipt can continue.", false, true);
        if (!row.activationStartedAt) { row.activationStartedAt = await adapter.now(); await persist(); }
        await guard(); await adapter.activate(row, receipt.context, input.requestId, index); row.activated = true; await persist();
      }
      if (!row.adjustmentId) {
        if (row.adjustmentStartedAt && await adapter.now() - row.adjustmentStartedAt >= RETRY_WINDOW) throw new SinglesError("RETRY_WINDOW_EXPIRED", "An inventory adjustment remains uncertain after 23 hours. Keep this receipt for owner reconciliation; do not create a replacement request.", false, true);
        if (!row.adjustmentStartedAt) { row.adjustmentStartedAt = await adapter.now(); await persist(); }
        await guard();
        try { row.adjustmentId = await adapter.adjust(row, receipt.context, input.requestId, index); }
        catch (error) {
          if (error instanceof SinglesError && error.code === "ADJUSTMENT_REJECTED" && !error.retryable && !error.uncertain) {
            row.adjustmentRejected = error.message;
            await persist();
          }
          throw error;
        }
        if (!row.adjustmentId) throw new SinglesError("ADJUSTMENT_UNCERTAIN", "Shopify did not confirm the inventory adjustment. Retry the same request.", true, true);
        await persist();
      }
      if (receipt.publish && !row.published) { await guard(); await adapter.publish(row, receipt.context); row.published = true; await persist(); }
    }
    if (receipt.status === "pending") { receipt.status = "complete"; await persist(); }
  } catch (error) {
    failure = error;
    // A timed-out journal mutation may have succeeded. Report only durable progress.
    try {
      const current = await adapter.read<StoredReceipt>(key);
      if (current.value) {
        validateStored(current.value, input.requestId, fingerprint);
        if (isPreflightRejection(current.value)) { confirmedTerminal = true; return preflightResult(current.value); }
        receipt = current.value; confirmedTerminal = receipt.status === "complete" || receipt.status === "rejected";
      }
    } catch { /* Preserve the original uncertainty. */ }
    if (receipt && !confirmedTerminal && error instanceof SinglesError && !error.retryable && !error.uncertain && receipt.rows.every(row => (!row.adjustmentStartedAt || row.adjustmentRejected) && !row.adjustmentId)) {
      // A known rejection before stock begins is terminal. Drafts or price metadata may exist,
      // but retaining this rejected receipt prevents its ID from ever receiving stock later.
      try {
        const reservation = await adapter.read<JournalLock>(LOCK_KEY);
        if (reservation.value?.owner !== owner || reservation.value.expiresAt - await adapter.now() < 30_000) throw new Error("Lease changed");
        const current = await adapter.read<SinglesReceipt>(key);
        if (!current.value || current.value.rows.some(row => (row.adjustmentStartedAt && !row.adjustmentRejected) || row.adjustmentId)) throw new Error("Receipt changed");
        validateReceipt(current.value, input.requestId, fingerprint);
        const rejected: SinglesReceipt = { ...current.value, status: "rejected", terminalError: { code: error.code, message: `${error.message} No stock was received. A draft or price update may already exist.`, retryable: false, uncertain: false } };
        if (!await adapter.cas(key, current, rejected)) throw new Error("Receipt changed");
        const verified = await adapter.read<SinglesReceipt>(key);
        if (verified.value?.status !== "rejected") throw new Error("Rejection unconfirmed");
        receipt = verified.value; confirmedTerminal = true;
      } catch {
        failure = new SinglesError("RECEIPT_UNCERTAIN", "The rejected receipt could not be recorded. Retry the same request before changing this row.", true, true);
      }
    }
  } finally {
    // Keep a pending request reserved, but release this worker so the original request can resume.
    try {
      const current = await adapter.read<JournalLock>(LOCK_KEY);
      if (current.value?.owner === owner) await adapter.cas(LOCK_KEY, current, { version: 1, requestId: confirmedTerminal ? "" : input.requestId, fingerprint: confirmedTerminal ? "" : fingerprint, owner: null, expiresAt: 0 });
    } catch { /* Lease expiry permits recovery after a process/network failure. */ }
  }
  if (!receipt) throw failure ?? new SinglesError("RECEIPT_UNCERTAIN", "The receipt reservation is uncertain. Retry the same request.", true, true);
  if (!confirmedTerminal) receipt.status = "pending";
  return result(receipt, receipt.status === "complete" ? undefined : failure);
}

export async function getSinglesConnectionStatus(): Promise<SinglesConnectionStatus> {
  return (await import("./shopify.ts")).getSinglesConnectionStatus();
}
