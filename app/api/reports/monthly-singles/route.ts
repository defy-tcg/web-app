import { getAuthorizedSession } from "@/lib/auth/authorization";
import { MonthlySinglesError } from "@/lib/reports/monthly-singles";
import { loadMonthlySinglesReport } from "@/lib/reports/monthly-singles-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  if (!(await getAuthorizedSession())) return Response.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => key !== "month") || params.getAll("month").length > 1) {
    return Response.json({ error: "Choose one calendar month in YYYY-MM format.", code: "INVALID_MONTH" }, { status: 400, headers });
  }
  try {
    return Response.json(await loadMonthlySinglesReport(params.has("month") ? params.get("month") : undefined), { headers });
  } catch (error) {
    return Response.json({
      error: error instanceof MonthlySinglesError ? error.message : "Monthly sales could not be checked. Retry shortly.",
      code: error instanceof MonthlySinglesError ? error.code : "SHOPIFY_UNAVAILABLE",
    }, { status: error instanceof MonthlySinglesError ? error.status : 503, headers });
  }
}
