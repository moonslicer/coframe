// No-API repro of the "alternating fills -> empty plan" bug. The emit_plan model
// sometimes returns a MALFORMED tool input: `steps` arrives as a mangled string
// (leaking tool-call markup) and the lone step's label/criterion are hoisted to the
// top level. The old `Array.isArray(steps)` check dropped that into an EMPTY plan,
// surfacing a false "That doesn't look like a canvas edit I can make." This exercises
// coercePlanSteps directly (no SDK call) to lock in the recovery.
import { coercePlanSteps } from "./llm-adapter.js";

const cases: { why: string; input: unknown; wantLen: number; check?: (s: any[]) => boolean }[] = [
  {
    // The EXACT shape captured from the failing planner run.
    why: "A) flattened single step (steps is leaked-markup string; label/criterion at top level) — was [] (false fail), must recover 1 step",
    input: {
      steps: '\n<parameter name="index">0',
      label: "Apply alternating fills to Card A, Card B, and Card C",
      criterion: { kind: "prop", id: "node:cardB", path: "style.fills", equals: [{ type: "SOLID", color: "#E0F2FE" }] },
    },
    wantLen: 1,
    check: (s) => s[0].label.startsWith("Apply alternating") && s[0].criterion.kind === "prop" && s[0].index === 0,
  },
  {
    why: "B) well-formed steps array still parses normally",
    input: {
      steps: [
        { index: 0, label: "Create pricing frame", criterion: { kind: "nodeExists", parentId: "page", type: "FRAME" } },
        { index: 1, label: "Lay out cards", criterion: { kind: "prop", id: "node:7", path: "layout.mode", equals: "HORIZONTAL" } },
      ],
    },
    wantLen: 2,
    check: (s) => s[0].label === "Create pricing frame" && s[1].index === 1,
  },
  {
    why: "C) flattened step missing index/label — recover with defaults, criterion preserved",
    input: { steps: "garbage", criterion: { kind: "childCount", frameId: "node:board", count: 3 } },
    wantLen: 1,
    check: (s) => s[0].index === 0 && s[0].label === "Step 1" && s[0].criterion.kind === "childCount",
  },
  {
    why: "D) genuinely empty (no steps array, no top-level criterion) — stays empty so the loop reports honestly",
    input: { steps: [] },
    wantLen: 0,
  },
  {
    why: "E) null/garbage input does not throw — stays empty",
    input: null,
    wantLen: 0,
  },
];

let allOk = true;
for (const c of cases) {
  let steps: any[] = [];
  let threw: string | null = null;
  try {
    steps = coercePlanSteps(c.input);
  } catch (e) {
    threw = (e as Error).message;
  }
  const lenOk = !threw && steps.length === c.wantLen;
  const checkOk = lenOk && (c.check ? c.check(steps) : true);
  const pass = lenOk && checkOk;
  allOk = allOk && pass;
  console.log(`${pass ? "EXPECTED ✓" : "REGRESSION ✗"}  [${steps.length} step(s)${threw ? ` THREW: ${threw}` : ""}]  ${c.why}`);
}

console.log("\n" + (allOk ? "ALL EXPECTATIONS MET ✓" : "SOME EXPECTATIONS FAILED ✗"));
process.exit(allOk ? 0 : 1);
