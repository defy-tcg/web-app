import { getAuthorizedSession } from "@/lib/auth/authorization";
import { SkuLabelInventoryError, validateSkuLabelReservation } from "@/lib/sku-label-inventory";
import { reserveSkuLabel } from "@/lib/sku-label-inventory-storage";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return Response.json({ error: "Send a valid JSON card label." }, { status: 400 });
    }
    const label = validateSkuLabelReservation(payload);
    const result = await reserveSkuLabel(label);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof SkuLabelInventoryError) {
      return Response.json({ error: error.message, ...(error.existingSku ? { existingSku: error.existingSku } : {}) }, { status: error.status });
    }
    return Response.json({ error: "The QR code could not be saved. Retry the same card; its saved SKU will be reused." }, { status: 500 });
  }
}
