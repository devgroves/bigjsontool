import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { ensureUploadDir, dataPath, writeMeta, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";

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

  // Build index at upload time so first json-level request is instant.
  try {
    const index = buildIndex(buf);
    console.info("Built index for upload", id, indexFilePath(id), index);
    writeFileSync(indexFilePath(id), JSON.stringify(index));
  } catch (error) {
    // Index is a performance optimization — non-critical.
    console.error("Failed to build index for upload", id, file.name, error);
    if (error instanceof Error) {
      console.error(error.stack);
    }
  }

  return NextResponse.json({ id, name: file.name, size: buf.length, lineCount });
}
