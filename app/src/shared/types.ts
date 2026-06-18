// Shared scene-graph types. Pure data — no SDK, no rendering, no Date.now/Math.random.
// Mirrors IMPLEMENTATION.md §5.1.

export type NodeId = string; // "node:<n>" — stable, survives reorder/move (NOT an array index)
export type DocVersion = number; // monotonic integer, server-assigned

export type NodeType =
  | "FRAME"
  | "TEXT"
  | "RECT"
  | "ELLIPSE" // v1-populated
  | "VECTOR"
  | "COMPONENT"
  | "INSTANCE"
  | "GROUP"; // reserved, additive

export type Paint = { type: "SOLID"; color: string; opacity?: number }; // hex; gradient/image reserved

export interface Node {
  id: NodeId;
  type: NodeType;
  name: string; // semantic index — "Hero", "CTA Button"
  bbox: [x: number, y: number, w: number, h: number];
  parent: NodeId | null;
  children: NodeId[]; // ids only, NEVER inlined nodes
  // --- projectable fields ---
  style?: {
    fills?: Paint[];
    opacity?: number;
    cornerRadius?: number;
    stroke?: { color: string; weight?: number }; // hex border; keeps white-on-white frames visible
  };
  text?: {
    chars: string;
    fontSize: number;
    fontWeight: number;
    align: "LEFT" | "CENTER" | "RIGHT";
  };
  layout?: {
    mode: "NONE" | "HORIZONTAL" | "VERTICAL";
    gap?: number;
    padding?: number;
    align?: "START" | "CENTER" | "END";
  };
}

// The unit of {ops, version}. v1 ops are DESCRIPTIVE (not guaranteed-invertible).
export type Op =
  | { kind: "add"; node: Node; index?: number }
  | { kind: "remove"; id: NodeId }
  | { kind: "set"; id: NodeId; path: string; value: unknown } // "style.fills" | "bbox" | "layout"
  | { kind: "reparent"; id: NodeId; parent: NodeId; index: number };

export type ToolOk = { ops: Op[]; version: DocVersion };
export type ToolError = {
  error: "BAD_ID" | "STALE" | "CONSTRAINT" | "UNKNOWN_TOOL";
  detail: string;
};
export type ToolResult = ToolOk | ToolError;
export const isErr = (r: ToolResult): r is ToolError => "error" in r;
