import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { ensureUploadDir, dataPath, writeMeta } from "../../lib/uploadStore";

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
  console.info(`Importing remote URL: ${url}`);
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

  const id = randomUUID();
  console.info(`Importing remote URL ${url} as upload ID ${id}`);
  const fileName = urlObj.pathname.split("/").pop() || "remote.json";
  const contentLength = remoteResponse.headers.get("content-length");
  const fileSize = contentLength ? parseInt(contentLength, 10) : 0;

  // Stream the remote response directly to disk instead of buffering the
  // entire file in memory. For a 1GB+ file this drops peak memory from
  // ~2× file size (Uint8Array chunks + Buffer.concat) down to a single
  // ~64KB write buffer.
  let fileStream: ReturnType<typeof createWriteStream>;
  try {
    await ensureUploadDir();
    fileStream = createWriteStream(dataPath(id));
  } catch (err: any) {
    return NextResponse.json(
      { error: `Failed to create local file: ${err.message ?? "unknown error"}` },
      { status: 500 }
    );
  }

  let bytesWritten = 0;
  try {
    const reader = remoteResponse.body!.getReader();
    console.info(`Streaming remote response body for ${url} (${fileSize} bytes)`);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(value);
      bytesWritten += value.byteLength;
    }
    await new Promise<void>((resolve, reject) => {
      fileStream.end(() => resolve());
      fileStream.on("error", reject);
    });
  } catch (err: any) {
    fileStream.destroy();
    return NextResponse.json(
      { error: `Failed to stream remote response: ${err.message ?? "unknown error"}` },
      { status: 502 }
    );
  }

  await writeMeta(id, {
    name: fileName,
    size: bytesWritten,
    lineCount: 0,
    uploadedAt: new Date().toISOString(),
  });

  // NOTE: index building used to happen synchronously right here
  // (buildIndex(buf) + writeFileSync). For large files that single-request
  // scan was slow enough to trip gateway/proxy timeouts on THIS response.
  // It's now a separate step: the client calls GET /api/import-index-stream
  // (SSE) with this id right after receiving the response below, and that
  // route builds + persists the index while streaming progress back.

  console.info(`Streamed remote file to ${dataPath(id)} (${bytesWritten} bytes)`);
  return NextResponse.json({ id, name: fileName, size: bytesWritten });
}
