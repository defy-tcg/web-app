import { getAuthorizedSession } from "@/lib/auth/authorization";
import { SkuLabelInventoryError, validateInventoryLabels } from "@/lib/sku-label-inventory";
import { saveSkuLabelsToInventory } from "@/lib/sku-label-inventory-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Send a valid JSON label batch." }, { status: 400 });
    }
    const labels = validateInventoryLabels(payload);
    const result = await saveSkuLabelsToInventory(labels);
    return Response.json(result, { status: result.createdCount > 0 ? 201 : 200 });
  } catch (error) {
    if (error instanceof SkuLabelInventoryError) return Response.json({ error: error.message }, { status: error.status });
    return Response.json({ error: "Inventory could not be saved. Retry with the same SKUs; existing saved products will not be added again." }, { status: 500 });
  }
}
