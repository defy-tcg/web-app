import { randomUUID } from "node:crypto";
import { loadSkuLabelProducts } from "./sku-label-inventory-storage.ts";
import { getSkuLabelShopifyStatuses, linkSkuLabelToShopify } from "./sku-label-shopify.ts";
import { createShopifyGraphQL, ShopifySinglesAdapter } from "./singles/shopify.ts";
import type { Snapshot } from "./singles/intake.ts";

const KEY = "qr_shopify_repair_v1";
type RepairState = { version: 1; afterId: number; lease: { token: string; until: number } | null };
export interface SkuRepairDependencies {
  read(): Promise<Snapshot<RepairState>>;
  cas(snapshot: Snapshot<RepairState>, value: RepairState): Promise<boolean>;
  page(afterId: number): Promise<{ id: number; ready: boolean; link: () => Promise<void> }[]>;
  now(): number;
}

/** Durable cursor + lease; a failed/expired request resumes at the last confirmed card. */
export async function runSkuRepairPage(deps: SkuRepairDependencies) {
  const snapshot = await deps.read();
  const previous = snapshot.value;
  if (previous && (previous.version !== 1 || !Number.isSafeInteger(previous.afterId) || previous.afterId < 0 ||
    (previous.lease && (typeof previous.lease.token !== "string" || !Number.isFinite(previous.lease.until))))) throw new Error("Invalid QR repair checkpoint.");
  if (previous?.lease && previous.lease.until > deps.now()) return { busy: true, checked: 0, attempted: 0, complete: false };
  let state: RepairState = { version: 1, afterId: previous?.afterId ?? 0, lease: { token: randomUUID(), until: deps.now() + 270_000 } };
  if (!await deps.cas(snapshot, state)) return { busy: true, checked: 0, attempted: 0, complete: false };
  const started = deps.now();
  let checked = 0, attempted = 0, complete = false;
  const checkpoint = async (release: boolean) => {
    const current = await deps.read();
    if (current.value?.lease?.token !== state.lease?.token || deps.now() >= state.lease!.until) throw new Error("QR repair lease changed.");
    const next = { ...state, lease: release ? null : state.lease };
    if (!await deps.cas(current, next)) throw new Error("QR repair checkpoint changed.");
    state = next;
  };
  try {
    while (deps.now() - started < 170_000 && checked < 1000 && attempted < 12) {
      const page = await deps.page(state.afterId);
      if (!page.length) { state.afterId = 0; complete = true; break; }
      if (page.length > 100 || page.some((row, i) => !Number.isSafeInteger(row.id) || row.id <= (i ? page[i - 1].id : state.afterId))) throw new Error("Invalid QR repair page.");
      for (const row of page) {
        if (deps.now() - started >= 170_000 || attempted >= 12) break;
        if (!row.ready) { await row.link(); attempted++; }
        state.afterId = row.id;
        checked++;
        await checkpoint(false);
      }
    }
    await checkpoint(true);
    return { busy: false, checked, attempted, complete };
  } catch (error) {
    try { await checkpoint(true); } catch { /* The persisted lease expires before the next repair. */ }
    throw error;
  }
}

export async function repairSavedSkuLinks() {
  const client = await createShopifyGraphQL({ apiVersion: "2026-10" });
  const journal = new ShopifySinglesAdapter(client.graphql, client.settings, client.clock);
  return runSkuRepairPage({
    read: () => journal.read<RepairState>(KEY),
    cas: (snapshot, state) => journal.cas(KEY, snapshot, state),
    now: client.clock,
    page: async afterId => {
      const products = await loadSkuLabelProducts({ afterId });
      const statuses = await getSkuLabelShopifyStatuses(products, client);
      return products.map(product => ({ id: product.id,
        ready: statuses.some(status => status.sku === product.sku && status.status === "ready"),
        link: async () => { await linkSkuLabelToShopify(product, client); },
      }));
    },
  });
}
