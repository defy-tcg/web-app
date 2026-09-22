export interface SkuLabelStockRequest {
  requestId: string;
  sku: string;
  quantity: number;
}

export interface SkuLabelStockResult extends SkuLabelStockRequest {
  status: "complete" | "pending" | "rejected";
  availableQuantity?: number;
  message: string;
  retryable: boolean;
}
