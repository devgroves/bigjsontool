import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { dataPath, isValidId, readMeta } from "../../lib/uploadStore";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id || !isValidId(id)) {
    return NextResponse.json({ error: "Missing or invalid 'id'" }, { status: 400 });
  }

  const filePath = dataPath(id);
  try {
    await stat(filePath);
  } catch {
    return NextResponse.json(
      { error: "File not found — it may have expired, or the id is wrong" },
      { status: 404 }
    );
  }

  const meta = await readMeta(id);
  const name = meta?.name ?? "upload.json";

  // Streams straight off disk in real chunks rather than reading the whole
  // file into memory first. Kept around as a plain "download the saved
  // file" endpoint — the editor UI no longer uses this to populate itself,
  // since buffering an arbitrarily large response into one JS string is
  // exactly what caused the browser-side crash on big files. See
  // /api/file-chars for how the viewer gets content instead.
  const nodeStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const webStream = Readable.toWeb(nodeStream) as ReadableStream;

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `inline; filename="${name.replace(/"/g, "")}"`,
      "Cache-Control": "no-store",
    },
  });
}
