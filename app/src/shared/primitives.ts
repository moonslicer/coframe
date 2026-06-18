import type { Node, NodeId, Paint, PrimitiveKind } from "./types.js";

export type BBox = Node["bbox"];
export type VectorKind = "line" | "arrow" | "draw";

const DEFAULT_FRAME_FILL = "#FFFFFF";
const DEFAULT_FRAME_STROKE = "#DDE3EC";
const DEFAULT_FRAME_RADIUS = 16;
const DEFAULT_BOX_FILL = "#E2E8F0";
const DEFAULT_VECTOR_STROKE = "#475569";
const DEFAULT_TEXT_COLOR = "#111827";
const DEFAULT_FONT = "Inter, system-ui, sans-serif";

export const solid = (color: string): Paint => ({ type: "SOLID", color });

function baseNode(args: {
  id: NodeId;
  type: Node["type"];
  primitive: PrimitiveKind;
  name: string;
  bbox: BBox;
  parent: NodeId | null;
  children?: NodeId[];
  template: Node["template"];
}): Pick<Node, "id" | "type" | "primitive" | "name" | "bbox" | "parent" | "children" | "tid" | "template"> {
  return {
    id: args.id,
    tid: args.id,
    type: args.type,
    primitive: args.primitive,
    name: args.name,
    bbox: args.bbox,
    parent: args.parent,
    children: args.children ?? [],
    template: args.template,
  };
}

export function createFrameNode(args: {
  id: NodeId;
  parent: NodeId;
  bbox: BBox;
  name?: string;
}): Node {
  return {
    ...baseNode({
      id: args.id,
      type: "FRAME",
      primitive: "frame",
      name: args.name ?? "Frame",
      bbox: args.bbox,
      parent: args.parent,
      template: { family: "box", domTag: "div" },
    }),
    layout: {
      display: "flex",
      mode: "NONE",
      positionMode: "absolute",
      widthMode: "fixed",
      heightMode: "fixed",
    },
    style: {
      fills: [solid(DEFAULT_FRAME_FILL)],
      cornerRadius: DEFAULT_FRAME_RADIUS,
      cornerRadiusUnit: "px",
      stroke: { color: DEFAULT_FRAME_STROKE, weight: 1, style: "solid" },
      overflow: "visible",
    },
  };
}

export function createTextNode(args: {
  id: NodeId;
  parent: NodeId;
  chars: string;
  bbox: BBox;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  name?: string;
}): Node {
  const color = args.color ?? DEFAULT_TEXT_COLOR;
  return {
    ...baseNode({
      id: args.id,
      type: "TEXT",
      primitive: "text",
      name: args.name ?? (args.chars.slice(0, 24) || "Text"),
      bbox: args.bbox,
      parent: args.parent,
      template: { family: "text", domTag: "p" },
    }),
    text: {
      chars: args.chars,
      fontFamily: DEFAULT_FONT,
      fontSize: args.fontSize ?? 16,
      fontWeight: args.fontWeight ?? 400,
      align: "LEFT",
      lineHeight: 1,
      color,
      textTransform: "none",
    },
    style: { fills: [solid(color)] },
    layout: { mode: "NONE", positionMode: "absolute", widthMode: "fixed", heightMode: "hug" },
  };
}

export function createShapeNode(args: {
  id: NodeId;
  parent: NodeId;
  kind: "RECT" | "ELLIPSE";
  bbox: BBox;
  color?: string;
  cornerRadius?: number;
  name?: string;
}): Node {
  const oval = args.kind === "ELLIPSE";
  return {
    ...baseNode({
      id: args.id,
      type: args.kind,
      primitive: oval ? "oval" : "rectangle",
      name: args.name ?? (oval ? "Oval" : "Rectangle"),
      bbox: args.bbox,
      parent: args.parent,
      template: { family: "box", domTag: "div" },
    }),
    style: {
      fills: [solid(args.color ?? DEFAULT_BOX_FILL)],
      cornerRadius: oval ? 50 : args.cornerRadius ?? 8,
      cornerRadiusUnit: oval ? "%" : "px",
      overflow: "visible",
    },
    layout: {
      display: "flex",
      mode: "NONE",
      align: oval ? "CENTER" : undefined,
      positionMode: "absolute",
      widthMode: "fixed",
      heightMode: "fixed",
    },
  };
}

export function createVectorNode(args: {
  id: NodeId;
  parent: NodeId;
  kind: VectorKind;
  bbox: BBox;
  points?: Array<[number, number]>;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  name?: string;
}): Node {
  const [, , w, h] = args.bbox;
  const points: Array<[number, number]> = args.points?.length
    ? args.points
    : [
        [0, h / 2],
        [w, h / 2],
      ];
  const title = args.kind === "draw" ? "Draw" : args.kind === "arrow" ? "Arrow" : "Line";
  return {
    ...baseNode({
      id: args.id,
      type: "VECTOR",
      primitive: args.kind,
      name: args.name ?? title,
      bbox: args.bbox,
      parent: args.parent,
      template: { family: "vector", domTag: "svg" },
    }),
    vector: {
      kind: args.kind,
      points,
      viewBox: [0, 0, Math.max(1, w), Math.max(1, h)],
      stroke: args.stroke ?? DEFAULT_VECTOR_STROKE,
      strokeWidth: args.strokeWidth ?? 4,
      fill: args.fill ?? "none",
      linecap: "round",
      linejoin: "round",
      scaling: "stretch",
    },
    style: {
      fills: args.fill && args.fill !== "none" ? [solid(args.fill)] : [],
      overflow: "visible",
    },
    layout: { mode: "NONE", positionMode: "absolute", widthMode: "fixed", heightMode: "fixed" },
  };
}
