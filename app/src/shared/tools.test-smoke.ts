// Plain tsx smoke (NOT a test framework). Run: npx tsx src/shared/tools.test-smoke.ts
//
// Exercises the four direct-manipulation tools (setBBox / deleteNodes /
// reparentNodes / setText) end-to-end through dispatch() against a real DocStore,
// asserting both the happy path and the boundary rejections. Prints OK/FAIL per
// case and exits 1 on any failure.

import { DocStore } from "./store.js";
import { SCATTERED_SEED } from "./seed.js";
import { dispatch } from "./tools.js";
import { isErr, type ToolResult } from "./types.js";

let failed = false;
function check(name: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
}

// Fresh store per case so version/state never bleeds between assertions.
function fresh(): DocStore {
  const s = new DocStore();
  s.loadSeed(SCATTERED_SEED);
  return s;
}
const isConstraint = (r: ToolResult) => isErr(r) && r.error === "CONSTRAINT";

// --- setBBox ---------------------------------------------------------------
{
  const s = fresh();
  const r = dispatch("setBBox", { id: "node:cardA", bbox: [10, 20, 300, 400] }, s, s.version);
  const bb = s.getNode("node:cardA")!.bbox;
  check(
    "setBBox changes bbox",
    !isErr(r) && bb[0] === 10 && bb[1] === 20 && bb[2] === 300 && bb[3] === 400,
    JSON.stringify(bb),
  );
}

// --- deleteNodes -----------------------------------------------------------
{
  const s = fresh();
  const r = dispatch("deleteNodes", { ids: ["node:cardA"] }, s, s.version);
  check("deleteNodes removes a node", !isErr(r) && !s.has("node:cardA"));
  // its subtree child must be gone too
  check("deleteNodes removes the subtree", !s.has("node:cardAtitle"));
}
{
  const s = fresh();
  const r = dispatch("deleteNodes", { ids: [s.rootId] }, s, s.version);
  check("deleteNodes rejects root with CONSTRAINT", isConstraint(r) && s.has(s.rootId));
}

// --- reparentNodes ---------------------------------------------------------
{
  const s = fresh();
  const r = dispatch("reparentNodes", { id: "node:cardAtitle", parent: "node:cardB" }, s, s.version);
  const moved = s.getNode("node:cardAtitle")!;
  const inNewParent = s.getNode("node:cardB")!.children.includes("node:cardAtitle");
  const outOfOld = !s.getNode("node:cardA")!.children.includes("node:cardAtitle");
  check("reparentNodes moves a node", !isErr(r) && moved.parent === "node:cardB" && inNewParent && outOfOld);
}
{
  // cycle: reparent node:cardA into its own descendant node:cardAtitle
  const s = fresh();
  const r = dispatch("reparentNodes", { id: "node:cardA", parent: "node:cardAtitle" }, s, s.version);
  check("reparentNodes rejects a cycle with CONSTRAINT", isConstraint(r));
}

// --- setText ---------------------------------------------------------------
{
  const s = fresh();
  const r = dispatch("setText", { id: "node:cardAtitle", chars: "Hello world" }, s, s.version);
  check("setText changes chars", !isErr(r) && s.getNode("node:cardAtitle")!.text!.chars === "Hello world");
}
{
  const s = fresh();
  const r = dispatch("setText", { id: "node:cardA", chars: "nope" }, s, s.version); // cardA is a FRAME
  check("setText rejects a non-TEXT node with CONSTRAINT", isConstraint(r));
}

// --- createVector / setProps ----------------------------------------------
{
  const s = fresh();
  const r = dispatch(
    "createVector",
    {
      parent: s.rootId,
      kind: "line",
      bbox: [20, 30, 120, 8],
      points: [
        [0, 4],
        [120, 4],
      ],
    },
    s,
    s.version,
  );
  const added = !isErr(r) && r.ops[0]?.kind === "add" ? r.ops[0].node : null;
  check("createVector adds a VECTOR node", !!added && added.type === "VECTOR" && added.vector?.kind === "line");
}
{
  const s = fresh();
  const r = dispatch(
    "setProps",
    { id: "node:cardA", patch: { "style.opacity": 0.5, "style.cornerRadius": 18 } },
    s,
    s.version,
  );
  const n = s.getNode("node:cardA")!;
  check("setProps patches allowed style paths", !isErr(r) && n.style?.opacity === 0.5 && n.style.cornerRadius === 18);
}
{
  const s = fresh();
  const r = dispatch("setProps", { id: "node:cardA", patch: { "children": [] } }, s, s.version);
  check("setProps rejects protected paths with CONSTRAINT", isConstraint(r));
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK (all tool cases passed)");
if (failed) process.exit(1);
