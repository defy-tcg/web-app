import { getAuthorizedSession } from "@/lib/auth/authorization";
import {
  commitTcgplayerImport,
  prepareTcgplayerImport,
} from "@/lib/tcgplayer-sales-import";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "TCGplayer import failed";
  if (message.includes("TCG_IMPORT_OVERLAP")) {
    return Response.json(
      {
        error:
          "TCGplayer sales changed while this import was open. Preview the file again to prevent overlapping dates.",
      },
      { status: 409 },
    );
  }
  if (
    message.includes("sales_number_unique") ||
    message.includes("duplicate key") ||
    message.includes("already imported")
  ) {
    return Response.json(
      { error: "One of these TCGplayer orders was just imported. Preview the file again." },
      { status: 409 },
    );
  }
  const status = message.includes("confirm the inventory warnings") ? 409 : 400;
  return Response.json({ error: message.slice(0, 500) }, { status });
}

export async function POST(request: Request) {
  if (!(await getAuthorizedSession())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const payload = (await request.json()) as {
      action?: "preview" | "commit";
      csvText?: string;
      fileName?: string;
      acknowledgeWarnings?: boolean;
    };
    if (typeof payload.csvText !== "string" || !payload.csvText.trim()) {
      return Response.json({ error: "Choose a TCGplayer order file" }, { status: 400 });
    }
    const fileName = typeof payload.fileName === "string" ? payload.fileName : "TCGplayer orders.csv";
    if (payload.action === "preview") {
      return Response.json({
        preview: await prepareTcgplayerImport(payload.csvText, fileName),
      });
    }
    if (payload.action === "commit") {
      return Response.json(
        {
          result: await commitTcgplayerImport(
            payload.csvText,
            fileName,
            Boolean(payload.acknowledgeWarnings),
          ),
        },
        { status: 201 },
      );
    }
    return Response.json({ error: "Unsupported import action" }, { status: 400 });
  } catch (error) {
    return errorResponse(error);
  }
}