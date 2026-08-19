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

  // When true, the left source panel is collapsed to a thin vertical strip and
  // the tree pane takes the full editor width.
  const [textCollapsed, setTextCollapsed] = useState(false);

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
        {textCollapsed ? (
          <div className="collapse-strip" onClick={() => setTextCollapsed(false)} title="Expand source panel">
            <span className="collapse-strip-label">Source text</span>
          </div>
        ) : (
          <div
            className="textarea-wrapper"
            style={{
              flex: 1,
              minWidth: 0,
              height: "100%",
            }}
          >
            <div className="jt-toolbar">
              <span className="jt-toolbar-title">Source Text</span>
              <div className="jt-toolbar-actions" aria-label="Source text actions">
                <button
                  type="button"
                  className="text-toggle"
                  title="Collapse source panel"
                  aria-label="Collapse source panel"
                  onClick={() => setTextCollapsed(true)}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path
                      d="M11 3 L5 8 L11 13 Z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </div>
            </div>
            <VirtualTextArea value={text} onChange={setText} fileId={fileId} />
          </div>
        )}

        <div className="tree-wrapper" style={{ flex: 1, minWidth: 0, height: "100%" }}>
          <JsonTreeView
            source={text}
            fileId={fileId ?? null}
            defaultExpandDepth={true}
          />
        </div>
      </div>
    </div>
  );
}
