// The single Node process (§5.5/§5.6): Hono + ws via @hono/node-server. It holds
// ONE authoritative DocStore in memory, keeps ANTHROPIC_API_KEY server-side, runs
// the agent loop server-side, and pushes the RunController event stream plus the
// transport-level doc-state frames (doc-sync / undone) down one WebSocket.
//
// dotenv FIRST with override:true so a stale exported shell ANTHROPIC_API_KEY can
// never shadow the committed app/.env.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { DocStore } from "../shared/store.js";
import { dispatch } from "../shared/tools.js";
import { isErr } from "../shared/types.js";
import { getSeed, DEFAULT_SEED_ID } from "../shared/seed.js";
import { RunController } from "../agent/run-controller.js";
import { runTask } from "../agent/loop.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import type { Node } from "../shared/types.js";

// ---- the ONE authoritative store ----
const store = new DocStore();
let activeSeedId = DEFAULT_SEED_ID;
store.loadSeed(getSeed(activeSeedId).seed);

// Per-connection nothing is held server-side; the doc is shared (single-writer demo).
// We keep the last pre-run snapshot keyed at the process level so undo can restore it.
type Snapshot = ReturnType<DocStore["snapshot"]>;
let lastSnapshot: Snapshot | null = null;
let lastRunVersion = 0; // doc version AT the time the run started (for undo bookkeeping)
// Pending human edits since the last run/undo should coalesce into the next run's undo level.
let humanDirty = false;

// The run guard: while a run is active, human mutations are rejected (single writer).
let activeRC: RunController | null = null;
const runActive = () =>
  activeRC != null &&
  activeRC.phase !== "IDLE" &&
  activeRC.phase !== "DONE" &&
  activeRC.phase !== "ESCALATED";

function nodesArray(): Node[] {
  return [...store.all().values()];
}

function docSync(t: "doc-sync" | "undone"): ServerMessage {
  return {
    t,
    nodes: nodesArray(),
    rootId: store.rootId,
    version: store.version,
    seedDocId: activeSeedId,
  };
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

// ---- Hono app (static bundle in prod; in dev Vite serves the client + proxies /ws) ----
const app = new Hono();
app.get("/healthz", (c) => c.text("ok"));

const PORT = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port: PORT });

// ---- WebSocket channel ----
const wss = new WebSocketServer({ server: server as any, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  // On connect: full doc-sync so the mirror is authoritative immediately.
  send(ws, docSync("doc-sync"));

  ws.on("message", async (raw: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    await handle(ws, msg);
  });
});

async function handle(ws: WebSocket, msg: ClientMessage): Promise<void> {
  switch (msg.t) {
    case "select":
      // Selection is read-only — always allowed, even mid-run. (No server state to
      // change; selection lives in the client mirror. Acknowledged implicitly.)
      return;

    case "resync":
      send(ws, docSync("doc-sync"));
      return;

    case "loadSeed": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is in progress." });
        return;
      }
      // Load a curated seed by id (falls back to the default if unknown).
      const { id, seed } = getSeed(msg.seedDocId);
      activeSeedId = id;
      store.loadSeed(seed);
      lastSnapshot = null;
      humanDirty = false;
      send(ws, docSync("doc-sync"));
      return;
    }

    case "undo": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is in progress." });
        return;
      }
      if (!lastSnapshot || store.version === lastRunVersion) {
        // One undo level; a second Cmd-Z is a no-op (already at pre-run state).
        return;
      }
      store.restore(lastSnapshot);
      lastSnapshot = null; // one undo level only — no redo, no ring
      humanDirty = false;
      send(ws, docSync("undone"));
      return;
    }

    case "tool": {
      // Human direct-manipulation edit. Editing is LOCKED during agent runs.
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is in progress." });
        return;
      }
      // Undo coalescing: capture the snapshot ONLY when none is pending.
      if (!lastSnapshot) {
        lastSnapshot = store.snapshot();
        lastRunVersion = store.version;
      }
      humanDirty = true; // a human edit is now pending
      // args are untrusted `unknown` — dispatch may throw on malformed input.
      let r;
      try {
        r = dispatch(msg.name, msg.args, store, msg.baseVersion);
      } catch (e) {
        send(ws, { t: "rejected", reason: `Tool error: ${(e as Error).message}` });
        return;
      }
      if (isErr(r)) {
        send(ws, { t: "rejected", reason: `${r.error}: ${r.detail}` });
        return;
      }
      // Success reuses the ops-applied frame; NO activityId for human edits.
      send(ws, { t: "ops-applied", ops: r.ops, version: r.version });
      return;
    }

    case "prompt": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is already in progress." });
        return;
      }
      // Capture the pre-run snapshot on the server so undo can restore it. Guarded
      // so a human edit followed by a run coalesces into one undo level.
      if (!lastSnapshot || !humanDirty) {
        lastSnapshot = store.snapshot();
        lastRunVersion = store.version;
      }

      const rc = new RunController();
      activeRC = rc;
      rc.on((e) => send(ws, e)); // every RunController event -> this socket

      try {
        await runTask(store, rc, msg.text, msg.selection ?? []);
      } catch (err) {
        // A thrown run (e.g. live model flake) must not strand the socket.
        rc.finishEscalated(`Run threw: ${(err as Error).message}`);
      } finally {
        activeRC = null;
        humanDirty = false; // the run is committed; the next run is its own level
        // Push a definitive doc-sync so the mirror matches the authoritative store
        // exactly (covers any op the mirror missed mid-stream).
        send(ws, docSync("doc-sync"));
      }
      return;
    }
  }
}

console.log(`[server] listening on http://localhost:${PORT}  (ws: /ws)`);

// Exported for the in-process smoke harness.
export { app, wss, store };
