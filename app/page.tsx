"use client";

import { useCallback, useRef, useState } from "react";
import JsonEditor from "./components/JsonEditor";
import Spinner from "./components/Spinner";

type Status = "idle" | "uploading" | "streaming" | "downloading" | "done" | "error";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [bytes, setBytes] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(50000);
  const [chunkSize, setChunkSize] = useState(500);
  const [delayMs, setDelayMs] = useState(20);
  const [importedName, setImportedName] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState("");
  // The server-side id of whatever's currently loaded. This is the only
  // thing the editor/tree view need — they fetch content by line-window
  // and by-level respectively, rather than the browser ever holding the
  // whole file as one string (that buffering is what crashed the tab on
  // large files before).
  const [fileId, setFileId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Reads a fetch Response body chunk by chunk purely to report progress —
  // bytes are counted and then dropped, never concatenated into a string.
  // This is intentionally different from the old version, which built up
  // `full += text` on every chunk: for a multi-hundred-MB/GB file that
  // single string (times the 3-4 copies React/child components used to
  // keep) blew past both realistic tab memory and V8's own string-length
  // ceiling, and the tab got SIGKILLed. Tracking only a running byte count
  // keeps memory flat regardless of file size.
  const trackDownloadProgress = useCallback(async (res: Response) => {
    if (!res.ok) {
      let message = `Server responded with ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {
        // ignore — not a JSON error body
      }
      throw new Error(message);
    }
    if (!res.body) throw new Error("No response body from server");

    setStatus("streaming");
    const startTime = performance.now();
    const reader = res.body.getReader();
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      setBytes(received);
      setElapsedMs(performance.now() - startTime);
      // Yield a real paint opportunity per chunk (see note in the previous
      // version) rather than starving the browser in a microtask chain.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  }, []);

  const start = useCallback(async () => {
    setImportedName(null);
    setFileId(null);
    setBytes(0);
    setElapsedMs(0);
    setError(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(
        `/api/stream-json?count=${count}&chunkSize=${chunkSize}&delayMs=${delayMs}`,
        { signal: controller.signal }
      );
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      // The header is available as soon as the response starts, but we only
      // act on it after the body finishes — the server guarantees the file
      // on disk is fully flushed by the time the stream closes, so acting
      // earlier could race a partially-written file.
      const id = res.headers.get("X-File-Id");
      await trackDownloadProgress(res);
      if (id) setFileId(id);
      setStatus("done");
    } catch (e: any) {
      if (e.name === "AbortError") {
        setStatus("idle");
      } else {
        setStatus("error");
        setError(e.message || "Something went wrong while streaming.");
      }
    }
  }, [trackDownloadProgress, count, chunkSize, delayMs]);

  // "Import from disk": upload immediately, then use the returned id
  // directly. There's no need to stream the file back down at all just to
  // populate the editor — it's already fully saved server-side, and the
  // editor/tree fetch what they need by window/level on their own.
  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-selecting the same file
      if (!file) return;

      setBytes(0);
      setElapsedMs(0);
      setError(null);
      setImportedName(file.name);
      setFileId(null);
      setStatus("uploading");

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const form = new FormData();
        form.append("file", file);

        const startTime = performance.now();
        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });

        if (!uploadRes.ok) {
          const body = await uploadRes.json().catch(() => ({}));
          throw new Error(body?.error || `Upload failed with ${uploadRes.status}`);
        }

        const body = await uploadRes.json();
        setBytes(body.size ?? file.size);
        setElapsedMs(performance.now() - startTime);
        setFileId(body.id);
        setStatus("done");
      } catch (e: any) {
        if (e.name === "AbortError") {
          setStatus("idle");
        } else {
          setStatus("error");
          setError(e.message || "Something went wrong while importing the file.");
        }
      }
    },
    []
  );

  const handleImportUrl = useCallback(async () => {
    const url = importUrl.trim();
    if (!url) return;

    setBytes(0);
    setElapsedMs(0);
    setError(null);
    setImportedName(url.split("/").pop() || "remote.json");
    setFileId(null);
    setStatus("downloading");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const startTime = performance.now();
      const res = await fetch("/api/import-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Import failed with ${res.status}`);
      }

      const body = await res.json();
      setBytes(body.size);
      setElapsedMs(performance.now() - startTime);
      setFileId(body.id);
      setStatus("done");
    } catch (e: any) {
      if (e.name === "AbortError") {
        setStatus("idle");
      } else {
        setStatus("error");
        setError(e.message || "Something went wrong while importing the URL.");
      }
    }
  }, [importUrl]);

  const speed = elapsedMs > 0 ? bytes / (elapsedMs / 1000) : 0;
  const busy = status === "streaming" || status === "uploading" || status === "downloading";

  return (
    <main className="wrap">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-live={status === "streaming"} />
          <h1>Stream → Editor</h1>
        </div>
        <p className="sub">
          The backend generates a large JSON array on the fly (or you import a file from disk) —
          either way it's saved server-side, and the editor and tree view below fetch just the
          lines/levels currently in view, so the browser never has to hold the whole file at once.
        </p>
      </header>

      <section className="controls">
        <label>
          Records
          <input
            type="number"
            min={100}
            max={2000000}
            step={100}
            value={count}
            disabled={busy}
            onChange={(e: { target: { value: any; }; }) => setCount(Number(e.target.value))}
          />
        </label>
        <label>
          Chunk size
          <input
            type="number"
            min={10}
            max={5000}
            step={10}
            value={chunkSize}
            disabled={busy}
            onChange={(e: { target: { value: any; }; }) => setChunkSize(Number(e.target.value))}
          />
        </label>
        <label>
          Delay / chunk (ms)
          <input
            type="number"
            min={0}
            max={1000}
            step={5}
            value={delayMs}
            disabled={busy}
            onChange={(e: { target: { value: any; }; }) => setDelayMs(Number(e.target.value))}
          />
        </label>

        {busy ? (
          <button className="btn stop" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="btn start" onClick={start}>
            Start streaming
          </button>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileSelected}
          style={{ display: "none" }}
        />
        <button
          className="btn import"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
        >
          Import from disk…
        </button>

        <div className="url-import-group">
          <input
            type="text"
            className="url-input"
            placeholder="https://example.com/data.json"
            value={importUrl}
            disabled={busy}
            onChange={(e: { target: { value: any; }; }) => setImportUrl(e.target.value)}
          />
          <button
            className="btn url-import"
            disabled={busy || !importUrl.trim()}
            onClick={handleImportUrl}
          >
            Import from URL
          </button>
        </div>
      </section>

      <section className="stats">
        <div className="stat">
          <span className="label">Status</span>
          <span className={`value status-${status}`} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {busy && <Spinner size={14} />}
            {status}
          </span>
        </div>
        {importedName && (
          <div className="stat">
            <span className="label">File</span>
            <span className="value">{importedName}</span>
          </div>
        )}
        <div className="stat">
          <span className="label">Size</span>
          <span className="value">{formatBytes(bytes)}</span>
        </div>
        <div className="stat">
          <span className="label">Elapsed</span>
          <span className="value">{(elapsedMs / 1000).toFixed(2)}s</span>
        </div>
        <div className="stat">
          <span className="label">Throughput</span>
          <span className="value">{formatBytes(speed)}/s</span>
        </div>
        {error && <div className="error">{error}</div>}
      </section>

        <JsonEditor
          value={fileId ? "" : "// Press \"Start streaming\", \"Import from disk\", or \"Import from URL\" to load JSON"}
          fileId={fileId}
        />

     
    </main>
  );
}
