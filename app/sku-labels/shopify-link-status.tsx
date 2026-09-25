import { isGeneratedSku } from "@/lib/sku-labels";

export type ShopifyLabelLink = {
  sku: string;
  status: "ready" | "pending" | "blocked";
  message: string;
  productId?: string;
  variantId?: string;
  adminUrl?: string;
  priceCents?: number;
  availableQuantity?: number; catalogCorrectionPending?: boolean;
};

export function isShopifyLabelLink(value: unknown): value is ShopifyLabelLink {
  if (!value || typeof value !== "object") return false;
  const link = value as Record<string, unknown>;
  return isGeneratedSku(link.sku) && ["ready", "pending", "blocked"].includes(String(link.status)) && typeof link.message === "string";
}

export function pendingShopifyLink(sku: string, message = "Your QR is saved in Defy. Retry the Shopify link before scanning in POS."): ShopifyLabelLink {
  return { sku, status: "pending", message };
}

export default function ShopifyLinkStatus({ sku, link, saved = true, busy = false, disabled = false, onRetry }: {
  sku: string; link?: ShopifyLabelLink; saved?: boolean; busy?: boolean; disabled?: boolean;
  onRetry: (sku: string) => void;
}) {
  const status = saved ? link?.status ?? "pending" : "draft";
  const title = busy ? "Linking to Shopify POS…" : status === "ready" ? "Shopify POS ready"
    : status === "blocked" ? "Shopify POS needs attention" : status === "draft" ? "Shopify POS · save first" : "Shopify POS pending";
  const message = !saved ? "Save this card to link its permanent QR to Shopify automatically."
    : busy ? "Keeping the same QR and checking its Shopify product."
    : link?.message || "Shopify POS has not been confirmed. Retry to finish linking this QR.";
  const adminUrl = link?.adminUrl && /^https:\/\/(?:admin\.shopify\.com|[a-z0-9-]+\.myshopify\.com)\//i.test(link.adminUrl) ? link.adminUrl : undefined;
  return <div className={`sku-shopify-status is-${status}`} aria-live="polite" aria-label={`Shopify POS status for ${sku}`}>
    <div><strong>{title}</strong><p>{message}</p>
      {status === "ready" && typeof link?.priceCents === "number" && link.priceCents > 0 ? <p>Shopify price: {(link.priceCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}</p> : null}
      {status === "ready" && typeof link?.availableQuantity === "number" ? <p>Shopify stock: {link.availableQuantity} available</p> : null}
    </div>
    {saved && !busy && status !== "ready" ? <button className="secondary-button" disabled={disabled} onClick={() => onRetry(sku)} aria-label={`Retry Shopify link for ${sku}`}>Retry Shopify link</button> : null}
    {adminUrl ? <a href={adminUrl} target="_blank" rel="noopener noreferrer">View in Shopify ↗</a> : null}
  </div>;
}
