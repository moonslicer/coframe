// Headless design probe for UX-bug hunting. NOT a test framework.
//   npm run probe -- "<design request>" [seedId|empty]
//
// Runs the REAL §5.4 loop (runTask) against one design request on a chosen seed,
// captures the full BEFORE tree, every emitted event, and the full AFTER tree, then
// prints ONE JSON object to stdout (human trace goes to stderr). An evaluator can
// diff "what was requested" vs "what the canvas actually contains" to find the bug
// class where modifying the page does NOT produce the expected change.
//
// override:true so the committed app/.env is authoritative over any stale shell key.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { DocStore } from "../shared/store.js";
import { getSeed } from "../shared/seed.js";
import type { Seed } from "../shared/seed.js";
import { getTree } from "../render/perception.js";
import { RunController } from "./run-controller.js";
import type { ServerEvent } from "./run-controller.js";
import { runTask } from "./loop.js";

const EMPTY_SEED: Seed = {
  rootId: "page",
  nodes: [
    { id: "page", type: "FRAME", name: "Page", parent: null, children: [],
      bbox: [0, 0, 1440, 1024] } as unknown as Seed["nodes"][number],
  ],
};

/** Full-depth, all-fields structured dump of the scene graph. */
function fullTree(store: DocStore) {
  const res = getTree(store, store.rootId, {
    depth: 99,
    fields: ["style", "text", "layout"],
  });
  return "error" in res ? { error: res.error } : res.nodes;
}

async function main() {
  const prompt = process.argv[2];
  const seedArg = process.argv[3];
  if (!prompt) {
    console.error('usage: npm run probe -- "<request>" [seedId|empty]');
    process.exit(2);
  }

  const store = new DocStore();
  if (seedArg === "empty") store.loadSeed(EMPTY_SEED);
  else store.loadSeed(getSeed(seedArg).seed);

  const seedId = seedArg === "empty" ? "empty" : getSeed(seedArg).id;
  const before = fullTree(store);
  const preCount = store.count();
  const preVersion = store.version;

  const events: ServerEvent[] = [];
  const rc = new RunController();
  rc.on((e: ServerEvent) => {
    events.push(e);
    // human-readable trace to STDERR (stdout stays pure JSON)
    if (e.t === "phase") console.error(`[phase] ${e.phase}`);
    else if (e.t === "plan") {
      console.error(`[plan] ${e.steps.length} step(s):`);
      e.steps.forEach((s, i) => console.error(`   ${i}. ${s.label}`));
    } else if (e.t === "activity") console.error(`[activity] ${e.text}${e.tool ? ` (${e.tool})` : ""}`);
    else if (e.t === "activity-update") console.error(`[update] ${e.status}${e.text ? ` — ${e.text}` : ""}`);
    else if (e.t === "ops-applied") console.error(`[ops] ${e.ops.length} op(s) -> v${e.version}`);
    else if (e.t === "usage")
      console.error(
        `[usage] turns=${e.turns} in=${e.input} out=${e.output} cacheRead=${e.cacheRead} cacheCreate=${e.cacheCreate}`,
      );
    else if (e.t === "done") console.error(`[done] ${e.summary}`);
    else if (e.t === "escalated") console.error(`[escalated] ${e.reason}`);
  });

  console.error(`\n=== probe: seed=${seedId} ===\nprompt: "${prompt}"\n`);

  let threw: string | null = null;
  try {
    await runTask(store, rc, prompt, []);
  } catch (e) {
    threw = (e as Error).message;
    console.error(`\nRUNTASK THREW: ${threw}`);
  }

  const terminal = events.find((e) => e.t === "done" || e.t === "escalated") ?? null;
  const usage = events.find((e) => e.t === "usage") ?? null;
  // Tool-call histogram: how often each tool fired (a single composeSubtree vs N creates).
  const toolHistogram: Record<string, number> = {};
  for (const e of events)
    if (e.t === "activity" && e.tool) toolHistogram[e.tool] = (toolHistogram[e.tool] ?? 0) + 1;
  const out = {
    seedId,
    prompt,
    threw,
    before,
    after: fullTree(store),
    preCount,
    postCount: store.count(),
    preVersion,
    postVersion: store.version,
    terminal,
    plan: events.find((e) => e.t === "plan") ?? null,
    opsApplied: events.filter((e) => e.t === "ops-applied").length,
    // headline cost metrics for the bulk-compose comparison
    usage,
    toolHistogram,
    events,
  };
  // The one machine-readable artifact: a single JSON line on stdout.
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((e) => {
  console.error("\nPROBE THREW:", e);
  process.exit(1);
});
