// The single WebSocket connection. Routes every server frame to the two stores:
// doc-state frames (doc-sync / undone / ops-applied) -> docMirror; run/chrome
// frames -> runStore. Reconnect sends {t:'resync'} and applies the doc-sync reply.

import type { ClientMessage, ServerMessage } from "../shared/protocol.js";
import { docMirror, runStore } from "./stores.js";

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string {
  // Vite dev proxies /ws to the Node server; in prod the bundle is served by the
  // same host, so a relative /ws resolves to the right origin either way.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function route(msg: ServerMessage) {
  switch (msg.t) {
    case "doc-sync":
    case "undone": {
      // A genuine seed switch invalidates the previous doc's run history/activity.
      const seedChanged =
        msg.t === "doc-sync" && msg.seedDocId != null && msg.seedDocId !== docMirror.seedDocId;
      docMirror.sync(msg.nodes, msg.rootId, msg.version, msg.seedDocId);
      if (seedChanged) runStore.resetForSeed();
      runStore.apply(msg);
      break;
    }
    case "ops-applied":
      docMirror.applyOps(msg.ops, msg.version);
      break;
    default:
      runStore.apply(msg);
  }
}

export function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
    return;

  const ws = new WebSocket(wsUrl());
  socket = ws;

  ws.onmessage = (ev) => {
    try {
      route(JSON.parse(ev.data) as ServerMessage);
    } catch {
      /* ignore malformed frame */
    }
  };
  ws.onopen = () => {
    // On (re)connect, ask for a fresh authoritative doc snapshot.
    sendWhenOpen({ t: "resync" });
  };
  ws.onclose = () => {
    socket = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1000); // simple backoff; resync on reopen
  };
  ws.onerror = () => ws.close();
}

function sendWhenOpen(msg: ClientMessage) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function send(msg: ClientMessage): void {
  if (msg.t === "prompt") {
    runStore.startRun();
    // Clear selection as the run STARTS: the resolved id set is already shipped with
    // the prompt, and a stale outline must not linger across the run or into the next.
    docMirror.clearSelection();
  }
  sendWhenOpen(msg);
}

// Human tool edit: read the current authoritative version off the mirror for the
// optimistic-concurrency baseVersion the server checks against.
export function sendTool(name: string, args: unknown): void {
  sendWhenOpen({ t: "tool", name, args, baseVersion: docMirror.version });
}
