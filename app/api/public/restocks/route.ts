import { syncConfig } from "@/lib/shopify/read-client";
import { ShopifySyncRepository } from "@/lib/shopify/repository";
import { publicRestocksResponse } from "@/lib/shopify/public-restocks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const config = syncConfig();
  return publicRestocksResponse(request, config, () => new ShopifySyncRepository().publicRestocks(config.shop, config.locationId));
}
