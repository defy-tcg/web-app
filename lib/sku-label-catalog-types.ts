/** Public review details only; never includes Shopify IDs or inventory receipt controls. */
export type SkuLabelCatalogDetails = {
  name: string; game: string; setName: string; cardNumber: string; finish: string;
  tcgplayerId: number | null; tcgplayerUrl: string | null;
};
export type SkuLabelCatalogReview = {
  sku: string; sourceVersion: string; targetVersion: string; source: SkuLabelCatalogDetails; target: SkuLabelCatalogDetails;
  condition: string; quantity: number; priceCents: number;
};
