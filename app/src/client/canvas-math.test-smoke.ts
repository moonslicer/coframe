// Headless smoke test for the pure canvas direct-manipulation math. NO DOM/React.
// Run: npm run smoke:canvas-math. Prints OK/FAIL per case, exit(1) on any failure.

import {
  type BBox,
  type HandleId,
  clientToCanvas,
  handlePositions,
  moveBBox,
  normalizeRect,
  resizeBBox,
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

if (failed) {
  console.log(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nAll OK");
