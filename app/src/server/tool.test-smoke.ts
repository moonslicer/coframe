// Headless WS smoke for the HUMAN-EDIT path (Step 2). Boots the server in-process
// and drives {t:"tool"} over a real WebSocket — NO Anthropic call anywhere. Asserts
// success echoes via ops-applied, server-minted create ids flow back, bad-id and
// stale-version mutations are rejected, and the human edits coalesce into ONE undo
// level. Mirrors the harness shape of server.test-smoke.ts.
//
//   npm run smoke:tool
import dotenv from "dotenv";
dotenv.config({ override: true });

import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import type { Op } from "../shared/types.js";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  await import("./index.js");
  await new Promise((r) => setTimeout(r, 400)); // let the listener bind

  const port = Number(process.env.PORT ?? 8787);
  const ws = new WebSocket(`ws://localhost:${port}/ws`);

  const received: ServerMessage[] = [];
  ws.on("message", (raw: WebSocket.RawData) => {
    received.push(JSON.parse(raw.toString()) as ServerMessage);
  });

  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

  await new Promise<void>((res, rej) => {
    ws.on("open", () => res());
    ws.on("error", rej);
  });

  // ---- 1. connect doc-sync: capture version, rootId, a real non-root node ----
  const sync = await waitFor(received, (m) => m.t === "doc-sync");
  if (sync.t !== "doc-sync") throw new Error("expected doc-sync");
  let version = sync.version;
  const rootId = sync.rootId;
  const preCount = sync.nodes.length;
  const target = sync.nodes.find((n) => n.id !== rootId);
  if (!target) throw new Error("no non-root node in seed");
  const [bx, by, bw, bh] = target.bbox;
  console.log(
    `connect: version=${version} rootId=${rootId} target=${target.id} bbox=[${bx},${by},${bw},${bh}] nodes=${preCount}`,
  );

  // ---- 2. setBBox success -> ops-applied with bumped version + set op ----
  send({ t: "tool", name: "setBBox", args: { id: target.id, bbox: [bx + 5, by + 5, bw, bh] }, baseVersion: version });
  const r2 = await waitFor(received, (m) => m.t === "ops-applied");
  if (r2.t !== "ops-applied") throw new Error("expected ops-applied");
  const setOp = r2.ops.find((o: Op) => o.kind === "set" && o.id === target.id && o.path === "bbox");
  check("2 setBBox -> ops-applied, version bumped", r2.version > version, `version ${version} -> ${r2.version}`);
  check(
    "2 setBBox op sets new bbox",
    !!setOp && JSON.stringify((setOp as any).value) === JSON.stringify([bx + 5, by + 5, bw, bh]),
  );
  version = r2.version;

  // ---- 3. createShape -> ops-applied with server-minted node.id ----
  send({ t: "tool", name: "createShape", args: { parent: rootId, kind: "RECT", bbox: [0, 0, 60, 40] }, baseVersion: version });
  const r3 = await waitFor(received, (m) => m.t === "ops-applied" && m.version > version);
  if (r3.t !== "ops-applied") throw new Error("expected ops-applied");
  const addOp = r3.ops.find((o: Op) => o.kind === "add");
  const newId = addOp && addOp.kind === "add" ? addOp.node.id : "";
  check("3 createShape add op carries server-minted node:* id", newId.startsWith("node:"), `id=${newId}`);
  version = r3.version;

  // ---- 3b. setBBoxes: TWO real nodes move atomically under ONE version ----
  // Proves multi-node drag commits in a single bump (vs N STALE-prone setBBox calls).
  const a = target.id;
  const b = newId;
  const aBox: [number, number, number, number] = [bx + 20, by + 20, bw, bh];
  const bBox: [number, number, number, number] = [99, 88, 60, 40];
  send({
    t: "tool",
    name: "setBBoxes",
    args: { items: [{ id: a, bbox: aBox }, { id: b, bbox: bBox }] },
    baseVersion: version,
  });
  const r3b = await waitFor(received, (m) => m.t === "ops-applied" && m.version > version);
  if (r3b.t !== "ops-applied") throw new Error("expected ops-applied");
  check("3b setBBoxes bumps version by exactly 1", r3b.version === version + 1, `${version} -> ${r3b.version}`);
  const setA = r3b.ops.find((o: Op) => o.kind === "set" && o.id === a && o.path === "bbox");
  const setB = r3b.ops.find((o: Op) => o.kind === "set" && o.id === b && o.path === "bbox");
  check(
    "3b setBBoxes set op for node A",
    !!setA && JSON.stringify((setA as any).value) === JSON.stringify(aBox),
  );
  check(
    "3b setBBoxes set op for node B",
    !!setB && JSON.stringify((setB as any).value) === JSON.stringify(bBox),
  );
  version = r3b.version;

  // ---- 4. bad id -> rejected containing BAD_ID ----
  send({ t: "tool", name: "setBBox", args: { id: "node:nope", bbox: [0, 0, 1, 1] }, baseVersion: version });
  const r4 = await waitFor(received, (m) => m.t === "rejected");
  check("4 bad id -> rejected BAD_ID", r4.t === "rejected" && r4.reason.includes("BAD_ID"), r4.t === "rejected" ? r4.reason : "");

  // ---- 5. stale version -> rejected containing STALE ----
  send({ t: "tool", name: "setBBox", args: { id: target.id, bbox: [bx, by, bw, bh] }, baseVersion: 0 });
  const r5 = await waitForFrom(received, received.length, (m) => m.t === "rejected");
  check("5 stale version -> rejected STALE", r5.t === "rejected" && r5.reason.includes("STALE"), r5.t === "rejected" ? r5.reason : "");

  // ---- 6. undo coalescing: one undo restores the pre-edit node count ----
  send({ t: "undo" });
  const r6 = await waitFor(received, (m) => m.t === "undone");
  const undoneCount = r6.t === "undone" ? r6.nodes.length : -1;
  check("6 undo coalesces all human edits to one level", undoneCount === preCount, `pre=${preCount} undone=${undoneCount}`);

  ws.close();

  console.log("───────────────────────────────────────────────");
  if (failures > 0) {
    console.error(`tool smoke FAILED (${failures} assertion(s))`);
    process.exit(1);
  }
  console.log("tool smoke OK");
  process.exit(0);
}

/** Poll an accumulating array until a predicate matches a NEW element (from start). */
async function waitFor(
  buf: ServerMessage[],
  pred: (m: ServerMessage) => boolean,
  timeoutMs = 10_000,
): Promise<ServerMessage> {
  return waitForFrom(buf, 0, pred, timeoutMs);
}

/** Like waitFor but only scans elements at index >= from (avoids matching a prior frame). */
async function waitForFrom(
  buf: ServerMessage[],
  from: number,
  pred: (m: ServerMessage) => boolean,
  timeoutMs = 10_000,
): Promise<ServerMessage> {
  const start = Date.now();
  let i = from;
  for (; i < buf.length; i++) if (pred(buf[i])) return buf[i];
  while (Date.now() - start < timeoutMs) {
    for (; i < buf.length; i++) if (pred(buf[i])) return buf[i];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

main().catch((e) => {
  console.error("\ntool smoke THREW:", e);
  process.exit(1);
});
