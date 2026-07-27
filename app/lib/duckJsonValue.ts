import duckdb from "duckdb";
import { promises as fs } from 'fs';
import { join } from 'path';
import os from 'os';

/**
 * Logs the current system RAM usage.
 * @param label A short string that will appear in the log line (e.g., "BEFORE TRY").
 */
function logSystemMemory(label: string): void {
  const total = os.totalmem(); // bytes
  const free  = os.freemem();  // bytes
  const used  = total - free;

  const mb = (b: number) => Number((b / 1024 / 1024).toFixed(2));

  console.info(
    `[${new Date().toISOString()}] ${label} – RAM: ` +
    `total=${mb(total)} MB, used=${mb(used)} MB, free=${mb(free)} MB`
  );
}

const DEBUG = process.env.DUCK_DEBUG !== "0"; // set DUCK_DEBUG=0 to silence

function log(...args: any[]) {
  if (DEBUG) console.info("[duckJsonValue]", new Date().toISOString(), ...args);
}
function logErr(...args: any[]) {
  console.error("[duckJsonValue:ERROR]", new Date().toISOString(), ...args);
}

// No cache. Every call opens a fresh in-memory DB, runs its query,
// and closes the connection/db so nothing lingers between requests.
function openDb(): { db: duckdb.Database; conn: duckdb.Connection } {
  const db = new duckdb.Database(":memory:");
  const conn = db.connect();
  return { db, conn };
}

function closeDb(db: duckdb.Database, conn: duckdb.Connection, tag: string) {
  conn.close((err) => {
    if (err) logErr(`[${tag}] conn.close error`, err);
    db.close((err2) => {
      if (err2) logErr(`[${tag}] db.close error`, err2);
      else log(`[${tag}] db closed`);
    });
  });
}

export function dotPathToJsonPath(dotPath: string): string {
  if (!dotPath || dotPath === "$") return "$";
  const segments = dotPath.replace(/^\$\.?/, "").split(".").filter((s) => s.length > 0);
  let out = "$";
  for (const seg of segments) {
    if (/^\d+$/.test(seg)) {
      out += `[${seg}]`;
    } else {
      const escaped = seg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      out += `."${escaped}"`;
    }
  }
  return out;
}

interface DescribedNode {
  nodeId: number;
  nodeType: string | null;
  keys: string[] | null;
  arrLen: number | null;
  scalarValue: any;
}

function allRows(conn: duckdb.Connection, sql: string, params: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    conn.all(sql, ...params, (err: Error | null, rows: any[]) => {
      const ms = Date.now() - t0;
      if (err) {
        logErr("query failed after", ms, "ms:", err.message);
        reject(err);
      } else {
        log("query ok:", rows.length, "row(s) in", ms, "ms");
        resolve(rows);
      }
    });
  });
}

function runOne(
  conn: duckdb.Connection,
  sql: string,
  params: any[]
): Promise<any> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    conn.all(sql, ...params, (err: Error | null, rows: any[]) => {
      const ms = Date.now() - t0;
      if (err) {
        logErr("query failed after", ms, "ms:", err.message, "\nSQL:", sql);
        return reject(err);
      }
      log("query ok in", ms, "ms:", sql.split("\n")[0].trim());
      resolve(rows[0]);
    });
  });
}

async function describeOneNode(
  conn: duckdb.Connection,
  filePath: string,
  jpath: string
): Promise<{ nodeType: string | null; keys: string[] | null; arrLen: number | null; scalarValue: any }> {
  // Step 1: just the type. Cheap — no keys, no length, no value extraction yet.
  const typeRow = await runOne(
    conn,
    `SELECT json_type(content -> ?) AS node_type FROM read_text(?)`,
    [jpath, filePath]
  );
  // log the json type for debugging
  log("describeOneNode types: --->", { filePath, jpath, nodeType: typeRow?.node_type ?? null });

  const nodeType: string | null = typeRow?.node_type ?? null;

  // Step 2: exactly one follow-up query, chosen by what step 1 told us.
  if (nodeType === "OBJECT") {
    const row = await runOne(
      conn,
      `SELECT json_keys(content -> ?) AS all_keys FROM read_text(?)`,
      [jpath, filePath]
    );
    log("describeOneNode keys: --->", { filePath, jpath, keys: row?.all_keys ?? null });
    return { nodeType, keys: row?.all_keys ?? null, arrLen: null, scalarValue: null };
  }

  if (nodeType === "ARRAY") {
    const row = await runOne(
      conn,
      `SELECT json_array_length(content -> ?) AS arr_len FROM read_text(?)`,
      [jpath, filePath]
    );
    log("describeOneNode arr_len: --->", { filePath, jpath, arrLen: row?.arr_len ?? null });
    const arrLen = row?.arr_len == null ? null : Number(row.arr_len);
    return { nodeType, keys: null, arrLen, scalarValue: null };
  }

  if (nodeType == null) {
    // Path didn't resolve to anything.
    return { nodeType: null, keys: null, arrLen: null, scalarValue: null };
  }

  // Scalar (STRING, NUMBER, BOOLEAN, NULL, etc.) — only now do we extract the value.
  const row = await runOne(
    conn,
    `SELECT (content -> ?) AS scalar_json FROM read_text(?)`,
    [jpath, filePath]
  );
  let scalarValue: any = null;
  const sj = row?.scalar_json;
  if (sj != null) {
    try {
      scalarValue = JSON.parse(sj);
    } catch {
      scalarValue = sj;
    }
  }
  return { nodeType, keys: null, arrLen: null, scalarValue };
}

export async function describeNodesBatch(
  filePath: string,
  targets: { nodeId: number; jpath: string }[]
): Promise<DescribedNode[]> {
  if (targets.length === 0) return [];
  log("describeNodesBatch", { filePath, targetCount: targets.length, sample: targets.slice(0, 3) });

  const { db, conn } = openDb();
  logSystemMemory('BEFORE TRY');
  try {
    // await new Promise<void>((resolve, reject) => {
    //   conn.exec("SET memory_limit = '2GB';", (err) => (err ? reject(err) : resolve()));
    // });

    // One simple, verified query per node. No CTE, no VALUES, no join.
    const results = await Promise.all(
      targets.map(async (t) => {
        const d = await describeOneNode(conn, filePath, t.jpath);
        return { nodeId: t.nodeId, ...d };
      })
    );
    return results;
  } catch (e) {
    logErr("describeNodesBatch failed", { filePath, targetCount: targets.length }, e);
    throw e;
  } finally {
    logSystemMemory('BEFORE CLOSE');
    closeDb(db, conn, "describeNodesBatch");
  }
}


interface PendingSlot {
  jpath: string;
  remainingDepth: number;
  setValue: (v: any) => void;
}

async function resolveFrontier(
  filePath: string,
  initialFrontier: PendingSlot[],
  childLimit: number
): Promise<void> {
  let frontier = initialFrontier;
  let level = 0;

  while (frontier.length > 0) {
    log("resolveFrontier level", level, "size", frontier.length);
    const targets = frontier.map((f, i) => ({ nodeId: i, jpath: f.jpath }));
    const described = await describeNodesBatch(filePath, targets);
    const next: PendingSlot[] = [];

    described.forEach((d, i) => {
      const slot = frontier[i];

      if (d.nodeType === "OBJECT") {
        if (slot.remainingDepth <= 0) {
          slot.setValue({ __truncated__: true, __kind__: "object", __count__: d.keys?.length ?? 0 });
          return;
        }
        const obj: Record<string, any> = {};
        slot.setValue(obj);
        for (const key of d.keys ?? []) {
          const childPath = slot.jpath + `."${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
          next.push({
            jpath: childPath,
            remainingDepth: slot.remainingDepth - 1,
            setValue: (v) => {
              obj[key] = v;
            },
          });
        }
        return;
      }

      if (d.nodeType === "ARRAY") {
        const len = d.arrLen ?? 0;
        if (slot.remainingDepth <= 0) {
          slot.setValue({ __truncated__: true, __kind__: "array", __count__: len });
          return;
        }
        const arr: any[] = [];
        slot.setValue(arr);
        const previewCount = Math.min(len, childLimit);
        for (let idx = 0; idx < previewCount; idx++) {
          next.push({
            jpath: `${slot.jpath}[${idx}]`,
            remainingDepth: slot.remainingDepth - 1,
            setValue: (v) => {
              arr[idx] = v;
            },
          });
        }
        if (len > childLimit) {
          arr[childLimit] = { __truncated__: true, __kind__: "array", __count__: len - childLimit };
        }
        return;
      }

      slot.setValue(d.scalarValue ?? null);
    });

    frontier = next;
    level++;
  }

  log("resolveFrontier done after", level, "level(s)");
}

export async function fetchLevelValue(
  filePath: string,
  dotPath: string,
  depth: number,
  childLimit = 10
): Promise<any> {
  log("fetchLevelValue", { filePath, dotPath, depth, childLimit });
  const jpath = dotPathToJsonPath(dotPath);
  let result: any = null;
  await resolveFrontier(
    filePath,
    [
      {
        jpath,
        remainingDepth: depth,
        setValue: (v) => {
          result = v;
        },
      },
    ],
    childLimit
  );
  return result;
}

export async function fetchArrayBatch(
  filePath: string,
  parentDotPath: string,
  depth: number,
  offset: number,
  batchSize = 10
): Promise<any[]> {
  log("fetchArrayBatch", { filePath, parentDotPath, depth, offset, batchSize });
  const parentJpath = dotPathToJsonPath(parentDotPath);
  const [head] = await describeNodesBatch(filePath, [{ nodeId: 0, jpath: parentJpath }]);
  const len = head?.arrLen ?? 0;
  const end = Math.min(offset + batchSize, len);
  log("fetchArrayBatch resolved length", len, "-> slicing", offset, "to", end);

  const arr: any[] = [];
  const slots: PendingSlot[] = [];
  for (let idx = offset; idx < end; idx++) {
    const i = idx - offset;
    slots.push({
      jpath: `${parentJpath}[${idx}]`,
      remainingDepth: depth,
      setValue: (v) => {
        arr[i] = v;
      },
    });
  }
  await resolveFrontier(filePath, slots, batchSize);

  if (end < len) {
    arr.push({ __truncated__: true, __kind__: "array", __count__: len - end });
  }
  return arr;
}

export async function fetchMultipleLevelValues(
  filePath: string,
  dotPaths: string[],
  delta: number,
  childLimit = 10
): Promise<Record<string, any>> {
  log("fetchMultipleLevelValues", { filePath, pathCount: dotPaths.length, delta, childLimit });
  const results: Record<string, any> = {};
  const slots: PendingSlot[] = dotPaths.map((dp) => ({
    jpath: dotPathToJsonPath(dp),
    remainingDepth: delta,
    setValue: (v: any) => {
      results[dp] = v;
    },
  }));
  await resolveFrontier(filePath, slots, childLimit);
  return results;
}