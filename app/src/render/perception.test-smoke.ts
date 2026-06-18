// Plain tsx smoke (NOT a test framework). Run: npx tsx src/render/perception.test-smoke.ts
//
// Prints the field-projected getTree for the working frame and a rough token estimate
// (chars / 4) showing the projection is far below a full dump.

import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
import { getTree, fieldsFor } from "./perception.js";

const store = new DocStore();
store.loadSeed(SEED);
const rootId = store.rootId; // the page; the hero is the realistic working frame

// rough token estimate: chars / 4 (English-text heuristic).
const est = (o: unknown) => Math.round(JSON.stringify(o).length / 4);

function show(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
  console.log(`~tokens (chars/4): ${est(value)}`);
}

// The realistic per-turn read: skeleton scoped to the working frame.
const skeleton = getTree(store, rootId, { depth: 2, fields: fieldsFor("skeleton") });
show("SKELETON (default, depth 2) — the per-turn read", skeleton);

// A layout task projects layout fields only.
const layout = getTree(store, rootId, { depth: 2, fields: fieldsFor("layout") });
show("LAYOUT-PROJECTED (fieldsFor('layout'))", layout);

// A restyle task projects style fields only.
const restyle = getTree(store, rootId, { depth: 2, fields: fieldsFor("restyle") });
show("RESTYLE-PROJECTED (fieldsFor('restyle'))", restyle);

// The anti-pattern: a FULL dump (every field on every node) — for contrast only.
const fullDump = getTree(store, rootId, { depth: 99, fields: ["style", "text", "layout"] });
show("FULL DUMP (all fields, unbounded depth) — the thing we DON'T send", fullDump);

console.log("\n=== summary ===");
const sk = est(skeleton);
const full = est(fullDump);
console.log(`skeleton ~${sk} tok  vs  full dump ~${full} tok  (${(full / sk).toFixed(1)}x larger)`);
console.log(
  "Note: the demo seed (hero, 6 nodes) is tiny; the ~3k-token/turn budget in §4.4 " +
    "is for a ~50-node working frame. The lever demonstrated here is the projection RATIO.",
);

if (sk >= full) {
  console.error("\nSMOKE FAILED: skeleton not smaller than full dump");
  process.exit(1);
}
console.log("\nSMOKE OK (field projection is far below a full dump)");
