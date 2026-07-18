import duckdb from "duckdb";

/**
 * Converts the client's dot-notation path ("$", "$.conversations",
 * "$.conversations.3.meta") into real DuckDB JSONPath ($."conversations"[3]."meta").
 *
 * NOTE: numeric segments are assumed to be array indices. A JSON object with
 * a purely-numeric string key would be misread as an index — this ambiguity
 * is inherited from the client's path scheme, which doesn't mark whether a
 * segment came from an object or an array. Only matters if your data has
 * numeric-string object keys.
 */
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
  nodeType: string | null; // 'OBJECT' | 'ARRAY' | 'VARCHAR' | 'BIGINT' | ... | null (path not found)
  keys: string[] | null;
  arrLen: number | null;
  scalarValue: any;
}

function allRows(conn: duckdb.Connection, sql: string, params: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows)));
  });
}

/**
 * Single read_text scan describing every target path at once: its type,
 * its keys (if OBJECT), its length (if ARRAY), or its resolved scalar value
 * (if a leaf). Batching multiple targets into one query is what lets a
 * whole BFS level cost exactly one file scan, no matter how many siblings
 * are in it.
 */
export async function describeNodesBatch(
  filePath: string,
  targets: { nodeId: number; jpath: string }[]
): Promise<DescribedNode[]> {
  if (targets.length === 0) return [];

  const db = new duckdb.Database(":memory:");
  const conn = db.connect();
  try {
    const valuesSql = targets.map(() => `(?::BIGINT, ?::VARCHAR)`).join(", ");
    const valueParams = targets.flatMap((t) => [t.nodeId, t.jpath]);

    const sql = `
      WITH src AS (SELECT content FROM read_text(?)),
      targets(node_id, jpath) AS (VALUES ${valuesSql})
      SELECT
        t.node_id,
        json_type(s.content, t.jpath) AS node_type,
        json_keys(s.content, t.jpath) AS all_keys,
        json_array_length(s.content, t.jpath) AS arr_len,
        CASE WHEN json_type(s.content, t.jpath) NOT IN ('OBJECT', 'ARRAY')
             THEN json_extract(s.content, t.jpath)
        END AS scalar_json
      FROM src s CROSS JOIN targets t;
    `;

    const rows = await allRows(conn, sql, [filePath, ...valueParams]);
    const byId = new Map(rows.map((r) => [Number(r.node_id), r]));

    return targets.map((t) => {
      const r = byId.get(t.nodeId);
      if (!r) return { nodeId: t.nodeId, nodeType: null, keys: null, arrLen: null, scalarValue: null };

      let scalarValue: any = null;
      if (r.scalar_json != null) {
        try {
          scalarValue = JSON.parse(r.scalar_json);
        } catch {
          scalarValue = null;
        }
      }

      return {
        nodeId: t.nodeId,
        nodeType: r.node_type,
        keys: r.all_keys ?? null,
        arrLen: r.arr_len === null || r.arr_len === undefined ? null : Number(r.arr_len),
        scalarValue,
      };
    });
  } finally {
    conn.close();
    db.close(() => {});
  }
}

interface PendingSlot {
  jpath: string;
  remainingDepth: number;
  setValue: (v: any) => void;
}

/**
 * Resolves a set of pending slots level-by-level. Each level is exactly one
 * read_text scan covering every node currently pending in that level,
 * regardless of how many siblings there are — this is what keeps a
 * wide-but-shallow expand cheap, and keeps total scans equal to the
 * requested depth rather than growing with breadth.
 */
async function resolveFrontier(
  filePath: string,
  initialFrontier: PendingSlot[],
  childLimit: number
): Promise<void> {
  let frontier = initialFrontier;

  while (frontier.length > 0) {
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

      // Scalar (or missing path, resolved as null).
      slot.setValue(d.scalarValue ?? null);
    });

    frontier = next;
  }
}

/**
 * Root call: materializes `dotPath`'s value down to `depth` levels, in the
 * TruncatedMarker shape the client's JsonTreeView expects.
 */
export async function fetchLevelValue(
  filePath: string,
  dotPath: string,
  depth: number,
  childLimit = 10
): Promise<any> {
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

/**
 * Continuation fetch: the next `batchSize` items of the array at
 * `parentDotPath`, starting at `offset`, resolved to `depth` levels each,
 * plus a trailing truncation marker if more remain past this batch.
 */
export async function fetchArrayBatch(
  filePath: string,
  parentDotPath: string,
  depth: number,
  offset: number,
  batchSize = 10
): Promise<any[]> {
  const parentJpath = dotPathToJsonPath(parentDotPath);
  const [head] = await describeNodesBatch(filePath, [{ nodeId: 0, jpath: parentJpath }]);
  const len = head?.arrLen ?? 0;
  const end = Math.min(offset + batchSize, len);

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

/**
 * Batch version of fetchLevelValue: resolves several independent dot-paths
 * (e.g. an entire frontier of TruncatedMarkers) `delta` levels deeper each,
 * in one shared BFS — so a wide frontier still costs exactly `delta` scans
 * total, not one scan per path.
 */
export async function fetchMultipleLevelValues(
  filePath: string,
  dotPaths: string[],
  delta: number,
  childLimit = 10
): Promise<Record<string, any>> {
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
