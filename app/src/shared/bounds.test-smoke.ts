// Plain tsx smoke (NOT a test framework). Run: npm run smoke:bounds
//
// Unit checks for contentBounds: when every node is inside the root frame it must
// equal root.bbox EXACTLY (no behavior change for existing seeds); when a node escapes
// the root frame the bounds expand to cover it (so escapees stay perceivable/visible).

import { boundsOf, contentBounds, DocStore } from "./store.js";
import { SEED, FLOW_SEED } from "./seed.js";
import { dispatch } from "./tools.js";
import { isErr } from "./types.js";
import type { BBox } from "./primitives.js";

let failed = false;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
}
const eq = (a: BBox, b: BBox) => a.every((v, i) => v === b[i]);

// --- all nodes inside root → equals root.bbox exactly ---
{
  const s = new DocStore();
  s.loadSeed(SEED);
  const root = s.getNode(s.rootId)!;
  const cb = contentBounds(s, s.rootId);
  check("inside-root bounds equals root.bbox", eq(cb, root.bbox), JSON.stringify(cb));
}

// --- an escaped node expands the bounds ---
{
  const s = new DocStore();
  s.loadSeed(SEED);
  const [rx, ry, rw, rh] = s.getNode(s.rootId)!.bbox;
  const r = dispatch(
    "createShape",
    { parent: s.rootId, kind: "RECT", bbox: [rx + rw + 200, ry + rh + 300, 100, 60] },
    s,
    s.version,
  );
  if (isErr(r)) {
    console.error(r);
    process.exit(1);
  }
  const cb = contentBounds(s, s.rootId);
  check("origin unchanged (escapee is right/below)", cb[0] === rx && cb[1] === ry, JSON.stringify(cb));
  check("width expands to cover escapee", cb[2] === rw + 200 + 100, JSON.stringify(cb));
  check("height expands to cover escapee", cb[3] === rh + 300 + 60, JSON.stringify(cb));
}

// --- missing root → [0,0,0,0] ---
{
  const s = new DocStore();
  check("missing root returns zero box", eq(contentBounds(s, "node:nope"), [0, 0, 0, 0]));
}

// --- boundsOf: bounds ONE subtree, not the whole canvas ---
{
  const s = new DocStore();
  s.loadSeed(FLOW_SEED);
  // The flow seed has two screens side by side; boundsOf("node:home") must equal the Home
  // frame (its children are inside it), NOT the union spanning both screens.
  const home = s.getNode("node:home")!;
  const b = boundsOf(s, "node:home");
  check("boundsOf one screen equals that screen's bbox", eq(b, home.bbox), JSON.stringify(b));
  // contentBounds (the editor) spans BOTH screens → strictly wider than one screen.
  const cb = contentBounds(s, s.rootId);
  check("contentBounds spans both screens (wider than one)", cb[2] > home.bbox[2], JSON.stringify(cb));
}

if (failed) {
  console.error("\nSMOKE FAILED");
  process.exit(1);
}
console.log("\nSMOKE OK");
