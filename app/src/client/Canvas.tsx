// The canvas viewport: a single <svg> rendered from the SHARED draw table
// (buildSvg) — human pixels == the agent's rasterized composition. Selection is a
// data-node-id DOM hit-test, disabled while a run is active (single-writer guard).
// The marks beat is a transient overlay drawn from the LIVE MIRROR bboxes (crisp,
// perfectly aligned), driven by useRunStore — NOT the doc store.

import { useEffect, useMemo, useRef, useState } from "react";
import { buildSvg } from "../render/svg-build.js";
import type { NodeId } from "../shared/types.js";
import {
  docMirror,
  getToolMode,
  setToolMode,
  useDocVersion,
  useRunState,
  useToolMode,
  type ToolMode,
} from "./stores.js";
import { send, sendTool } from "./ws.js";
import {
  type BBox,
  type HandleId,
  clientToCanvas,
  handlePositions,
  moveBBox,
  normalizeRect,
  resizeBBox,
} from "./canvas-math.js";

const MARKS_FLASH_MS = 2600; // float briefly, then dock to the corner thumbnail
const DRAG_THRESHOLD = 3; // screen px before a press becomes a move/resize (plain click still selects)
const MIN_SIZE = 4; // minimum node w/h a resize may produce, in canvas px
const HANDLE_PX = 8; // on-screen handle size; divided by `fit` so it stays constant
const REPARENT_ECHO_TIMEOUT_MS = 1500; // wait this long for the setBBox echo before bailing

// Default node size for a bare click (no rubber-band drag) in each create tool,
// anchored at the click point. Tuned so a single tap drops a usable element.
type BoxTool = Extract<ToolMode, "frame" | "text" | "rect" | "oval">;
type VectorTool = Extract<ToolMode, "line" | "arrow" | "draw">;

const BOX_TOOLS = new Set<ToolMode>(["frame", "text", "rect", "oval"]);
const VECTOR_TOOLS = new Set<ToolMode>(["line", "arrow", "draw"]);

const CREATE_DEFAULTS: Record<BoxTool, [number, number]> = {
  frame: [320, 360],
  text: [200, 40],
  rect: [120, 40],
  oval: [120, 40],
};

const DEFAULT_VECTOR_SIZE: Record<VectorTool, [number, number]> = {
  line: [140, 24],
  arrow: [140, 24],
  draw: [80, 40],
};

// The in-flight pointer gesture. Null = idle. `kind:"select"` is a pending click that
// only resolves on pointerup if no drag crossed the threshold. move/resize carry the
// original bboxes so we can rebuild the override map from the running delta each move.
type Gesture =
  | {
      kind: "select";
      startClientX: number;
      startClientY: number;
      hit: NodeId | null; // node under the press (null = empty canvas)
      additive: boolean;
    }
  | {
      kind: "move" | "resize";
      handle: HandleId | null; // resize handle, null for move
      startX: number; // gesture start in CANVAS coords
      startY: number;
      startClientX: number;
      startClientY: number;
      orig: Map<NodeId, BBox>; // original bboxes of every affected node
      dragging: boolean; // crossed the threshold yet?
      reparentTarget: NodeId | null; // valid drop-into FRAME under cursor (single-select moves only)
    }
  | {
      // A create-tool rubber-band: draws a LOCAL preview rect only; the real node is
      // minted server-side on pointerup (it doesn't exist yet, so nothing to preview
      // via docMirror — we render the dashed box directly).
      kind: "create";
      tool: BoxTool;
      startX: number; // start corner in CANVAS coords
      startY: number;
      startClientX: number;
      startClientY: number;
      parent: NodeId; // deepest FRAME under the START point (resolved on pointerdown)
      rect: BBox | null; // live preview rect (null until the first move)
    }
  | {
      kind: "vector";
      tool: VectorTool;
      startX: number;
      startY: number;
      startClientX: number;
      startClientY: number;
      parent: NodeId;
      points: Array<[number, number]>; // canvas-space points until committed
      preview: VectorPreview | null;
    };

interface VectorPreview {
  tool: VectorTool;
  bbox: BBox;
  points: Array<[number, number]>; // local to bbox
}

// Per-handle cursor so the affordance reads correctly. Diagonal handles get the
// matching resize cursor; edges get the axis cursor.
const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
};

export function Canvas() {
  const version = useDocVersion(); // re-render on every mirror mutation OR selection change
  const run = useRunState();
  const toolMode = useToolMode(); // active create tool (drives the crosshair cursor)
  const [flashMarks, setFlashMarks] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // The transform:scale(fit) STAGE div — its getBoundingClientRect() already reflects
  // the scale and centering, so clientToCanvas divides by `fit` against THIS rect.
  const stageRef = useRef<HTMLDivElement>(null);
  // The live gesture lives in a ref (not state): pointermove fires faster than React
  // re-renders, and we drive the preview imperatively via docMirror, not via setState.
  const gestureRef = useRef<Gesture | null>(null);
  // Overlay state for gestures that DON'T have a doc node to preview through the
  // mirror: the create rubber-band rect and the current reparent drop-target frame.
  // These DO need a re-render, so they live in React state (low-frequency relative
  // to bbox previews, which still go through docMirror.previewBboxes).
  const [createRect, setCreateRect] = useState<BBox | null>(null);
  const [vectorPreview, setVectorPreview] = useState<VectorPreview | null>(null);
  const [reparentTarget, setReparentTarget] = useState<NodeId | null>(null);

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

  // Map a client point to canvas coords against the SCALED stage rect + viewBox origin.
  function toCanvas(clientX: number, clientY: number): [number, number] {
    const rect = stageRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    const [vx, vy] = viewBoxDims();
    return clientToCanvas(clientX, clientY, rect, fit, vx, vy);
  }

  // Resolve a no-drag press into a selection change (the OLD onClick logic verbatim).
  function resolveSelectClick(hit: NodeId | null, additive: boolean) {
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

  // Walk UP from a DOM element to the nearest ancestor that is a FRAME node, mapping
  // each data-node-id to its mirror node and stopping at the first FRAME. `exclude`
  // skips ids (the dragged node itself + its descendants + its current parent) so a
  // reparent never targets an invalid frame. Returns null if none qualifies.
  function frameUnder(el: Element | null, exclude?: Set<NodeId>): NodeId | null {
    let cur: Element | null = el;
    while (cur) {
      const node = cur.closest("[data-node-id]");
      if (!node) return null;
      const id = node.getAttribute("data-node-id") as NodeId | null;
      if (id) {
        if (!exclude?.has(id) && docMirror.store.getNode(id)?.type === "FRAME") return id;
        // Not a (valid) frame — keep climbing from this node's parent.
        cur = node.parentElement;
        continue;
      }
      cur = node.parentElement;
    }
    return null;
  }

  // Collect a node id + its entire subtree (for the reparent exclusion set).
  function subtreeIds(id: NodeId, into: Set<NodeId>) {
    into.add(id);
    const n = docMirror.store.getNode(id);
    if (n) for (const c of n.children) subtreeIds(c, into);
  }

  function normalizeVector(tool: VectorTool, points: Array<[number, number]>): VectorPreview {
    const meaningful =
      points.length >= 2
        ? points
        : [
            points[0],
            [points[0][0] + DEFAULT_VECTOR_SIZE[tool][0], points[0][1]],
          ];
    let minX = Math.min(...meaningful.map((p) => p[0]));
    let minY = Math.min(...meaningful.map((p) => p[1]));
    let maxX = Math.max(...meaningful.map((p) => p[0]));
    let maxY = Math.max(...meaningful.map((p) => p[1]));
    const strokePad = tool === "draw" ? 4 : 0;
    minX -= strokePad;
    minY -= strokePad;
    maxX += strokePad;
    maxY += strokePad;

    let w = maxX - minX;
    let h = maxY - minY;
    if (w < MIN_SIZE) {
      const pad = (MIN_SIZE - w) / 2;
      minX -= pad;
      w = MIN_SIZE;
    }
    if (h < MIN_SIZE) {
      const pad = (MIN_SIZE - h) / 2;
      minY -= pad;
      h = MIN_SIZE;
    }

    const bbox: BBox = [minX, minY, w, h];
    return {
      tool,
      bbox,
      points: meaningful.map(([x, y]) => [x - minX, y - minY] as [number, number]),
    };
  }

  function previewPath(preview: VectorPreview): string {
    const [x, y] = preview.bbox;
    return preview.points
      .map(([px, py], i) => `${i === 0 ? "M" : "L"} ${x + px} ${y + py}`)
      .join(" ");
  }

  function onPointerDown(e: React.PointerEvent) {
    if (runActive) return; // all gestures disabled mid-run (single-writer guard)
    const el = e.target as Element;
    const cur = docMirror.selection;

    // 0) Non-select tools are either inert click-through, box creation, or vector
    //    point capture. The parent is the deepest FRAME under the START point.
    const tool = getToolMode();
    if (tool === "clickthrough") return;
    if (BOX_TOOLS.has(tool)) {
      const [sx, sy] = toCanvas(e.clientX, e.clientY);
      const parent = frameUnder(el) ?? docMirror.store.rootId;
      gestureRef.current = {
        kind: "create",
        tool: tool as BoxTool,
        startX: sx,
        startY: sy,
        startClientX: e.clientX,
        startClientY: e.clientY,
        parent,
        rect: null,
      };
      setCreateRect(null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (VECTOR_TOOLS.has(tool)) {
      const [sx, sy] = toCanvas(e.clientX, e.clientY);
      const parent = frameUnder(el) ?? docMirror.store.rootId;
      gestureRef.current = {
        kind: "vector",
        tool: tool as VectorTool,
        startX: sx,
        startY: sy,
        startClientX: e.clientX,
        startClientY: e.clientY,
        parent,
        points: [[sx, sy]],
        preview: null,
      };
      setVectorPreview(null);
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    // 1) A resize handle (only rendered for single selection) → begin resize.
    const handleEl = el.closest("[data-handle]");
    if (handleEl && cur.length === 1) {
      const handle = handleEl.getAttribute("data-handle") as HandleId;
      const n = docMirror.store.getNode(cur[0]);
      if (n) {
        const [sx, sy] = toCanvas(e.clientX, e.clientY);
        gestureRef.current = {
          kind: "resize",
          handle,
          startX: sx,
          startY: sy,
          startClientX: e.clientX,
          startClientY: e.clientY,
          orig: new Map([[n.id, n.bbox as BBox]]),
          dragging: false,
          reparentTarget: null,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      }
      return;
    }

    // 2) A node already in the selection → begin a potential move of ALL selected.
    const nodeEl = el.closest("[data-node-id]");
    const nodeId = nodeEl?.getAttribute("data-node-id") as NodeId | null;
    const hit = nodeId && nodeId !== docMirror.store.rootId ? nodeId : null;
    if (hit && cur.includes(hit)) {
      const orig = new Map<NodeId, BBox>();
      for (const id of cur) {
        const n = docMirror.store.getNode(id);
        if (n) orig.set(id, n.bbox as BBox);
      }
      const [sx, sy] = toCanvas(e.clientX, e.clientY);
      gestureRef.current = {
        kind: "move",
        handle: null,
        startX: sx,
        startY: sy,
        startClientX: e.clientX,
        startClientY: e.clientY,
        orig,
        dragging: false,
        reparentTarget: null,
      };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    // 3) Anything else → a pending selection click, resolved on pointerup if no drag.
    gestureRef.current = {
      kind: "select",
      startClientX: e.clientX,
      startClientY: e.clientY,
      hit,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
    };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const g = gestureRef.current;
    if (!g || runActive) return;

    const movedPx =
      Math.abs(e.clientX - g.startClientX) + Math.abs(e.clientY - g.startClientY);

    if (g.kind === "select") {
      // A pending click never previews; it just waits for pointerup. (Crossing the
      // threshold here would mean a drag on an unselected node — we leave it a click.)
      return;
    }

    const [cx, cy] = toCanvas(e.clientX, e.clientY);

    if (g.kind === "create") {
      // Live rubber-band preview drawn directly (no doc node exists yet).
      const rect = normalizeRect(g.startX, g.startY, cx, cy, MIN_SIZE);
      g.rect = rect;
      setCreateRect(rect);
      return;
    }

    if (g.kind === "vector") {
      if (g.tool === "draw") {
        const last = g.points[g.points.length - 1];
        const dist = Math.abs(cx - last[0]) + Math.abs(cy - last[1]);
        if (dist >= 2) g.points.push([cx, cy]);
      } else {
        g.points = [
          [g.startX, g.startY],
          [cx, cy],
        ];
      }
      const preview = normalizeVector(g.tool, g.points);
      g.preview = preview;
      setVectorPreview(preview);
      return;
    }

    // Only begin manipulating once past the threshold, so a plain click on a selected
    // node doesn't micro-nudge it.
    if (!g.dragging && movedPx <= DRAG_THRESHOLD) return;
    g.dragging = true;

    const dx = cx - g.startX;
    const dy = cy - g.startY;

    const overrides = new Map<NodeId, BBox>();
    if (g.kind === "move") {
      for (const [id, bbox] of g.orig) overrides.set(id, moveBBox(bbox, dx, dy));
      // Drag-to-reparent (single selected node only): highlight the FRAME under the
      // cursor that is a VALID new parent — not the node itself, not its descendants,
      // not its current parent. Multi-select moves never reparent.
      let target: NodeId | null = null;
      if (g.orig.size === 1) {
        const draggedId = [...g.orig.keys()][0];
        const dragged = docMirror.store.getNode(draggedId);
        const exclude = new Set<NodeId>();
        subtreeIds(draggedId, exclude); // self + descendants (mirrors the server cycle guard)
        if (dragged?.parent) exclude.add(dragged.parent); // already there → no-op move
        target = frameUnder(e.target as Element, exclude);
      }
      if (target !== g.reparentTarget) {
        g.reparentTarget = target;
        setReparentTarget(target);
      }
    } else {
      for (const [id, bbox] of g.orig)
        overrides.set(id, resizeBBox(bbox, g.handle!, dx, dy, MIN_SIZE));
    }
    docMirror.previewBboxes(overrides); // LIVE feedback only — nothing sent yet
  }

  function onPointerUp(e: React.PointerEvent) {
    const g = gestureRef.current;
    gestureRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
    if (!g || runActive) return;

    if (g.kind === "create") {
      // Compute the new node's bbox: the rubber-band rect, or a sensible default size
      // anchored at the click point when it was a bare click (no drag).
      const [dw, dh] = CREATE_DEFAULTS[g.tool];
      const bbox: BBox = g.rect ?? [g.startX, g.startY, dw, dh];
      const parent = g.parent;
      // Auto-select the node on the server echo, then dispatch the matching create.
      docMirror.selectNextAdded();
      if (g.tool === "frame") sendTool("createFrame", { parent, bbox });
      else if (g.tool === "text") sendTool("createText", { parent, chars: "Text", bbox });
      else if (g.tool === "rect") sendTool("createShape", { parent, kind: "RECT", bbox });
      else if (g.tool === "oval") sendTool("createShape", { parent, kind: "ELLIPSE", bbox });
      setCreateRect(null);
      setToolMode("select"); // single-use create tool → revert to select after one drop
      return;
    }

    if (g.kind === "vector") {
      const preview =
        g.preview ??
        normalizeVector(g.tool, [
          [g.startX, g.startY],
          [g.startX + DEFAULT_VECTOR_SIZE[g.tool][0], g.startY],
        ]);
      if (g.tool === "draw" && g.points.length < 2) {
        setVectorPreview(null);
        setToolMode("select");
        return;
      }
      docMirror.selectNextAdded();
      sendTool("createVector", {
        parent: g.parent,
        kind: g.tool,
        bbox: preview.bbox,
        points: preview.points,
      });
      setVectorPreview(null);
      setToolMode("select");
      return;
    }

    if (g.kind === "select") {
      // No-drag press → resolve the selection click with the preserved modifiers.
      resolveSelectClick(g.hit, g.additive);
      return;
    }

    if (!g.dragging) {
      // A press on a selected node that never moved past the threshold → treat as a
      // plain click that re-selects just that node (matching single-click behavior).
      const id = [...g.orig.keys()][0];
      if (g.kind === "move") resolveSelectClick(id ?? null, false);
      return;
    }

    // Capture the reparent target before we clear the overlay state.
    const target = g.kind === "move" ? g.reparentTarget : null;
    setReparentTarget(null);

    // A real drag committed: send ONE setBBoxes for all affected nodes so they move
    // under a single version (N separate setBBox calls share one baseVersion and all
    // but the first would be STALE). The server's ops-applied echo snaps the mirror
    // back to authoritative truth.
    const bboxes: { id: NodeId; bbox: BBox }[] = [];
    for (const [id] of g.orig) {
      const n = docMirror.store.getNode(id);
      if (n) bboxes.push({ id, bbox: n.bbox as BBox });
    }
    if (bboxes.length) sendTool("setBBoxes", { items: bboxes });

    // Drag-to-reparent: a single node dropped into a valid new frame. We must send
    // setBBoxes FIRST (above), then reparent — but reparent's baseVersion would be
    // STALE if we fired it immediately, because sendTool reads docMirror.version,
    // which only advances when the server echoes the setBBoxes. So we AWAIT the echo
    // (docMirror.nextOpsApplied) before sending reparent, racing it against a timeout
    // so a missing echo can't hang the gesture — on timeout we skip and resync.
    if (target && bboxes.length === 1) {
      const id = bboxes[0].id;
      const echoed = Symbol("echoed");
      const timedOut = Symbol("timedout");
      Promise.race([
        docMirror.nextOpsApplied().then(() => echoed),
        new Promise<typeof timedOut>((res) =>
          setTimeout(() => res(timedOut), REPARENT_ECHO_TIMEOUT_MS),
        ),
      ]).then((winner) => {
        if (winner === echoed) {
          sendTool("reparentNodes", { id, parent: target }); // fresh baseVersion now
        } else {
          send({ t: "resync" }); // echo never arrived → re-anchor to authoritative truth
        }
      });
    }
  }

  // Escape cancels an in-flight drag: restore the originals locally, send nothing.
  // Delete/Backspace deletes the selection (unless typing in an input — future inspector).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (runActive) return; // no keyboard gestures mid-run
      const g = gestureRef.current;
      if (e.key === "Escape" && g) {
        if (g.kind === "create") {
          gestureRef.current = null;
          setCreateRect(null);
          setToolMode("select");
          return;
        }
        if (g.kind === "vector") {
          gestureRef.current = null;
          setVectorPreview(null);
          setToolMode("select");
          return;
        }
        if ((g.kind === "move" || g.kind === "resize") && g.dragging) {
          docMirror.previewBboxes(g.orig); // snap back to where the drag began
          setReparentTarget(null);
          gestureRef.current = null;
          return;
        }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = docMirror.selection;
        if (!sel.length) return;
        const ae = document.activeElement;
        const tag = ae?.tagName;
        const typing =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          (ae as HTMLElement | null)?.isContentEditable;
        if (typing) return;
        e.preventDefault();
        sendTool("deleteNodes", { ids: sel });
        docMirror.clearSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runActive]);

  return (
    <div
      ref={containerRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
        cursor:
          runActive || toolMode === "clickthrough"
            ? "default"
            : toolMode !== "select"
              ? "crosshair"
              : "pointer",
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
          ref={stageRef}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            borderRadius: 2,
            boxShadow: "0 18px 60px rgba(18,24,38,0.16), 0 1px 0 rgba(255,255,255,0.8)",
            transform: `scale(${fit})`,
            transformOrigin: "top left",
          }}
        >
          {/* The injected SVG string — the SAME bytes the rasterizer consumes. */}
          <div dangerouslySetInnerHTML={{ __html: svg }} />

          {/* Selection outline(s) + resize handles, in the SVG's coord space. */}
          <SelectionLayer selection={selection} fit={fit} runActive={runActive} />

          {/* Transient gesture overlay: create rubber-band + reparent drop target. */}
          {(createRect || vectorPreview || reparentTarget) && (
            <GestureOverlay
              createRect={createRect}
              vectorPreview={vectorPreview}
              vectorPath={vectorPreview ? previewPath(vectorPreview) : null}
              reparentTarget={reparentTarget}
              fit={fit}
            />
          )}

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
            border: "2px solid var(--accent)",
            borderRadius: 8,
            boxShadow: "0 18px 60px rgba(18,24,38,0.22)",
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

function SelectionLayer({
  selection,
  fit,
  runActive,
}: {
  selection: NodeId[];
  fit: number;
  runActive: boolean;
}) {
  const [vx, vy, vw, vh] = viewBoxDims();
  if (!selection.length) return null;
  // Handles only for a single, manipulable selection (resizeBBox is single-node and
  // setBBox is single-id). Sized in SCREEN px by dividing the constant by `fit`.
  const single = selection.length === 1 ? docMirror.store.getNode(selection[0]) : null;
  const showHandles = !!single && !runActive;
  const hs = HANDLE_PX / fit; // handle side length in canvas units → ~HANDLE_PX on screen
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
      {showHandles &&
        handlePositions(single!.bbox as BBox).map(({ id, cx, cy }) => (
          // pointerEvents:"auto" so ONLY the handle rects are hit-testable (the svg
          // layer stays pointerEvents:"none" so node bodies remain clickable below it).
          <rect
            key={id}
            data-handle={id}
            x={cx - hs / 2}
            y={cy - hs / 2}
            width={hs}
            height={hs}
            fill="#fff"
            stroke="#2563eb"
            strokeWidth={1 / fit}
            style={{ pointerEvents: "auto", cursor: HANDLE_CURSOR[id] }}
          />
        ))}
    </svg>
  );
}

// Transient overlay for the create rubber-band (a dashed blue rect) and the
// reparent drop-target (a dashed green outline around the FRAME we'd drop into).
// Both draw in the SVG's viewBox coord space, pointerEvents off so nothing blocks
// the gesture below.
function GestureOverlay({
  createRect,
  vectorPreview,
  vectorPath,
  reparentTarget,
  fit,
}: {
  createRect: BBox | null;
  vectorPreview: VectorPreview | null;
  vectorPath: string | null;
  reparentTarget: NodeId | null;
  fit: number;
}) {
  const [vx, vy, vw, vh] = viewBoxDims();
  const target = reparentTarget ? docMirror.store.getNode(reparentTarget) : null;
  return (
    <svg
      viewBox={`${vx} ${vy} ${vw} ${vh}`}
      width={vw}
      height={vh}
      style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}
    >
      {target && (
        <rect
          x={target.bbox[0]}
          y={target.bbox[1]}
          width={target.bbox[2]}
          height={target.bbox[3]}
          fill="#22c55e"
          fillOpacity={0.08}
          stroke="#16a34a"
          strokeWidth={2 / fit}
          strokeDasharray={`${6 / fit} ${4 / fit}`}
        />
      )}
      {createRect && (
        <rect
          x={createRect[0]}
          y={createRect[1]}
          width={createRect[2]}
          height={createRect[3]}
          fill="#2563eb"
          fillOpacity={0.08}
          stroke="#2563eb"
          strokeWidth={1.5 / fit}
          strokeDasharray={`${6 / fit} ${4 / fit}`}
        />
      )}
      {vectorPreview && vectorPath && (
        <>
          <rect
            x={vectorPreview.bbox[0]}
            y={vectorPreview.bbox[1]}
            width={vectorPreview.bbox[2]}
            height={vectorPreview.bbox[3]}
            fill="none"
            stroke="#2563eb"
            strokeWidth={1 / fit}
            strokeDasharray={`${4 / fit} ${4 / fit}`}
          />
          <path
            d={vectorPath}
            fill="none"
            stroke="#2563eb"
            strokeWidth={4 / fit}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
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
