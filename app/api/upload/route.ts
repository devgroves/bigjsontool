import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { ensureUploadDir, dataPath, writeMeta } from "../../lib/uploadStore";

export const dynamic = "force-dynamic";

function countLines(buf: Buffer): number {
  let count = 1;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) count++; // "\n"
  }
  return count;
}

export async function POST(req: NextRequest) {
  await ensureUploadDir();

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a 'file' field" },
      { status: 400 }
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json(
      { error: "No file provided (expected multipart field 'file')" },
      { status: 400 }
    );
  }

  const id = randomUUID();

  // NOTE: formData()/arrayBuffer() bring the *whole* upload into the Node
  // process's memory before we ever touch disk. That's fine up to a few
  // hundred MB, but it's a real ceiling for true multi-GB uploads — a
  // production version would parse the multipart stream incrementally and
  // pipe straight to disk instead of buffering it first. This is a
  // server-side memory concern (bounded by your Node process), which is a
  // different failure mode than the browser-side crash this route change
  // is fixing — but worth knowing it's still there.
  const buf = Buffer.from(await file.arrayBuffer());
  const lineCount = countLines(buf);

  const dp = dataPath(id);
  await writeFile(dp, buf);
  await writeMeta(id, {
    name: file.name,
    size: buf.length,
    lineCount,
    uploadedAt: new Date().toISOString(),
  });
  console.info("Saved upload", id, dp, file.name, buf.length, lineCount);

  // NOTE: index building used to happen synchronously right here
  // (buildIndex(buf) + writeFileSync of indexFilePath(id)). For large files
  // that single-request scan was slow enough to trip gateway/proxy timeouts
  // on THIS response. It's now a separate step — the client calls
  // GET /api/import-index-stream (SSE) with this id right after receiving
  // the response below, and that route splits via pyjson-splitter by default
  // (falling back to a local byte-offset index build) while streaming
  // progress back. This matches the remote-URL import flow.

  return NextResponse.json({ id, name: file.name, size: buf.length, lineCount });
}
