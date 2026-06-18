// Headless MULTI-TURN design session for UX-bug hunting. NOT a test framework.
//   npm run session -- <specFile.json>
//
// Mirrors the server's per-message lifecycle (ONE persistent DocStore, a FRESH
// RunController per turn, selection passed in) so we can replay a realistic human
// session: design an app, then iterate on it turn after turn. Each turn runs the
// REAL §5.4 loop (runTask). Selection is resolved BY NAME (selectNameLike) the way a
// human clicks a frame before asking for an edit.
//
// Emits ONE JSON object on stdout: per-turn plan, ops, terminal (done/escalated),
// version+count deltas, plus the final full tree. An evaluator diffs "what each turn
// asked for" vs "what actually changed" to surface the bug class where the agent
// CANNOT complete an edit (hard escalation) or claims done while changing nothing
// (silent no-op).
//
// override:true so the committed app/.env is authoritative over any stale shell key.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { readFileSync } from "node:fs";
import { DocStore } from "../shared/store.js";
import { getSeed } from "../shared/seed.js";
import type { Seed } from "../shared/seed.js";
import { getTree } from "../render/perception.js";
import { RunController } from "./run-controller.js";
import type { ServerEvent } from "./run-controller.js";
import type { Op } from "../shared/types.js";
import { runTask } from "./loop.js";

const EMPTY_SEED: Seed = {
  rootId: "page",
  nodes: [
    { id: "page", type: "FRAME", name: "Page", parent: null, children: [],
      bbox: [0, 0, 1440, 1024] } as unknown as Seed["nodes"][number],
  ],
};

interface TurnSpec {
  intent: string;
  /** Resolve selection to every node whose name contains this (case-insensitive). */
  selectNameLike?: string;
}
interface SessionSpec {
  app: string;
  seed?: string; // seed id, or "empty" (default)
  turns: TurnSpec[];
}

function fullTree(store: DocStore) {
  const res = getTree(store, store.rootId, { depth: 99, fields: ["style", "text", "layout"] });
  return "error" in res ? { error: res.error } : res.nodes;
}

/** Compact op summary: kind + target (+ path for set) so the evaluator sees WHAT changed. */
function opSummary(op: Op): string {
  switch (op.kind) {
    case "add": return `add ${op.node.type} "${op.node.name}"`;
    case "remove": return `remove ${op.id}`;
    case "set": return `set ${op.id}.${op.path}`;
    case "reparent": return `reparent ${op.id} -> ${op.parent}`;
  }
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error("usage: npm run session -- <specFile.json>");
    process.exit(2);
  }
  const spec: SessionSpec = JSON.parse(readFileSync(specPath, "utf8"));

  const store = new DocStore();
  if (!spec.seed || spec.seed === "empty") store.loadSeed(EMPTY_SEED);
  else store.loadSeed(getSeed(spec.seed).seed);

  console.error(`\n=== session: app=${spec.app} seed=${spec.seed ?? "empty"} turns=${spec.turns.length} ===\n`);

  const turns: any[] = [];

  for (let i = 0; i < spec.turns.length; i++) {
    const t = spec.turns[i];

    // Resolve selection by name, the way a human clicks a node before editing.
    let selection: string[] = [];
    let selectedNames: string[] = [];
    if (t.selectNameLike) {
      const needle = t.selectNameLike.toLowerCase();
      for (const n of store.all().values()) {
        if (n.name?.toLowerCase().includes(needle)) {
          selection.push(n.id);
          selectedNames.push(n.name);
        }
      }
    }

    const preVersion = store.version;
    const preCount = store.count();
    const events: ServerEvent[] = [];
    const rc = new RunController();
    rc.on((e) => events.push(e));

    console.error(`--- turn ${i}: "${t.intent}"${t.selectNameLike ? ` [select ~"${t.selectNameLike}" -> ${selection.length}]` : ""}`);

    let threw: string | null = null;
    try {
      await runTask(store, rc, t.intent, selection);
    } catch (e) {
      threw = (e as Error).message;
    }

    const terminal = events.find((e) => e.t === "done" || e.t === "escalated") ?? null;
    const planEvent = events.find((e) => e.t === "plan") as Extract<ServerEvent, { t: "plan" }> | undefined;
    const ops = events
      .filter((e): e is Extract<ServerEvent, { t: "ops-applied" }> => e.t === "ops-applied")
      .flatMap((e) => e.ops.map(opSummary));

    const result = {
      index: i,
      intent: t.intent,
      selectNameLike: t.selectNameLike ?? null,
      selection: selectedNames,
      selectionCount: selection.length,
      terminal: terminal
        ? terminal.t === "escalated"
          ? { kind: "escalated", reason: terminal.reason }
          : { kind: "done", summary: terminal.summary }
        : { kind: threw ? "threw" : "none", reason: threw },
      plan: planEvent ? planEvent.steps.map((s) => s.label) : null,
      ops,
      opCount: ops.length,
      preVersion,
      postVersion: store.version,
      changed: store.version !== preVersion,
      preCount,
      postCount: store.count(),
      // The two automatic bug signals:
      hardFail: terminal?.t === "escalated" || threw != null,
      silentNoop: terminal?.t === "done" && store.version === preVersion,
    };
    turns.push(result);

    console.error(
      `    -> ${result.terminal.kind}` +
        `${result.hardFail ? " ❌HARDFAIL" : result.silentNoop ? " ⚠️NOOP" : ""}` +
        ` (${result.opCount} ops, v${preVersion}->${store.version})`,
    );
  }

  const out = {
    app: spec.app,
    seed: spec.seed ?? "empty",
    turns,
    hardFails: turns.filter((t) => t.hardFail).length,
    silentNoops: turns.filter((t) => t.silentNoop).length,
    finalTree: fullTree(store),
  };
  process.stdout.write(JSON.stringify(out) + "\n");
}

main().catch((e) => {
  console.error("\nSESSION THREW:", e);
  process.exit(1);
});
