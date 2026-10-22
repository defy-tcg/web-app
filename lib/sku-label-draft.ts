export type SkuInventoryDraft = {
  game: string; setName: string; cardNumber: string; condition: string; finish: string;
  quantity: string; cost: string; price: string; location: string; tcgplayerId: string;
};

export type SkuDraftLabel = {
  sku: string;
  name: string;
  condition?: string;
  setName?: string;
  inventory?: SkuInventoryDraft;
};

/** Saved inventory supplies current print details; older browser batches remain compatible. */
export function skuLabelPrintDetails(label: SkuDraftLabel, saved?: { condition: string; setName: string }): SkuDraftLabel {
  return { ...label, condition: saved?.condition ?? label.inventory?.condition ?? label.condition,
    setName: saved?.setName ?? label.inventory?.setName ?? label.setName };
}

export const EMPTY_SKU_INVENTORY_DRAFT: SkuInventoryDraft = {
  game: "", setName: "", cardNumber: "", condition: "Near Mint", finish: "Normal",
  quantity: "1", cost: "0.00", price: "0.00", location: "REDMOND", tcgplayerId: "",
};
