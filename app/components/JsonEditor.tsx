"use client";

import { useEffect, useState } from "react";
import JsonTreeView from "./JsonTreeView";
import VirtualTextArea from "./VirtualTextArea";

export default function JsonEditor({
  value,
  fileId,
}: {
  value: string;
  fileId?: string | null;
}) {
  // Local text state so the tree view can reflect live edits, not just the
  // initial `value` prop.
  const [text, setText] = useState(value);

  // Keep in sync if the parent passes a new `value` externally (e.g. new
  // bytes arriving from the stream). In remote mode (fileId set), content
  // lives server-side and is fetched in windows by the child components —
  // mirroring the full `value` into local state here would just recreate
  // the same "hold the whole file in one string" problem one layer up.
  useEffect(() => {
    if (fileId) return;
    setText(value);
  }, [value, fileId]);

  return (
    <div className="editor-host" style={{ height: "100%" }}>
      <div className="editor-split" style={{ display: "flex", height: "100%" }}>
        <div
          className="textarea-wrapper"
          style={{
            flex: 1,
            minWidth: 0,
            height: "100%",
            background: "var(--jt-editor-bg, #1e1e1e)",
          }}
        >
          <VirtualTextArea value={text} onChange={setText} fileId={fileId} />
        </div>

        <div className="tree-wrapper" style={{ flex: 1, minWidth: 0, height: "100%" }}>
          {fileId ? (
            <JsonTreeView fileId={fileId} defaultExpandDepth={2} />
          ) : (
            <div className="jt-pane" style={{ display: "flex", flexDirection: "column", height: "100%", alignItems: "center", justifyContent: "center", color: "var(--jt-linenum, #6b7078)", fontSize: 13 }}>
              Load a file to see the tree view
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
