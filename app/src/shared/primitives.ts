import type { InputSpec, Node, NodeId, Paint, PrimitiveKind, Shadow } from "./types.js";
import { getIcon, ICON_VIEWBOX } from "./icons.js";

export type BBox = Node["bbox"];
export type VectorKind = "line" | "arrow" | "draw";

const DEFAULT_FRAME_FILL = "#FFFFFF";
const DEFAULT_FRAME_STROKE = "#DDE3EC";
const DEFAULT_FRAME_RADIUS = 16;
const DEFAULT_BOX_FILL = "#E2E8F0";
const DEFAULT_VECTOR_STROKE = "#475569";
const DEFAULT_TEXT_COLOR = "#111827";
const DEFAULT_FONT = "Inter, system-ui, sans-serif";
const DEFAULT_INPUT_FILL = "#FFFFFF";
const DEFAULT_INPUT_STROKE = "#CBD5E1";

/** Sensible field box height per kind — a single-line field hugs ~48px, a textarea is taller,
 *  a checkbox/switch is compact. Used when the caller omits a height. */
export const defaultInputSize = (kind: InputSpec["kind"]): [number, number] =>
  kind === "textarea" ? [280, 96] : kind === "checkbox" || kind === "switch" ? [220, 28] : [280, 48];

export const solid = (color: string): Paint => ({ type: "SOLID", color });

/** A gradient paint from a list of colors evenly spread across the track. 2 colors is the
 *  common case (from→to); angle is CSS degrees (0=to top, 180=to bottom, 90=to right). */
export const gradientPaint = (
  colors: string[],
  opts?: { gradient?: "linear" | "radial"; angle?: number },
): Paint => ({
  type: "GRADIENT",
  gradient: opts?.gradient ?? "linear",
  ...(opts?.angle != null ? { angle: opts.angle } : {}),
  stops: colors.map((color, i) => ({
    color,
    offset: colors.length <= 1 ? 0 : Math.round((i / (colors.length - 1)) * 1000) / 1000,
  })),
});

/** An image paint (data: URI or URL) fitted to the node box. */
export const imagePaint = (src: string, fit?: "cover" | "contain" | "fill"): Paint => ({
  type: "IMAGE",
  src,
  ...(fit ? { fit } : {}),
});

/** Normalize a loose shadow spec into a canonical Shadow (sensible soft default). */
export const normalizeShadow = (s: Partial<Shadow> | true | number): Shadow => {
  if (s === true) return { x: 0, y: 4, blur: 12, color: "rgba(0,0,0,0.18)" };
  if (typeof s === "number") return { x: 0, y: Math.round(s / 2), blur: s, color: "rgba(0,0,0,0.18)" };
  return {
    x: s.x ?? 0,
    y: s.y ?? 4,
    blur: s.blur ?? 12,
    color: s.color ?? "rgba(0,0,0,0.18)",
    ...(s.spread != null ? { spread: s.spread } : {}),
    ...(s.inset != null ? { inset: s.inset } : {}),
  };
};

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

/** A VECTOR node carrying an icon glyph (raw path from the icon library). Stroke-drawn by
 *  default; pass a `fill` for a solid glyph. Returns null when the icon name is unknown. */
export function createIconNode(args: {
  id: NodeId;
  parent: NodeId;
  icon: string;
  bbox: BBox;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  name?: string;
}): Node | null {
  const d = getIcon(args.icon);
  if (!d) return null;
  return {
    ...baseNode({
      id: args.id,
      type: "VECTOR",
      primitive: "draw",
      name: args.name ?? `icon:${args.icon}`,
      bbox: args.bbox,
      parent: args.parent,
      template: { family: "vector", domTag: "svg" },
    }),
    vector: {
      kind: "icon",
      d,
      points: [],
      viewBox: [0, 0, ICON_VIEWBOX, ICON_VIEWBOX],
      stroke: args.stroke ?? "#111827",
      strokeWidth: args.strokeWidth ?? 2,
      fill: args.fill ?? "none",
      linecap: "round",
      linejoin: "round",
      scaling: "aspect-fit",
    },
    style: { overflow: "visible" },
    layout: { mode: "NONE", positionMode: "absolute", widthMode: "fixed", heightMode: "fixed" },
  };
}

/** A stateful form input (text field, select, checkbox, switch, …) bound to `field`.
 *  Renders as a styled field box on the canvas; becomes a real control in Play mode.
 *  Checkbox/switch carry no box fill — they draw their own control glyph. */
export function createInputNode(args: {
  id: NodeId;
  parent: NodeId;
  input: InputSpec;
  bbox: BBox;
  name?: string;
}): Node {
  const compact = args.input.kind === "checkbox" || args.input.kind === "switch";
  return {
    ...baseNode({
      id: args.id,
      type: "FRAME",
      primitive: "input",
      name: args.name ?? `${args.input.kind}:${args.input.field}`,
      bbox: args.bbox,
      parent: args.parent,
      template: { family: "box", domTag: "div" },
    }),
    input: { ...args.input },
    style: {
      fills: compact ? [] : [solid(DEFAULT_INPUT_FILL)],
      cornerRadius: compact ? 6 : 10,
      cornerRadiusUnit: "px",
      stroke: compact
        ? { color: "#000000", weight: 0, style: "none" }
        : { color: DEFAULT_INPUT_STROKE, weight: 1, style: "solid" },
      overflow: "hidden",
    },
    layout: { mode: "NONE", positionMode: "absolute", widthMode: "fixed", heightMode: "fixed" },
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
