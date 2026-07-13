import path from "node:path";
import os from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const UPLOAD_DIR = path.join(os.tmpdir(), "json-stream-uploads");

export function isValidId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function dataPath(id: string) {
  return path.join(UPLOAD_DIR, `${id}.bin`);
}

export function indexFilePath(id: string) {
  return dataPath(id).replace(".bin", ".index.json");
}

export function metaFilePath(id: string) {
  return path.join(UPLOAD_DIR, `${id}.meta.json`);
}

export interface FileMeta {
  name: string;
  size: number;
  lineCount: number;
  uploadedAt: string;
}

export async function ensureUploadDir() {
  await mkdir(UPLOAD_DIR, { recursive: true });
}

export async function writeMeta(id: string, meta: FileMeta) {
  await writeFile(metaFilePath(id), JSON.stringify(meta));
}

export async function readMeta(id: string): Promise<FileMeta | null> {
  try {
    return JSON.parse(await readFile(metaFilePath(id), "utf8"));
  } catch {
    return null;
  }
}
