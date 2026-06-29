// The single Node process (§5.5/§5.6): Hono + ws via @hono/node-server. It holds
// ONE authoritative DocStore in memory, keeps ANTHROPIC_API_KEY server-side, runs
// the agent loop server-side, and pushes the RunController event stream plus the
// transport-level doc-state frames (doc-sync / undone) down one WebSocket.
//
// dotenv FIRST with override:true so a stale exported shell ANTHROPIC_API_KEY can
// never shadow the committed app/.env.
import dotenv from "dotenv";
dotenv.config({ override: true });

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { DocStore } from "../shared/store.js";
import { dispatch } from "../shared/tools.js";
import { isErr } from "../shared/types.js";
import { getSeed, DEFAULT_SEED_ID } from "../shared/seed.js";
import { RunController } from "../agent/run-controller.js";
import { runTask } from "../agent/loop.js";
import { formatClarifiedIntent, maybeClarifyDesignIntent } from "../agent/clarify.js";
import { importDesignSystemFromHtml } from "../shared/design-system.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import type { DesignSystemProfile } from "../shared/design-system.js";
import type { Node, NodeId } from "../shared/types.js";

// ---- the ONE authoritative store ----
const store = new DocStore();
let activeSeedId = DEFAULT_SEED_ID;
store.loadSeed(getSeed(activeSeedId).seed);

// Per-connection nothing is held server-side; the doc is shared (single-writer demo).
// A bounded snapshot ring gives the human palette normal Undo/Redo. This is still a
// single-user implementation detail; the op boundary remains the future multiplayer
// migration path.
type Snapshot = ReturnType<DocStore["snapshot"]>;
const HISTORY_LIMIT = 50;
let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];
let activeDesignSystem: DesignSystemProfile | null = null;

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

function docSync(t: "doc-sync" | "undone" | "redone"): ServerMessage {
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

function pushUndoSnapshot(snapshot: Snapshot) {
  undoStack.push(snapshot);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
}

function sendHistoryState(ws: WebSocket) {
  send(ws, { t: "history-state", canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

function sendDesignSystemState(ws: WebSocket, error?: string) {
  send(ws, { t: "design-system", designSystem: activeDesignSystem, ...(error ? { error } : {}) });
}

async function loadDesignSystemImport(msg: Extract<ClientMessage, { t: "importDesignSystem" }>) {
  const sourceUrl = msg.sourceUrl?.trim();
  const sourceName = msg.sourceName?.trim();
  if (msg.html?.trim()) {
    return {
      html: msg.html,
      source: sourceName || sourceUrl || "Uploaded HTML",
    };
  }
  if (!sourceUrl) throw new Error("Provide an HTML file or file:// URL.");

  if (/^file:\/\//i.test(sourceUrl)) {
    const filePath = fileURLToPath(sourceUrl);
    return {
      html: await readFile(filePath, "utf8"),
      source: sourceUrl,
    };
  }

  if (/^https?:\/\//i.test(sourceUrl)) {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`Could not fetch HTML (${res.status}).`);
    return {
      html: await res.text(),
      source: sourceUrl,
    };
  }

  return {
    html: await readFile(sourceUrl, "utf8"),
    source: sourceUrl,
  };
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
  sendHistoryState(ws);
  sendDesignSystemState(ws);

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
      sendHistoryState(ws);
      sendDesignSystemState(ws);
      return;

    case "importDesignSystem": {
      if (runActive()) {
        sendDesignSystemState(ws, "Wait for the active run to finish before importing a design system.");
        return;
      }
      try {
        const imported = await loadDesignSystemImport(msg);
        activeDesignSystem = importDesignSystemFromHtml(imported.html, { source: imported.source });
        sendDesignSystemState(ws);
      } catch (e) {
        sendDesignSystemState(ws, (e as Error).message);
      }
      return;
    }

    case "clearDesignSystem":
      if (runActive()) {
        sendDesignSystemState(ws, "Wait for the active run to finish before clearing the design system.");
        return;
      }
      activeDesignSystem = null;
      sendDesignSystemState(ws);
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
      undoStack = [];
      redoStack = [];
      send(ws, docSync("doc-sync"));
      sendHistoryState(ws);
      return;
    }

    case "undo": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is in progress." });
        return;
      }
      const snapshot = undoStack.pop();
      if (!snapshot) {
        sendHistoryState(ws);
        return;
      }
      redoStack.push(store.snapshot());
      store.restore(snapshot);
      send(ws, docSync("undone"));
      sendHistoryState(ws);
      return;
    }

    case "redo": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is in progress." });
        return;
      }
      const snapshot = redoStack.pop();
      if (!snapshot) {
        sendHistoryState(ws);
        return;
      }
      undoStack.push(store.snapshot());
      store.restore(snapshot);
      send(ws, docSync("redone"));
      sendHistoryState(ws);
      return;
    }

    case "tool": {
      // Human direct-manipulation edit. Editing is LOCKED during agent runs.
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is in progress." });
        return;
      }
      const before = store.snapshot();
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
      pushUndoSnapshot(before);
      // Success reuses the ops-applied frame; NO activityId for human edits.
      send(ws, { t: "ops-applied", ops: r.ops, version: r.version });
      sendHistoryState(ws);
      return;
    }

    case "prompt": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is already in progress." });
        return;
      }
      const clarification = await maybeClarifyDesignIntent(msg.text, msg.selection ?? [], {
        designSystem: activeDesignSystem,
      });
      if (clarification) {
        send(ws, { t: "clarification-request", ...clarification });
        return;
      }
      await runAgentPrompt(ws, msg.text, msg.selection ?? []);
      return;
    }

    case "clarification-answer": {
      if (runActive()) {
        send(ws, { t: "rejected", reason: "A run is already in progress." });
        return;
      }
      await runAgentPrompt(
        ws,
        formatClarifiedIntent(msg.original, msg.answers),
        msg.selection ?? [],
      );
      return;
    }
  }
}

async function runAgentPrompt(ws: WebSocket, intent: string, selection: NodeId[]): Promise<void> {
  // Capture one pre-run snapshot so the whole agent run is one undo entry.
  const before = store.snapshot();
  pushUndoSnapshot(before);

  const rc = new RunController();
  activeRC = rc;
  rc.on((e) => send(ws, e)); // every RunController event -> this socket

  try {
    await runTask(store, rc, intent, selection, activeDesignSystem);
  } catch (err) {
    // A thrown run (e.g. live model flake) must not strand the socket.
    rc.finishEscalated(`Run threw: ${(err as Error).message}`);
  } finally {
    activeRC = null;
    // Push a definitive doc-sync so the mirror matches the authoritative store
    // exactly (covers any op the mirror missed mid-stream).
    send(ws, docSync("doc-sync"));
    sendHistoryState(ws);
  }
}

console.log(`[server] listening on http://localhost:${PORT}  (ws: /ws)`);

// Exported for the in-process smoke harness.
export { app, wss, store };
