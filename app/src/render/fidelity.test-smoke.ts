// Plain tsx smoke (NOT a test framework). Run: npx tsx src/render/fidelity.test-smoke.ts
//
// Exercises the visual-fidelity features added on top of the solid-fill baseline —
// gradients, image fills, drop shadows, blur, and icon glyphs — through the REAL tool
// path (composeSubtree / createIcon / setGradient) → buildSvg → resvg raster. Proves:
//   1. the new style fields serialize into <defs> (gradient/pattern/filter) + scaled icon paths,
//   2. resvg actually rasterizes that SVG (the agent's eye SEES the depth, not just the DOM),
//   3. buildSvg stays deterministic with defs present.

import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
import { dispatch } from "../shared/tools.js";
import { buildSvg } from "./svg-build.js";
import { renderPng } from "./raster.js";

const store = new DocStore();
store.loadSeed(SEED);

// 1×1 transparent PNG data URI — a real, embeddable image src.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function must<T>(r: T | { error: string; detail: string }): T {
  if (r && typeof r === "object" && "error" in r) {
    console.error("tool error:", r);
    process.exit(1);
  }
  return r as T;
}

// A rich subtree: gradient header, shadowed + image card, blurred glass panel, icon row.
must(
  dispatch(
    "composeSubtree",
    {
      parent: store.rootId,
      tree: {
        type: "FRAME",
        name: "Rich Card",
        w: 360,
        h: 520,
        x: 40,
        y: 40,
        fill: "#FFFFFF",
        cornerRadius: 24,
        shadow: { y: 8, blur: 24, color: "rgba(0,0,0,0.2)" },
        layout: { dir: "V", gap: 12, padding: 16, align: "START" },
        children: [
          {
            type: "FRAME",
            name: "Header",
            w: 328,
            h: 80,
            cornerRadius: 16,
            gradient: { from: "#FF8A00", to: "#FF2D78", angle: 90 },
          },
          { type: "RECT", name: "Photo", w: 328, h: 200, cornerRadius: 16, image: PIXEL, imageFit: "cover" },
          {
            type: "FRAME",
            name: "Glass",
            w: 328,
            h: 80,
            cornerRadius: 16,
            fill: "#FFFFFF",
            blur: 6,
          },
          {
            type: "FRAME",
            name: "Actions",
            w: 328,
            h: 40,
            fill: "none",
            stroke: "none",
            layout: { dir: "H", gap: 24, padding: 8, align: "CENTER" },
            children: [
              { icon: "heart", w: 24, h: 24, fill: "#FF2D78", stroke: "#FF2D78" },
              { icon: "comment", w: 24, h: 24 },
              { icon: "share", w: 24, h: 24 },
              { icon: "bookmark", w: 24, h: 24 },
            ],
          },
        ],
      },
    },
    store,
    store.version,
  ),
);

// createIcon + setGradient as standalone tools (the refine-pass path).
const iconRes = must(
  dispatch("createIcon", { parent: store.rootId, icon: "star", bbox: [420, 40, 32, 32], fill: "#F5B301" }, store, store.version),
);
const starId = (iconRes as { ops: Array<{ kind: string; node?: { id: string } }> }).ops.find((o) => o.kind === "add")!.node!.id;
must(dispatch("setGradient", { ids: [store.rootId], colors: ["#0E1530", "#1B2A6B"], angle: 180 }, store, store.version));

const { svg } = buildSvg(store, store.rootId, { marks: false });

const checks: Array<[string, boolean]> = [
  ["emits a <defs> block", svg.includes("<defs>")],
  ["linear gradient def present", svg.includes("<linearGradient")],
  ["page radial/linear gradient via setGradient", (svg.match(/<linearGradient/g) ?? []).length >= 2],
  ["image fill -> <pattern> + <image", svg.includes("<pattern") && svg.includes("<image ")],
  ["drop shadow filter present", svg.includes("<filter") && svg.includes("feComposite")],
  ["blur filter present (feGaussianBlur on SourceGraphic)", svg.includes('in="SourceGraphic"')],
  ["icon glyph scaled via transform", svg.includes("<g transform=") && svg.includes("scale(")],
  ["filled like-icon uses fill", svg.includes('fill="#FF2D78"') || svg.includes('fill="#ff2d78"')],
  ["star icon node created", svg.includes(`data-node-id="${starId}"`)],
  ["fill references a gradient url", svg.includes('fill="url(#grad-')],
  ["fill references an image url", svg.includes('fill="url(#img-')],
];

// Determinism with defs in play.
const a = buildSvg(store, store.rootId, { marks: true });
const b = buildSvg(store, store.rootId, { marks: true });
checks.push(["buildSvg deterministic with defs", a.svg === b.svg]);

let ok = true;
console.log("--- SVG assertions ---");
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}

// resvg must rasterize the rich SVG (this is the agent's vision channel).
const png = await renderPng(store, store.rootId, { marks: false, maxPx: 1024 });
if (png.rasterAvailable) {
  const big = png.png.length > 2000;
  console.log(`\nraster: ${png.png.length} bytes @ ${png.width}x${png.height}`);
  console.log(`${big ? "PASS" : "FAIL"}  resvg rasterized the rich SVG to a real PNG`);
  if (!big) ok = false;
} else {
  console.log(`\nraster unavailable on this platform (${png.reason}) — SVG-only checks stand.`);
}

if (!ok) {
  console.error("\nFIDELITY SMOKE FAILED");
  process.exit(1);
}
console.log("\nFIDELITY SMOKE OK");
