// Plain tsx smoke script (NOT a test framework). Run: npx tsx src/render/svg-build.test-smoke.ts
// Loads the seed, builds the SVG via the shared draw table, prints it, and asserts
// the key contract invariants are present.

import { DocStore } from "../shared/store.js";
import { SEED, FLOW_SEED } from "../shared/seed.js";
import { dispatch } from "../shared/tools.js";
import { isErr } from "../shared/types.js";
import { buildSvg } from "./svg-build.js";

const store = new DocStore();
store.loadSeed(SEED);
const vector = dispatch(
  "createVector",
  {
    parent: store.rootId,
    kind: "arrow",
    bbox: [100, 900, 140, 40],
    points: [
      [0, 20],
      [140, 20],
    ],
  },
  store,
  store.version,
);
if (isErr(vector)) {
  console.error(vector);
  process.exit(1);
}

const { svg, markMap } = buildSvg(store, store.rootId, { marks: true });

console.log(svg);
console.log("\n--- markMap ---");
console.log(markMap);

const checks: Array<[string, boolean]> = [
  ["contains <rect", svg.includes("<rect")],
  ["contains <text", svg.includes("<text")],
  ["contains vector <path", svg.includes("<path")],
  ['data-node-id="node:headline"', svg.includes('data-node-id="node:headline"')],
  ['data-dc-tpl="node:headline"', svg.includes('data-dc-tpl="node:headline"')],
  ['data-node-id="node:cta"', svg.includes('data-node-id="node:cta"')],
  ['data-dc-tpl for vector', svg.includes('data-dc-tpl="node:')],
  ["headline chars rendered", svg.includes("Build faster with Acme")],
];

// --- escaped node is now framed by the viewBox (was excluded under root.bbox) ---
{
  const s2 = new DocStore();
  s2.loadSeed(SEED);
  const root = s2.getNode(s2.rootId)!;
  const [, , rw, rh] = root.bbox;
  // Place a node far OUTSIDE the root frame (to the right + below it).
  const far = dispatch(
    "createShape",
    { parent: s2.rootId, kind: "RECT", bbox: [rw + 500, rh + 500, 120, 80] },
    s2,
    s2.version,
  );
  if (isErr(far)) {
    console.error(far);
    process.exit(1);
  }
  const out = buildSvg(s2, s2.rootId);
  // The viewBox width/height must now reach past the root frame to cover the escapee.
  const m = out.svg.match(/viewBox="([^"]+)"/);
  const [, , vw, vh] = (m?.[1] ?? "").split(" ").map(Number);
  checks.push(["escaped node expands viewBox width", vw >= rw + 500 + 120]);
  checks.push(["escaped node expands viewBox height", vh >= rh + 500 + 80]);
  checks.push([`viewBox width=${vw} > root width=${rw}`, vw > rw]);

  // DETERMINISM: same store, two builds, identical output.
  const a = buildSvg(s2, s2.rootId, { marks: true });
  const b = buildSvg(s2, s2.rootId, { marks: true });
  checks.push(["buildSvg is deterministic", a.svg === b.svg]);
}

// --- prototype interactivity: play mode + interaction data-attrs ---
{
  const s3 = new DocStore();
  s3.loadSeed(FLOW_SEED);

  // 1) The editor SVG for the flow seed is byte-identical with and without a no-op play
  //    predicate that hides nothing — the determinism/back-compat contract.
  const editor = buildSvg(s3, "node:home").svg;
  checks.push([
    "interaction data-action emitted for wired nodes",
    editor.includes('data-action="navigate"') && editor.includes('data-target="node:detail"'),
  ]);

  // 2) Play mode SKIPS a hidden node's subtree; editor still renders it.
  const editorHasPanel = editor.includes('data-node-id="node:home-menupanel"');
  const play = buildSvg(s3, "node:home", { play: {} }).svg; // default: honor node.hidden
  const playHidesPanel = !play.includes('data-node-id="node:home-menupanel"');
  checks.push(["editor renders the hidden panel (editable)", editorHasPanel]);
  checks.push(["play mode hides the hidden panel", playHidesPanel]);

  // 3) An isHidden override re-skips a normally-visible node (toggle off).
  const playToggled = buildSvg(s3, "node:home", { play: { isHidden: (id) => id === "node:home-card" } }).svg;
  checks.push(["play isHidden override skips a visible node", !playToggled.includes('data-node-id="node:home-card"')]);

  // 4) Play mode frames ONLY the screen (boundsOf), not the whole 1040px canvas.
  const m = play.match(/viewBox="([^"]+)"/);
  const [, , pw] = (m?.[1] ?? "").split(" ").map(Number);
  checks.push([`play viewBox frames one screen (w=${pw} ≈ 390)`, pw <= 400]);

  // 5) A non-interactive doc's editor bytes are UNCHANGED by the new attrs path.
  const plain = new DocStore();
  plain.loadSeed(SEED);
  const noAttrs = !buildSvg(plain, plain.rootId).svg.includes("data-action");
  checks.push(["non-interactive doc emits no data-action (bytes unchanged)", noAttrs]);
}

let ok = true;
console.log("\n--- assertions ---");
for (const [label, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) ok = false;
}

if (!ok) {
  console.error("\nSMOKE FAILED");
  process.exit(1);
}
console.log("\nSMOKE OK");
