# Stream → JSON Editor

A Next.js (App Router) split-pane JSON viewer for **multi-GB files**. The server
keeps the raw JSON on disk and answers every request by reading only the bytes
it needs — the browser never holds or walks the full document. A text pane
fetches byte windows as you scroll; a tree pane fetches depth-limited subtrees
and runs JSONPath queries against per-key chunk files (Fastify) or a byte-offset
index.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # next build (standalone output)
npm run start      # next start
```

All routes are `force-dynamic`; there is no SSR for the main page.

## Importing JSON

Three ways to get data in, all served from `{os.tmpdir()}/json-stream-uploads/`:

| Mode | Route | Behavior |
|------|-------|----------|
| Stream | `GET /api/stream-json?count=&chunkSize=&delayMs=` | Generates fake JSON, streams it to the browser **and** to disk. Header `X-File-Id` arrives first, but the file is only fully readable after the stream ends. |
| Upload | `POST /api/upload` (multipart) | Saves the file to disk. Fully buffered in Node memory — not for true multi-GB files. |
| URL import | `POST /api/import-url` → `GET /api/import-index-stream?id=` | Streams a remote file to disk with `createWriteStream` (~64KB buffer). The index is built **asynchronously**; the client opens the SSE endpoint for `progress`/`done` events. |

Every file gets a UUID `id` (validated against
`/^[0-9a-f]{8}-[0-9a-f]{4}-...$/i`).

### Storage layout

```
{os.tmpdir()}/json-stream-uploads/
├── {id}.bin            raw JSON bytes
├── {id}.meta.json      name, size, lineCount, uploadedAt
├── {id}.index.json     byte-offset map (depth1, containers, rootKeys)
└── {id}.manifest.json  Fastify manifest (chunks, depth1Snapshot) — if split
```

### External services

When the **pyjson-splitter** service is reachable, imported files are split into
per-root-key chunk files served by **Fastify**:

```
pyjson-splitter (localhost:8000)  →  split JSON into chunk files
Fastify (localhost:4000)          →  GET {jobId}/{chunk}?path=&skip=&limit=
```

`master_manifest.json` lists the chunks for each root key. Array chunks carry a
`json_path` range like `$.users[0:500]` (stamped onto the chunk as `start`/`end`
at registration); object chunks hold disjoint key subsets of the root object.
If the splitter is unreachable, the local byte-offset index is used instead.

## Split-pane viewer

### Text pane (`VirtualTextArea`)

Renders 200-character fixed-width rows. In remote mode (`fileId` set) each row
is fetched on demand from `GET /api/file-chars?id=&start=&length=` as a byte
window, with old windows dropped rather than accumulated. Caveat: reads are by
**byte offset**, so multi-byte UTF-8 can split at chunk boundaries.

### Tree pane (`JsonTreeView`)

Fetches a depth-limited view from `GET /api/json-level?id=&path=&depth=&offset=`
and expands on demand. Containers beyond the fetched depth arrive as
**truncated markers** — clickable placeholders rendered as
`{ __truncated__: true, __kind__: "object"|"array", __count__: n }`. Expanding a
marker fetches that subtree (or the next array batch via `offset`) and splices
it in. Arrays are previewed at most `MAX_PREVIEW_SIZE = 10` items; the remainder
is a marker the user paginates through.

Depth presets (0–3, `true`→8, `false`→1, `function`→3) are flattened to a single
server depth; the fetch is capped at depth 3 so huge files aren't materialized.

## JSONPath queries

`POST /api/json-query` with `{ id, query, depth?, offset?, limit? }` returns
`{ query, depth, value, total, hasMore }`. The tree pane's query bar sends these
(e.g. `$.users[?(@.age>30)]`, `$.users[10:20]`).

### How a query is resolved — "querying all sub-JSONs to build the final JSON"

The engine never loads the whole file. It resolves the query against the
**manifest of chunk files**, fetching only the pieces the expression touches:

1. **Extract the root key.** `extractRootKey` strips the leading `$`, splits the
   expression into `rootKey` (e.g. `users`) and `remaining` (everything after,
   e.g. `[10:20]`, `.name`, `[?(@.age>30)]`). If the root key has no chunks, the
   result is empty.

2. **Dispatch on the root key's kind**, taken from the manifest's `value_type`
   (arrays/objects/scalars), lazily probed for legacy manifests:

   - **Scalar** (`$.version`, `$.title`): fetch the value from its single chunk
     (`getManifestScalar` → Fastify `path=key`), then apply `remaining` to it
     in memory. Return `[value]` when there's no remainder.
   - **Object** (`$.metadata`): chunks hold disjoint key subsets, so
     `getManifestMergedObject` fetches every chunk and `Object.assign`s the parts
     into one object. `remaining` is then applied to that merged object locally.
     This is why `$.metadata` resolves: the whole object root is materialized
     (bounded by the object's size), not streamed item-by-item.
   - **Array** (`$.users`) — the interesting case, three shapes:

     - **Positional accessor** `[n]`, `[n:m]`, `[n:]`, `[:m]`, `[*]` indexes the
       array itself, so it must **not** be applied per item. `parseArrayAccessor`
       extracts `{ start, end, rest }`; the engine fetches exactly the window
       `[start, start+count)` across chunk boundaries with
       `getManifestArrayItems` (→ `sliceArray`), then applies any trailing
       expression (e.g. `.name`) to each fetched item.
     - **Filter** `[?(...)]`: jsonpath-plus evaluates filters over an array's
       elements (a filter applied to a single object never matches), so the whole
       expression is applied to the fetched window of items.
     - **Projection / descent** (`.name`, `..name`): evaluated per fetched item
       and flattened.
     - **No remainder**: return the fetched items directly.

   Pagination is `offset`/`limit`; `total` is the slice size for positional
   access (or `totalCount - start` for open-ended ranges), otherwise the scanned
   match count.

#### Crossing chunk boundaries (`sliceArray`)

Each chunk has a global `start`/`end` stamped from its `json_path` range (e.g.
`$.users[0:500]`, `$.users[500:1000]`). `sliceArray` walks the ordered chunk
list, and for every overlapping chunk calls Fastify
`GET {jobId}/{chunk}?path=users&skip={localOffset}&limit={needed}` — so a query
for `$.users[10:20]` reads a few bytes from the first chunk instead of pulling
the whole array. Legacy manifests without ranges fall back to accumulating
`item_count`.

#### Local / remote fallback

If there's no manifest, `/api/json-query` falls back to the byte-offset index or
a full-file streaming parse (`stream-json`): the file (or the root key's byte
span from `index.containers`/`rootKeys`) is stream-parsed, then the same
`remaining` expression is applied. These paths evaluate against the parsed
window (arrays are preview-capped), so positional access beyond the preview is
limited — the Fastify/manifest path is the one built for multi-GB files.

## Tree-pane server internals (`/api/json-level`)

`GET /api/json-level?id=&path=&depth=&offset=` returns `{ path, depth, value }`
where `value` is the subtree at `path` truncated to `depth`.

1. **Manifest entry** (checked first) → `resolveManifestValue` in
   `app/lib/manifestJsonValue.ts`: dispatches by root-key kind — arrays paginate
   via `sliceArray`, objects merge chunks, scalars read one chunk. Paths deeper
   than the root key (`users.1523.address.city`) locate the owning chunk and
   ask Fastify for the specific sub-path.
2. **Remote entry** (no local disk) → resolves `path` against the in-memory
   index and `Range`-fetches the byte span from the remote URL.
3. **Local disk** → `loadOrBuildIndex` reads/rebuilds `{id}.index.json`, then
   `resolvePath`:
   - **Direct container hit** — `index.containers[path]` gives `{offset,
     endOffset, count}`; the file is read with `createReadStream(file,{start,end})`
     and stream-parsed. O(1) seek.
   - **Ancestor walk-up** — if the exact container isn't indexed, walk from the
     deepest indexed ancestor down to `path`.
   - **`rootKeys`** — top-level container byte map for fast key seeking.
   - **Fallback** — full-file streaming parse.

`buildIndex.ts` is the active indexer: a byte-level streaming parser (never
decodes the full file to a JS string) that records containers up to depth 3 with
the first 10 array items, plus a `depth1` snapshot of root keys.

## Dev notes

- `tsc --noEmit` typechecks; there's no configured test suite.
- `npm run lint` (`next lint`) is currently broken under Next 16; run
  `npx eslint .` with `eslint-config-next` installed, or verify manually.
- Two identical copies of `uploadStore.ts` exist (`app/lib/` and
  `app/components/`) — keep in sync.
- `MAX_PREVIEW_SIZE = 10` (server) must match `INDIVIDUAL_ITEM_THRESHOLD = 10`
  (client tree view).
