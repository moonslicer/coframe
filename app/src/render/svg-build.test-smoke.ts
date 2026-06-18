// Plain tsx smoke script (NOT a test framework). Run: npx tsx src/render/svg-build.test-smoke.ts
// Loads the seed, builds the SVG via the shared draw table, prints it, and asserts
// the key contract invariants are present.

import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
import { buildSvg } from "./svg-build.js";

const store = new DocStore();
store.loadSeed(SEED);

const { svg, markMap } = buildSvg(store, store.rootId, { marks: true });

console.log(svg);
console.log("\n--- markMap ---");
console.log(markMap);

const checks: Array<[string, boolean]> = [
  ["contains <rect", svg.includes("<rect")],
  ["contains <text", svg.includes("<text")],
  ['data-node-id="node:headline"', svg.includes('data-node-id="node:headline"')],
  ['data-node-id="node:cta"', svg.includes('data-node-id="node:cta"')],
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
