// The canvas viewport: a single <svg> rendered from the SHARED draw table
// (buildSvg) — human pixels == the agent's rasterized composition. Selection is a
// data-node-id DOM hit-test, disabled while a run is active (single-writer guard).
// The marks beat is a transient overlay drawn from the LIVE MIRROR bboxes (crisp,
// perfectly aligned), driven by useRunStore — NOT the doc store.

import { useEffect, useMemo, useRef, useState } from "react";
import { buildSvg } from "../render/svg-build.js";
import { contentBounds } from "../shared/store.js";
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
  type Camera,
  type HandleId,
  fitCamera,
  handlePositions,
  moveBBox,
  normalizeRect,
  panCamera,
  resizeBBox,
  screenToCanvas,
  zoomAt,
} from "./canvas-math.js";

const MARKS_FLASH_MS = 2600; // float briefly, then dock to the corner thumbnail
const DRAG_THRESHOLD = 3; // screen px before a press becomes a move/resize (plain click still selects)
const MIN_SIZE = 4; // minimum node w/h a resize may produce, in canvas px
const HANDLE_PX = 8; // on-screen handle size; divided by zoom so it stays constant
const REPARENT_ECHO_TIMEOUT_MS = 1500; // wait this long for the setBBox echo before bailing

// Interactive camera limits + fit breathing room (all CLIENT-only view state).
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const FIT_PADDING = 48;
// The hand/pan tool's ToolMode value (the Hand button in the toolbar).
const PAN_TOOL: ToolMode = "clickthrough";

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
      orig: Map<NodeId, BBox>; // original bboxes of every MOVED node (selection + descendants)
      selIds: NodeId[]; // the SELECTED ids (drives reparent: only single-select moves reparent)
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
    }
  | {
      // View-only camera pan (hand tool or held Space): drags the camera, never the
      // doc. Pans imperatively via e.movementX/Y on pointermove — no doc preview.
      kind: "pan";
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
  // The container is the STABLE element: its content-box origin coincides with the
  // stage origin (padding:0), so all screen<->canvas math measures against THIS rect,
  // never the stage (which moves under the camera transform).
  const containerRef = useRef<HTMLDivElement>(null);
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

  // Interactive camera — CLIENT-ONLY view state in the Phase-2 ABSOLUTE convention
  // (screen = rect.left + tx + canvasCoord*zoom). It is NEVER fed into perception /
  // buildSvg: the agent's eye is the unscaled, unpanned composition. Mirrored into a
  // ref so non-React wheel/pointer handlers read the live camera without stale closures.
  const [cam, setCam] = useState<Camera>({ tx: 0, ty: 0, zoom: 1 });
  const camRef = useRef(cam);
  useEffect(() => {
    camRef.current = cam;
  }, [cam]);
  // True once the user has taken manual control of the camera (pan/zoom). While false,
  // the camera auto-fits content (mount/resize/scene-switch); once true, resize and
  // layout-settle no longer stomp the user's view. fitToContent() resets it to false.
  const userMovedCam = useRef(false);
  // Every user-driven camera change goes through this so resize/auto-fit won't override it.
  function moveCamera(next: Camera) {
    userMovedCam.current = true;
    setCam(next);
  }
  // Held-Space pans regardless of the active tool (standard canvas affordance).
  const [spaceDown, setSpaceDown] = useState(false);
  const spaceRef = useRef(false);
  // The seed we last auto-fitted to: we re-fit ONLY on an actual scene change, never
  // on version bumps (which would reset the user's pan/zoom on every agent edit).
  const lastFitSeed = useRef<string | null>(null);

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

  // Frame ALL content in the container with breathing room, centered. The fit/reset
  // primitive — used on mount, container resize, scene switch, and the Fit button.
  // Returns true once it actually fit (container measured + content non-empty) so the
  // seed-gate below only latches after a real fit — otherwise the first (empty-store,
  // pre-sync) pass would consume the gate and the loaded doc would never auto-fit.
  function fitToContent(): boolean {
    const el = containerRef.current;
    if (!el) return false;
    const bbox = contentBounds(docMirror.store, docMirror.store.rootId);
    if (!bbox[2] || !bbox[3]) return false;
    setCam(
      fitCamera(
        bbox,
        { width: el.clientWidth, height: el.clientHeight },
        FIT_PADDING,
        MIN_ZOOM,
        MAX_ZOOM,
      ),
    );
    userMovedCam.current = false; // fit IS the framed baseline — resize may re-fit again
    return true;
  }

  // Auto-fit on initial mount (after the container is measured), on container resize,
  // and on scene switch (seedDocId change) — but NEVER on version bumps, so an agent
  // edit mid-run preserves the user's pan/zoom. We re-fit only when the seed actually
  // changes (tracked in lastFitSeed); the ResizeObserver re-fits on container resize.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!userMovedCam.current) fitToContent();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (lastFitSeed.current === docMirror.seedDocId) return;
    // Latch the seed only when the fit actually lands (content is loaded), so a pre-sync
    // empty-store pass doesn't consume the gate and suppress the real auto-fit.
    if (fitToContent()) lastFitSeed.current = docMirror.seedDocId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Map a client point to canvas coords via the live camera, measured against the
  // STABLE container rect (the stage moves under the transform, so it can't be used).
  function toCanvas(clientX: number, clientY: number): [number, number] {
    const rect = containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
    return screenToCanvas(clientX, clientY, rect, camRef.current);
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
        const t = docMirror.store.getNode(id)?.type;
        if (!exclude?.has(id) && (t === "FRAME" || t === "GROUP")) return id;
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

  function isLayoutDropTarget(id: NodeId | null): boolean {
    if (!id) return false;
    const mode = docMirror.store.getNode(id)?.layout?.mode;
    return mode === "HORIZONTAL" || mode === "VERTICAL";
  }

  function nodeDepth(id: NodeId): number {
    let depth = 0;
    let cur = docMirror.store.getNode(id)?.parent ?? null;
    while (cur) {
      depth += 1;
      cur = docMirror.store.getNode(cur)?.parent ?? null;
    }
    return depth;
  }

  // Resolve a drop target by geometry, not by the pointer event's DOM target. During
  // a drag, pointer capture and the moving preview often make the event target the
  // dragged node/canvas, so DOM hit-testing misses the frame underneath the cursor.
  function frameAtPoint(cx: number, cy: number, exclude?: Set<NodeId>): NodeId | null {
    let best: { id: NodeId; depth: number; area: number } | null = null;
    for (const n of docMirror.store.all().values()) {
      if (exclude?.has(n.id)) continue;
      if (n.type !== "FRAME" && n.type !== "GROUP") continue;
      const [x, y, w, h] = n.bbox;
      if (cx < x || cy < y || cx > x + w || cy > y + h) continue;
      const candidate = { id: n.id, depth: nodeDepth(n.id), area: w * h };
      if (
        !best ||
        candidate.depth > best.depth ||
        (candidate.depth === best.depth && candidate.area < best.area)
      ) {
        best = candidate;
      }
    }
    return best?.id ?? null;
  }

  // Is any ANCESTOR of `id` in the selection? Used so a press inside a selected
  // group/frame drags the whole group (its children have rects; the group itself
  // may render nothing, so the hit-test lands on a child).
  function ancestorSelected(id: NodeId, sel: NodeId[]): boolean {
    let cur = docMirror.store.getNode(id)?.parent ?? null;
    while (cur) {
      if (sel.includes(cur)) return true;
      cur = docMirror.store.getNode(cur)?.parent ?? null;
    }
    return false;
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
    // The zoom-control lives inside this container; without this guard our
    // setPointerCapture below would swallow the buttons' click events.
    if (el.closest(".zoom-control")) return;
    const cur = docMirror.selection;

    const tool = getToolMode();

    // 0a) Camera pan: the hand/pan tool OR held Space. View-only, never touches the
    //     doc — just drags the camera on pointermove. Takes precedence over all else.
    if (tool === PAN_TOOL || spaceRef.current) {
      gestureRef.current = { kind: "pan" };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      return;
    }

    // 0b) Non-select tools are either box creation or vector point capture. The parent
    //     is the deepest FRAME under the START point.
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
          selIds: [n.id],
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
    // Drag the SELECTION when the press lands on a selected node OR on a descendant of
    // one (so clicking inside a selected group moves the whole group, Figma-style).
    if (hit && (cur.includes(hit) || ancestorSelected(hit, cur))) {
      // Move the selection AND every descendant together, so dragging a frame/group
      // carries its contents (positions are absolute — a parent doesn't move children
      // on its own). The map dedups, so a selected parent+child translate exactly once.
      const orig = new Map<NodeId, BBox>();
      const ids = new Set<NodeId>();
      for (const id of cur) subtreeIds(id, ids);
      for (const id of ids) {
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
        selIds: [...cur],
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

    if (g.kind === "pan") {
      // Drag the camera by the raw screen-pixel delta (view-only; no doc preview).
      moveCamera(panCamera(camRef.current, e.movementX, e.movementY));
      return;
    }

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
      if (g.selIds.length === 1) {
        const draggedId = g.selIds[0];
        const dragged = docMirror.store.getNode(draggedId);
        const exclude = new Set<NodeId>();
        subtreeIds(draggedId, exclude); // self + descendants (mirrors the server cycle guard)
        target = frameAtPoint(cx, cy, exclude);
        if (target === dragged?.parent && !isLayoutDropTarget(target)) target = null;
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

    if (g.kind === "pan") return; // view-only; nothing to commit

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
      if (g.kind === "move") resolveSelectClick(g.selIds[0] ?? null, false);
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

    // Drag-to-reparent: a single SELECTED node dropped into a valid new frame/group.
    // (bboxes may carry descendants too, but only the selected node reparents.) We must
    // send setBBoxes FIRST (above), then reparent — but reparent's baseVersion would be
    // STALE if we fired it immediately, because sendTool reads docMirror.version, which
    // only advances when the server echoes the setBBoxes. So we AWAIT the echo
    // (docMirror.nextOpsApplied) before sending reparent, racing it against a timeout
    // so a missing echo can't hang the gesture — on timeout we skip and resync.
    const selId = g.kind === "move" ? g.selIds[0] : null;
    if (target && selId) {
      const id = selId;
      const echoed = Symbol("echoed");
      const timedOut = Symbol("timedout");
      Promise.race([
        docMirror.nextOpsApplied().then(() => echoed),
        new Promise<typeof timedOut>((res) =>
          setTimeout(() => res(timedOut), REPARENT_ECHO_TIMEOUT_MS),
        ),
      ]).then((winner) => {
        if (winner === echoed) {
          const parent = docMirror.store.getNode(id)?.parent ?? null;
          if (isLayoutDropTarget(target)) {
            sendTool("snapIntoLayout", { id, parent: target }); // fresh baseVersion now
          } else if (target !== parent) {
            sendTool("reparentNodes", { id, parent: target }); // fresh baseVersion now
          }
        } else {
          send({ t: "resync" }); // echo never arrived → re-anchor to authoritative truth
        }
      });
    }
  }

  // Wheel: ctrl/meta held → zoom-to-cursor; otherwise two-axis pan. Attached
  // imperatively with {passive:false} so we can preventDefault the browser's
  // page-zoom / scroll. Reads the live camera + container rect via refs.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        // Pinch-zoom / ctrl+wheel → zoom about the cursor. deltaY<0 zooms in.
        const factor = Math.exp(-e.deltaY * 0.01);
        moveCamera(zoomAt(camRef.current, factor, e.clientX, e.clientY, rect, MIN_ZOOM, MAX_ZOOM));
      } else {
        // Plain wheel / trackpad scroll → pan (natural direction).
        moveCamera(panCamera(camRef.current, -e.deltaX, -e.deltaY));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Track held Space (enables temporary pan over any tool). Mirrored to a ref so the
  // pointerdown handler reads it live. Ignored while typing so Space in the prompt box
  // is unaffected, and skipped mid-run.
  useEffect(() => {
    function isTyping() {
      const ae = document.activeElement;
      const tag = ae?.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (ae as HTMLElement | null)?.isContentEditable === true
      );
    }
    function onDown(e: KeyboardEvent) {
      if (e.code === "Space" && !isTyping() && !runActive) {
        spaceRef.current = true;
        setSpaceDown(true);
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceRef.current = false;
        setSpaceDown(false);
      }
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [runActive]);

  // Camera keyboard shortcuts. GUARDED to ignore keystrokes while typing in an
  // INPUT/TEXTAREA/contentEditable so the prompt box is unaffected. These are
  // view-only: none of them mutate the doc or flow into perception.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ae = document.activeElement;
      const tag = ae?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (ae as HTMLElement | null)?.isContentEditable;
      if (typing) return;
      const el = containerRef.current;
      const center = (): { x: number; y: number; rect: DOMRect } | null => {
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
      };

      // Shift+1 → fit all content.
      if (e.key === "!" || (e.shiftKey && e.key === "1")) {
        e.preventDefault();
        fitToContent();
        return;
      }
      // Shift+2 → fit the current selection (no-op on empty selection).
      if (e.key === "@" || (e.shiftKey && e.key === "2")) {
        e.preventDefault();
        const sel = docMirror.selection;
        if (!sel.length || !el) return;
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity;
        for (const id of sel) {
          const n = docMirror.store.getNode(id);
          if (!n) continue;
          const [x, y, w, h] = n.bbox;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x + w > maxX) maxX = x + w;
          if (y + h > maxY) maxY = y + h;
        }
        if (minX === Infinity) return;
        moveCamera(
          fitCamera(
            [minX, minY, maxX - minX, maxY - minY],
            { width: el.clientWidth, height: el.clientHeight },
            FIT_PADDING,
            MIN_ZOOM,
            MAX_ZOOM,
          ),
        );
        return;
      }
      // Cmd/Ctrl+0 → reset zoom to exactly 1, about the container center.
      if ((e.metaKey || e.ctrlKey) && e.key === "0") {
        e.preventDefault();
        const c = center();
        if (!c) return;
        moveCamera(
          zoomAt(camRef.current, 1 / camRef.current.zoom, c.x, c.y, c.rect, MIN_ZOOM, MAX_ZOOM),
        );
        return;
      }
      // "=" / "+" → zoom in step; "-" → zoom out step, both about the center.
      if (!e.metaKey && !e.ctrlKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        const c = center();
        if (!c) return;
        moveCamera(zoomAt(camRef.current, 1.2, c.x, c.y, c.rect, MIN_ZOOM, MAX_ZOOM));
        return;
      }
      if (!e.metaKey && !e.ctrlKey && e.key === "-") {
        e.preventDefault();
        const c = center();
        if (!c) return;
        moveCamera(zoomAt(camRef.current, 1 / 1.2, c.x, c.y, c.rect, MIN_ZOOM, MAX_ZOOM));
        return;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Step-zoom about the container center — shared by the +/- UI buttons.
  function zoomStep(factor: number) {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    moveCamera(
      zoomAt(
        camRef.current,
        factor,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        rect,
        MIN_ZOOM,
        MAX_ZOOM,
      ),
    );
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
      const ae = document.activeElement;
      const tag = ae?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (ae as HTMLElement | null)?.isContentEditable;
      if (typing) return;

      // ⌘G / Ctrl-G groups the current selection into a new GROUP; ⌘⇧G / Ctrl-⇧G
      // dissolves a selected GROUP back into its parent.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g") {
        e.preventDefault();
        const sel = docMirror.selection;
        if (e.shiftKey) {
          if (sel.length === 1) {
            const n = docMirror.store.getNode(sel[0]);
            if (n?.type === "GROUP" && n.children.length) {
              const kids = [...n.children];
              sendTool("ungroupNodes", { id: sel[0] });
              docMirror.setSelection(kids); // ids survive the hoist → keep them selected
              send({ t: "select", ids: kids });
            }
          }
        } else if (sel.length >= 1) {
          docMirror.selectNextAdded(); // select the new group on the server echo
          sendTool("groupNodes", { ids: sel });
        }
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        const sel = docMirror.selection;
        if (!sel.length) return;
        e.preventDefault();
        sendTool("deleteNodes", { ids: sel });
        docMirror.clearSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runActive]);

  // Reconcile the Phase-2 ABSOLUTE camera with the overlays' viewBox origin: each
  // overlay (and the injected SVG) draws a canvas point (cx,cy) at element-local pixel
  // (cx - vx, cy - vy). So the stage transform must ADD BACK the viewBox origin scaled
  // by zoom, on top of the camera translate, to land the same canvas point on screen.
  const [vx, vy] = viewBoxDims();
  // The grab affordance shows whenever a pan is available (hand tool or held Space).
  const panning = !runActive && (toolMode === PAN_TOOL || spaceDown);

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
        padding: 0,
        boxSizing: "border-box",
        cursor: runActive
          ? "default"
          : panning
            ? "grab"
            : toolMode !== "select"
              ? "crosshair"
              : "pointer",
      }}
    >
      {/* The transform-scaled/translated STAGE: fills from the container origin so the
          container rect (stable) maps cleanly to canvas coords. The injected SVG +
          overlays live inside, so they pan/zoom together and stay pixel-aligned. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          borderRadius: 2,
          boxShadow: "0 18px 60px rgba(18,24,38,0.16), 0 1px 0 rgba(255,255,255,0.8)",
          transform: `translate(${cam.tx + vx * cam.zoom}px, ${cam.ty + vy * cam.zoom}px) scale(${cam.zoom})`,
          transformOrigin: "top left",
        }}
      >
        {/* The injected SVG string — the SAME bytes the rasterizer consumes. */}
        <div dangerouslySetInnerHTML={{ __html: svg }} />

        {/* Selection outline(s) + resize handles, in the SVG's coord space. */}
        <SelectionLayer selection={selection} zoom={cam.zoom} runActive={runActive} />

        {/* Transient gesture overlay: create rubber-band + reparent drop target. */}
        {(createRect || vectorPreview || reparentTarget) && (
          <GestureOverlay
            createRect={createRect}
            vectorPreview={vectorPreview}
            vectorPath={vectorPreview ? previewPath(vectorPreview) : null}
            reparentTarget={reparentTarget}
            zoom={cam.zoom}
          />
        )}

        {/* Marks beat overlay — transient, from the live mirror bboxes. */}
        {flashMarks && <MarksLayer boxes={markBoxes} />}
      </div>

      {/* Zoom control, bottom-left (clear of the agent's-eye thumbnail bottom-right). */}
      <div className="zoom-control" aria-label="Zoom">
        <button
          className="tool-button"
          onClick={() => zoomStep(1 / 1.2)}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="zoom-readout">{Math.round(cam.zoom * 100)}%</span>
        <button
          className="tool-button"
          onClick={() => zoomStep(1.2)}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="tool-button zoom-fit"
          onClick={() => fitToContent()}
          title="Fit to content"
          aria-label="Fit to content"
        >
          Fit
        </button>
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
  // Frame ALL content (root frame UNION every node), so nodes that escaped the root
  // frame stay visible. Equals root.bbox when nothing has escaped.
  return contentBounds(docMirror.store, docMirror.store.rootId);
}

function SelectionLayer({
  selection,
  zoom,
  runActive,
}: {
  selection: NodeId[];
  zoom: number;
  runActive: boolean;
}) {
  const [vx, vy, vw, vh] = viewBoxDims();
  if (!selection.length) return null;
  // Handles only for a single, manipulable selection (resizeBBox is single-node and
  // setBBox is single-id). Sized in SCREEN px by dividing the constant by zoom.
  const single = selection.length === 1 ? docMirror.store.getNode(selection[0]) : null;
  const showHandles = !!single && !runActive;
  const hs = HANDLE_PX / zoom; // handle side length in canvas units → ~HANDLE_PX on screen
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
            strokeWidth={1 / zoom}
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
  zoom,
}: {
  createRect: BBox | null;
  vectorPreview: VectorPreview | null;
  vectorPath: string | null;
  reparentTarget: NodeId | null;
  zoom: number;
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
          strokeWidth={2 / zoom}
          strokeDasharray={`${6 / zoom} ${4 / zoom}`}
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
          strokeWidth={1.5 / zoom}
          strokeDasharray={`${6 / zoom} ${4 / zoom}`}
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
            strokeWidth={1 / zoom}
            strokeDasharray={`${4 / zoom} ${4 / zoom}`}
          />
          <path
            d={vectorPath}
            fill="none"
            stroke="#2563eb"
            strokeWidth={4 / zoom}
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
