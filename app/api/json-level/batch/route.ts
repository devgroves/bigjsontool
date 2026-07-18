import { NextRequest, NextResponse } from "next/server";
import { dataPath, isValidId, readMeta } from "../../../lib/uploadStore";
import { fetchMultipleLevelValues } from "../../../lib/duckJsonValue";

export const dynamic = "force-dynamic";

const MAX_DEPTH = 6;
const MAX_PATHS = 500;
const MAX_PREVIEW_SIZE = 10; // must match INDIVIDUAL_ITEM_THRESHOLD in JsonTreeView.tsx

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = body?.id;
  const paths = body?.paths;
  const depth = Math.max(0, Math.min(Number(body?.depth) || 1, MAX_DEPTH));

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    return NextResponse.json({ error: "'paths' must be a non-empty array" }, { status: 400 });
  }
  if (paths.length > MAX_PATHS) {
    return NextResponse.json({ error: `'paths' exceeds max of ${MAX_PATHS}` }, { status: 400 });
  }
  if (!paths.every((p: unknown) => typeof p === "string")) {
    return NextResponse.json({ error: "'paths' must be an array of strings" }, { status: 400 });
  }

  const meta = await readMeta(id);
  if (!meta) {
    return NextResponse.json({ error: "File not found — it may have expired" }, { status: 404 });
  }

  try {
    const values = await fetchMultipleLevelValues(dataPath(id), paths, depth, MAX_PREVIEW_SIZE);
    return NextResponse.json({ values });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Query failed" }, { status: 500 });
  }
}
