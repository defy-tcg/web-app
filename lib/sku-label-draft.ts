export type SkuInventoryDraft = {
  game: string; setName: string; cardNumber: string; condition: string; finish: string;
  quantity: string; cost: string; price: string; location: string; tcgplayerId: string;
};

export type SkuDraftLabel = {
  sku: string;
  name: string;
  inventory?: SkuInventoryDraft;
};

export const EMPTY_SKU_INVENTORY_DRAFT: SkuInventoryDraft = {
  game: "", setName: "", cardNumber: "", condition: "Near Mint", finish: "Normal",
  quantity: "1", cost: "0.00", price: "0.00", location: "REDMOND", tcgplayerId: "",
};
