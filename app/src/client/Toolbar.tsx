// The human's tool palette: pick Select/Click-through or one of the create tools.
// The active mode drives
// Canvas's pointer state machine via the toolMode store. Editing is LOCKED while a
// run is active (single-writer guard), so every button disables and the mode is
// forced back to "select" — exactly like the rest of the chrome reads runActive.

import { useEffect } from "react";
import {
  ArrowRight,
  Circle,
  Frame,
  Hand,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { setToolMode, useRunState, useToolMode, type ToolMode } from "./stores.js";
import { send } from "./ws.js";

const TOOLS: { mode: ToolMode; label: string; Icon: LucideIcon }[] = [
  { mode: "select", label: "Select", Icon: MousePointer2 },
  { mode: "clickthrough", label: "Click-through", Icon: Hand },
  { mode: "text", label: "Text", Icon: Type },
  { mode: "frame", label: "Frame", Icon: Frame },
  { mode: "rect", label: "Rectangle", Icon: Square },
  { mode: "oval", label: "Oval", Icon: Circle },
  { mode: "arrow", label: "Arrow", Icon: ArrowRight },
  { mode: "line", label: "Line", Icon: Minus },
  { mode: "draw", label: "Draw", Icon: Pencil },
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
    <div className="floating-toolbar" aria-label="Canvas tools">
      {TOOLS.map(({ mode: m, label, Icon }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            className={`tool-button${active ? " is-active" : ""}`}
            onClick={() => setToolMode(m)}
            disabled={runActive}
            title={label}
            aria-label={label}
            aria-pressed={active}
          >
            <Icon size={17} />
          </button>
        );
      })}
      <div className="toolbar-divider" />
      <button
        className="tool-button"
        onClick={() => send({ t: "undo" })}
        disabled={runActive || !run.canUndo}
        title="Undo"
        aria-label="Undo"
      >
        <Undo2 size={17} />
      </button>
      <button
        className="tool-button"
        onClick={() => send({ t: "redo" })}
        disabled={runActive || !run.canRedo}
        title="Redo"
        aria-label="Redo"
      >
        <Redo2 size={17} />
      </button>
    </div>
  );
}
