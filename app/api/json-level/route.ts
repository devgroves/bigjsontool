import { NextRequest, NextResponse } from "next/server";
import { dataPath, isValidId, readMeta } from "../../lib/uploadStore";
import { fetchLevelValue, fetchArrayBatch } from "../../lib/duckJsonValue";

export const dynamic = "force-dynamic";

const MAX_DEPTH = 6;
const MAX_PREVIEW_SIZE = 10; // must match INDIVIDUAL_ITEM_THRESHOLD in JsonTreeView.tsx

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const path = searchParams.get("path") ?? "$";
  const depth = Math.max(0, Math.min(Number(searchParams.get("depth")) || 1, MAX_DEPTH));
  const offsetParam = searchParams.get("offset");

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }

  const meta = await readMeta(id);
  if (!meta) {
    return NextResponse.json({ error: "File not found — it may have expired" }, { status: 404 });
  }

  try {
    if (offsetParam !== null) {
      const offset = Math.max(0, Number(offsetParam) || 0);
      const value = await fetchArrayBatch(dataPath(id), path, depth, offset, MAX_PREVIEW_SIZE);
      return NextResponse.json({ value });
    }

    const value = await fetchLevelValue(dataPath(id), path, depth, MAX_PREVIEW_SIZE);
    return NextResponse.json({ value });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Query failed" }, { status: 500 });
  }
}
