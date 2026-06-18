// Parametrized regression eval (§4.5 — the curated seed+prompt pairs ARE the eval).
// Run: npm run smoke:eval
//
// Runs the REAL loop (runTask on a fresh DocStore per pair) against EVERY curated
// (seed, prompt) pair and asserts SEMANTIC STRUCTURAL invariants per pair — NOT
// "node count changed", NOT pixels/prose. Each pair declares its own assertions
// (tolerant of exact coords). Prints per-pair PASS/FAIL + the terminal event +
// which invariants held, then an aggregate DONE-rate.
//
// BOUNDED: each pair runs ONCE per invocation (no internal retries beyond the
// loop's own MAX_ATTEMPTS). Each pair makes live Opus 4.8 calls — budget aware.
//
// override:true so the committed app/.env is authoritative even if a stale
// ANTHROPIC_API_KEY is already exported in the shell.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { DocStore } from "../shared/store.js";
import type { Node, NodeId } from "../shared/types.js";
import { SEEDS, SEED_PROMPTS } from "../shared/seed.js";
import type { Seed } from "../shared/seed.js";
import { RunController } from "./run-controller.js";
import type { ServerEvent } from "./run-controller.js";
import { runTask } from "./loop.js";

// ---------------------------------------------------------------------------
// Invariant helpers — semantic, coord-tolerant queries over the post-run doc.
// ---------------------------------------------------------------------------
type Check = { name: string; ok: boolean; detail: string };

function children(store: DocStore, id: NodeId): Node[] {
  const n = store.getNode(id);
  if (!n) return [];
  return n.children.map((c) => store.getNode(c)!).filter(Boolean);
}

const bottom = (n: Node): number => n.bbox[1] + n.bbox[3];

/** A FRAME child of `parentId` whose name matches any of the keywords. */
function findFrameLike(store: DocStore, parentId: NodeId, keywords: string[]): Node | undefined {
  return children(store, parentId).find(
    (c) =>
      c.type === "FRAME" &&
      keywords.some((k) => c.name.toLowerCase().includes(k.toLowerCase())),
  );
}

/** Are these nodes left-aligned (all x within `tol` px of each other)? */
function leftAligned(nodes: Node[], tol = 8): boolean {
  if (nodes.length < 2) return true;
  const xs = nodes.map((n) => n.bbox[0]);
  return Math.max(...xs) - Math.min(...xs) <= tol;
}

/** Are these nodes top-aligned (all y within `tol` px)? */
function topAligned(nodes: Node[], tol = 8): boolean {
  if (nodes.length < 2) return true;
  const ys = nodes.map((n) => n.bbox[1]);
  return Math.max(...ys) - Math.min(...ys) <= tol;
}

/** Laid out in a row: sorted by x, each starts at-or-after the previous one's
 *  right edge (non-overlapping, left-to-right), and gaps are roughly even. */
function evenlySpacedRow(nodes: Node[], gapTol = 12): boolean {
  if (nodes.length < 2) return true;
  const sorted = [...nodes].sort((a, b) => a.bbox[0] - b.bbox[0]);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const gap = cur.bbox[0] - (prev.bbox[0] + prev.bbox[2]);
    if (gap < -2) return false; // overlap
    gaps.push(gap);
  }
  return Math.max(...gaps) - Math.min(...gaps) <= gapTol;
}

// ---------------------------------------------------------------------------
// Per-pair eval cases. Each declares its seed, prompt, optional selection, and a
// function returning the list of semantic invariants checked AFTER the run.
// ---------------------------------------------------------------------------
interface EvalCase {
  id: string;
  seedId: string;
  prompt: string;
  selection?: (seed: Seed) => NodeId[];
  invariants: (store: DocStore) => Check[];
}

const CASES: EvalCase[] = [
  // --- landing: add a pricing section with three tiers, below the hero ---
  {
    id: "landing/pricing",
    seedId: "landing",
    prompt: SEED_PROMPTS.landing[0],
    invariants: (store) => {
      const page = store.rootId;
      const hero = store.getNode("node:hero");
      const pricing = findFrameLike(store, page, ["pricing", "tier", "plan", "price"]);
      const checks: Check[] = [];
      checks.push({
        name: "pricing FRAME exists under page",
        ok: !!pricing,
        detail: pricing ? `${pricing.id} ("${pricing.name}")` : "none found",
      });
      checks.push({
        name: "pricing sits below the hero bbox",
        ok: !!(pricing && hero && pricing.bbox[1] >= bottom(hero)),
        detail:
          pricing && hero
            ? `pricing.y=${pricing.bbox[1]} vs hero bottom=${bottom(hero)}`
            : "missing pricing/hero",
      });
      const tiers = pricing ? children(store, pricing.id) : [];
      checks.push({
        name: "pricing has exactly 3 tier children",
        ok: tiers.length === 3,
        detail: `${tiers.length} children`,
      });
      checks.push({
        name: "tiers are a horizontal auto-layout OR an evenly-spaced row",
        ok: !!(pricing && (pricing.layout?.mode === "HORIZONTAL" || evenlySpacedRow(tiers))),
        detail: pricing
          ? `layout.mode=${pricing.layout?.mode}, evenRow=${evenlySpacedRow(tiers)}`
          : "no pricing frame",
      });
      checks.push({
        name: "tiers are top-aligned",
        ok: topAligned(tiers, 10),
        detail: `ys=[${tiers.map((t) => t.bbox[1]).join(", ")}]`,
      });
      return checks;
    },
  },
  // --- landing: tidy the hero (left-align logo/headline/subtitle) ---
  {
    id: "landing/tidy-hero",
    seedId: "landing",
    prompt: SEED_PROMPTS.landing[1],
    invariants: (store) => {
      const ids = ["node:logo", "node:headline", "node:subtitle"];
      const nodes = ids.map((i) => store.getNode(i)!).filter(Boolean);
      return [
        {
          name: "logo, headline, subtitle all still exist",
          ok: nodes.length === 3,
          detail: `${nodes.length}/3 present`,
        },
        {
          name: "logo, headline, subtitle are left-aligned",
          ok: leftAligned(nodes, 8),
          detail: `xs=[${nodes.map((n) => n.bbox[0]).join(", ")}]`,
        },
      ];
    },
  },
  // --- scattered: line up the three cards in a row ---
  {
    id: "scattered/row",
    seedId: "scattered",
    prompt: SEED_PROMPTS.scattered[0],
    invariants: (store) => {
      const board = "node:board";
      const cards = children(store, board).filter((c) => c.type === "FRAME");
      return [
        {
          name: "board still has its 3 cards",
          ok: cards.length === 3,
          detail: `${cards.length} card frames`,
        },
        {
          name: "cards form a horizontal layout OR an evenly-spaced row",
          ok:
            store.getNode(board)?.layout?.mode === "HORIZONTAL" || evenlySpacedRow(cards),
          detail: `layout.mode=${store.getNode(board)?.layout?.mode}, evenRow=${evenlySpacedRow(cards)}`,
        },
        {
          name: "cards are top-aligned",
          ok: topAligned(cards, 10),
          detail: `ys=[${cards.map((c) => c.bbox[1]).join(", ")}]`,
        },
      ];
    },
  },
  // --- buttons: match the primary button + even out spacing (selection-scoped) ---
  {
    id: "buttons/match-and-space",
    seedId: "buttons",
    prompt: SEED_PROMPTS.buttons[0],
    selection: () => ["node:btnPrimary", "node:btnSecondary", "node:btnTertiary"],
    invariants: (store) => {
      const ids = ["node:btnPrimary", "node:btnSecondary", "node:btnTertiary"];
      const btns = ids.map((i) => store.getNode(i)!).filter(Boolean);
      const primary = store.getNode("node:btnPrimary")!;
      const primaryColor = primary?.style?.fills?.[0]?.color;
      const allMatch =
        !!primaryColor &&
        btns.every((b) => b.style?.fills?.[0]?.color === primaryColor);
      return [
        {
          name: "all three buttons still exist",
          ok: btns.length === 3,
          detail: `${btns.length}/3 present`,
        },
        {
          name: "all three buttons share the primary fill color",
          ok: allMatch,
          detail: `colors=[${btns.map((b) => b.style?.fills?.[0]?.color).join(", ")}]`,
        },
        {
          name: "buttons are evenly spaced in a row OR top-aligned",
          ok: evenlySpacedRow(btns) || topAligned(btns, 8),
          detail: `evenRow=${evenlySpacedRow(btns)}, topAligned=${topAligned(btns, 8)}`,
        },
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------
async function runCase(c: EvalCase): Promise<{ done: boolean; allInvariants: boolean }> {
  const seed = SEEDS[c.seedId];
  const store = new DocStore();
  store.loadSeed(seed);
  const selection = c.selection ? c.selection(seed) : [];

  console.log(`\n${"=".repeat(72)}`);
  console.log(`PAIR ${c.id}  [seed=${c.seedId}]`);
  console.log(`  prompt: "${c.prompt}"`);
  if (selection.length) console.log(`  selection: ${selection.join(", ")}`);

  const rc = new RunController();
  let terminal: string | null = null;
  let terminalDetail = "";
  rc.on((e: ServerEvent) => {
    if (e.t === "plan") {
      console.log(`  [plan] ${e.steps.map((s) => s.label).join(" | ")}`);
    } else if (e.t === "done") {
      terminal = "done";
      terminalDetail = e.summary;
    } else if (e.t === "escalated") {
      terminal = "escalated";
      terminalDetail = e.reason;
    }
  });

  try {
    await runTask(store, rc, c.prompt, selection);
  } catch (err) {
    terminal = "escalated";
    terminalDetail = `threw: ${(err as Error).message}`;
  }

  console.log(`  terminal: ${terminal ?? "NONE"}${terminalDetail ? ` — ${terminalDetail}` : ""}`);

  const checks = c.invariants(store);
  let allOk = true;
  for (const ch of checks) {
    if (!ch.ok) allOk = false;
    console.log(`  ${ch.ok ? "PASS" : "FAIL"}  ${ch.name}  (${ch.detail})`);
  }

  const done = terminal === "done";
  const pass = done && allOk;
  console.log(`  => ${pass ? "PASS" : "FAIL"} (reached DONE: ${done}, all invariants: ${allOk})`);
  return { done, allInvariants: allOk };
}

async function main() {
  console.log(`Running ${CASES.length} curated (seed, prompt) pairs against the REAL loop.`);
  const results: { id: string; done: boolean; allInvariants: boolean }[] = [];
  for (const c of CASES) {
    const r = await runCase(c);
    results.push({ id: c.id, ...r });
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log("AGGREGATE");
  const fullPass = results.filter((r) => r.done && r.allInvariants);
  for (const r of results) {
    const ok = r.done && r.allInvariants;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${r.id}  (done=${r.done}, invariants=${r.allInvariants})`);
  }
  console.log(
    `\n${fullPass.length}/${results.length} pairs reached DONE with ALL invariants held.`,
  );
}

main().catch((e) => {
  console.error("\nEVAL THREW:", e);
  process.exit(1);
});
