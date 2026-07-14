import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createWriteStream, writeFileSync } from "node:fs";
import { ensureUploadDir, dataPath, writeMeta, indexFilePath } from "../../lib/uploadStore";
import { BuildIndexStream } from "../../lib/BuildIndexStream";

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
  const fileName = urlObj.pathname.split("/").pop() || "remote.json";

  await ensureUploadDir();
  const dp = dataPath(id);
  const fileStream = createWriteStream(dp);
  const indexer = new BuildIndexStream();
  const reader = remoteResponse.body.getReader();

  let fileSize = 0;

  const pump = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileSize += value.length;
      indexer.write(value);
      if (!fileStream.write(value)) {
        await new Promise<void>((resolve) => fileStream.once("drain", resolve));
      }
    }
    fileStream.end();
    indexer.end();
  };

  const [index] = await Promise.all([
    new Promise<any>((resolve, reject) => {
      indexer.on("complete", resolve);
      indexer.on("error", reject);
    }),
    pump(),
    new Promise<void>((resolve, reject) => {
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    }),
  ]);

  await writeMeta(id, {
    name: fileName,
    size: fileSize,
    lineCount: 0,
    uploadedAt: new Date().toISOString(),
  });

  try {
    writeFileSync(indexFilePath(id), JSON.stringify(index));
  } catch (error) {
    console.error("Failed to write index for URL import", id, fileName, error);
  }

  return NextResponse.json({ id, name: fileName, size: fileSize });
}
