import { randomUUID } from "node:crypto";
import { PriceSyncError, type VariantPriceResult } from "./price-sync-core.ts";

export interface PriceSyncState {
  version: 1; runId: string; startedAt: string; finishedAt: string | null; after: string | null;
  checked: number; updated: number; unchanged: number; skipped: number;
  issues: { sku: string; title: string; message: string }[];
  samples: VariantPriceResult[];
  lease: { token: string; until: number } | null;
  lastError: string | null;
}
export interface PriceJournal {
  read(): Promise<{ value: PriceSyncState | null; digest: string | null }>;
  cas(snapshot: { value: PriceSyncState | null; digest: string | null }, value: PriceSyncState): Promise<boolean>;
}
export interface PricePage {
  checked: number; results: VariantPriceResult[];
  issues: PriceSyncState["issues"]; nextCursor: string | null;
}
export function validatePriceState(value: PriceSyncState | null): void {
  if (!value) return;
  if (value.version !== 1 || typeof value.runId !== "string" || !Number.isFinite(Date.parse(value.startedAt))
    || (value.finishedAt !== null && !Number.isFinite(Date.parse(value.finishedAt)))
    || (value.after !== null && (typeof value.after !== "string" || value.after.length > 2048))
    || ![value.checked, value.updated, value.unchanged, value.skipped].every(number => Number.isSafeInteger(number) && number >= 0)
    || !Array.isArray(value.issues) || value.issues.length > 20 || !Array.isArray(value.samples) || value.samples.length > 10
    || (value.lease !== null && (!value.lease || typeof value.lease.token !== "string" || !Number.isFinite(value.lease.until)))) {
    throw new PriceSyncError("JOURNAL_INVALID", "The saved Shopify pricing run needs review before prices can be changed.");
  }
}

/** A durable Shopify metafield lease prevents overlapping manual/scheduled runs. */
export async function runPricePage(input: {
  journal: PriceJournal; runId?: string; automatic?: boolean; now: () => number;
  page: (after: string | null) => Promise<PricePage>;
}): Promise<PriceSyncState> {
  const snapshot = await input.journal.read();
  validatePriceState(snapshot.value);
  const prior = snapshot.value;
  if (input.runId && prior?.runId !== input.runId) throw new PriceSyncError("RUN_CHANGED", "Another pricing run started. Refresh its status before continuing.");
  if (prior?.lease && prior.lease.until > input.now()) throw new PriceSyncError("SYNC_BUSY", "A Shopify price refresh is already running. Check its status shortly.");
  if (prior?.finishedAt && (input.runId || (input.automatic && input.now() - Date.parse(prior.finishedAt) < 23 * 60 * 60 * 1000))) return prior;
  const state: PriceSyncState = prior && !prior.finishedAt ? { ...prior } : {
    version: 1, runId: randomUUID(), startedAt: new Date(input.now()).toISOString(), finishedAt: null, after: null,
    checked: 0, updated: 0, unchanged: 0, skipped: 0, issues: [], samples: [], lease: null, lastError: null,
  };
  state.lease = { token: randomUUID(), until: input.now() + 330_000 };
  state.lastError = null;
  if (!await input.journal.cas(snapshot, state)) throw new PriceSyncError("SYNC_BUSY", "Another refresh acquired this pricing run. Check its status shortly.");
  try {
    const page = await input.page(state.after);
    if (!Number.isSafeInteger(page.checked) || page.checked < 0 || page.checked !== page.results.length + page.issues.length
      || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === state.after || page.nextCursor.length > 2048))) {
      throw new PriceSyncError("PAGINATION_INVALID", "Shopify pricing returned an incomplete page. Retry this saved run.");
    }
    const current = await input.journal.read();
    if (current.value?.lease?.token !== state.lease.token || input.now() >= state.lease.until) throw new PriceSyncError("LEASE_CHANGED", "The pricing lease expired. Resume this saved run.");
    const completed: PriceSyncState = {
      ...state, after: page.nextCursor, finishedAt: page.nextCursor === null ? new Date(input.now()).toISOString() : null,
      checked: state.checked + page.checked, updated: state.updated + page.results.filter(row => row.outcome === "updated").length,
      unchanged: state.unchanged + page.results.filter(row => row.outcome === "unchanged").length,
      skipped: state.skipped + page.issues.length,
      issues: [...state.issues, ...page.issues].slice(0, 20), samples: [...page.results, ...state.samples].slice(0, 10), lease: null,
    };
    if (!await input.journal.cas(current, completed)) throw new PriceSyncError("LEASE_CHANGED", "The price updates succeeded but the checkpoint changed. Resume to verify them.");
    return completed;
  } catch (error) {
    const current = await input.journal.read();
    if (current.value?.lease?.token === state.lease.token) {
      await input.journal.cas(current, { ...state, lease: null, lastError: error instanceof PriceSyncError ? error.message : "The price connection failed. Resume this saved run; confirmed prices are safe to repeat." });
    }
    throw error;
  }
}
