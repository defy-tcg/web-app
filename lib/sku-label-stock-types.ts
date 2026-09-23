interface SkuLabelStockRequestBase {
  requestId: string;
  sku: string;
  quantity: number;
}

export type SkuLabelStockRequest = SkuLabelStockRequestBase & (
  | { mode?: "add"; expectedAvailableQuantity?: never }
  | { mode: "set"; expectedAvailableQuantity: number }
);

export type SkuLabelStockResult = SkuLabelStockRequest & {
  status: "complete" | "pending" | "rejected";
  availableQuantity?: number;
  message: string;
  retryable: boolean;
};
