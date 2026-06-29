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
import type { DesignSystemProfile } from "./design-system.js";
import type { ServerEvent as RunEvent } from "../agent/run-controller.js";

// ---- client -> server ----
export type ClientMessage =
  | { t: "prompt"; text: string; selection: NodeId[]; seedDocId?: string }
  | { t: "clarification-answer"; original: string; answers: string; selection: NodeId[] }
  | { t: "importDesignSystem"; html?: string; sourceUrl?: string; sourceName?: string }
  | { t: "clearDesignSystem" }
  | { t: "undo" }
  | { t: "redo" }
  | { t: "select"; ids: NodeId[] }
  | { t: "loadSeed"; seedDocId: string }
  | { t: "resync" }
  | { t: "tool"; name: string; args: unknown; baseVersion: DocVersion };

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
export interface RedoneMessage {
  t: "redone";
  nodes: Node[];
  rootId: NodeId;
  version: DocVersion;
  seedDocId: string;
}
export interface HistoryStateMessage {
  t: "history-state";
  canUndo: boolean;
  canRedo: boolean;
}
// Surfaced when the single-writer guard rejects a human mutation mid-run.
export interface RejectedMessage {
  t: "rejected";
  reason: string;
}
export interface ClarificationRequestMessage {
  t: "clarification-request";
  original: string;
  questions: string[];
  assumptions: string[];
}
export interface DesignSystemMessage {
  t: "design-system";
  designSystem: DesignSystemProfile | null;
  error?: string;
}

export type ServerMessage =
  | RunEvent
  | DocSyncMessage
  | UndoneMessage
  | RedoneMessage
  | HistoryStateMessage
  | RejectedMessage
  | ClarificationRequestMessage
  | DesignSystemMessage;

// Re-export the run-event union so the client imports run-event types from one place.
export type { RunEvent };
