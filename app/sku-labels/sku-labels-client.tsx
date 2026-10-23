"use client";

import Image from "next/image";
import Link from "next/link";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { generateSkuBatch, isGeneratedSku, normalizeSkuPrefix, skuLabelCondition, skuLabelSetName, skuQrSvg, SKU_LABEL_WEBSITE } from "@/lib/sku-labels";
import { compareSavedSkuLabels, sameSkuLabelVariant } from "@/lib/sku-label-matching";
import { EMPTY_SKU_INVENTORY_DRAFT, skuLabelPrintDetails, type SkuDraftLabel } from "@/lib/sku-label-draft";
import { skuLabelFeedbackText, type SkuLabelFeedback } from "@/lib/sku-label-feedback";
import { canAutomaticallyRecoverSkuLink, SkuLinkRecoveryQueue, SkuLinkVerificationQueue } from "@/lib/sku-label-link-recovery";
import type { TcgplayerCardLookup } from "@/lib/tcgplayer-card";
import ThemeToggle from "../theme-toggle";
import SkuInventoryPanel, { type SavedSkuProduct } from "./sku-inventory-panel";
import TcgplayerCardImport, { type LinkedLabelSelection } from "./tcgplayer-card-import";
import SkuStockPanel from "./sku-stock-panel";
import SkuManualPrice from "./sku-manual-price";
import ShopifyLinkStatus, { isShopifyLabelLink, pendingShopifyLink, type ShopifyLabelLink } from "./shopify-link-status";

type Label = SkuDraftLabel;
type SavedBatch = { version: 1; labels: Label[] };
const STORAGE_KEY = "defy-qr-sku-labels:v1";
const PENDING_RESERVATIONS_KEY = "defy-qr-sku-pending-reservations:v1";
const example: Label = { sku: "DEFY-1234567890", name: "Your single goes here", condition: "Near Mint" };

function readSavedBatch(key = STORAGE_KEY): Label[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  const saved = JSON.parse(raw) as SavedBatch;
  if (saved.version !== 1 || !Array.isArray(saved.labels) || saved.labels.length > 100 ||
    saved.labels.some((label) => !label || !isGeneratedSku(label.sku) || typeof label.name !== "string" || label.name.length > 1000 ||
      (label.condition !== undefined && typeof label.condition !== "string") ||
      (label.setName !== undefined && (typeof label.setName !== "string" || label.setName.length > 1000)) ||
      (label.inventory !== undefined && (!label.inventory || typeof label.inventory !== "object" ||
        Object.keys(EMPTY_SKU_INVENTORY_DRAFT).some((key) => typeof label.inventory?.[key as keyof typeof EMPTY_SKU_INVENTORY_DRAFT] !== "string")))) ||
    new Set(saved.labels.map((label) => label.sku)).size !== saved.labels.length) {
    throw new Error("Invalid saved batch");
  }
  if (key !== STORAGE_KEY) return saved.labels;
  // Older drafts kept details separately. Carry them into the batch before link matching.
  try {
    const stored = JSON.parse(localStorage.getItem("defy-qr-sku-inventory-drafts:v1") || "null") as { version?: number; drafts?: Record<string, unknown> } | null;
    if (stored?.version === 1 && stored.drafts) return saved.labels.map((label) => {
      const draft = stored.drafts?.[label.sku];
      if (label.inventory || !draft || typeof draft !== "object" ||
        Object.keys(EMPTY_SKU_INVENTORY_DRAFT).some((key) => typeof (draft as Record<string, unknown>)[key] !== "string")) return label;
      return { ...label, inventory: draft as NonNullable<Label["inventory"]> };
    });
  } catch { /* Existing draft validation in the inventory panel reports a storage warning. */ }
  return saved.labels;
}

type LinkedVariant = Pick<SavedSkuProduct, "name" | "game" | "setName" | "cardNumber" | "condition" | "finish" | "tcgplayerId">;

function sameLinkedVariant(left: LinkedVariant, right: LinkedVariant) {
  return sameSkuLabelVariant(left, right);
}

function draftMatchesVariant(label: Label, variant: LinkedVariant) {
  return Boolean(label.inventory && sameLinkedVariant({ ...label.inventory, name: label.name,
    tcgplayerId: Number(label.inventory.tcgplayerId) || null }, variant));
}

function isSavedProduct(value: unknown): value is SavedSkuProduct {
  if (!value || typeof value !== "object") return false;
  const product = value as Record<string, unknown>;
  return isGeneratedSku(product.sku) && product.productType === "Single" &&
    ["name", "game", "setName", "cardNumber", "condition", "finish", "location"].every((field) => typeof product[field] === "string") &&
    ["id", "quantity", "costCents", "listPriceCents"].every((field) => typeof product[field] === "number" && Number.isSafeInteger(product[field]) && Number(product[field]) >= 0) &&
    Number(product.id) > 0 && (product.tcgplayerId === null || (typeof product.tcgplayerId === "number" && Number.isSafeInteger(product.tcgplayerId) && product.tcgplayerId > 0));
}

async function readShopifyLinks(skus: string[], signal?: AbortSignal, verification: "summary" | "live" = "live"): Promise<ShopifyLabelLink[]> {
  const unique = [...new Set(skus)];
  const size = verification === "summary" ? 100 : 3;
  const links: ShopifyLabelLink[] = [];
  // Serialize batches: live checks are intentionally limited to a few Shopify products.
  for (let index = 0; index < unique.length; index += size) {
    if (signal?.aborted || document.visibilityState === "hidden") throw new DOMException("The request was aborted.", "AbortError");
    const batch = unique.slice(index, index + size);
    const response = await fetch(`/api/sku-labels/shopify?${new URLSearchParams({ skus: batch.join(","), verification })}`, { cache: "no-store", signal });
    if (response.redirected || !response.ok) throw new Error("Shopify link status could not be checked. Retry the link before scanning in POS.");
    const result = await response.json() as { links?: unknown[] };
    if (!Array.isArray(result.links) || !result.links.every(isShopifyLabelLink)) throw new Error("Shopify link status could not be confirmed. Retry the link before scanning in POS.");
    const confirmed = result.links.filter((link) => batch.includes(link.sku));
    if (batch.some(sku => !confirmed.some(link => link.sku === sku))) throw new Error("Shopify did not return a status for every selected QR. POS readiness will be checked again automatically.");
    links.push(...confirmed);
  }
  return links;
}

async function linkSavedSkus(skus: string[], signal?: AbortSignal): Promise<ShopifyLabelLink[]> {
  const response = await fetch("/api/sku-labels/shopify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ skus }), signal });
  if (response.redirected || response.status === 401) throw new Error("Sign in again to link this saved QR to Shopify POS.");
  const result = await response.json() as { links?: unknown[]; error?: string };
  if (!response.ok) throw new Error(result.error || "Shopify could not be linked. Your saved QR is unchanged; retry with this SKU.");
  return skus.map((sku) => {
    const link = result.links?.find((value) => isShopifyLabelLink(value) && value.sku === sku);
    if (!isShopifyLabelLink(link)) throw new Error("Shopify did not confirm this QR. Retry with the same SKU.");
    return link;
  });
}

function QrLabel({ label }: { label: Label }) {
  const svg = useMemo(() => skuQrSvg(label.sku), [label.sku]);
  const displayName = Array.from(label.name.trim().replace(/\s+/g, " ")).slice(0, 48).join("");
  const condition = skuLabelCondition(label.condition ?? label.inventory?.condition);
  const setName = skuLabelSetName(label.setName ?? label.inventory?.setName);
  return (
    <div className={`sku-paper${condition ? " sku-paper-with-condition" : ""}${setName ? " sku-paper-with-set" : ""}`}>
      <div className="sku-qr" role="img" aria-label={`QR code for ${label.sku}`} dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="sku-paper-text">
        <div className="sku-paper-brand">Defy TCG - Redmond</div>
        {displayName && <strong>{displayName}</strong>}
        {setName && <div className="sku-paper-set">{setName}</div>}
        {condition && <div className="sku-paper-condition">{condition}</div>}
        <code>{label.sku}</code>
        <div className="sku-paper-website">{SKU_LABEL_WEBSITE}</div>
      </div>
    </div>
  );
}

export default function SkuLabelsClient() {
  const [prefix, setPrefix] = useState("DEFY");
  const [name, setName] = useState("");
  const [count, setCount] = useState("1");
  const [copies, setCopies] = useState("1");
  const [batch, setLabels] = useState<Label[]>([]);
  const [linkedSelection, setLinkedSelection] = useState<LinkedLabelSelection | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [generatingBusy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [inventoryBusy, setInventoryBusy] = useState(false);
  const [stockBusy, setStockBusy] = useState(false);
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [inventoryHydrated, setInventoryHydrated] = useState(false);
  const [savedProducts, setSavedProducts] = useState<SavedSkuProduct[]>([]);
  const [shopifyLinks, setShopifyLinks] = useState<Record<string, ShopifyLabelLink>>({});
  const [linkingSkus, setLinkingSkus] = useState<string[]>([]);
  const [automaticLinkingSkus, setAutomaticLinkingSkus] = useState<string[]>([]);
  const [automaticRecoverySkus, setAutomaticRecoverySkus] = useState<string[]>([]);
  const [printReady, setPrintReady] = useState<SkuLabelFeedback>("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState<SkuLabelFeedback>("");
  const [storageWarning, setStorageWarning] = useState("");
  const generated = useRef(new Set<string>());
  const pendingReservations = useRef<Label[]>([]);
  const generating = useRef(false);
  const downloadingPdf = useRef(false);
  const printDialog = useRef<HTMLDialogElement>(null);
  const shopifyLinkVersions = useRef(new Map<string, number>());
  const shopifyReadRequest = useRef(false);
  const retryingShopify = useRef(false);
  const automaticShopifyQueue = useRef(new SkuLinkRecoveryQueue());
  const shopifyVerificationQueue = useRef(new SkuLinkVerificationQueue());
  const automaticShopifyRequest = useRef(false);
  const busy = generatingBusy || lookupBusy || stockBusy;
  // Looking up a link temporarily selects one saved QR without replacing manual drafts.
  // Unknown variants have no printable label until the server confirms their permanent SKU.
  const labels = useMemo<Label[]>(() => {
    const selected = linkedSelection === null ? batch
      : linkedSelection.product && isGeneratedSku(linkedSelection.product.sku)
        ? [{ sku: linkedSelection.product.sku, name: linkedSelection.product.name, condition: linkedSelection.product.condition, setName: linkedSelection.product.setName }] : [];
    return selected.map((label) => skuLabelPrintDetails(label, savedProducts.find((product) => product.sku === label.sku)));
  }, [batch, linkedSelection, savedProducts]);
  const savedSkus = useMemo(() => new Set(savedProducts.map((product) => product.sku)), [savedProducts]);
  const total = labels.length * Number(copies);
  const validCopies = Number.isInteger(Number(copies)) && Number(copies) >= 1 && Number(copies) <= 100;
  // Legacy batches need a successful inventory read before an omitted condition is safe.
  const conditionsReady = inventoryHydrated || labels.every((label) => Boolean(label.condition?.trim()));
  const canPrint = !inventoryLoading && conditionsReady && labels.length > 0 && validCopies && total <= 1000;
  const manualShopifyBusy = linkingSkus.length > 0;
  const shopifyBusy = manualShopifyBusy || automaticLinkingSkus.length > 0;
  const allLinkingSkus = [...linkingSkus, ...automaticLinkingSkus];
  const unreadyForPos = labels.filter((label) => !savedSkus.has(label.sku) || shopifyLinks[label.sku]?.status !== "ready" || shopifyLinks[label.sku]?.verificationPending).length;
  const libraryShopifySkus = savedProducts.map((product) => product.sku).sort().join(",");
  const selectedShopifySkus = labels.filter((label) => savedSkus.has(label.sku)).map((label) => label.sku).sort().join(",");
  const displayShopifyLinks = useMemo(() => {
    const selected = new Set(selectedShopifySkus.split(","));
    return Object.fromEntries(Object.entries(shopifyLinks).map(([sku, link]) => [sku, { ...link, verificationSelected: selected.has(sku) }]));
  }, [shopifyLinks, selectedShopifySkus]);
  const printLabels = useMemo(() => labels.map((label) => ({ ...label, setName: skuLabelSetName(label.setName), condition: skuLabelCondition(label.condition), name: Array.from(label.name.trim().replace(/\s+/g, " ")).slice(0, 48).join(""), svg: skuQrSvg(label.sku) })), [labels]);

  const updateAutomaticRecoverySkus = useCallback(() => {
    const next = automaticShopifyQueue.current.skus();
    setAutomaticRecoverySkus((current) => current.length === next.length && current.every((sku, index) => sku === next[index]) ? current : next);
  }, []);

  const updateShopifyLinks = useCallback((links: ShopifyLabelLink[], summary = false) => {
    if (!links.length) return;
    if (!summary) {
      for (const link of links) shopifyLinkVersions.current.set(link.sku, (shopifyLinkVersions.current.get(link.sku) ?? 0) + 1);
    }
    automaticShopifyQueue.current.observe(links);
    updateAutomaticRecoverySkus();
    setShopifyLinks((current) => ({ ...current, ...Object.fromEntries(links.map((link) => [link.sku, link])) }));
  }, [updateAutomaticRecoverySkus]);

  const readCurrentShopifyLinks = useCallback(async (skus: string[], signal?: AbortSignal, verification: "summary" | "live" = "live") => {
    const versions = new Map(skus.map((sku) => [sku, shopifyLinkVersions.current.get(sku) ?? 0]));
    const links = await readShopifyLinks(skus, signal, verification);
    if (signal?.aborted) return [];
    // A summary must not overwrite a newer save, receipt, recovery, or live check.
    // Summary reads do not invalidate a live check already in flight.
    const current = links.filter((link) => versions.get(link.sku) === (shopifyLinkVersions.current.get(link.sku) ?? 0));
    updateShopifyLinks(current, verification === "summary");
    return current;
  }, [updateShopifyLinks]);

  const stockReceived = useCallback((sku: string, availableQuantity?: number) => {
    shopifyLinkVersions.current.set(sku, (shopifyLinkVersions.current.get(sku) ?? 0) + 1);
    setShopifyLinks((current) => current[sku] ? { ...current, [sku]: { ...current[sku], availableQuantity } } : current);
    if (availableQuantity === undefined) {
      void readCurrentShopifyLinks([sku]).catch(() => { /* A confirmed receipt remains complete even if the live count is unavailable. */ });
    }
  }, [readCurrentShopifyLinks]);

  const refreshStock = useCallback(async (sku: string) => {
    shopifyLinkVersions.current.set(sku, (shopifyLinkVersions.current.get(sku) ?? 0) + 1);
    setShopifyLinks((current) => current[sku] ? { ...current, [sku]: { ...current[sku], availableQuantity: undefined } } : current);
    await readCurrentShopifyLinks([sku]);
  }, [readCurrentShopifyLinks]);

  const queueAutomaticLinks = useCallback((links: ShopifyLabelLink[]) => {
    automaticShopifyQueue.current.grant(links, Date.now(), { reset: true });
    updateAutomaticRecoverySkus();
  }, [updateAutomaticRecoverySkus]);

  const inventoryLoaded = useCallback((products: SavedSkuProduct[]) => {
    setInventoryHydrated(true);
    setSavedProducts(products);
    setLinkedSelection(current => {
      if (!current?.product) return current;
      const product = products.find(saved => saved.sku === current.product?.sku);
      return product ? { ...current, name: product.name, product } : current;
    });
    setLabels((current) => current.map((label) => {
      const saved = products.find((product) => product.sku === label.sku);
      return saved ? { sku: saved.sku, name: saved.name, condition: saved.condition, setName: saved.setName } : label;
    }));
  }, []);

  useEffect(() => {
    if (!inventoryHydrated || !libraryShopifySkus) return;
    const controller = new AbortController();
    let reading = false;
    async function refreshLibraryLinks() {
      if (controller.signal.aborted || document.visibilityState === "hidden" || reading) return;
      reading = true;
      try {
        const links = await readCurrentShopifyLinks(libraryShopifySkus.split(","), controller.signal, "summary");
        if (!controller.signal.aborted) {
          automaticShopifyQueue.current.grant(links, Date.now());
          updateAutomaticRecoverySkus();
        }
      } catch { /* A failed summary cannot authorize a link or replace a live confirmation. */ }
      finally { reading = false; }
    }
    void refreshLibraryLinks();
    const refresh = () => void refreshLibraryLinks();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [inventoryHydrated, libraryShopifySkus, readCurrentShopifyLinks, updateAutomaticRecoverySkus]);

  useEffect(() => {
    if (!selectedShopifySkus || manualShopifyBusy || inventoryBusy || busy) return;
    const selected = selectedShopifySkus.split(",");
    const controller = new AbortController();
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function verifySelectedLinks(force = false) {
      if (controller.signal.aborted || document.visibilityState === "hidden" || reading) return;
      if (automaticShopifyRequest.current || shopifyReadRequest.current) {
        clearTimeout(timer);
        timer = setTimeout(() => void verifySelectedLinks(force), 5_000);
        return;
      }
      const skus = force ? selected : shopifyVerificationQueue.current.take(selected, Date.now());
      if (!skus.length) {
        // Keep the timer alive while a delayed verification is not due yet.
        if (selected.some(sku => shopifyVerificationQueue.current.has(sku, Date.now()))) {
          clearTimeout(timer);
          timer = setTimeout(() => void verifySelectedLinks(), 5_000);
        }
        return;
      }
      reading = true;
      shopifyReadRequest.current = true;
      try {
        // Stored links are deliberately not POS-ready until the selected labels pass this live check.
        const links = await readCurrentShopifyLinks(skus, controller.signal);
        if (!controller.signal.aborted) {
          shopifyVerificationQueue.current.observe(links, Date.now());
          automaticShopifyQueue.current.grant(links, Date.now());
          updateAutomaticRecoverySkus();
        }
      } catch (caught) {
        if (!controller.signal.aborted) {
          const unavailable = skus.map(sku => ({ sku, status: "pending" as const, verificationPending: true,
            message: caught instanceof Error ? caught.message : "Shopify POS status could not be verified. It will be checked again automatically." }));
          shopifyVerificationQueue.current.observe(unavailable, Date.now());
          // Keep any known Shopify mapping, but failed verification must not claim POS readiness.
          setShopifyLinks(current => ({ ...current, ...Object.fromEntries(unavailable.map(link => [link.sku, {
            ...current[link.sku], ...link, priceCents: undefined, availableQuantity: undefined,
          }])) }));
        }
      } finally {
        reading = false;
        shopifyReadRequest.current = false;
        clearTimeout(timer);
        if (!controller.signal.aborted && selected.some(sku => shopifyVerificationQueue.current.has(sku, Date.now()))) {
          timer = setTimeout(() => void verifySelectedLinks(), 5_000);
        }
      }
    }
    void verifySelectedLinks(true);
    const refresh = () => void verifySelectedLinks(true);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [selectedShopifySkus, manualShopifyBusy, inventoryBusy, busy, readCurrentShopifyLinks, updateAutomaticRecoverySkus]);

  useEffect(() => {
    if (manualShopifyBusy || inventoryBusy || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let working = false;
    async function recoverLinks() {
      if (controller.signal.aborted || working) return;
      working = true;
      try {
        automaticShopifyQueue.current.expire(Date.now());
        updateAutomaticRecoverySkus();
        if (document.visibilityState === "hidden" || automaticShopifyRequest.current || shopifyReadRequest.current
          || retryingShopify.current || generating.current) return;
        const automatic = automaticShopifyQueue.current.take(automaticShopifyQueue.current.skus(), Date.now());
        if (!automatic.length) return;
        automaticShopifyRequest.current = true;
        try {
          const links = await readCurrentShopifyLinks(automatic, controller.signal);
          automaticShopifyQueue.current.grant(links, Date.now());
          const recoverable = links.filter(canAutomaticallyRecoverSkuLink).map((link) => link.sku);
          // A completed card must not hold up the pending cards beside it.
          if (!controller.signal.aborted && !document.hidden && recoverable.length) {
            setAutomaticLinkingSkus(recoverable);
            const completed = await linkSavedSkus(recoverable, controller.signal);
            if (!controller.signal.aborted) updateShopifyLinks(completed);
          }
        } catch { /* The journal keeps this QR and its original receipt safe for the next bounded attempt. */ }
        finally {
          automaticShopifyRequest.current = false;
          setAutomaticLinkingSkus([]);
          if (!controller.signal.aborted) updateAutomaticRecoverySkus();
        }
      } finally {
        working = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void recoverLinks(), 5_000);
      }
    }
    timer = setTimeout(() => void recoverLinks(), 5_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [manualShopifyBusy, inventoryBusy, busy, readCurrentShopifyLinks, updateShopifyLinks, updateAutomaticRecoverySkus]);

  async function retryShopifyLink(sku: string) {
    if (retryingShopify.current || automaticShopifyRequest.current || busy || inventoryBusy) return;
    const verificationOnly = shopifyLinks[sku]?.verificationPending === true;
    retryingShopify.current = true;
    shopifyLinkVersions.current.set(sku, (shopifyLinkVersions.current.get(sku) ?? 0) + 1);
    setLinkingSkus([sku]);
    setError("");
    try {
      if (verificationOnly) {
        const links = await readCurrentShopifyLinks([sku]);
        shopifyVerificationQueue.current.observe(links, Date.now());
        automaticShopifyQueue.current.grant(links, Date.now());
        updateAutomaticRecoverySkus();
      } else {
        const [link] = await linkSavedSkus([sku]);
        updateShopifyLinks([link]);
        queueAutomaticLinks([link]);
      }
      setMessage({ text: `${sku} is saved in Defy.`, skus: [sku] });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Shopify could not be linked. Retry with this same SKU.";
      if (verificationOnly) {
        setError(message);
      } else {
        updateShopifyLinks([pendingShopifyLink(sku, message)]);
        queueAutomaticLinks([pendingShopifyLink(sku, message)]);
      }
      setMessage({ text: `${sku} is saved in Defy.`, skus: [sku] });
    } finally {
      retryingShopify.current = false;
      setLinkingSkus([]);
    }
  }

  useEffect(() => {
    if (printReady && !printDialog.current?.open) printDialog.current?.showModal();
  }, [printReady]);

  useEffect(() => {
    let saved: Label[] = [];
    let warning = "";
    try {
      saved = readSavedBatch();
      saved.forEach((label) => generated.current.add(label.sku));
    } catch {
      warning = "The last batch could not be restored. Download new labels to keep a copy.";
    }
    try {
      pendingReservations.current = readSavedBatch(PENDING_RESERVATIONS_KEY);
      pendingReservations.current.forEach((label) => generated.current.add(label.sku));
    } catch { /* Inventory lookup still finds a reservation if its response was lost. */ }
    startTransition(() => {
      setLabels(saved);
      setStorageWarning(warning);
      setReady(true);
    });
  }, []);

  function saveBatch(next: Label[]) {
    setLinkedSelection(null);
    setLabels(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, labels: next } satisfies SavedBatch));
      setStorageWarning("");
    } catch {
      setStorageWarning("This browser could not save your batch. Download the CSV before leaving this page.");
    }
  }

  function selectLinkedLabel(selection: LinkedLabelSelection | null) {
    setLinkedSelection(selection);
    setCopies("1");
    setError("");
    setMessage("");
    if (selection?.product && isSavedProduct(selection.product)) {
      const product = selection.product;
      generated.current.add(product.sku);
      setSavedProducts((current) => [...current.filter((saved) => saved.sku !== product.sku), product]);
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (generating.current || lookupBusy || inventoryBusy || retryingShopify.current || automaticShopifyRequest.current || !ready) return;
    setError("");
    setMessage("");
    try {
      const normalized = normalizeSkuPrefix(prefix);
      const amount = Number(count);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw new Error("Choose 1 to 100 SKUs per batch.");
      generating.current = true;
      setBusy(true);
      // Read inventory only. This workspace never mounts the store's sheet-sync timers.
      const response = await fetch("/api/inventory", { cache: "no-store" });
      if (response.redirected) throw new Error("Your session expired. Sign in again before generating labels.");
      if (!response.ok) throw new Error(response.status === 401
        ? "Your session expired. Sign in again before generating labels."
        : "Inventory could not be checked for duplicate SKUs. Try again.");
      const data = await response.json() as { products?: { sku: string; barcode: string | null }[] };
      if (!Array.isArray(data.products) || data.products.some((product) => !product || typeof product.sku !== "string")) {
        throw new Error("Inventory could not be checked for duplicate SKUs. Try again.");
      }
      const excluded = new Set(generated.current);
      for (const product of data.products) {
        excluded.add(product.sku.trim().toUpperCase());
        if (product.barcode) excluded.add(product.barcode.trim().toUpperCase());
      }
      try { readSavedBatch().forEach((label) => excluded.add(label.sku)); } catch { /* Saving below reports unavailable storage. */ }
      const skus = generateSkuBatch(amount, excluded, normalized);
      skus.forEach((sku) => generated.current.add(sku));
      saveBatch(skus.map((sku) => ({ sku, name: name.trim(), condition: EMPTY_SKU_INVENTORY_DRAFT.condition })));
      setPrefix(normalized);
      setMessage(`${skus.length} QR draft${skus.length === 1 ? "" : "s"} created. Complete the card details and save to link each SKU to Shopify POS.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Labels could not be generated. Try again.");
    } finally {
      generating.current = false;
      setBusy(false);
    }
  }

  async function addLinkedCard(card: TcgplayerCardLookup, condition: string, finish: string, quantity: number) {
    if (generating.current || inventoryBusy || inventoryLoading || retryingShopify.current || automaticShopifyRequest.current || !ready) throw new Error("Wait for the current batch to finish.");
    generating.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      if (response.redirected) throw new Error("Your session expired. Sign in again before adding a card.");
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again before adding a card." : "Inventory could not be checked. Try again.");
      const data = await response.json() as { products?: (SavedSkuProduct & { barcode?: string | null })[] };
      if (!Array.isArray(data.products)) throw new Error("Inventory could not be checked. Try again.");
      const identity = { ...card, condition, finish, tcgplayerId: card.productId };
      const existing = [...data.products].sort(compareSavedSkuLabels).find((product) => product.productType === "Single" &&
        sameLinkedVariant(product, identity));
      if (existing && !isGeneratedSku(existing.sku)) throw new Error(`This variant already uses SKU ${existing.sku}. Open Inventory to manage its stock or print its existing barcode.`);
      let storedLabels: Label[] = [];
      try { storedLabels = readSavedBatch(); } catch { /* Saving below reports unavailable storage. */ }
      let storedPending: Label[] = [];
      try { storedPending = readSavedBatch(PENDING_RESERVATIONS_KEY); } catch { /* The in-memory candidate remains available for retries. */ }
      const draft = [...batch, ...storedLabels, ...pendingReservations.current, ...storedPending].find((label) => draftMatchesVariant(label, identity));
      const excluded = new Set([...generated.current, ...labels.map((label) => label.sku)]);
      for (const product of data.products) {
        excluded.add(product.sku.trim().toUpperCase());
        if (product.barcode) excluded.add(product.barcode.trim().toUpperCase());
      }
      [...storedLabels, ...storedPending].forEach((label) => excluded.add(label.sku));
      const sku = existing?.sku ?? draft?.sku ?? generateSkuBatch(1, excluded, normalizeSkuPrefix(prefix))[0];
      generated.current.add(sku);
      setLinkingSkus([sku]);
      const candidate: Label = { sku, name: card.name, inventory: {
        ...EMPTY_SKU_INVENTORY_DRAFT, game: card.game, setName: card.setName, cardNumber: card.cardNumber,
        condition, finish, quantity: String(quantity), tcgplayerId: String(card.productId),
      } };
      // Retain the proposed SKU before the request: a failed response must not cause a new QR on retry.
      pendingReservations.current = [...pendingReservations.current.filter((label) => !draftMatchesVariant(label, identity)), candidate].slice(-100);
      try {
        localStorage.setItem(PENDING_RESERVATIONS_KEY, JSON.stringify({ version: 1, labels: pendingReservations.current } satisfies SavedBatch));
      } catch { /* The candidate remains in memory; the server also reuses saved variants. */ }
      const reserved = await fetch("/api/sku-labels/reserve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: { sku, name: card.name, game: card.game, setName: card.setName,
          cardNumber: card.cardNumber, condition, finish, tcgplayerId: card.productId,
          quantity, costCents: 0, listPriceCents: 0 } }),
      });
      if (reserved.redirected || reserved.status === 401) throw new Error("Your session expired. Sign in again before saving the QR code.");
      const result = await reserved.json() as { product?: unknown; created?: boolean; shopify?: unknown; error?: string };
      if (!reserved.ok) throw new Error(result.error || "The QR code could not be saved. Try again to keep the same SKU.");
      if (!isSavedProduct(result.product) || typeof result.created !== "boolean" || !sameLinkedVariant(result.product, identity)) {
        throw new Error("The saved QR code could not be confirmed. Try again to load its original SKU.");
      }
      // Another browser may have saved this variant first. Its confirmed original SKU wins.
      const product = result.product;
      const shopify = isShopifyLabelLink(result.shopify) && result.shopify.sku === product.sku ? result.shopify : pendingShopifyLink(product.sku);
      updateShopifyLinks([shopify]);
      queueAutomaticLinks([shopify]);
      generated.current.add(product.sku);
      setSavedProducts((current) => [...current.filter((saved) => saved.sku !== product.sku), product]);
      saveBatch([{ sku: product.sku, name: product.name, condition: product.condition, setName: product.setName }]);
      setCopies("1");
      pendingReservations.current = pendingReservations.current.filter((label) => !draftMatchesVariant(label, identity));
      try {
        localStorage.setItem(PENDING_RESERVATIONS_KEY, JSON.stringify({ version: 1, labels: pendingReservations.current } satisfies SavedBatch));
      } catch { /* A retained candidate is safe: a later retry returns the same saved product. */ }
      const savedMessage = result.created
        ? `${product.name} saved with permanent SKU ${product.sku}. Starting quantity: ${product.quantity}.`
        : `Loaded the original QR for ${product.name}: ${product.sku}. No stock was added.`;
      setMessage({ text: savedMessage, skus: [product.sku] });
    } finally {
      generating.current = false;
      setBusy(false);
      setLinkingSkus([]);
    }
  }

  function savedForPrint(products: SavedSkuProduct[], createdCount: number, existingCount: number, links: ShopifyLabelLink[]) {
    updateShopifyLinks(links);
    queueAutomaticLinks(links);
    saveBatch(products.map(({ sku, name, condition, setName }) => ({ sku, name, condition, setName })));
    setError("");
    const savedConfirmation = createdCount === 0 ? "Your QR labels are already saved. Reprinting keeps their original SKUs and does not add stock."
      : `${createdCount} new single${createdCount === 1 ? "" : "s"} saved to inventory.${existingCount ? ` ${existingCount} already saved; stock and prices unchanged.` : ""}`;
    const confirmation = { text: savedConfirmation, skus: products.map(product => product.sku) };
    setMessage(confirmation);
    setPrintReady(confirmation);
  }

  function loadSavedLabel(product: SavedSkuProduct) {
    saveBatch([{ sku: product.sku, name: product.name, condition: product.condition, setName: product.setName }]);
    setCopies("1");
    setError("");
    setMessage(`Loaded ${product.sku}. Print or download its label below. Reprinting does not change stock.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function copySkus(values: string[]) {
    setError("");
    try {
      await navigator.clipboard.writeText(values.join("\n"));
      setMessage(values.length === 1 ? "SKU copied." : `${values.length} SKUs copied.`);
    } catch {
      setError("Clipboard access is unavailable. Select a SKU to copy it, or download the CSV.");
    }
  }

  function downloadCsv() {
    const cell = (value: string) => {
      const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const rows = ["SKU,Card name", ...labels.map((label) => [label.sku, label.name].map(cell).join(","))];
    const url = URL.createObjectURL(new Blob(["\uFEFF", rows.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "defy-singles-qr-skus.csv";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage("SKU list downloaded. Keep it with your card records.");
  }

  function print() {
    if (!canPrint || busy || pdfBusy || inventoryBusy || shopifyBusy) return;
    setError("");
    setMessage("Print requested. On the store Mac, choose the Defy 38x13 Upright preset and confirm 38 × 13 mm paper, Portrait, and 100% scale. Letter-size paper can feed blank labels. If no dialog opens, download the PDF and open it in Preview.");
    try {
      // Keep the print request in the click event and avoid unsupported popup windows.
      window.print();
    } catch (caught) {
      setError(caught instanceof Error ? `${caught.message} Use Download PDF to print this batch.` : "Printing is unavailable here. Use Download PDF to print this batch.");
    }
  }

  async function downloadPdf() {
    if (!canPrint || downloadingPdf.current) return;
    downloadingPdf.current = true;
    setPdfBusy(true);
    setError("");
    setMessage("");
    try {
      const { createSkuLabelPdf } = await import("@/lib/sku-label-pdf");
      const bytes = await createSkuLabelPdf(labels, Number(copies));
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "defy-singles-labels-38x13mm.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMessage("PDF ready. Open it in Preview, select your thermal printer and paper width 38 mm across the roll × height 13 mm in the feed direction. Use Portrait, no additional rotation, and 100% / actual size.");
    } catch (caught) {
      setError(caught instanceof Error ? `PDF could not be created: ${caught.message}` : "PDF could not be created. Try again.");
    } finally {
      downloadingPdf.current = false;
      setPdfBusy(false);
    }
  }

  return (
    <>
    <main className="sku-shell">
      <header className="sku-topbar">
        <Link href="/" className="sku-brand">
          <Image src="/defy-os-icon.png" alt="" width={38} height={38} />
          <span>defy<small>STORE OS</small></span>
        </Link>
        <div className="sku-top-actions"><Link href="/">← Back to store</Link><ThemeToggle /></div>
      </header>
      <div className="sku-main">
        <header className="sku-hero">
          <div><p className="eyebrow">SINGLES · LABEL STUDIO</p><h1>Make it yours.<br /><span>Scan it in.</span></h1>
            <p>Paste a TCGplayer card link to save one permanent QR and link it to Shopify POS. Reuse the same SKU whenever you print it.</p>
          </div>
          <div className="sku-size-badge"><b>38 × 13</b><span>mm thermal label</span></div>
        </header>

        <TcgplayerCardImport disabled={!ready || busy || inventoryBusy || inventoryLoading || pdfBusy || shopifyBusy} onAdd={addLinkedCard}
          onSelectionChange={selectLinkedLabel} onLoadingChange={setLookupBusy} />

        <div className="sku-workbench">
          <section className="sku-panel sku-controls" aria-labelledby="sku-settings-title">
            <div className="sku-panel-heading"><span className="sku-step">01</span><div><h2 id="sku-settings-title">Customize your batch</h2><p>A short prefix, a random number, your card.</p></div></div>
            <form onSubmit={generate}>
              <label>SKU prefix<input disabled={inventoryBusy} value={prefix} onChange={(event) => setPrefix(event.target.value.toUpperCase())} maxLength={4} pattern="[A-Za-z0-9]{0,4}" placeholder="DEFY" autoComplete="off" /><small>Up to 4 letters or numbers. Leave blank for numbers only.</small></label>
              <label>Card name (optional)<input disabled={inventoryBusy} value={name} onChange={(event) => setName(event.target.value)} maxLength={240} placeholder="e.g. Ahri · Spirit Blossom" /><small>Add a name for each card before saving to inventory.</small></label>
              <label>Number of SKUs<input disabled={inventoryBusy} type="number" inputMode="numeric" min={1} max={100} step={1} required value={count} onChange={(event) => setCount(event.target.value)} /><small>1–100 different SKUs per batch.</small></label>
              <button className="primary-button" disabled={!ready || busy || inventoryBusy || pdfBusy || shopifyBusy}>{busy ? "Checking inventory…" : labels.length ? "Generate new batch" : "Generate QR labels"}<span aria-hidden="true">↗</span></button>
              {labels.length > 0 && <p className="sku-replace-note">A new batch replaces the preview. Imported cards stay in Saved labels; save any manual drafts to keep them.</p>}
            </form>
          </section>

          <section className="sku-panel sku-preview-panel" aria-labelledby="sku-preview-title">
            <div className="sku-panel-heading"><span className="sku-step">02</span><div><h2 id="sku-preview-title">Your permanent QR label.</h2><p>Defy TCG - Redmond + QR + card name + set + SKU + {SKU_LABEL_WEBSITE}</p></div></div>
            <div className="sku-preview-stage"><div className="sku-dimension">← <span>38 mm</span> →</div>
              {linkedSelection && !labels.length ? <div role="status">
                {linkedSelection.name && <h3>{linkedSelection.name}</h3>}
                <p>{linkedSelection.message ?? (linkedSelection.product ? "This card uses an existing inventory SKU. Manage its barcode in Inventory."
                  : "Confirm the variant and save its QR above to preview and print this card.")}</p>
              </div> : <><QrLabel label={labels[0] ?? example} /><p>{labels.length === 1 ? "Selected label · enlarged for clarity" : labels.length ? "First label preview · enlarged for clarity" : "Example label · generate a batch to preview yours"}</p></>}
            </div>
            <div className="sku-print-settings">
              <label>Copies per SKU<input disabled={inventoryBusy || pdfBusy} type="number" inputMode="numeric" min={1} max={100} step={1} value={copies} onChange={(event) => setCopies(event.target.value)} /></label>
              <div className="sku-total"><strong>{canPrint ? total : "—"}</strong><span>{total === 1 ? "label" : "labels"} to print</span></div>
              <div className="sku-print-actions">
                <button className="dark-button" disabled={!canPrint || busy || pdfBusy || inventoryBusy || shopifyBusy} onClick={() => void downloadPdf()}>{pdfBusy ? "Preparing PDF…" : "Download PDF"}</button>
                <button className="secondary-button" disabled={!canPrint || busy || pdfBusy || inventoryBusy || shopifyBusy} onClick={print}>Print {canPrint ? total : ""} label{total === 1 ? "" : "s"}</button>
              </div>
            </div>
            {(!validCopies || total > 1000) && <p className="sku-inline-error" role="alert">Use 1–100 copies per SKU, up to 1,000 labels per print job.</p>}
            <p className="sku-print-help"><strong>No print dialog?</strong> Download the PDF and open it in Preview or a browser to print. Your existing SKUs stay the same.</p>
            {labels.some((label) => !savedSkus.has(label.sku)) && <p className="sku-print-help">This batch contains drafts. Use <strong>Save to Inventory &amp; Print</strong> below to add their stock before printing.</p>}
            {unreadyForPos > 0 && <p className="sku-pos-warning" role="status"><strong>{unreadyForPos} label{unreadyForPos === 1 ? " is" : "s are"} not ready for Shopify POS.</strong> You can print now, but finish the Shopify link below before scanning. The QR will stay the same.</p>}
            <p className="sku-print-help">Paper: <strong>38 mm wide across the roll × 13 mm high in the feed direction</strong>. Print at <strong>100% / actual size</strong> with no margins, headers, or footers. Scan one test label with a QR-capable scanner first.</p>
            <p className="sku-print-help"><strong>Blank, sideways, or split labels?</strong> In Mac Chrome, choose <strong>More settings → Print using system dialog</strong> (Option + Command + P). On the store Mac, select the <strong>Defy 38x13 Upright</strong> preset. Confirm <strong>38 × 13 mm</strong> paper, <strong>Portrait</strong>, no additional rotation, and <strong>100%</strong> scale. If Paper Size shows <strong>8.5 × 11 inches / Letter</strong>, the artwork can fall outside the label and print blank. The browser cannot override the printer’s selected paper size or orientation.</p>
          </section>
        </div>

        <div className="sku-feedback" aria-live="polite">{message && <p className="sku-success" role="status">{skuLabelFeedbackText(message, shopifyLinks)}</p>}{error && <p className="sku-inline-error" role="alert">{error}</p>}{storageWarning && <p className="sku-storage-warning" role="status">{storageWarning}</p>}</div>

        {labels.length > 0 && <section className="sku-panel sku-batch" aria-labelledby="sku-batch-title">
          <header className="sku-batch-heading"><div><p className="eyebrow">YOUR CURRENT BATCH</p><h2 id="sku-batch-title">{labels.length} custom QR SKU{labels.length === 1 ? "" : "s"}</h2></div><div className="sku-batch-actions"><button className="secondary-button" onClick={() => void copySkus(labels.map((label) => label.sku))}>Copy SKUs</button><button className="secondary-button" onClick={downloadCsv}>Download CSV</button><button className="secondary-button" disabled={inventoryBusy || busy || pdfBusy} onClick={() => {
            if (linkedSelection) {
              setLinkedSelection(null);
              setMessage("Previous batch restored, including any manual drafts.");
            } else {
              saveBatch([]);
              setMessage("Batch cleared. Your saved QR codes remain in Saved labels for future use.");
            }
            setError("");
          }}>{linkedSelection ? "Return to previous batch" : "Clear batch"}</button></div></header>
          <div className="sku-label-list">{labels.map((label, index) => <article className="sku-label-row" key={label.sku}>
            <span className="sku-row-number">{String(index + 1).padStart(2, "0")}</span><QrLabel label={label} />
            <label>Card name {index + 1}<input disabled={inventoryBusy || busy || pdfBusy || savedSkus.has(label.sku)} maxLength={240} value={label.name} placeholder="Add a card name" onChange={(event) => saveBatch(labels.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} />{savedSkus.has(label.sku) && <small>Saved card · edit its name in Inventory.</small>}</label>
            <button className="secondary-button" onClick={() => void copySkus([label.sku])} aria-label={`Copy SKU ${label.sku}`}>Copy SKU</button>
            {!savedSkus.has(label.sku) && <button className="secondary-button sku-remove-draft" disabled={inventoryBusy || busy || pdfBusy || shopifyBusy} aria-label={`Remove draft ${label.sku}`} onClick={() => saveBatch(labels.filter((item) => item.sku !== label.sku))}>Remove draft</button>}
            <ShopifyLinkStatus sku={label.sku} link={shopifyLinks[label.sku]} selected saved={savedSkus.has(label.sku)} busy={allLinkingSkus.includes(label.sku) || inventoryBusy} disabled={busy || inventoryBusy || pdfBusy || shopifyBusy} onRetry={(sku) => void retryShopifyLink(sku)} />
            {shopifyLinks[label.sku]?.manualPriceAllowed && savedProducts.filter(product => product.sku === label.sku).map(product =>
              <SkuManualPrice key={JSON.stringify([product.sku, product.name, product.game, product.setName, product.cardNumber,
                product.condition, product.finish, product.tcgplayerId])} product={product} disabled={busy || inventoryBusy || pdfBusy || shopifyBusy}
                onBusy={setInventoryBusy} onLinked={link => { updateShopifyLinks([link]); queueAutomaticLinks([link]); }} />)}
          </article>)}</div>
        </section>}
        {automaticRecoverySkus.length > 0 && <p className="sku-print-help" role="status">Automatic recovery is checking {automaticRecoverySkus.length} saved card{automaticRecoverySkus.length === 1 ? "" : "s"}. A verified match and price will link to Shopify with the same QR. Cards that still need review will stay saved.</p>}
        <SkuInventoryPanel labels={labels} products={savedProducts} disabled={busy || pdfBusy || inventoryBusy || shopifyBusy} canPrint={canPrint} shopifyLinks={displayShopifyLinks} linkingSkus={allLinkingSkus} onRetryShopify={(sku) => void retryShopifyLink(sku)} onSavingChange={setInventoryBusy} onLoadingChange={setInventoryLoading} onInventoryLoaded={inventoryLoaded} onSaved={savedForPrint} onLoad={loadSavedLabel} onDraftChange={(sku, inventory) => saveBatch(labels.map((label) => label.sku === sku ? { ...label, inventory } : label))}
          stockControls={<SkuStockPanel cards={labels.filter((label) => savedSkus.has(label.sku))} links={shopifyLinks}
            disabled={!ready || generatingBusy || lookupBusy || inventoryBusy || inventoryLoading || pdfBusy || shopifyBusy}
            onReceived={stockReceived} onRefresh={refreshStock} onBusyChange={setStockBusy} />} />
        <footer className="sku-footer"><strong>Your SKU stays with the card.</strong><p>Saving links the exact QR to Shopify POS and keeps it in your shared Defy library. Wait for <strong>Shopify POS ready</strong>, then refresh POS before scanning.</p><p>Starting quantity is transferred once. Use <strong>Change inventory</strong> in Saved card details to add copies or set the total available in Shopify. Importing the same card, condition, and finish reuses its original QR without adding stock. Manual drafts stay in this browser until you save them; downloading or printing alone does not save or link a draft.</p></footer>
      </div>
      <dialog ref={printDialog} className="sku-print-dialog" aria-labelledby="sku-print-dialog-title" onClose={() => setPrintReady("")}>
        <p className="eyebrow">SAVED TO DEFY INVENTORY</p><h2 id="sku-print-dialog-title">Your labels are saved.</h2><p>{skuLabelFeedbackText(printReady, shopifyLinks)}</p><p>Print {total} label{total === 1 ? "" : "s"} on paper <strong>38 mm across the roll × 13 mm in the feed direction</strong>, at <strong>100% / actual size</strong>.</p>
        <div className="sku-dialog-actions"><button className="primary-button" onClick={() => { printDialog.current?.close(); print(); }}>Print labels</button><button className="secondary-button" onClick={() => { printDialog.current?.close(); void downloadPdf(); }}>Download PDF</button><button className="secondary-button" onClick={() => printDialog.current?.close()}>Print later</button></div>
        <p className="sku-print-help">If no print dialog appears, use Download PDF and open it in Preview. Your cards are already saved, even if you print later.</p>
      </dialog>
    </main>
    {ready && createPortal(
      <div className="sku-print-sheet" aria-hidden="true">
        {canPrint && printLabels.flatMap((label) => Array.from({ length: Number(copies) }, (_, copy) => (
          <section className={`sku-thermal-label${label.condition ? " sku-thermal-with-condition" : ""}${label.setName ? " sku-thermal-with-set" : ""}`} key={`${label.sku}-${copy}`}>
            <div className="sku-thermal-qr" dangerouslySetInnerHTML={{ __html: label.svg }} />
            <div className="sku-thermal-details">
              <div className="sku-thermal-brand">Defy TCG - Redmond</div>
              {label.name.trim() && <div className="sku-thermal-name">{label.name.trim()}</div>}
              {label.setName && <div className="sku-thermal-set">{label.setName}</div>}
              {label.condition && <div className="sku-thermal-condition">{label.condition}</div>}
              <div className="sku-thermal-code">{label.sku}</div>
              <div className="sku-thermal-website">{SKU_LABEL_WEBSITE}</div>
            </div>
          </section>
        )))}
      </div>, document.body,
    )}
    </>
  );
}
