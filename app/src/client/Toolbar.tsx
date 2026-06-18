// The human's tool palette: pick Select (the default direct-manipulation mode) or
// one of the create tools (Frame / Text / Rect / Ellipse). The active mode drives
// Canvas's pointer state machine via the toolMode store. Editing is LOCKED while a
// run is active (single-writer guard), so every button disables and the mode is
// forced back to "select" — exactly like the rest of the chrome reads runActive.

import { useEffect } from "react";
import { setToolMode, useRunState, useToolMode, type ToolMode } from "./stores.js";

const TOOLS: { mode: ToolMode; label: string }[] = [
  { mode: "select", label: "Select" },
  { mode: "frame", label: "Frame" },
  { mode: "text", label: "Text" },
  { mode: "rect", label: "Rect" },
  { mode: "ellipse", label: "Ellipse" },
];

export function Toolbar() {
  const mode = useToolMode();
  const run = useRunState();
  const runActive =
    run.phase !== "IDLE" && run.phase !== "DONE" && run.phase !== "ESCALATED";

  // A run starting mid-create must not leave a create tool armed — force back to
  // select so a stale mode can't fire a gesture the instant the run ends.
  useEffect(() => {
    if (runActive && mode !== "select") setToolMode("select");
  }, [runActive, mode]);

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: 4,
        borderRadius: 10,
        border: "1px solid #d1d5db",
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
      }}
    >
      {TOOLS.map(({ mode: m, label }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            onClick={() => setToolMode(m)}
            disabled={runActive}
            title={label}
            style={{
              padding: "5px 10px",
              borderRadius: 6,
              border: "1px solid",
              borderColor: active ? "#7c3aed" : "#d1d5db",
              background: runActive ? "#f3f4f6" : active ? "#7c3aed" : "#fff",
              color: runActive ? "#9ca3af" : active ? "#fff" : "#111",
              fontWeight: active ? 600 : 400,
              fontSize: 13,
              cursor: runActive ? "default" : "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
