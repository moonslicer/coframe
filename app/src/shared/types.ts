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

export type PrimitiveKind =
  | "frame"
  | "text"
  | "rectangle"
  | "oval"
  | "line"
  | "arrow"
  | "draw";

export type SizeMode = "hug" | "fixed" | "fill";
export type PositionMode = "inline" | "absolute" | "fixed" | "sticky";
export type SvgScaling = "stretch" | "aspect-fit" | "fill";

export interface NodeStyle {
  fills?: Paint[];
  opacity?: number;
  cornerRadius?: number;
  cornerRadiusUnit?: "px" | "%";
  stroke?: {
    color: string;
    weight?: number;
    style?: "none" | "solid" | "dashed" | "dotted" | "double";
  };
  overflow?: "visible" | "hidden" | "auto" | "scroll";
  zIndex?: number | "auto";
  boxShadow?: string;
  textShadow?: string;
  transform?: string;
  filter?: string;
}

export interface TextStyle {
  chars: string;
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  fontStyle?: "normal" | "italic";
  textDecoration?: Array<"underline" | "line-through">;
  align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
  lineHeight?: number;
  color?: string;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  letterSpacingEm?: number;
}

export interface LayoutStyle {
  display?: "block" | "flex" | "grid" | "inline-block" | "inline" | "none";
  mode: "NONE" | "HORIZONTAL" | "VERTICAL";
  gap?: number;
  padding?: number;
  paddingSides?: { top?: number; right?: number; bottom?: number; left?: number };
  marginSides?: { top?: number; right?: number; bottom?: number; left?: number };
  align?: "START" | "CENTER" | "END";
  wrap?: "nowrap" | "wrap" | "wrap-reverse";
  grow?: number;
  alignSelf?: "auto" | "stretch" | "flex-start" | "center" | "flex-end";
  widthMode?: SizeMode;
  heightMode?: SizeMode;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  positionMode?: PositionMode;
  inset?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface VectorStyle {
  kind: "line" | "arrow" | "draw";
  // Points are local to bbox. This keeps resize as a bbox operation instead of a
  // destructive path rewrite and gives the future DOM compiler a clean viewBox.
  points: Array<[number, number]>;
  viewBox: [x: number, y: number, w: number, h: number];
  stroke: string;
  strokeWidth: number;
  fill?: string;
  linecap?: "butt" | "round" | "square";
  linejoin?: "miter" | "round" | "bevel";
  scaling?: SvgScaling;
}

export interface TemplateProjection {
  family: "text" | "box" | "vector";
  domTag: "p" | "div" | "svg";
}

export interface Node {
  id: NodeId;
  type: NodeType;
  name: string; // semantic index — "Hero", "CTA Button"
  bbox: [x: number, y: number, w: number, h: number];
  parent: NodeId | null;
  children: NodeId[]; // ids only, NEVER inlined nodes
  tid?: string; // stable template id; defaults to id when omitted
  primitive?: PrimitiveKind;
  // --- projectable fields ---
  style?: NodeStyle;
  text?: TextStyle;
  layout?: LayoutStyle;
  vector?: VectorStyle;
  template?: TemplateProjection;
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
