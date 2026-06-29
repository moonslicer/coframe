// Pure direct-manipulation math for the canvas — NO DOM, NO React, so the risky
// coordinate/resize arithmetic is headlessly testable (canvas-math.test-smoke.ts).
// All bboxes are the shared [x, y, w, h] tuple in CANVAS (viewBox) coordinates.

export type BBox = [number, number, number, number];
export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// Screen pixel -> canvas (viewBox) coordinate. Inverse of the stage transform:
// the stage div is `transform: scale(fit)` (origin top-left) and its SVG draws in
// viewBox space offset by the viewBox origin (originX, originY = vx, vy). So a
// client point, measured against the SCALED stage rect, divides by `fit` to undo
// the scale, then adds the viewBox origin to land in canvas coords.
export function clientToCanvas(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  fit: number,
  originX: number,
  originY: number,
): [number, number] {
  const cx = originX + (clientX - rect.left) / fit;
  const cy = originY + (clientY - rect.top) / fit;
  return [cx, cy];
}

// --- Interactive camera (Phase 2; not yet wired into Canvas.tsx). The stage is
// transformed as `translate(tx, ty) scale(zoom)` in SCREEN pixels relative to the
// container's top-left (rect). tx/ty are screen-pixel offsets, zoom is unitless.
export type Camera = { tx: number; ty: number; zoom: number };

// Screen point -> canvas point. Inverse of the stage transform: subtract the
// container origin and the camera translate, then undo the zoom.
export function screenToCanvas(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  cam: Camera,
): [number, number] {
  const cx = (clientX - rect.left - cam.tx) / cam.zoom;
  const cy = (clientY - rect.top - cam.ty) / cam.zoom;
  return [cx, cy];
}

// Canvas point -> screen point (forward transform). Exact inverse of screenToCanvas.
export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  rect: { left: number; top: number },
  cam: Camera,
): [number, number] {
  const sx = rect.left + cam.tx + canvasX * cam.zoom;
  const sy = rect.top + cam.ty + canvasY * cam.zoom;
  return [sx, sy];
}

// Zoom about a fixed SCREEN anchor (the cursor): scale zoom by `factor`, clamped to
// [minZoom, maxZoom], and shift tx/ty so the canvas point under the anchor stays put.
// Derivation: the anchor's container-local offset (ax, ay) must satisfy
// a = t + canvasUnderAnchor * zoom for both old & new zoom, so the canvas point
// cancels out: tNew = a - (a - tOld) * zoomNew / zoomOld. Returns a NEW Camera.
export function zoomAt(
  cam: Camera,
  factor: number,
  anchorClientX: number,
  anchorClientY: number,
  rect: { left: number; top: number },
  minZoom: number,
  maxZoom: number,
): Camera {
  const zoom = Math.max(minZoom, Math.min(maxZoom, cam.zoom * factor));
  const ax = anchorClientX - rect.left;
  const ay = anchorClientY - rect.top;
  const ratio = zoom / cam.zoom;
  return {
    tx: ax - (ax - cam.tx) * ratio,
    ty: ay - (ay - cam.ty) * ratio,
    zoom,
  };
}

// Pan by a SCREEN-pixel delta. Zoom unchanged. Returns a NEW Camera.
export function panCamera(cam: Camera, dxScreen: number, dyScreen: number): Camera {
  return { tx: cam.tx + dxScreen, ty: cam.ty + dyScreen, zoom: cam.zoom };
}

// Camera that fits a canvas-space bbox into a container with padding, centered.
// zoom fits the tighter axis (clamped), then tx/ty are set so the bbox center maps
// to the container center. The reset / zoom-to-fit / zoom-to-selection primitive.
export function fitCamera(
  bbox: BBox,
  container: { width: number; height: number },
  padding: number,
  minZoom: number,
  maxZoom: number,
): Camera {
  const [bx, by, bw, bh] = bbox;
  const sw = (container.width - 2 * padding) / bw;
  const sh = (container.height - 2 * padding) / bh;
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.min(sw, sh)));
  // bbox center -> container center: center = t + bboxCenter * zoom  =>  t = center - bboxCenter*zoom
  const bcx = bx + bw / 2;
  const bcy = by + bh / 2;
  return {
    tx: container.width / 2 - bcx * zoom,
    ty: container.height / 2 - bcy * zoom,
    zoom,
  };
}

// Translate a bbox by a canvas-space delta (drag-move). Size unchanged.
export function moveBBox(orig: BBox, dx: number, dy: number): BBox {
  const [x, y, w, h] = orig;
  return [x + dx, y + dy, w, h];
}

// Resize a bbox by dragging `handle` a canvas-space delta (dx, dy). Corner handles
// move two axes, edge handles one. w/h clamp to >= minSize; when a clamp engages on
// a left/top handle, x/y are pinned to the opposite edge minus minSize so they never
// overshoot past it (otherwise the box would flip/invert).
export function resizeBBox(
  orig: BBox,
  handle: HandleId,
  dx: number,
  dy: number,
  minSize: number,
): BBox {
  let [x, y, w, h] = orig;
  const right = x + w; // fixed edges when dragging the opposite side
  const bottom = y + h;

  // West side: x and w move together (left edge follows the cursor, right pinned).
  if (handle === "nw" || handle === "w" || handle === "sw") {
    x = x + dx;
    w = right - x;
    if (w < minSize) {
      w = minSize;
      x = right - minSize; // pin to the fixed right edge — no overshoot past it
    }
  }
  // East side: only w grows/shrinks (left edge pinned).
  if (handle === "ne" || handle === "e" || handle === "se") {
    w = w + dx;
    if (w < minSize) w = minSize;
  }
  // North side: y and h move together (top edge follows, bottom pinned).
  if (handle === "nw" || handle === "n" || handle === "ne") {
    y = y + dy;
    h = bottom - y;
    if (h < minSize) {
      h = minSize;
      y = bottom - minSize; // pin to the fixed bottom edge
    }
  }
  // South side: only h grows/shrinks (top edge pinned).
  if (handle === "sw" || handle === "s" || handle === "se") {
    h = h + dy;
    if (h < minSize) h = minSize;
  }

  return [x, y, w, h];
}

// Two drag corners (canvas space) -> a normalized [x,y,w,h] with positive w/h,
// regardless of drag direction (up/left yields the same rect as down/right). Each
// dimension is floored at minSize so a tiny rubber-band still produces a usable node.
export function normalizeRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minSize: number,
): BBox {
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  const w = Math.max(Math.abs(bx - ax), minSize);
  const h = Math.max(Math.abs(by - ay), minSize);
  return [x, y, w, h];
}

// The 8 selection handles, as CENTER points in canvas coords: 4 corners + 4 edge
// midpoints. Order is stable (clockwise from nw) but callers key by `id`.
export function handlePositions(
  bbox: BBox,
): { id: HandleId; cx: number; cy: number }[] {
  const [x, y, w, h] = bbox;
  const mx = x + w / 2;
  const my = y + h / 2;
  const r = x + w;
  const b = y + h;
  return [
    { id: "nw", cx: x, cy: y },
    { id: "n", cx: mx, cy: y },
    { id: "ne", cx: r, cy: y },
    { id: "e", cx: r, cy: my },
    { id: "se", cx: r, cy: b },
    { id: "s", cx: mx, cy: b },
    { id: "sw", cx: x, cy: b },
    { id: "w", cx: x, cy: my },
  ];
}
