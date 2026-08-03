# Wiki — JSON Stream App

A Next.js application for uploading, streaming, and browsing large JSON files (1GB+) through a split-pane viewer with a JSONPath query engine.

---

## Table of Contents

1. [Importing JSON Files](#1-importing-json-files)
2. [Viewing JSON — Text Pane](#2-viewing-json--text-pane)
3. [Viewing JSON — Tree Pane](#3-viewing-json--tree-pane)
4. [Querying JSON — JSONPath](#4-querying-json--jsonpath)
5. [API Reference](#5-api-reference)
6. [Architecture Overview](#6-architecture-overview)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Importing JSON Files

There are three ways to get JSON data into the app.

### 1a. Stream Generated Data

Click **Start streaming** on the home page. The server generates a fake JSON array and streams it to the browser while simultaneously writing to disk. Configurable parameters:

| Parameter | Description | Default |
|-----------|-------------|---------|
| Records | Total number of records to generate | 50000 |
| Chunk size | Records per streamed chunk | 500 |
| Delay / chunk | Milliseconds pause between chunks | 20 |

The server writes the file to `{os.tmpdir()}/json-stream-uploads/{uuid}.bin` and builds a byte-offset index synchronously after the stream completes.

**API:** `GET /api/stream-json?count=&chunkSize=&delayMs=`

### 1b. Upload a Local File

Click **Import from disk** and select a JSON file. The file is uploaded as multipart form data, written to disk, and indexed inline before the response returns.

**API:** `POST /api/upload` (multipart/form-data, field: `file`)

> **Note:** The upload is fully buffered in Node memory before writing to disk. For files larger than a few hundred MB, use URL import instead.

### 1c. Import from URL

Enter a URL in the **Import from URL** field and click **Import**. The server streams the remote file directly to disk using `createWriteStream` (no full-file memory buffer). After the file is saved, the client opens an SSE connection to build the index.

**Two-step process:**

1. `POST /api/import-url` — fetches the remote URL, streams to disk, returns `{id}`
2. `GET /api/import-index-stream?id={id}` — SSE endpoint that builds the byte-offset index while streaming progress events back

If the pyjson-splitter service is available (localhost:8000), the file is also split into per-root-key chunk files served by Fastify (localhost:4000). This enables fast JSONPath queries on multi-GB files. If the splitter is unreachable, a local byte-offset index is built as a fallback.

**Memory:** URL imports stream chunks directly to disk, using only ~64KB of buffer memory regardless of file size.

---

## 2. Viewing JSON — Text Pane

The **left pane** shows a virtualized text view of the raw JSON. It renders lines on demand from a byte-offset window, so the browser never holds the full file as a string.

### Local Mode (no fileId)

When data is generated or uploaded, the full text is held client-side and rendered in a virtual textarea. Lines are split on `\n` and rendered at fixed row height.

### Remote Mode (fileId set)

For URL imports and streamed files, the text pane fetches 200-character byte windows from `GET /api/file-chars?id={id}&start={byte}&length={chars}`. The server reads the requested byte range from disk using `fs.createReadStream` with `{start, end}` options.

> **Caveat:** `/api/file-chars` reads by **byte offset**, not codepoint offset. Multi-byte UTF-8 characters can split at chunk boundaries, causing temporary rendering glitches until the adjacent chunk is loaded.

---

## 3. Viewing JSON — Tree Pane

The **right pane** shows a virtualized, expandable tree view of the JSON structure.

### Depth Level Controls

The toolbar has preset buttons that control how deep the tree is fetched from the server:

| Level | Behavior |
|-------|----------|
| **0** | Root only — collapsed single node |
| **1** | Root keys visible, all children shown as collapsed arrays/objects |
| **2** | Root + immediate children expanded (default) |
| **3** | Root + children + grandchildren expanded |
| **true** | Deep expand (capped at depth 8) |
| **false** | Everything collapsed (depth 1) |
| **function** | Size-based heuristic — collapses large containers automatically |

Clicking a depth preset re-fetches the root tree from the server at that depth.

### Placeholder Nodes (Server Mode)

When the tree is fetched at a limited depth, containers beyond that depth appear as clickable placeholders:

```
messages: [ 10 items — click to load from server ]
```

Clicking a placeholder triggers `GET /api/json-level?id={id}&path={jsonPath}&depth={depth}`. The fetched depth is floored at 2 (`Math.max(2, depth)`) to guarantee at least one level of real data is always shown.

- **Individual items** (offset < 10): fetched by their exact path
- **Batch items** (offset >= 10): fetched from the parent with an offset parameter for pagination

### Large Array Chunking

Arrays with more than 100 items (configurable via `groupSize` prop) are grouped into expandable chunks of 100 items each:

```
[0 … 99]     ← click to expand
[100 … 199]
[200 … 299]
```

This prevents the virtualized list from being overwhelmed by tens of thousands of rows. The `ignoreLargeArray` toggle disables chunking.

### Local vs Server Fetching

| Aspect | Local Mode | Server Mode |
|--------|-----------|-------------|
| Trigger | `fileId` is null | `fileId` is set |
| Data source | `JSON.parse(source)` in browser | `GET /api/json-level` per depth level |
| Memory | Holds full parsed object | Never holds full object — only fetched subtree |
| Suitable for | Small files, live streams | Files of any size |

---

## 4. Querying JSON — JSONPath

The tree pane toolbar includes a **JSONPath query input** for filtering and searching JSON data using [RFC 9535](https://www.rfc-editor.org/rfc/rfc9535) syntax.

### How to Use

1. Enter a JSONPath expression in the query input field
2. Click **Query** (or press Enter)
3. The tree view is replaced with the query results
4. Click **Clear** to return to the normal tree view

While a query is active, the depth preset buttons are **disabled** with a tooltip: *"Clear the search query to change depth"*.

### JSONPath Syntax Examples

| Expression | Description |
|------------|-------------|
| `$.users` | All items in the `users` root key |
| `$.users[0]` | First item in `users` |
| `$.users[*]` | All items in `users` (wildcard) |
| `$.users[?(@.age > 30)]` | Filter: items where `age` > 30 |
| `$.users[?(@.name = "John")]` | Filter: items where `name` = "John" |
| `$.users[?(@.active = true)].email` | Filter + field projection |
| `$.conversations[*].messages[*].text` | Nested array traversal |
| `$..name` | Recursive descent: all `name` fields at any depth |
| `$.users[0:5]` | Array slice: first 5 items |
| `$.users.length()` | Array length |

### How Queries Are Executed

**API:** `POST /api/json-query` with body `{ id, query, depth?, offset?, limit? }`

The server:

1. Parses the JSONPath expression to extract the **root key** (e.g., `users` from `$.users[?(@.age>30)]`)
2. For **manifest entries** (Fastify): fetches all chunks for that root key, applies the remaining expression to each item, consolidates results
3. For **local disk entries**: reads the JSON file, navigates to the root key, applies the expression
4. Returns up to `limit` results (default 100) with `total` and `hasMore` for pagination

### Query Result Behavior

- Results **replace** the tree view in the same pane
- The tree's expand/collapse and virtualization work on results normally
- Changing the depth preset is disabled during query mode
- Clearing the query re-fetches the normal tree at the currently selected depth

---

## 5. API Reference

### `GET /api/stream-json`

Generates and streams fake JSON data.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `count` | number | 50000 | Records to generate (max 10M) |
| `chunkSize` | number | 500 | Records per chunk (max 5000) |
| `delayMs` | number | 20 | Pause between chunks in ms |

Response: `application/json` stream with `X-File-Id` header.

### `POST /api/upload`

Upload a JSON file as multipart/form-data.

| Field | Type | Description |
|-------|------|-------------|
| `file` | File | The JSON file to upload |

Response: `{ id, name, size, lineCount }`

### `POST /api/import-url`

Import a JSON file from a remote URL (streamed to disk).

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | The URL to fetch |

Response: `{ id, name, size }`

### `GET /api/import-index-stream`

SSE endpoint that builds the index for an imported file.

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | The file UUID |

Events: `progress`, `done` (with `depth1` snapshot), `error`, `heartbeat`

### `GET /api/file-chars`

Read a byte window from a file.

| Param | Type | Description |
|-------|------|-------------|
| `id` | string | The file UUID |
| `start` | number | Byte offset to start reading |
| `length` | number | Number of characters to read |

Response: plain text content.

### `GET /api/json-level`

Fetch a JSON subtree at a specific depth.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | The file UUID |
| `path` | string | `$` | Dot-notation JSON path |
| `depth` | number | 1 | Max depth to traverse (0–12) |
| `offset` | number | 0 | Array pagination offset |

Response: `{ path, depth, value }`

### `POST /api/json-query`

Execute a JSONPath query against a file.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | The file UUID |
| `query` | string | required | JSONPath expression |
| `depth` | number | 2 | Render depth for results |
| `offset` | number | 0 | Result pagination offset |
| `limit` | number | 100 | Max results (1–1000) |

Response: `{ query, depth, value, total, hasMore }`

---

## 6. Architecture Overview

```
Browser                          Server (Next.js)
───────                          ────────────────
page.tsx                    ──>  /api/stream-json     (generates + streams)
                          ──>  /api/upload           (multipart save)
                          ──>  /api/import-url       (stream to disk)
                          ──>  /api/import-index-stream (SSE index build)

JsonEditor
├── VirtualTextArea (left)  ──>  /api/file-chars      (byte-range read)
└── JsonTreeView (right)   ──>  /api/json-level      (depth-limited fetch)
                          ──>  /api/json-query       (JSONPath query)

Storage:
  {tmpdir}/json-stream-uploads/
  ├── {uuid}.bin            (raw JSON bytes)
  ├── {uuid}.meta.json      (name, size, lineCount, uploadedAt)
  ├── {uuid}.index.json     (byte-offset map: containers, depth1, rootKeys)
  └── {uuid}.manifest.json  (Fastify manifest: chunks, depth1Snapshot)

External services (optional):
  pyjson-splitter (localhost:8000)  — splits JSON into per-key chunk files
  Fastify (localhost:4000)          — serves chunk files with skip/limit queries
  Shared filesystem (/tmp/output-json) — where chunks are written/read
```

### Index Structure (`{uuid}.index.json`)

Built by the streaming byte-level indexer (`buildIndex.ts`):

- **`depth1`** — Flat map of root keys to scalar values or truncated markers with `__count__`
- **`containers`** — Byte-offset map of JSON paths to `{offset, endOffset, count, type}` (up to depth 3, first 10 array items)
- **`rootKeys`** — Root-level container byte map for fast key-based seeking

### Truncated Markers

When the server returns data at a limited depth, containers beyond that depth are replaced with sentinel objects:

```json
{
  "__truncated__": true,
  "__kind__": "object" | "array",
  "__count__": 1234
}
```

These appear as clickable placeholders in the tree view.

---

## 7. Troubleshooting

### File upload fails for large files

The upload route buffers the entire file in memory. For files >500MB, use **URL import** instead, which streams to disk without buffering.

### Tree shows infinite "click to load" placeholders

This was caused by placeholder fetches using `depth=1`, which truncates children at depth 0 (all markers). Fixed by flooring the placeholder fetch depth at 2.

### Active depth button not visible

The `.jt-btn:hover` style was overriding `.jt-btn[data-active="true"]` due to equal CSS specificity. Fixed by combining selectors so active state always wins.

### URL import uses too much memory

The old implementation buffered the entire response with `Buffer.concat(chunks)`. Fixed by streaming directly to disk with `createWriteStream`.

### JSONPath query returns no results

- Check that the root key exists (e.g., `$.users` requires a `users` key at the root)
- Verify the filter syntax: `@.field` references the current item, comparisons use `=`, `>`, `<`, `>=`, `<=`
- For manifest entries, ensure the splitter has processed the file (check the import progress)

### Index build fails or is slow

The index is built asynchronously via SSE after URL import. If the pyjson-splitter is unreachable, the fallback local index builder reads the full file from disk. For very large files, this can be slow — the splitter approach is preferred.
