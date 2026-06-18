// The bidirectional WebSocket protocol — the single boundary contract imported by
// BOTH the server (src/server/index.ts) and the browser (src/client/*). Boundary
// types are import, not re-spec (§5.6). A plain discriminated union — not a
// production telemetry taxonomy (cut by review).
//
// Server -> client carries the RunController ServerEvent union PLUS two doc-state
// frames (doc-sync / undone) that the loop never emits — they belong to the
// transport layer (connect / loadSeed / resync / undo), so they're composed here
// rather than bolted onto the loop's event vocabulary.

import type { DocVersion, Node, NodeId } from "./types.js";
import type { ServerEvent as RunEvent } from "../agent/run-controller.js";

// ---- client -> server ----
export type ClientMessage =
  | { t: "prompt"; text: string; selection: NodeId[]; seedDocId?: string }
  | { t: "undo" }
  | { t: "select"; ids: NodeId[] }
  | { t: "loadSeed"; seedDocId: string }
  | { t: "resync" };

// ---- server -> client ----
// Full doc-state frames (transport-level, not run-level).
export interface DocSyncMessage {
  t: "doc-sync";
  nodes: Node[];
  rootId: NodeId;
  version: DocVersion;
  seedDocId: string; // which curated seed is loaded (drives the per-seed chips)
}
export interface UndoneMessage {
  t: "undone";
  nodes: Node[];
  rootId: NodeId;
  version: DocVersion;
  seedDocId: string;
}
// Surfaced when the single-writer guard rejects a human mutation mid-run.
export interface RejectedMessage {
  t: "rejected";
  reason: string;
}

export type ServerMessage = RunEvent | DocSyncMessage | UndoneMessage | RejectedMessage;

// Re-export the run-event union so the client imports run-event types from one place.
export type { RunEvent };
