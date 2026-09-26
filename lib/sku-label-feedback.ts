export type SkuLabelFeedback = string | { text: string; skus: string[] };
type Link = { status: "ready" | "pending" | "blocked"; message: string };

/** Save/retry confirmations follow the latest link checks instead of freezing their first result. */
export function skuLabelFeedbackText(feedback: SkuLabelFeedback, links: Readonly<Record<string, Link>>): string {
  if (typeof feedback === "string") return feedback;
  const skus = [...new Set(feedback.skus)];
  if (!skus.length) return feedback.text;
  const unready = skus.filter(sku => links[sku]?.status !== "ready");
  if (!unready.length) return `${feedback.text} ${skus.length === 1 ? "Linked" : "All labels are linked"} to Shopify POS. Refresh POS before scanning the same ${skus.length === 1 ? "QR" : "labels"}.`;
  if (skus.length === 1) return `${feedback.text} ${links[skus[0]]?.message || "Shopify linking is pending. The original QR is saved."}`;
  return `${feedback.text} ${unready.length} label${unready.length === 1 ? " is" : "s are"} not ready for Shopify POS. Check their link status below before scanning.`;
}
