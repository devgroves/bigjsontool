import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createWriteStream, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { ensureUploadDir, dataPath, writeMeta, indexFilePath } from "../../lib/uploadStore";
import { BuildIndexStream } from "../../lib/BuildIndexStream";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Busboy = require("busboy");

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  await ensureUploadDir();

  if (!req.body) {
    return NextResponse.json(
      { error: "No request body" },
      { status: 400 }
    );
  }

  const contentType = req.headers.get("content-type") || "";

  const id = randomUUID();
  const dp = dataPath(id);

  let fileName = "upload.json";
  let fileSize = 0;
  let lineCount = 1;
  let fileWriteDone: Promise<void> = Promise.resolve();
  let indexDone: Promise<any> = Promise.resolve(null);

  const bb = Busboy({ headers: { "content-type": contentType } });

  bb.on("file", (_fieldname: string, fileStream: any, info: { filename: string }) => {
    fileName = info.filename;
    const outStream = createWriteStream(dp);
    const indexer = new BuildIndexStream();

    fileWriteDone = new Promise<void>((resolve, reject) => {
      outStream.on("finish", resolve);
      outStream.on("error", reject);
    });

    indexDone = new Promise<any>((resolve, reject) => {
      indexer.on("complete", (index) => resolve(index));
      indexer.on("error", reject);
    });

    fileStream.on("data", (data: Buffer) => {
      fileSize += data.length;
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 0x0a) lineCount++;
      }
      indexer.write(data);
      if (!outStream.write(data)) {
        fileStream.pause();
        outStream.once("drain", () => fileStream.resume());
      }
    });

    fileStream.on("end", () => {
      outStream.end();
      indexer.end();
    });

    fileStream.on("error", (err: Error) => {
      outStream.destroy(err);
      indexer.destroy(err);
    });
  });

  const nodeStream = Readable.fromWeb(req.body as any);
  nodeStream.pipe(bb);

  await new Promise<void>((resolve, reject) => {
    bb.on("close", resolve);
    bb.on("error", (err: Error) => reject(err));
  });

  await fileWriteDone;
  const index = await indexDone;

  await writeMeta(id, {
    name: fileName,
    size: fileSize,
    lineCount,
    uploadedAt: new Date().toISOString(),
  });

  if (index) {
    try {
      writeFileSync(indexFilePath(id), JSON.stringify(index));
    } catch (error) {
      console.error("Failed to write index for upload", id, fileName, error);
    }
  }

  return NextResponse.json({ id, name: fileName, size: fileSize, lineCount });
}
