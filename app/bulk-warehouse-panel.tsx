"use client";

import Image from "next/image";
import { groupBulkCopies } from "@/lib/bulk-warehouse/grouping";
import Link from "next/link";
import { startTransition, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { BulkCopy, CommandInput } from "@/lib/bulk-warehouse/model";
import BulkNativeOrderSales, { type NativeOrderForPricing } from "./bulk-native-order-sales";

type Workspace = "all" | "riftbound" | "mtg" | "pokemon";
type StockFilter = "all" | "available" | "unavailable";
type CommandResult = { id: string; kind?: string; status: "pending" | "applied" | "rejected"; message: string; createdAt?: string };
type Warehouse = { id: string; workspace: string; name: string; lastSyncedAt: string | null };
type InventoryPage = {
  copies: BulkCopy[]; total: number; page: number; pageSize: number;
  summary: { total: number; available: number; pending: number };
  warehouses: Warehouse[]; commands: CommandResult[];
  unpricedOrders: NativeOrderForPricing[]; unpricedOrderCount: number;
};
type SavedRequest = { version: 1; body: string; createdAt: string };
type Draft = { kind: "remove" | "sale"; copies: BulkCopy[] };

const STORAGE_KEY = "defy-bulk-warehouse-request:v1";
const LOCK_NAME = "defy-bulk-warehouse-request";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const count = new Intl.NumberFormat("en-US");
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const workspaceNames: Record<string, string> = { riftbound: "Riftbound", mtg: "Magic: The Gathering", pokemon: "Pokémon" };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function amount(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : money.format(value / 100);
}
function dateLabel(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not synced yet";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function localDateTime() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function copyKey(copy: Pick<BulkCopy, "warehouseId" | "copyId">) {
  return `${copy.warehouseId}:${copy.copyId}`;
}
function dollarsToCents(value: string, name: string, max = 20_000_000) {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) throw new Error(`${name} needs a dollar amount with up to two decimal places.`);
  const cents = Math.round(Number(trimmed) * 100);
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > max) throw new Error(`${name} is outside the supported amount.`);
  return cents;
}
function tcgplayerLink(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "tcgplayer.com" || url.hostname.endsWith(".tcgplayer.com")) ? value : null;
  } catch { return null; }
}
function imageLink(value: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? value : null; }
  catch { return null; }
}
function requestPayload(saved: SavedRequest): CommandInput {
  const payload: unknown = JSON.parse(saved.body);
  if (!record(payload) || typeof payload.requestId !== "string" || !UUID.test(payload.requestId) ||
    typeof payload.warehouseId !== "string" || !UUID.test(payload.warehouseId) ||
    !["remove", "sale"].includes(String(payload.kind)) || typeof payload.note !== "string" || payload.note.length > 500 ||
    !Array.isArray(payload.copies) || !payload.copies.length || payload.copies.length > 100 ||
    payload.copies.some(copy => !record(copy) || typeof copy.copyId !== "string" || !copy.copyId || copy.copyId.length > 160 ||
      typeof copy.expectedFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(copy.expectedFingerprint)) ||
    (payload.kind === "sale" && !record(payload.sale))) throw new Error("Invalid saved request");
  return payload as CommandInput;
}
function readSavedRequest(raw: string | null): SavedRequest | null {
  if (raw === null) return null;
  const saved: unknown = JSON.parse(raw);
  if (!record(saved) || saved.version !== 1 || typeof saved.body !== "string" || saved.body.length > 200_000 ||
    typeof saved.createdAt !== "string" || !Number.isFinite(Date.parse(saved.createdAt))) throw new Error("Invalid saved request");
  requestPayload(saved as SavedRequest);
  return saved as SavedRequest;
}
async function withRequestLock<T>(action: () => T | Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("This browser cannot safely save a warehouse request. Open Defy in an updated browser to make inventory changes.");
  return navigator.locks.request(LOCK_NAME, action);
}
function isResult(value: unknown): value is CommandResult {
  return record(value) && typeof value.id === "string" && UUID.test(value.id) &&
    ["pending", "applied", "rejected"].includes(String(value.status)) && typeof value.message === "string";
}
function checkedPage(value: unknown): InventoryPage {
  if (!record(value) || !Array.isArray(value.copies) || value.copies.length > 100 ||
    !Number.isSafeInteger(value.total) || Number(value.total) < 0 ||
    !Number.isSafeInteger(value.page) || Number(value.page) < 1 ||
    !Number.isSafeInteger(value.pageSize) || Number(value.pageSize) < 1 || Number(value.pageSize) > 100 ||
    !record(value.summary) || ["total", "available", "pending"].some(key => !Number.isSafeInteger(value.summary && (value.summary as Record<string, unknown>)[key]) || Number((value.summary as Record<string, unknown>)[key]) < 0) ||
    !Array.isArray(value.warehouses) || !Array.isArray(value.commands) || value.commands.some(command => !isResult(command)) ||
    !Number.isSafeInteger(value.unpricedOrderCount) || Number(value.unpricedOrderCount) < 0 ||
    !Array.isArray(value.unpricedOrders) || value.unpricedOrders.length > 50 || value.unpricedOrders.some(order => !record(order) ||
      typeof order.warehouseId !== "string" || typeof order.orderId !== "string" || typeof order.reference !== "string" ||
      typeof order.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(order.fingerprint) ||
      !Number.isSafeInteger(order.copyCount) || Number(order.copyCount) < 1 || !Array.isArray(order.copyIds) ||
      order.copyIds.length !== order.copyCount || order.copyIds.some(id => typeof id !== "string")) ||
    value.warehouses.some(warehouse => !record(warehouse) || typeof warehouse.id !== "string" || typeof warehouse.name !== "string" || typeof warehouse.workspace !== "string") ||
    value.copies.some(copy => !record(copy) || typeof copy.warehouseId !== "string" || typeof copy.copyId !== "string" ||
      typeof copy.pending !== "boolean" || !record(copy.data) || typeof copy.data.fingerprint !== "string" ||
      typeof copy.data.available !== "boolean" || typeof copy.data.name !== "string" || typeof copy.data.serial !== "string" ||
      typeof copy.data.status !== "string")) throw new Error("Warehouse inventory was incomplete. Refresh to try again.");
  const page = value as InventoryPage;
  if (new Set(page.copies.map(copyKey)).size !== page.copies.length) throw new Error("Warehouse inventory contained repeated copies. Refresh to try again.");
  return page;
}

export default function BulkWarehousePanel() {
  const [filters, setFilters] = useState<{ q: string; workspace: Workspace; status: StockFilter; page: number }>({ q: "", workspace: "all", status: "all", page: 1 });
  const [search, setSearch] = useState("");
  const [view, setView] = useState<{ key: string; data: InventoryPage } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<BulkCopy[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [unitPrice, setUnitPrice] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [saleDate, setSaleDate] = useState("");
  const [channel, setChannel] = useState("In-store");
  const [paymentMethod, setPaymentMethod] = useState("Card");
  const [discount, setDiscount] = useState("0.00");
  const [tax, setTax] = useState("0.00");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState("");
  const [sending, setSending] = useState(false);
  const [saved, setSaved] = useState<SavedRequest | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const mounted = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const posting = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const submitting = useRef(false);
  const savedRef = useRef<SavedRequest | null>(null);
  const observedCommands = useRef(new Map<string, CommandResult["status"]>());
  const composerHeading = useRef<HTMLHeadingElement | null>(null);
  const queryKey = new URLSearchParams({ q: filters.q, workspace: filters.workspace, status: filters.status, page: String(filters.page) }).toString();
  const current = view?.key === queryKey ? view.data : null;

  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++requestSequence.current;
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/bulk-warehouse?${queryKey}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to view Bulk Warehouse." : record(body) && typeof body.error === "string" ? body.error : "Warehouse inventory could not be loaded. Try Refresh.");
      const data = checkedPage(body);
      if (controller.signal.aborted || sequence !== requestSequence.current || !mounted.current) return;
      setView({ key: queryKey, data });
      setLoadError("");
      setSelected(previous => {
        const keep = previous.filter(copy => data.copies.some(latest => copyKey(copy) === copyKey(latest) &&
          latest.data.fingerprint === copy.data.fingerprint && latest.data.available && !latest.pending));
        return keep.length === previous.length ? previous : keep;
      });
      let salesChanged = false;
      for (const command of data.commands) {
        if (command.kind === "sale" && command.status === "applied" && observedCommands.current.get(command.id) !== "applied") salesChanged = true;
        observedCommands.current.set(command.id, command.status);
      }
      if (observedCommands.current.size > 500) observedCommands.current = new Map(data.commands.map(command => [command.id, command.status]));
      if (salesChanged) window.dispatchEvent(new Event("defy-bulk-warehouse-updated"));
    } catch (error) {
      if (!controller.signal.aborted && sequence === requestSequence.current && mounted.current) setLoadError(error instanceof Error ? error.message : "Warehouse inventory could not be loaded.");
    } finally {
      if (!controller.signal.aborted && sequence === requestSequence.current && mounted.current) setLoading(false);
    }
  }, [queryKey]);

  useEffect(() => {
    mounted.current = true;
    const restore = () => {
      try {
        const pending = readSavedRequest(localStorage.getItem(STORAGE_KEY));
        savedRef.current = pending;
        startTransition(() => { setSaved(pending); setStorageError(""); setStorageReady(true); });
      } catch {
        startTransition(() => {
          setStorageReady(true);
          setStorageError("The browser could not read its saved warehouse request. New changes are blocked to prevent a duplicate. Check recent activity before using another browser.");
        });
      }
    };
    restore();
    const changed = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) restore(); };
    window.addEventListener("storage", changed);
    return () => { mounted.current = false; reading.current?.abort(); posting.current?.abort(); window.removeEventListener("storage", changed); };
  }, []);

  useEffect(() => {
    startTransition(() => { void refresh(); });
    const visibleRefresh = () => { if (document.visibilityState === "visible" && !submitting.current) void refresh(true); };
    const interval = window.setInterval(visibleRefresh, 15_000);
    window.addEventListener("focus", visibleRefresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    return () => { reading.current?.abort(); window.clearInterval(interval); window.removeEventListener("focus", visibleRefresh); document.removeEventListener("visibilitychange", visibleRefresh); };
  }, [refresh]);

  useEffect(() => { if (draft) composerHeading.current?.focus(); }, [draft]);

  function changeFilters(next: Partial<typeof filters>) {
    setSelected([]);
    setDraft(null);
    setFilters(previous => ({ ...previous, ...next, page: next.page ?? 1 }));
  }
  function searchInventory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    changeFilters({ q: search.trim() });
  }
  function toggleCopy(copy: BulkCopy) {
    if (draft || sending || saved || storageError || !copy.data.available || copy.pending) return;
    setSelected(previous => {
      if (previous.some(value => copyKey(value) === copyKey(copy))) return previous.filter(value => copyKey(value) !== copyKey(copy));
      if (previous.length >= 100 || (previous.length && previous[0].warehouseId !== copy.warehouseId)) return previous;
      return [...previous, copy];
    });
  }
  function openDraft(kind: Draft["kind"]) {
    if (!selected.length || saved || storageError || sending || loading || !current) return;
    setDraft({ kind, copies: selected });
    setUnitPrice("");
    const knownCost = selected[0].data.costCents;
    setUnitCost(knownCost !== null && knownCost !== undefined && selected.every(copy => copy.data.costCents === knownCost) ? (knownCost / 100).toFixed(2) : "");
    setSaleDate(localDateTime());
    setDiscount("0.00"); setTax("0.00"); setNote(""); setFormError(""); setNotice("");
  }
  async function clearSavedRequest(pending: SavedRequest) {
    await withRequestLock(() => {
      const latest = readSavedRequest(localStorage.getItem(STORAGE_KEY));
      if (latest?.body === pending.body) {
        localStorage.removeItem(STORAGE_KEY);
        if (localStorage.getItem(STORAGE_KEY) !== null) throw new Error("The browser could not clear the confirmed request.");
      } else if (latest) throw new Error("Another warehouse request is saved in this browser. Reload to review it.");
    });
    savedRef.current = null;
    if (mounted.current) setSaved(null);
  }
  async function transmit(pending: SavedRequest) {
    const payload = requestPayload(pending);
    const controller = new AbortController();
    posting.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 25_000);
    try {
      // Send the exact durable body. In particular, never replace the request ID,
      // copies, comparison fingerprints, amount, or sale date on a retry.
      const response = await fetch("/api/bulk-warehouse", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: pending.body, signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) {
        // The API guarantees that a JSON validation 400 happens before command
        // creation. Other failures, including a conflicting ID, stay retryable.
        if (response.status === 400 && record(body) && typeof body.error === "string") await clearSavedRequest(pending);
        throw new Error(response.status === 401 ? "Sign in again, then retry this same saved request." : record(body) && typeof body.error === "string" ? body.error : "The warehouse request was not confirmed. Retry the saved request.");
      }
      if (!isResult(body) || body.id !== payload.requestId) throw new Error("The response could not be matched to this request. Retry the saved request.");
      if (!mounted.current) return;
      if (body.status === "applied" && payload.kind === "sale") {
        observedCommands.current.set(body.id, "applied");
        window.dispatchEvent(new Event("defy-bulk-warehouse-updated"));
      }
      setNotice(body.status === "pending" ? "Request queued. Keep Warehouse Manager open and connected; stock and sales update after it confirms." : body.status === "applied" ? body.message || "Warehouse Manager confirmed the change." : `Not applied. ${body.message || "The copies changed. Refresh and review your selection."}`);
      setDraft(null); setSelected([]);
      try { await clearSavedRequest(pending); setStorageError(""); }
      catch { setStorageError("The server received this request, but the browser could not clear its saved copy. Retry the same request to recover safely."); }
      await refresh(true);
    } catch (error) {
      if (mounted.current) setFormError(controller.signal.aborted ? "The connection timed out before confirmation. Your exact request is saved; retry it to check the result safely." : error instanceof Error ? error.message : "The request was not confirmed. Retry the saved request.");
    } finally { window.clearTimeout(timeout); }
  }
  async function retrySaved() {
    if (submitting.current || !savedRef.current) return;
    submitting.current = true; setSending(true); setFormError("");
    try {
      const pending = await withRequestLock(() => readSavedRequest(localStorage.getItem(STORAGE_KEY)));
      if (!pending || pending.body !== savedRef.current?.body) throw new Error("The saved request changed in another tab. Reload to review it.");
      await transmit(pending);
    } catch (error) { if (mounted.current) setFormError(error instanceof Error ? error.message : "The saved request could not be restored."); }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  }
  async function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !draft || savedRef.current || storageError || loadError || !storageReady) return;
    setFormError("");
    submitting.current = true; setSending(true);
    try {
      if (!current || draft.copies.some(copy => !current.copies.some(latest => copyKey(copy) === copyKey(latest) &&
        latest.data.fingerprint === copy.data.fingerprint && latest.data.available && !latest.pending))) throw new Error("Some selected copies changed. Close this form, refresh, and choose available copies again.");
      const payload: CommandInput = {
        requestId: crypto.randomUUID(), kind: draft.kind, warehouseId: draft.copies[0].warehouseId,
        copies: draft.copies.map(copy => ({ copyId: copy.copyId, expectedFingerprint: copy.data.fingerprint })).sort((a, b) => a.copyId.localeCompare(b.copyId)),
        note: note.trim(), sale: null,
      };
      if (draft.kind === "sale") {
        const price = dollarsToCents(unitPrice, "Sale price");
        if (price < 1) throw new Error("Enter the actual sale price per copy, greater than $0.00.");
        const cost = unitCost.trim() ? dollarsToCents(unitCost, "Cost per copy", 2_000_000_000) : null;
        const discountCents = dollarsToCents(discount || "0", "Discount", price * draft.copies.length);
        const sold = new Date(saleDate);
        if (!Number.isFinite(sold.getTime()) || sold.getTime() > Date.now() + 300_000 || sold.getTime() < Date.UTC(2000, 0, 1)) throw new Error("Use a valid sale date that is not in the future.");
        payload.sale = { unitPriceCents: price, unitCostCents: cost, soldAt: sold.toISOString(), channel, paymentMethod, taxCents: dollarsToCents(tax || "0", "Tax"), discountCents };
      }
      const pending: SavedRequest = { version: 1, body: JSON.stringify(payload), createdAt: new Date().toISOString() };
      await withRequestLock(() => {
        if (localStorage.getItem(STORAGE_KEY) !== null) throw new Error("A warehouse request is already saved in this browser. Reload and retry that request first.");
        const serialized = JSON.stringify(pending);
        localStorage.setItem(STORAGE_KEY, serialized);
        if (localStorage.getItem(STORAGE_KEY) !== serialized) throw new Error("The browser could not preserve this request. No change was sent.");
      });
      savedRef.current = pending; setSaved(pending);
      await transmit(pending);
    } catch (error) { if (mounted.current) setFormError(error instanceof Error ? error.message : "The warehouse request could not be saved. No change was sent."); }
    finally { submitting.current = false; if (mounted.current) setSending(false); }
  }

  const copyRows = current?.copies ?? [];
  const selectedKeys = new Set(selected.map(copyKey));
  const selectedWarehouse = selected[0]?.warehouseId;
  const warehouseMap = new Map((current?.warehouses ?? []).map(warehouse => [warehouse.id, warehouse]));
  const availableOnPage = copyRows.filter(copy => copy.data.available && !copy.pending && (!selectedWarehouse || selectedWarehouse === copy.warehouseId));
  const canSelectPage = availableOnPage.length > 0 && new Set(availableOnPage.map(copy => copy.warehouseId)).size === 1;
  const actionsDisabled = !storageReady || Boolean(storageError) || Boolean(loadError) || Boolean(saved) || sending || Boolean(draft) || loading || !current;
  const draftStale = Boolean(draft && (!current || draft.copies.some(copy => !copyRows.some(latest => copyKey(copy) === copyKey(latest) && latest.data.fingerprint === copy.data.fingerprint && latest.data.available && !latest.pending))));
  const totalPages = current ? Math.max(1, Math.ceil(current.total / current.pageSize)) : 1;
  let previewTotal: number | null = null;
  if (draft?.kind === "sale") {
    try { const subtotal = dollarsToCents(unitPrice, "Price") * draft.copies.length; previewTotal = subtotal - dollarsToCents(discount || "0", "Discount", subtotal) + dollarsToCents(tax || "0", "Tax"); }
    catch { /* The form reports invalid amounts on submit. */ }
  }
  const savedPayload = saved ? requestPayload(saved) : null;

  return <section className="bulk-warehouse" aria-labelledby="bulk-warehouse-title">
    <header className="bw-heading">
      <div><p className="bw-eyebrow">SCANNED CARD INVENTORY</p><h2 id="bulk-warehouse-title">Bulk Warehouse</h2><p>Expand a card printing to see its physical copies. Keep Warehouse Manager open to sync scans and confirm changes from Defy Store OS.</p></div>
      <button type="button" className="bw-button" disabled={loading || sending} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh inventory"}</button>
    </header>

    <div className="bw-summary" aria-label="Warehouse inventory totals">
      <div><span>Total copies</span><strong>{current ? count.format(current.summary.total) : "—"}</strong></div>
      <div><span>Available copies</span><strong>{current ? count.format(current.summary.available) : "—"}</strong></div>
      <div><span>Pending changes</span><strong>{current ? count.format(current.summary.pending) : "—"}</strong></div>
    </div>

    <details className="bw-connections">
      <summary><span>Warehouse connections</span><span>{current ? `${current.warehouses.length} connected` : "Loading…"}</span></summary>
      {current?.warehouses.length ? <ul>{current.warehouses.map(warehouse => <li key={warehouse.id}><div><strong>{warehouse.name}</strong><small>{workspaceNames[warehouse.workspace] || warehouse.workspace}</small></div><span>Last sync <time dateTime={warehouse.lastSyncedAt || undefined}>{dateLabel(warehouse.lastSyncedAt)}</time></span></li>)}</ul> : <p>No warehouse has synced yet. Open Warehouse Manager on your Mac and connect your approved Defy account.</p>}
      <Link href="/native-warehouse">Manage connected devices</Link>
    </details>

    <p className="bw-guidance"><strong>Add cards in Warehouse Manager.</strong> Scan, review, and store them in the correct physical location. Synced copies appear here automatically.</p>
    {loadError && <p className="bw-alert bw-alert-error" role="alert">{loadError}</p>}
    {storageError && <p className="bw-alert bw-alert-error" role="alert">{storageError}</p>}
    {notice && <p className="bw-alert" role="status">{notice}</p>}
    {formError && <p className="bw-alert bw-alert-error" role="alert">{formError}</p>}
    {saved && savedPayload && <div className="bw-retry" role="status">
      <div><strong>Confirm your saved {savedPayload.kind === "sale" ? "sale" : "removal"} request</strong><p>{count.format(savedPayload.copies.length)} {savedPayload.copies.length === 1 ? "copy" : "copies"} · Saved {dateLabel(saved.createdAt)}. Retry checks the same request and cannot create a second one.</p><details><summary>Request and copy IDs</summary><code>{savedPayload.requestId}</code><p>{savedPayload.copies.map(copy => copy.copyId).join(", ")}</p></details></div>
      <button type="button" className="bw-button bw-button-primary" disabled={sending} onClick={() => void retrySaved()}>{sending ? "Checking request…" : "Retry saved request"}</button>
    </div>}

    <form className="bw-filters" onSubmit={searchInventory}>
      <label className="bw-search">Find a card<span><input type="search" placeholder="Card name, SKU, serial, or set" maxLength={200} value={search} disabled={Boolean(draft) || sending} onChange={event => setSearch(event.target.value)} /><button type="submit" className="bw-button" disabled={Boolean(draft) || sending}>Search</button></span></label>
      <label>Game<select value={filters.workspace} disabled={Boolean(draft) || sending} onChange={event => changeFilters({ workspace: event.target.value as Workspace })}><option value="all">All games</option><option value="riftbound">Riftbound</option><option value="mtg">Magic: The Gathering</option><option value="pokemon">Pokémon</option></select></label>
      <label>Availability<select value={filters.status} disabled={Boolean(draft) || sending} onChange={event => changeFilters({ status: event.target.value as StockFilter })}><option value="all">All copies</option><option value="available">Available</option><option value="unavailable">Unavailable</option></select></label>
    </form>

    <div className="bw-selection">
      <div><strong>{selected.length ? `${count.format(selected.length)} ${selected.length === 1 ? "copy" : "copies"} selected` : "Select available copies"}</strong><p>{selectedWarehouse ? warehouseMap.get(selectedWarehouse)?.name || "One warehouse per request" : "Choose copies from one warehouse for each request."}</p></div>
      <div className="bw-selection-buttons">
        <button type="button" className="bw-button bw-button-subtle" disabled={actionsDisabled || !canSelectPage} title={!canSelectPage ? "Select one copy first if this page contains more than one warehouse." : undefined} onClick={() => setSelected(availableOnPage)}>Select page</button>
        <button type="button" className="bw-button bw-button-subtle" disabled={actionsDisabled || !selected.length} onClick={() => setSelected([])}>Clear</button>
        <button type="button" className="bw-button" disabled={actionsDisabled || !selected.length} onClick={() => openDraft("remove")}>Remove copies</button>
        <button type="button" className="bw-button bw-button-primary" disabled={actionsDisabled || !selected.length} onClick={() => openDraft("sale")}>Record sale</button>
      </div>
    </div>

    {draft && <form className="bw-composer" onSubmit={event => void submitDraft(event)} aria-labelledby="bw-composer-title">
      <header><div><h3 id="bw-composer-title" ref={composerHeading} tabIndex={-1}>{draft.kind === "sale" ? "Record a bulk sale" : "Remove warehouse copies"}</h3><p>{count.format(draft.copies.length)} selected {draft.copies.length === 1 ? "copy" : "copies"} · {warehouseMap.get(draft.copies[0].warehouseId)?.name || "Warehouse Manager"}</p></div><button type="button" className="bw-button bw-button-subtle" disabled={sending} onClick={() => { setDraft(null); setFormError(""); }}>Close</button></header>
      <details className="bw-copy-review"><summary>Review the exact copies</summary><ul>{draft.copies.map(copy => <li key={copyKey(copy)}><span>{copy.data.name} · {copy.data.condition} · {copy.data.finish}</span><code>{copy.data.serial} · ID {copy.copyId}</code></li>)}</ul></details>
      {draftStale && <p className="bw-alert bw-alert-error" role="alert">Selected stock has changed. Close this form and select available copies again.</p>}
      <fieldset disabled={sending || Boolean(saved)}>
        {draft.kind === "sale" && <>
          <p className="bw-form-help">Record the amount already paid. The price and cost below apply to every selected copy; use separate sales for different prices. This form does not collect payment.</p>
          <div className="bw-sale-fields">
            <label>Sale price per copy ($)<input type="number" inputMode="decimal" min="0.01" max="200000" step="0.01" required value={unitPrice} onChange={event => setUnitPrice(event.target.value)} placeholder="Actual sale price" /></label>
            <label>Cost per copy ($)<input type="number" inputMode="decimal" min="0" max="20000000" step="0.01" aria-label="Cost per copy ($)" aria-describedby="bw-cost-note" value={unitCost} onChange={event => setUnitCost(event.target.value)} placeholder="Unknown" /><small id="bw-cost-note">Blank keeps cost unknown; profit stays incomplete.</small></label>
            <label>Sale date and time<input type="datetime-local" required value={saleDate} onChange={event => setSaleDate(event.target.value)} /></label>
            <label>Sales channel<select value={channel} onChange={event => setChannel(event.target.value)}><option>In-store</option><option>Online</option><option>TCGplayer</option><option>Other</option></select></label>
            <label>Payment method<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option>Card</option><option>Cash</option><option>Marketplace</option><option>Other</option></select></label>
            <label>Total discount ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={discount} onChange={event => setDiscount(event.target.value)} /></label>
            <label>Total tax ($)<input type="number" inputMode="decimal" min="0" max="200000" step="0.01" value={tax} onChange={event => setTax(event.target.value)} /></label>
          </div>
        </>}
        <label className="bw-note">Note (optional)<textarea rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder={draft.kind === "sale" ? "Receipt or order reference" : "Reason for removing these copies"} /></label>
      </fieldset>
      <footer><div>{draft.kind === "sale" && <strong>Sale total: {previewTotal === null ? "Enter a sale price" : amount(previewTotal)}</strong>}<p>{draft.kind === "sale" ? "Stock and sales reports update after Warehouse Manager confirms." : "The selected copies leave available stock after Warehouse Manager confirms. Removal does not record a sale."}</p></div><button type="submit" className="bw-button bw-button-primary" disabled={sending || Boolean(saved) || draftStale || Boolean(storageError) || Boolean(loadError)}>{sending ? "Sending request…" : draft.kind === "sale" ? "Queue sale" : "Queue removal"}</button></footer>
    </form>}

    <div className="bw-inventory" aria-busy={loading}>
      {current && copyRows.length > 0 && <p className="bw-scroll-hint">Counts reflect matching copies on this page. Expand a printing for copy IDs, locations, and status.</p>}
      {loading && !current ? <div className="bw-empty" role="status">Loading warehouse copies…</div> : current && copyRows.length ? <div className="bw-table-scroll" tabIndex={0} role="region" aria-label="Warehouse copies; scroll horizontally for all columns">
        {groupBulkCopies(copyRows).map(group => {
          const card = group.copies[0].data;
          return <details className="bw-printing-group" key={group.key}>
            <summary><span><strong>{card.name}</strong><small>{[card.setName, card.cardNumber ? `#${card.cardNumber}` : "", card.rarity, card.finish || "Unknown finish", card.language || "Unknown language"].filter(Boolean).join(" · ")}</small></span><span>{count.format(group.copies.length)} total · {count.format(group.available)} available</span></summary>
        <table className="bw-table"><thead><tr><th scope="col"><span className="bw-visually-hidden">Select copy</span></th><th scope="col">Card & printing</th><th scope="col">Physical copy</th><th scope="col">Condition & finish</th><th scope="col">Location</th><th scope="col">Status</th><th scope="col">Price / cost</th></tr></thead><tbody>{group.copies.map(copy => {
          const link = tcgplayerLink(copy.data.tcgplayerUrl);
          const image = imageLink(copy.data.imageUrl);
          const otherWarehouse = Boolean(selectedWarehouse && selectedWarehouse !== copy.warehouseId);
          const checked = selectedKeys.has(copyKey(copy));
          return <tr key={copyKey(copy)} className={checked ? "bw-row-selected" : undefined}>
            <td><input type="checkbox" aria-label={`Select ${copy.data.name}, ${copy.data.serial}, copy ${copy.copyId}`} title={copy.pending ? "A change is already pending." : !copy.data.available ? "This copy is not available." : otherWarehouse ? "Clear the selection to choose another warehouse." : undefined} checked={checked} disabled={actionsDisabled || !copy.data.available || copy.pending || otherWarehouse} onChange={() => toggleCopy(copy)} /></td>
            <th scope="row"><div className="bw-card">{image ? <Image src={image} width={42} height={59} alt="" unoptimized referrerPolicy="no-referrer" /> : <span className="bw-card-placeholder" aria-hidden="true">◇</span>}<div>{link ? <a href={link} target="_blank" rel="noopener noreferrer">{copy.data.name}<span className="bw-visually-hidden"> on TCGplayer, opens a new tab</span></a> : <strong>{copy.data.name}</strong>}<small>{[copy.data.setName, copy.data.cardNumber ? `#${copy.data.cardNumber}` : "", copy.data.rarity].filter(Boolean).join(" · ") || "Printing details unavailable"}</small></div></div></th>
            <td className="bw-copy-id"><strong>{copy.data.serial}</strong><code>ID {copy.copyId}</code><small>{copy.data.sku || "SKU not assigned"}</small><small>{warehouseMap.get(copy.warehouseId)?.name || "Warehouse"}</small></td>
            <td><strong>{copy.data.condition || "Unknown"}</strong><small>{copy.data.finish || "Unknown finish"}{copy.data.language ? ` · ${copy.data.language}` : ""}</small></td>
            <td className="bw-location">{copy.data.location || "Not placed"}</td>
            <td><span className={`bw-status ${copy.pending ? "bw-status-pending" : copy.data.available ? "bw-status-available" : "bw-status-unavailable"}`}>{copy.pending ? "Change pending" : copy.data.available ? "Available" : "Unavailable"}</span><small>{copy.data.status.replaceAll("_", " ")}</small></td>
            <td className="bw-money"><strong>{amount(copy.data.listPriceCents)}</strong><small>Cost: {amount(copy.data.costCents)}</small></td>
          </tr>;
        })}</tbody></table>
          </details>;
        })}
      </div> : current && !loadError ? <div className="bw-empty"><h3>{current.warehouses.length ? "No copies match these filters" : "Your warehouse inventory will appear here"}</h3><p>{current.warehouses.length ? "Try another game, availability filter, or search." : "Connect Warehouse Manager and sync your scanned cards to start."}</p></div> : null}
      {current && <footer className="bw-pagination"><p>{copyRows.length ? `${count.format((current.page - 1) * current.pageSize + 1)}–${count.format((current.page - 1) * current.pageSize + copyRows.length)} of ${count.format(current.total)} copies` : current.total ? `0 copies on this page · ${count.format(current.total)} matching copies` : "0 copies"} · Page {count.format(current.page)} of {count.format(totalPages)}</p><div><button type="button" className="bw-button" disabled={loading || sending || Boolean(draft) || current.page <= 1} onClick={() => changeFilters({ page: Math.max(1, filters.page - 1) })}>Previous</button><button type="button" className="bw-button" disabled={loading || sending || Boolean(draft) || current.page >= totalPages} onClick={() => changeFilters({ page: filters.page + 1 })}>Next</button></div></footer>}
    </div>

    {current && <BulkNativeOrderSales orders={current.unpricedOrders} total={current.unpricedOrderCount}
      warehouseNames={Object.fromEntries(current.warehouses.map(warehouse => [warehouse.id, warehouse.name]))}
      disabled={Boolean(loadError) || loading || sending || Boolean(draft)} onRecorded={() => refresh(true)} />}

    <section className="bw-activity" id="bw-recent-activity" aria-labelledby="bw-activity-title">
      <header><div><h3 id="bw-activity-title">Recent warehouse changes</h3><p>Queued requests wait for the connected Mac. Rejected requests leave stock unchanged.</p></div></header>
      {current?.commands.length ? <ul>{current.commands.map(command => <li key={command.id}><div><strong>{command.kind === "sale" ? "Bulk sale" : "Stock removal"}</strong><p>{command.message || (command.status === "pending" ? "Waiting for Warehouse Manager to confirm." : command.status === "applied" ? "Confirmed by Warehouse Manager." : "The requested change was not applied.")}</p><small>{dateLabel(command.createdAt)} · <code>{command.id}</code></small></div><span className={`bw-status ${command.status === "pending" ? "bw-status-pending" : command.status === "applied" ? "bw-status-available" : "bw-status-unavailable"}`}>{command.status === "pending" ? "Queued" : command.status === "applied" ? "Applied" : "Not applied"}</span></li>)}</ul> : <p className="bw-activity-empty">Requests made here will show their confirmation status in this list.</p>}
    </section>
  </section>;
}
