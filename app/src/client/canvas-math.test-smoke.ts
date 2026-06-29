// Headless smoke test for the pure canvas direct-manipulation math. NO DOM/React.
// Run: npm run smoke:canvas-math. Prints OK/FAIL per case, exit(1) on any failure.

import {
  type BBox,
  type Camera,
  type HandleId,
  canvasToScreen,
  clientToCanvas,
  fitCamera,
  handlePositions,
  moveBBox,
  normalizeRect,
  panCamera,
  resizeBBox,
  screenToCanvas,
  zoomAt,
} from "./canvas-math.js";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`OK   ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}${detail ? "  — " + detail : ""}`);
  }
}
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const bboxClose = (a: BBox, b: BBox) => a.every((v, i) => close(v, b[i]));

// --- clientToCanvas round-trips (canvas -> client -> canvas), non-1 fit, non-0 origin
{
  const fit = 0.5;
  const originX = 100;
  const originY = -40;
  const rect = { left: 30, top: 70 };
  // Forward: client point -> canvas.
  const [cx, cy] = clientToCanvas(230, 170, rect, fit, originX, originY);
  // Hand-derived: 100 + (230-30)/0.5 = 100 + 400 = 500; -40 + (170-70)/0.5 = -40+200=160
  check("clientToCanvas forward maps correctly", close(cx, 500) && close(cy, 160), `got ${cx},${cy}`);

  // Round-trip: take an arbitrary canvas point, project to client, project back.
  const canvasX = 312.5;
  const canvasY = 88.25;
  const clientX = rect.left + (canvasX - originX) * fit;
  const clientY = rect.top + (canvasY - originY) * fit;
  const [rx, ry] = clientToCanvas(clientX, clientY, rect, fit, originX, originY);
  check(
    "clientToCanvas round-trips for non-1 fit & non-0 origin",
    close(rx, canvasX) && close(ry, canvasY),
    `got ${rx},${ry}`,
  );
}

// --- moveBBox translates by canvas-space delta, size unchanged
{
  const orig: BBox = [10, 20, 100, 60];
  const moved = moveBBox(orig, 15, -5);
  check("moveBBox translates", bboxClose(moved, [25, 15, 100, 60]), JSON.stringify(moved));
}

// --- resizeBBox "se" grows w/h, x/y fixed
{
  const orig: BBox = [10, 20, 100, 60];
  const r = resizeBBox(orig, "se", 30, 40, 4);
  check("resizeBBox se grows w/h, pins x/y", bboxClose(r, [10, 20, 130, 100]), JSON.stringify(r));
}

// --- resizeBBox "nw" moves x/y and shrinks w/h (right/bottom pinned)
{
  const orig: BBox = [10, 20, 100, 60];
  const r = resizeBBox(orig, "nw", 25, 15, 4);
  // x:35, w: 110-35=75 ; y:35, h: 80-35=45
  check("resizeBBox nw moves x/y & shrinks", bboxClose(r, [35, 35, 75, 45]), JSON.stringify(r));
}

// --- resizeBBox "nw" clamps at minSize without x/y overshooting the opposite edge
{
  const orig: BBox = [10, 20, 100, 60];
  const min = 4;
  // Drag the nw handle WAY past the right/bottom edges: dx,dy huge.
  const r = resizeBBox(orig, "nw", 500, 500, min);
  const right = orig[0] + orig[2]; // 110
  const bottom = orig[1] + orig[3]; // 80
  // w/h clamped to min; x/y pinned to opposite edge minus min (no overshoot past it).
  check(
    "resizeBBox nw clamps to minSize, no x/y overshoot",
    close(r[2], min) &&
      close(r[3], min) &&
      close(r[0], right - min) &&
      close(r[1], bottom - min) &&
      r[0] <= right &&
      r[1] <= bottom,
    JSON.stringify(r),
  );
}

// --- resizeBBox edge handle moves one axis only
{
  const orig: BBox = [10, 20, 100, 60];
  const r = resizeBBox(orig, "e", 25, 999, 4); // dy ignored for an east handle
  check("resizeBBox e moves width only", bboxClose(r, [10, 20, 125, 60]), JSON.stringify(r));
}

// --- dual-axis corners ne / sw move BOTH axes correctly (the highest-risk handles)
{
  const orig: BBox = [10, 20, 100, 60];
  // ne: east grows w; north moves y & shrinks h (bottom pinned at 80).
  const ne = resizeBBox(orig, "ne", 30, 40, 4); // w:130 ; y:60, h:80-60=20
  check("resizeBBox ne grows w + moves y/h", bboxClose(ne, [10, 60, 130, 20]), JSON.stringify(ne));
  // sw: west moves x & shrinks w (right pinned at 110); south grows h.
  const sw = resizeBBox(orig, "sw", 25, 40, 4); // x:35,w:75 ; h:100
  check("resizeBBox sw moves x/w + grows h", bboxClose(sw, [35, 20, 75, 100]), JSON.stringify(sw));
}

// --- single-axis edge handles n / s / w move exactly one axis
{
  const orig: BBox = [10, 20, 100, 60];
  const n = resizeBBox(orig, "n", 999, 15, 4); // dx ignored; y:35, h:45
  check("resizeBBox n moves y/h only", bboxClose(n, [10, 35, 100, 45]), JSON.stringify(n));
  const s = resizeBBox(orig, "s", 999, 20, 4); // dx ignored; h:80
  check("resizeBBox s grows h only", bboxClose(s, [10, 20, 100, 80]), JSON.stringify(s));
  const w = resizeBBox(orig, "w", 25, 999, 4); // dy ignored; x:35, w:75
  check("resizeBBox w moves x/w only", bboxClose(w, [35, 20, 75, 60]), JSON.stringify(w));
}

// --- north & east min-clamps engage independently (cover the non-nw clamp paths)
{
  const orig: BBox = [10, 20, 100, 60];
  const min = 4;
  const nClamp = resizeBBox(orig, "n", 0, 500, min); // h clamps; y pinned to bottom-min=76
  check(
    "resizeBBox n clamps h, pins y to bottom-min",
    bboxClose(nClamp, [10, 76, 100, min]),
    JSON.stringify(nClamp),
  );
  const eClamp = resizeBBox(orig, "e", -500, 0, min); // w clamps to min; x unchanged
  check("resizeBBox e clamps w to min", bboxClose(eClamp, [10, 20, min, 60]), JSON.stringify(eClamp));
}

// --- normalizeRect: drag down-right and drag up-left yield the SAME positive rect
{
  const min = 4;
  const downRight = normalizeRect(10, 20, 110, 80, min); // a=top-left, b=bottom-right
  check(
    "normalizeRect down-right gives positive rect",
    bboxClose(downRight, [10, 20, 100, 60]),
    JSON.stringify(downRight),
  );
  const upLeft = normalizeRect(110, 80, 10, 20, min); // same corners, dragged the other way
  check(
    "normalizeRect up-left matches down-right (positive w/h)",
    bboxClose(upLeft, [10, 20, 100, 60]),
    JSON.stringify(upLeft),
  );
}

// --- normalizeRect: a tiny / zero drag floors each dimension at minSize
{
  const min = 4;
  const tiny = normalizeRect(50, 50, 51, 50, min); // 1px wide, 0px tall
  check(
    "normalizeRect applies minSize floor",
    bboxClose(tiny, [50, 50, min, min]),
    JSON.stringify(tiny),
  );
}

// --- handlePositions returns 8 correctly-placed points
{
  const bbox: BBox = [10, 20, 100, 60];
  const hp = handlePositions(bbox);
  check("handlePositions returns 8 points", hp.length === 8, `got ${hp.length}`);
  const byId = new Map(hp.map((h) => [h.id, h] as [HandleId, (typeof hp)[number]]));
  const expect: Record<HandleId, [number, number]> = {
    nw: [10, 20],
    n: [60, 20],
    ne: [110, 20],
    e: [110, 50],
    se: [110, 80],
    s: [60, 80],
    sw: [10, 80],
    w: [10, 50],
  };
  let allPlaced = true;
  for (const id of Object.keys(expect) as HandleId[]) {
    const h = byId.get(id);
    if (!h || !close(h.cx, expect[id][0]) || !close(h.cy, expect[id][1])) {
      allPlaced = false;
      console.log(`     placement off for ${id}: got ${h?.cx},${h?.cy} want ${expect[id]}`);
    }
  }
  check("handlePositions places all 8 handles at corners/edge-midpoints", allPlaced);
}

// --- camera: screenToCanvas(canvasToScreen(p)) === p (round-trip identity)
{
  const cam: Camera = { tx: 37, ty: -19, zoom: 0.625 };
  const rect = { left: 30, top: 70 };
  const canvasX = 312.5;
  const canvasY = 88.25;
  const [sx, sy] = canvasToScreen(canvasX, canvasY, rect, cam);
  const [rx, ry] = screenToCanvas(sx, sy, rect, cam);
  check(
    "camera screenToCanvas inverts canvasToScreen",
    close(rx, canvasX) && close(ry, canvasY),
    `got ${rx},${ry}`,
  );
}

// --- camera: forward transform matches the hand-derived translate(t) scale(zoom)
{
  const cam: Camera = { tx: 40, ty: 10, zoom: 2 };
  const rect = { left: 30, top: 70 };
  // screen = left + tx + canvas*zoom ; 30+40+5*2=80 ; 70+10+3*2=86
  const [sx, sy] = canvasToScreen(5, 3, rect, cam);
  check("camera canvasToScreen forward maps correctly", close(sx, 80) && close(sy, 86), `got ${sx},${sy}`);
}

// --- zoomAt invariant: the canvas point under the anchor is unchanged by the zoom
{
  const cam: Camera = { tx: 12, ty: -8, zoom: 0.5 };
  const rect = { left: 30, top: 70 };
  const ax = 250;
  const ay = 190;
  const before = screenToCanvas(ax, ay, rect, cam);
  const next = zoomAt(cam, 2, ax, ay, rect, 0.1, 8);
  const after = screenToCanvas(ax, ay, rect, next);
  check("zoomAt keeps canvas point under cursor fixed", close(after[0], before[0]) && close(after[1], before[1]), `before ${before} after ${after}`);
  check("zoomAt scales zoom by factor", close(next.zoom, 1), `got ${next.zoom}`);
  // input camera not mutated
  check("zoomAt does not mutate input camera", cam.zoom === 0.5 && cam.tx === 12 && cam.ty === -8);
}

// --- zoomAt respects min/max clamps (cursor still stays fixed at the clamp)
{
  const cam: Camera = { tx: 0, ty: 0, zoom: 4 };
  const rect = { left: 0, top: 0 };
  const ax = 100;
  const ay = 100;
  const clamped = zoomAt(cam, 10, ax, ay, rect, 0.1, 8); // 4*10=40 -> clamp to 8
  check("zoomAt clamps to maxZoom", close(clamped.zoom, 8), `got ${clamped.zoom}`);
  const before = screenToCanvas(ax, ay, rect, cam);
  const after = screenToCanvas(ax, ay, rect, clamped);
  check("zoomAt keeps cursor fixed even when clamped", close(after[0], before[0]) && close(after[1], before[1]));
  const lo = zoomAt(cam, 0.001, ax, ay, rect, 0.1, 8); // 4*0.001 -> clamp to 0.1
  check("zoomAt clamps to minZoom", close(lo.zoom, 0.1), `got ${lo.zoom}`);
}

// --- panCamera shifts tx/ty by screen pixels, leaves zoom, returns a NEW camera
{
  const cam: Camera = { tx: 5, ty: 9, zoom: 0.5 };
  const panned = panCamera(cam, 20, -10);
  check("panCamera shifts tx/ty, keeps zoom", close(panned.tx, 25) && close(panned.ty, -1) && close(panned.zoom, 0.5), JSON.stringify(panned));
  check("panCamera does not mutate input camera", cam.tx === 5 && cam.ty === 9);
}

// --- fitCamera: bbox center maps to container center, and bbox fits the padded box
{
  const bbox: BBox = [100, 200, 400, 300]; // center (300, 350)
  const container = { width: 800, height: 600 };
  const pad = 40;
  const cam = fitCamera(bbox, container, pad, 0.1, 8);
  // limiting axis: sw=(800-80)/400=1.8 ; sh=(600-80)/300=1.7333 -> zoom=1.7333 (height-limited)
  check("fitCamera fits the tighter (height) axis", close(cam.zoom, (600 - 2 * pad) / 300), `got ${cam.zoom}`);
  // center -> container center
  const [scx, scy] = canvasToScreen(300, 350, { left: 0, top: 0 }, cam);
  check("fitCamera maps bbox center to container center", close(scx, 400) && close(scy, 300), `got ${scx},${scy}`);
  // bbox screen extent fits within container minus padding on each axis
  const wScreen = bbox[2] * cam.zoom;
  const hScreen = bbox[3] * cam.zoom;
  check(
    "fitCamera bbox fits within padded container",
    wScreen <= container.width - 2 * pad + 1e-9 && hScreen <= container.height - 2 * pad + 1e-9,
    `extent ${wScreen}x${hScreen}`,
  );
}

// --- fitCamera respects clamps: a tiny bbox would over-zoom, but clamps to maxZoom
{
  const bbox: BBox = [0, 0, 1, 1];
  const container = { width: 800, height: 600 };
  const cam = fitCamera(bbox, container, 40, 0.1, 8);
  check("fitCamera clamps zoom to maxZoom for tiny bbox", close(cam.zoom, 8), `got ${cam.zoom}`);
  // even clamped, center still lands at container center
  const [scx, scy] = canvasToScreen(0.5, 0.5, { left: 0, top: 0 }, cam);
  check("fitCamera centers even when zoom-clamped", close(scx, 400) && close(scy, 300), `got ${scx},${scy}`);
}

if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nAll OK");
