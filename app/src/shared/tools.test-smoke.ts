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

// --- reorderChild ----------------------------------------------------------
// board's children are [cardA, cardB, cardC]; reorder within that single parent.
{
  const s = fresh();
  // Move cardA (index 0) to the end (index 2): expect [cardB, cardC, cardA].
  const r = dispatch("reorderChild", { id: "node:cardA", index: 2 }, s, s.version);
  const kids = s.getNode("node:board")!.children;
  check(
    "reorderChild moves a node forward",
    !isErr(r) && kids.join(",") === "node:cardB,node:cardC,node:cardA",
    kids.join(","),
  );
}
{
  const s = fresh();
  // Move cardC (index 2) to the front (index 0): expect [cardC, cardA, cardB].
  const r = dispatch("reorderChild", { id: "node:cardC", index: 0 }, s, s.version);
  const kids = s.getNode("node:board")!.children;
  check(
    "reorderChild moves a node backward",
    !isErr(r) && kids.join(",") === "node:cardC,node:cardA,node:cardB",
    kids.join(","),
  );
}
{
  const s = fresh();
  // Reordering to the position it already holds is a CONSTRAINT no-op.
  const r = dispatch("reorderChild", { id: "node:cardB", index: 1 }, s, s.version);
  check("reorderChild rejects a no-op with CONSTRAINT", isConstraint(r));
}
{
  const s = fresh();
  const r = dispatch("reorderChild", { id: s.rootId, index: 0 }, s, s.version);
  check("reorderChild rejects the parentless root with CONSTRAINT", isConstraint(r));
}

// --- groupNodes / ungroupNodes ---------------------------------------------
{
  const s = fresh();
  // Group cardA + cardC (skip cardB). board's children: [cardA, cardB, cardC].
  const r = dispatch("groupNodes", { ids: ["node:cardC", "node:cardA"] }, s, s.version);
  const added = !isErr(r) && r.ops[0]?.kind === "add" ? r.ops[0].node : null;
  const gid = added?.id ?? "";
  const board = s.getNode("node:board")!;
  const group = gid ? s.getNode(gid) : undefined;
  check(
    "groupNodes wraps members in a GROUP at the earliest slot",
    !!group && group.type === "GROUP" && board.children.join(",") === `${gid},node:cardB`,
    board.children.join(","),
  );
  check(
    "groupNodes reparents members in document order",
    !!group && group.children.join(",") === "node:cardA,node:cardC" &&
      s.getNode("node:cardA")!.parent === gid && s.getNode("node:cardC")!.parent === gid,
    group?.children.join(","),
  );
}
{
  const s = fresh();
  const g = dispatch("groupNodes", { ids: ["node:cardA", "node:cardC"] }, s, s.version);
  const gid = !isErr(g) && g.ops[0]?.kind === "add" ? g.ops[0].node.id : "";
  const r = dispatch("ungroupNodes", { id: gid }, s, s.version);
  const board = s.getNode("node:board")!;
  check(
    "ungroupNodes hoists children back and deletes the container",
    !isErr(r) && !s.has(gid) && board.children.join(",") === "node:cardA,node:cardC,node:cardB",
    board.children.join(","),
  );
}
{
  const s = fresh();
  const r = dispatch("ungroupNodes", { id: s.rootId }, s, s.version);
  check("ungroupNodes rejects the root with CONSTRAINT", isConstraint(r));
}

// --- applyAutoLayout justify (space-between) --------------------------------
{
  const s = fresh();
  const board = s.getNode("node:board")!;
  const [bx, , bw] = board.bbox;
  const pad = 24;
  const r = dispatch(
    "applyAutoLayout",
    { frame: "node:board", dir: "H", padding: pad, justify: "SPACE_BETWEEN" },
    s,
    s.version,
  );
  const kids = board.children.map((id) => s.getNode(id)!);
  const first = kids[0].bbox[0];
  const last = kids[kids.length - 1];
  const lastRight = last.bbox[0] + last.bbox[2];
  check(
    "applyAutoLayout SPACE_BETWEEN pins first/last to the padded edges",
    !isErr(r) && Math.abs(first - (bx + pad)) < 0.5 && Math.abs(lastRight - (bx + bw - pad)) < 0.5,
    `first=${first} (want ${bx + pad}); lastRight=${lastRight} (want ${bx + bw - pad})`,
  );
}

// --- snapIntoLayout: drop/reorder + fit/fill sizing -------------------------
{
  const s = fresh();
  const made = dispatch(
    "createShape",
    { parent: s.rootId, kind: "RECT", bbox: [100, 160, 1240, 40], name: "Full Row" },
    s,
    s.version,
  );
  const id = !isErr(made) && made.ops[0]?.kind === "add" ? made.ops[0].node.id : "";
  dispatch(
    "setProps",
    {
      id: "node:board",
      patch: { "layout.mode": "VERTICAL", "layout.padding": 20, "layout.gap": 12 },
    },
    s,
    s.version,
  );
  const r = dispatch("snapIntoLayout", { id, parent: "node:board" }, s, s.version);
  const snapped = s.getNode(id)!;
  const board = s.getNode("node:board")!;
  check("snapIntoLayout reparents dropped node", !isErr(r) && snapped.parent === "node:board");
  check(
    "snapIntoLayout infers cross-axis fill from dropped width",
    snapped.layout?.positionMode === "inline" && snapped.layout?.widthMode === "fill",
    JSON.stringify(snapped.layout),
  );
  check(
    "snapIntoLayout sizes fill child to the layout inner width",
    Math.abs(snapped.bbox[0] - (board.bbox[0] + 20)) < 0.5 && Math.abs(snapped.bbox[2] - (board.bbox[2] - 40)) < 0.5,
    JSON.stringify(snapped.bbox),
  );
}
{
  const s = fresh();
  dispatch("setProps", { id: "node:cardA", patch: { "layout.widthMode": "fill", "layout.grow": 1 } }, s, s.version);
  dispatch("setProps", { id: "node:cardB", patch: { "layout.widthMode": "fill", "layout.grow": 2 } }, s, s.version);
  const r = dispatch("applyAutoLayout", { frame: "node:board", dir: "H", padding: 20, gap: 10 }, s, s.version);
  const a = s.getNode("node:cardA")!;
  const b = s.getNode("node:cardB")!;
  check(
    "applyAutoLayout distributes main-axis fill by grow",
    !isErr(r) && Math.abs(a.bbox[2] - 310) < 0.5 && Math.abs(b.bbox[2] - 620) < 0.5,
    `cardA=${a.bbox[2]}, cardB=${b.bbox[2]}`,
  );
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

// --- prototype interactivity: setInteraction / setHidden / screens ----------
import { LANDING_SEED } from "./seed.js";
function freshLanding(): DocStore {
  const s = new DocStore();
  s.loadSeed(LANDING_SEED);
  return s;
}

// createFrame {screen} places screens side-by-side, marks them, defaults phone size.
{
  const s = freshLanding();
  const r1 = dispatch("createFrame", { parent: s.rootId, name: "Home", screen: true }, s, s.version);
  const id1 = !isErr(r1) ? (r1.ops.find((o) => o.kind === "add") as any)?.node.id : null;
  const n1 = id1 ? s.getNode(id1) : null;
  check("createFrame screen marks screen + phone default", !!n1?.screen && n1!.bbox[2] === 390 && n1!.bbox[3] === 844);
  const leftEdgeFirst = n1!.bbox[0];
  const r2 = dispatch("createFrame", { parent: s.rootId, name: "Detail", screen: true }, s, s.version);
  const id2 = !isErr(r2) ? (r2.ops.find((o) => o.kind === "add") as any)?.node.id : null;
  const n2 = id2 ? s.getNode(id2) : null;
  check("second screen sits to the RIGHT of the first", !!n2 && n2!.bbox[0] >= leftEdgeFirst + 390);

  // setInteraction navigate must target a screen; toggle/back wire fine.
  const ok = dispatch("setInteraction", { id: "node:cta", action: "navigate", target: id2 }, s, s.version);
  const cta = s.getNode("node:cta");
  check("setInteraction navigate writes interaction", !isErr(ok) && cta?.interactions?.[0]?.action === "navigate" && cta?.interactions?.[0]?.target === id2);

  const badNav = dispatch("setInteraction", { id: "node:cta", action: "navigate", target: "node:headline" }, s, s.version);
  check("navigate to a NON-screen is CONSTRAINT", isConstraint(badNav));

  const noTarget = dispatch("setInteraction", { id: "node:cta", action: "toggle" }, s, s.version);
  check("toggle without target is CONSTRAINT", isConstraint(noTarget));

  const back = dispatch("setInteraction", { id: "node:cta", action: "back" }, s, s.version);
  check("back needs no target", !isErr(back) && s.getNode("node:cta")?.interactions?.[0]?.action === "back");
}

// setHidden flips the play-mode visibility flag.
{
  const s = freshLanding();
  const r = dispatch("setHidden", { ids: ["node:cta"], hidden: true }, s, s.version);
  check("setHidden sets hidden=true", !isErr(r) && s.getNode("node:cta")?.hidden === true);
  const r2 = dispatch("setHidden", { ids: ["node:cta"], hidden: false }, s, s.version);
  check("setHidden sets hidden=false", !isErr(r2) && s.getNode("node:cta")?.hidden === false);
}

// composeSubtree {screen:true} builds a marked, side-by-side screen.
{
  const s = freshLanding();
  const r = dispatch(
    "composeSubtree",
    { parent: s.rootId, tree: { type: "FRAME", name: "Screen A", screen: true, children: [{ type: "TEXT", chars: "Hi", h: 24 }] } },
    s,
    s.version,
  );
  const added = !isErr(r) ? (r.ops.find((o) => o.kind === "add") as any)?.node : null;
  check("composeSubtree screen:true marks the root frame", !!added?.screen);
}

console.log(failed ? "\nSMOKE FAILED" : "\nSMOKE OK (all tool cases passed)");
if (failed) process.exit(1);
