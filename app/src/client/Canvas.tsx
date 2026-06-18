// The canvas viewport: a single <svg> rendered from the SHARED draw table
// (buildSvg) — human pixels == the agent's rasterized composition. Selection is a
// data-node-id DOM hit-test, disabled while a run is active (single-writer guard).
// The marks beat is a transient overlay drawn from the LIVE MIRROR bboxes (crisp,
// perfectly aligned), driven by useRunStore — NOT the doc store.

import { useEffect, useMemo, useRef, useState } from "react";
import { buildSvg } from "../render/svg-build.js";
import type { NodeId } from "../shared/types.js";
import { docMirror, useDocVersion, useRunState } from "./stores.js";
import { send } from "./ws.js";

const MARKS_FLASH_MS = 2600; // float briefly, then dock to the corner thumbnail

export function Canvas() {
  const version = useDocVersion(); // re-render on every mirror mutation OR selection change
  const run = useRunState();
  const [flashMarks, setFlashMarks] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Selection lives in the single doc-mirror source (drives this layer, the prompt
  // placeholder, and the id set shipped with the prompt) — never a local copy.
  const selection = docMirror.selection;

  const runActive =
    run.phase !== "IDLE" && run.phase !== "DONE" && run.phase !== "ESCALATED";

  const { svg } = useMemo(
    () => buildSvg(docMirror.store, docMirror.store.rootId, { marks: false }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  // Fit-to-content: scale the stage so the active seed's page frames reasonably,
  // regardless of its bbox (landing/scattered/buttons differ). NO pan/zoom — just a
  // single computed scale that re-fits on container resize and seed change.
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const [, , vw, vh] = viewBoxDims();
      if (!vw || !vh) return;
      const padding = 48; // breathing room inside the viewport
      const sw = (el.clientWidth - padding) / vw;
      const sh = (el.clientHeight - padding) / vh;
      // Never upscale past 1:1 (keeps text crisp); fit to the tighter axis.
      setFit(Math.max(0.1, Math.min(1, sw, sh)));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [version]);

  // Flash the marks overlay when a fresh marks beat arrives (PERCEIVING).
  useEffect(() => {
    if (!run.marks) return;
    setFlashMarks(true);
    const t = setTimeout(() => setFlashMarks(false), MARKS_FLASH_MS);
    return () => clearTimeout(t);
  }, [run.marks?.at]);

  // Marks overlay: drawn from the live mirror's bboxes (not the doc store, not the
  // server image) so the boxes are crisp and aligned to what's on screen.
  const markBoxes = useMemo(() => {
    if (!run.marks) return [];
    return Object.entries(run.marks.markMap)
      .map(([m, id]) => {
        const n = docMirror.store.getNode(id);
        return n ? { m, bbox: n.bbox } : null;
      })
      .filter((x): x is { m: string; bbox: [number, number, number, number] } => !!x);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.marks?.at, version]);

  function onClick(e: React.MouseEvent) {
    if (runActive) return; // selection disabled mid-run (single-writer guard)
    const target = (e.target as Element).closest("[data-node-id]");
    const id = target?.getAttribute("data-node-id") as NodeId | null;
    const hit = id && id !== docMirror.store.rootId ? id : null;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const cur = docMirror.selection;

    let next: NodeId[];
    if (!hit) {
      // Click on empty canvas / the root frame clears the selection.
      next = [];
    } else if (additive) {
      // Shift / Cmd / Ctrl-click TOGGLES the node in/out of the selection set.
      next = cur.includes(hit) ? cur.filter((x) => x !== hit) : [...cur, hit];
    } else {
      // Plain click selects just that node.
      next = [hit];
    }

    docMirror.setSelection(next);
    send({ t: "select", ids: next });
  }

  return (
    <div
      ref={containerRef}
      onClick={onClick}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        boxSizing: "border-box",
        cursor: runActive ? "default" : "pointer",
      }}
    >
      {/* Sizing box reserves the SCALED footprint so the transform-scaled stage
          centers without spurious scrollbars; overlays live inside, so they scale
          and stay pixel-aligned to the injected SVG. */}
      <div
        style={{
          position: "relative",
          width: viewBoxDims()[2] * fit,
          height: viewBoxDims()[3] * fit,
          flex: "0 0 auto",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
            transform: `scale(${fit})`,
            transformOrigin: "top left",
          }}
        >
          {/* The injected SVG string — the SAME bytes the rasterizer consumes. */}
          <div dangerouslySetInnerHTML={{ __html: svg }} />

          {/* Selection outline(s), absolutely positioned in the SVG's coord space. */}
          <SelectionLayer selection={selection} />

          {/* Marks beat overlay — transient, from the live mirror bboxes. */}
          {flashMarks && <MarksLayer boxes={markBoxes} />}
        </div>
      </div>

      {/* Agent's-eye corner thumbnail (the server PNG the model actually saw). */}
      {run.marks?.image && (run.phase === "PERCEIVING" || flashMarks) && (
        <img
          alt="agent's eye"
          src={`data:image/png;base64,${run.marks.image}`}
          style={{
            position: "fixed",
            right: 16,
            bottom: 96,
            width: 180,
            border: "2px solid #7c3aed",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
            background: "#fff",
            zIndex: 30,
          }}
        />
      )}
    </div>
  );
}

function viewBoxDims() {
  const root = docMirror.store.getNode(docMirror.store.rootId);
  return root ? root.bbox : [0, 0, 0, 0];
}

function SelectionLayer({ selection }: { selection: NodeId[] }) {
  const [vx, vy, vw, vh] = viewBoxDims();
  if (!selection.length) return null;
  return (
    <svg
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      width={vw}
      height={vh}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
    >
      {selection.map((id) => {
        const n = docMirror.store.getNode(id);
        if (!n) return null;
        const [x, y, w, h] = n.bbox;
        // A tinted fill + a doubled outline (halo + crisp line) so EVERY selected
        // node reads obviously, even with 3+ outlines overlapping a busy canvas.
        return (
          <g key={id}>
            <rect x={x} y={y} width={w} height={h} fill="#2563eb" fillOpacity={0.08} />
            <rect
              x={x - 1}
              y={y - 1}
              width={w + 2}
              height={h + 2}
              fill="none"
              stroke="#fff"
              strokeWidth={4}
            />
            <rect
              x={x - 1}
              y={y - 1}
              width={w + 2}
              height={h + 2}
              fill="none"
              stroke="#2563eb"
              strokeWidth={2}
            />
          </g>
        );
      })}
    </svg>
  );
}

function MarksLayer({
  boxes,
}: {
  boxes: { m: string; bbox: [number, number, number, number] }[];
}) {
  const [vx, vy, vw, vh] = viewBoxDims();
  return (
    <svg
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      width={vw}
      height={vh}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
    >
      {boxes.map(({ m, bbox: [x, y, w, h] }) => (
        <g key={m}>
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill="none"
            stroke="#7c3aed"
            strokeWidth={2}
            strokeDasharray="4 3"
          />
          <rect x={x} y={y} width={20} height={16} fill="#7c3aed" rx={3} />
          <text
            x={x + 10}
            y={y + 12}
            fontFamily="Inter, system-ui, sans-serif"
            fontSize={12}
            fill="#fff"
            textAnchor="middle"
            fontWeight={700}
          >
            {m}
          </text>
        </g>
      ))}
    </svg>
  );
}
