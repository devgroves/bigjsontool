# json-stream-app — Agent Guide

**What it does:** Upload or stream large JSON files (1GB+) into a Next.js app that renders the content in a split pane — raw text (left) and a JSON tree view (right). The browser never holds the full file: text is fetched by character-window on scroll, and the tree view fetches only the current depth level, lazy-loading deeper subtrees on click. All data lives server-side on disk (`os.tmpdir()`).

## Dev commands
```bash
npm run dev      # next dev, http://localhost:3000
npm run build    # next build
npm run lint     # next lint
npm run start    # next start
```
No tests configured; no typecheck script (use `tsc --noEmit`).

## Architecture

**Next.js 14 App Router**, all routes force-dynamic. No SSR — the page, editor, tree view, and virtual text area are all `"use client"`.

### Routes
| Route | Purpose |
|---|---|
| `GET /api/stream-json?count=&chunkSize=&delayMs=` | Generates fake JSON array, streams it to client **and** writes it to disk concurrently. Returns `X-File-Id` header. |
| `POST /api/upload` | Accepts multipart/form-data `file`, saves to disk, returns `{id}`. Buffers entire upload in Node memory first. |
| `GET /api/file-chars?id=&start=&length=` | Byte-range read from saved file (O(1) seek), returns text window. Used by VirtualTextArea in remote mode. |
| `GET /api/json-level?id=&path=&depth=` | Streaming JSON parser (`stream-json`) navigates to `path`, returns subtree at `depth`. Containers beyond depth become `TruncatedMarker` placeholders. |
| `GET /api/stream-file?id=` | Streams saved file from disk. Legacy — editor no longer uses this. |
| `GET /api/debug-storage?id=` | TEMPORARY — lists upload dir contents. Do not expose in production. |

### Components
- **`app/page.tsx`** — Main page: streaming controls (records/chunk/delay), file import, status bar.
- **`app/components/VirtualTextArea.tsx`** — Text viewer. Local mode: newline-split lines. Remote mode (`fileId` set): fixed-width 200-char rows fetched from `/api/file-chars` on scroll. **Read-only in remote mode** — no write-back to server.
- **`app/components/JsonTreeView.tsx`** — Tree viewer. Local mode: parses `source` string. Remote mode: fetches depth-limited view from `/api/json-level`, lazy-loads deeper on expand. Uses virtualized list (no react-window dependency — custom scroll math).
- **`app/components/JsonEditor.tsx`** — Split pane: VirtualTextArea left, JsonTreeView right.

### Storage
- All files stored at `os.tmpdir()/json-stream-uploads/` — **ephemeral, not shared across serverless instances**.
- Each file gets `{uuid}.bin` (data) + `{uuid}.meta.json` (name, size, lineCount, uploadedAt).
- **Two identical copies** of `uploadStore.ts` exist at `app/lib/` and `app/components/`. Keep in sync or consolidate.

## Key quirks
- The README mentions Monaco but the actual editor is a custom `VirtualTextArea` — there is **no `@monaco-editor/react` dependency**.
- `/api/file-chars` reads by **byte offset**, not codepoint offset — multi-byte UTF-8 can split at chunk boundaries.
- `/api/stream-json` must **finish writing to disk before closing the client stream** (`fileStream.end()` callback then `writeMeta`), otherwise a client reacting to stream-end could read a half-written file.
- UUID validation regex in `isValidId()`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`
- All routes import from `../../lib/uploadStore` (relative to route file).
- Inline type annotations like `e: { target: { value: any; }; }` are used instead of imported event types.
- No lint/typecheck runs in CI — verify manually before commits.
