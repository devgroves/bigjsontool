import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createWriteStream, writeFileSync, readFileSync } from "node:fs";
import { ensureUploadDir, dataPath, writeMeta, indexFilePath } from "../../lib/uploadStore";
import { buildIndex } from "../../lib/buildIndex";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Expected JSON body with a 'url' field" },
      { status: 400 }
    );
  }

  const url = body.url?.trim();
  if (!url) {
    return NextResponse.json(
      { error: "Missing 'url' in request body" },
      { status: 400 }
    );
  }

  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }
  if (!["http:", "https:"].includes(urlObj.protocol)) {
    return NextResponse.json(
      { error: "Only http and https URLs are supported" },
      { status: 400 }
    );
  }

  await ensureUploadDir();
  const id = randomUUID();

  let remoteResponse: Response;
  try {
    remoteResponse = await fetch(url, {
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to fetch URL: ${err.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  if (!remoteResponse.ok) {
    return NextResponse.json(
      {
        error: `Remote server responded with ${remoteResponse.status} ${remoteResponse.statusText}`,
      },
      { status: 502 }
    );
  }

  if (!remoteResponse.body) {
    return NextResponse.json(
      { error: "Remote server returned no body" },
      { status: 502 }
    );
  }

  const fileName = urlObj.pathname.split("/").pop() || "remote.json";
  const dp = dataPath(id);
  const fileStream = createWriteStream(dp);

  let byteSize = 0;
  let lineCount = 1;
  const newline = Buffer.from("\n", "utf8")[0];

  try {
    const reader = remoteResponse.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(value);
        byteSize += value.byteLength;
        for (let i = 0; i < value.byteLength; i++) {
          if (value[i] === newline) lineCount++;
        }
      }
    }
  } catch (err: any) {
    fileStream.destroy();
    return NextResponse.json(
      { error: `Download failed: ${err.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err: Error | null) => (err ? reject(err) : resolve()));
  });

  await writeMeta(id, {
    name: fileName,
    size: byteSize,
    lineCount,
    uploadedAt: new Date().toISOString(),
  });

  try {
    const fullBuf = readFileSync(dp);
    const index = buildIndex(fullBuf);
    writeFileSync(indexFilePath(id), JSON.stringify(index));
  } catch {
    // Non-critical — without an index the json-level route falls back
    // to a full scan (slower but still correct).
  }

  return NextResponse.json({ id, name: fileName, size: byteSize, lineCount });
}
