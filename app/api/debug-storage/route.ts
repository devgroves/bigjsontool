import { NextRequest, NextResponse } from "next/server";
import { readdir, stat } from "node:fs/promises";
import { UPLOAD_DIR, dataPath, metaFilePath, isValidId } from "../../lib/uploadStore";

export const dynamic = "force-dynamic";

// TEMPORARY: this route exists purely to debug the "file exists on disk but
// the route 404s" mismatch. Delete it once storage is confirmed working —
// it lists directory contents, which you don't want exposed long-term.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  let dirListing: string[] = [];
  let dirError: string | null = null;
  try {
    dirListing = await readdir(UPLOAD_DIR);
  } catch (e: any) {
    dirError = e?.message ?? String(e);
  }

  let dataFileExists = false;
  let metaFileExists = false;
  let idValid = false;

  if (id) {
    idValid = isValidId(id);
    if (idValid) {
      try {
        await stat(dataPath(id));
        dataFileExists = true;
      } catch {
        // leave false
      }
      try {
        await stat(metaFilePath(id));
        metaFileExists = true;
      } catch {
        // leave false
      }
    }
  }

  return NextResponse.json({
    // Where THIS route (via the shared lib) thinks uploads live.
    resolvedUploadDir: UPLOAD_DIR,
    // What's actually sitting in that directory right now.
    dirListing,
    dirReadError: dirError,
    // Per-id check, if you passed ?id=...
    checkedId: id,
    idPassesValidation: idValid,
    expectedDataPath: id && idValid ? dataPath(id) : null,
    expectedMetaPath: id && idValid ? metaFilePath(id) : null,
    dataFileExists,
    metaFileExists,
  });
}
