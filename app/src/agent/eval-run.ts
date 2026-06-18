// One A/B child run for the composeSubtree eval (driven by compose-eval.ts).
//   tsx src/agent/eval-run.ts "<prompt>" <seedId|empty> <pngOutPath>
//
// Runs the REAL loop once and prints ONE JSON line of cost+outcome metrics to stdout
// (turns, token usage, terminal status, node counts, wall-clock ms) and writes the final
// rendered page PNG to <pngOutPath>. The mode (baseline vs compose) is selected by the
// NO_COMPOSE env var the parent sets: NO_COMPOSE=1 drops composeSubtree + the
// refine/empty-image levers, reproducing the old node-by-node path. Because the SDK tool
// list is frozen at import time, the two modes MUST run as separate processes — hence this
// child entrypoint rather than an in-process toggle.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { writeFileSync } from "node:fs";
import { DocStore } from "../shared/store.js";
import { getSeed } from "../shared/seed.js";
import type { Seed } from "../shared/seed.js";
import { render } from "../render/perception.js";
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

async function main() {
  const prompt = process.argv[2];
  const seedArg = process.argv[3] ?? "empty";
  const pngOut = process.argv[4];
  if (!prompt || !pngOut) {
    console.error('usage: tsx eval-run.ts "<prompt>" <seedId|empty> <pngOutPath>');
    process.exit(2);
  }
  const mode = process.env.NO_COMPOSE ? "baseline" : "compose";

  const store = new DocStore();
  store.loadSeed(seedArg === "empty" ? EMPTY_SEED : getSeed(seedArg).seed);
  const pre = store.count();

  const rc = new RunController();
  let usage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  let turns = 0;
  let terminal = "none";
  let detail = "";
  rc.on((e: ServerEvent) => {
    if (e.t === "usage") {
      usage = { input: e.input, output: e.output, cacheRead: e.cacheRead, cacheCreate: e.cacheCreate };
      turns = e.turns;
    } else if (e.t === "done") { terminal = "done"; detail = e.summary; }
    else if (e.t === "escalated") { terminal = "escalated"; detail = e.reason; }
  });

  const t0 = Date.now();
  let threw: string | null = null;
  try {
    await runTask(store, rc, prompt, []);
  } catch (e) {
    threw = (e as Error).message;
    terminal = "threw";
    detail = threw;
  }
  const ms = Date.now() - t0;

  // Render the final PAGE (what the user actually sees — off-page content is clipped, which
  // is the fair completeness model). marks:false for a clean judge view.
  let pngWritten = false;
  const r = await render(store, store.rootId, { marks: false, maxPx: 1024 });
  if (!("error" in r) && r.rasterAvailable) {
    writeFileSync(pngOut, Buffer.from(r.image, "base64"));
    pngWritten = true;
  }

  process.stdout.write(
    JSON.stringify({
      mode, prompt, seedArg, turns, usage, terminal, detail, threw,
      nodeCount: store.count(), newNodes: store.count() - pre, ms,
      png: pngWritten ? pngOut : null,
    }) + "\n",
  );
}

main().catch((e) => {
  console.error("EVAL-RUN THREW:", e);
  process.exit(1);
});
