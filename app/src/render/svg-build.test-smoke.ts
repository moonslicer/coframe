// Plain tsx smoke script (NOT a test framework). Run: npx tsx src/render/svg-build.test-smoke.ts
// Loads the seed, builds the SVG via the shared draw table, prints it, and asserts
// the key contract invariants are present.

import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
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
