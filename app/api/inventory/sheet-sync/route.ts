import { getAuthorizedSession } from "@/lib/auth/authorization";
import { syncMasterInventorySheet } from "@/lib/master-inventory-sheet";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST() {
  if (!(await getAuthorizedSession()))
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await syncMasterInventorySheet());
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Master sheet sync failed",
      },
      { status: 502 },
    );
  }
}