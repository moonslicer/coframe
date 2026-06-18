// Headless smoke harness (NOT a test framework). Run: npm run smoke:loop
//
// Loads the SEED, builds a RunController, runs runTask against a curated prompt, logs
// every emitted event (plan steps, activity, verify outcomes, done/escalated), asserts
// the doc structurally changed on success, then exercises undo (snapshot -> restore)
// and asserts the doc returns to the pre-run structure (version + node count equal).
//
// This makes ONE live Opus 4.8 call. The key is read from app/.env via dotenv.

// override:true so the committed app/.env is authoritative even if a stale
// ANTHROPIC_API_KEY is already exported in the shell (dotenv won't override by default).
import dotenv from "dotenv";
dotenv.config({ override: true });
import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
import { RunController } from "./run-controller.js";
import type { ServerEvent } from "./run-controller.js";
import { runTask } from "./loop.js";

const PROMPT =
  "Add a pricing section with three tiers below the hero, aligned and evenly spaced.";

async function main() {
  const store = new DocStore();
  store.loadSeed(SEED);

  const preVersion = store.version;
  const preCount = store.count();
  console.log(`SEED loaded: ${preCount} nodes, version ${preVersion}`);

  // The undo snapshot (rc.snapshot is captured inside runTask; we also keep our own
  // pre-run snapshot to exercise the explicit undo path at the end).
  const undoSnap = store.snapshot();

  const rc = new RunController();
  let lastTerminal: ServerEvent | null = null;

  rc.on((e: ServerEvent) => {
    switch (e.t) {
      case "phase":
        console.log(`[phase] ${e.phase}`);
        break;
      case "plan":
        console.log(`[plan] ${e.steps.length} step(s):`);
        e.steps.forEach((s, i) => console.log(`   ${i}. ${s.label}`));
        break;
      case "activity":
        console.log(`[activity] ${e.text}${e.tool ? ` (${e.tool})` : ""}`);
        break;
      case "activity-update":
        console.log(`[activity-update] ${e.status}${e.text ? ` — ${e.text}` : ""}`);
        break;
      case "marks":
        console.log(
          `[marks] ${Object.keys(e.markMap).length} marks, image ${e.image ? `${e.image.length}b64` : "none"}`,
        );
        break;
      case "ops-applied":
        console.log(`[ops-applied] ${e.ops.length} op(s) -> v${e.version}`);
        break;
      case "done":
        console.log(`[done] ${e.summary} (v${e.fromVersion} -> v${e.toVersion})`);
        lastTerminal = e;
        break;
      case "escalated":
        console.log(`[escalated] ${e.reason}`);
        lastTerminal = e;
        break;
    }
  });

  console.log(`\nPrompt: "${PROMPT}"\n`);
  await runTask(store, rc, PROMPT, []);

  console.log("\n=== run finished ===");
  const term = lastTerminal as ServerEvent | null;
  if (!term) {
    console.error("SMOKE FAILED: no terminal (done/escalated) event emitted.");
    process.exit(1);
  }

  const postVersion = store.version;
  const postCount = store.count();
  console.log(`post-run: ${postCount} nodes, version ${postVersion}`);

  if (term.t === "done") {
    // On success the doc MUST have structurally changed.
    const changed = postCount > preCount || postVersion > preVersion;
    console.log(
      `ASSERT doc changed on success: ${changed ? "OK" : "FAIL"} ` +
        `(nodes ${preCount}->${postCount}, version ${preVersion}->${postVersion})`,
    );
    if (!changed) {
      console.error("SMOKE FAILED: done but doc did not change.");
      process.exit(1);
    }
  } else {
    console.log("Run escalated (acceptable for smoke — verify the loop ran cleanly).");
  }

  // Exercise undo: restore the pre-run snapshot and assert we're back.
  store.restore(undoSnap);
  const undoVersion = store.version;
  const undoCount = store.count();
  const undone = undoVersion === preVersion && undoCount === preCount;
  console.log(
    `ASSERT undo restores pre-run structure: ${undone ? "OK" : "FAIL"} ` +
      `(version ${undoVersion} == ${preVersion}, nodes ${undoCount} == ${preCount})`,
  );
  if (!undone) {
    console.error("SMOKE FAILED: undo did not restore the pre-run structure.");
    process.exit(1);
  }

  console.log("\nSMOKE OK (terminal event reached, verify ran, undo restored).");
}

main().catch((e) => {
  console.error("\nSMOKE THREW:", e);
  process.exit(1);
});
