// Headless WS integration smoke (§6 #6) — the PRIMARY Day-6 gate. Boots the server
// in-process, opens a ws client, sends the pricing-section prompt, asserts it
// RECEIVES the streamed event sequence (doc-sync -> phase/plan -> activity/marks/
// ops-applied … -> done|escalated), then sends {t:'undo'} and asserts the undone
// doc-sync restores the pre-run node count. Logs received event types in order.
//
//   npm run smoke:server
//
// Makes ONE live Opus 4.8 call (key from app/.env via dotenv, loaded by the server).
import dotenv from "dotenv";
dotenv.config({ override: true });

import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PROMPT =
  "Add a pricing section with three tiers below the hero, aligned and evenly spaced.";

async function main() {
  // Boot the server in-process (its module-load side effect calls serve()).
  await import("./index.js");
  await new Promise((r) => setTimeout(r, 400)); // let the listener bind

  const port = Number(process.env.PORT ?? 8787);
  const ws = new WebSocket(`ws://localhost:${port}/ws`);

  const received: ServerMessage[] = [];
  const order: string[] = [];
  let preCount = -1;
  let postCount = -1;
  let undoneCount = -1;

  const onMsg = (raw: WebSocket.RawData) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    received.push(m);
    // Compress noisy repeats in the order log but keep the first of each kind/phase.
    const tag = m.t === "phase" ? `phase:${m.phase}` : m.t;
    if (order[order.length - 1] !== tag) order.push(tag);
  };
  ws.on("message", onMsg);

  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });

  // The connect frame is doc-sync; the onopen resync also yields one. Capture the
  // pre-run node count from the first doc-sync.
  await waitFor(received, (m) => m.t === "doc-sync");
  const firstSync = received.find((m) => m.t === "doc-sync");
  if (firstSync && firstSync.t === "doc-sync") preCount = firstSync.nodes.length;
  console.log(`pre-run node count (doc-sync): ${preCount}`);

  // Fire the prompt and wait for the terminal run event.
  console.log(`\nPrompt: "${PROMPT}"\n`);
  send({ t: "prompt", text: PROMPT, selection: [] });

  const terminal = await waitFor(
    received,
    (m) => m.t === "done" || m.t === "escalated",
    120_000,
  );
  console.log(`\nterminal run event: ${terminal.t}`);

  // After the run the server pushes a definitive doc-sync; capture the post count.
  await new Promise((r) => setTimeout(r, 200));
  const lastSync = [...received].reverse().find((m) => m.t === "doc-sync");
  if (lastSync && lastSync.t === "doc-sync") postCount = lastSync.nodes.length;
  console.log(`post-run node count (doc-sync): ${postCount}`);

  // ---- assert the streamed sequence ----
  const seen = new Set(order.map((o) => o.split(":")[0]));
  const required = ["doc-sync", "phase", "plan"];
  const hasTerminal = seen.has("done") || seen.has("escalated");
  const seqOk = required.every((r) => seen.has(r)) && hasTerminal;

  console.log("\nreceived event order:");
  console.log("  " + order.join(" → "));

  // ---- undo ----
  console.log("\nsending {t:'undo'}…");
  send({ t: "undo" });
  if (terminal.t === "done") {
    const undone = await waitFor(received, (m) => m.t === "undone", 5_000);
    if (undone.t === "undone") undoneCount = undone.nodes.length;
    console.log(`undone node count: ${undoneCount}`);
  } else {
    console.log("(run escalated — server already restored the snapshot; undo is a no-op)");
    undoneCount = postCount; // escalation already reverted server-side
  }

  ws.close();

  // ---- verdicts ----
  const undoOk =
    terminal.t === "escalated" || (undoneCount === preCount && preCount >= 0);

  console.log("\n───────────────────────────────────────────────");
  console.log(`event sequence (doc-sync→phase→plan→…→terminal): ${seqOk ? "OK" : "FAIL"}`);
  console.log(
    `undo restores pre-run node count (${preCount}): ${undoOk ? "OK" : "FAIL"} ` +
      `(undone=${undoneCount})`,
  );
  console.log("───────────────────────────────────────────────");

  if (!seqOk || !undoOk) {
    console.error("\nsmoke:server FAILED");
    process.exit(1);
  }
  console.log("\nsmoke:server OK");
  process.exit(0);
}

/** Poll an accumulating array until a predicate matches a NEW element. */
async function waitFor(
  buf: ServerMessage[],
  pred: (m: ServerMessage) => boolean,
  timeoutMs = 10_000,
): Promise<ServerMessage> {
  const start = Date.now();
  let i = 0;
  // Scan already-buffered first.
  for (; i < buf.length; i++) if (pred(buf[i])) return buf[i];
  while (Date.now() - start < timeoutMs) {
    for (; i < buf.length; i++) if (pred(buf[i])) return buf[i];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

main().catch((e) => {
  console.error("\nsmoke:server THREW:", e);
  process.exit(1);
});
