// The mutation / tool layer: 8 semantic tools + boundary validation + diff-return.
// One registry entry per tool is the single source of truth. Mirrors §5.3.

import type Anthropic from "@anthropic-ai/sdk";
import type { DocVersion, Node, NodeId, Op, Paint, ToolResult } from "./types.js";
import { DocStore } from "./store.js";

export interface ToolDef {
  name: string;
  schema: Anthropic.Tool;
  validate(args: any, store: DocStore): { error: "BAD_ID" | "CONSTRAINT"; detail: string } | null;
  plan(args: any, store: DocStore): Op[];
  label(args: any): string;
}

export const REGISTRY = new Map<string, ToolDef>();
const register = (d: ToolDef) => REGISTRY.set(d.name, d);

export const buildAnthropicTools = (): Anthropic.Tool[] =>
  [...REGISTRY.values()].map((d) => d.schema).sort((a, b) => a.name.localeCompare(b.name)); // byte-stable -> cacheable

/** Startup assertion: a malformed schema would silently break ALL tool use. */
export function assertValidToolSchemas() {
  for (const d of REGISTRY.values()) {
    if (d.schema.name !== d.name) throw new Error(`schema/name mismatch: ${d.name}`);
    if ((d.schema.input_schema as any).type !== "object")
      throw new Error(`tool ${d.name} input_schema.type must be "object"`);
  }
}

export function dispatch(
  name: string,
  rawInput: unknown,
  store: DocStore,
  baseVersion: DocVersion,
): ToolResult {
  const def = REGISTRY.get(name);
  if (!def) return { error: "UNKNOWN_TOOL", detail: name };
  const args = rawInput as any; // SDK already parsed JSON — never string-match
  const err = def.validate(args, store);
  if (err) return err;
  const ops = def.plan(args, store);
  return store.commit(ops, baseVersion); // single chokepoint; returns {ops,version}|{error}
}

// ---- helpers ----
const badId = (id: NodeId): { error: "BAD_ID"; detail: string } => ({ error: "BAD_ID", detail: id });
const solid = (color: string): Paint => ({ type: "SOLID", color });
type BBox = [number, number, number, number];

function bounds(nodes: Node[]): BBox {
  const xs = nodes.map((n) => n.bbox[0]);
  const ys = nodes.map((n) => n.bbox[1]);
  const xe = nodes.map((n) => n.bbox[0] + n.bbox[2]);
  const ye = nodes.map((n) => n.bbox[1] + n.bbox[3]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return [x, y, Math.max(...xe) - x, Math.max(...ye) - y];
}

// ---------- Create ----------
register({
  name: "createFrame",
  schema: {
    name: "createFrame",
    description:
      "Create a new FRAME (a container/section/card) inside an existing parent. Call this whenever the " +
      "design needs a new grouping box, e.g. a pricing card or a content section. The new frame's id is " +
      "returned in the ops so you can add children to it on the next turn.",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the parent frame to nest inside." },
        name: { type: "string", description: 'Human-readable name, e.g. "Pricing Card".' },
        bbox: {
          type: "array",
          items: { type: "number" },
          description: "[x,y,w,h] in canvas coords. Omit to default below the parent.",
        },
      },
      required: ["parent"],
    },
  },
  validate: (a, s) => (s.has(a.parent) ? null : badId(a.parent)),
  plan: (a, s) => {
    const p = s.getNode(a.parent)!;
    const bbox: BBox = a.bbox ?? [p.bbox[0], p.bbox[1] + p.bbox[3] + 24, 320, 360];
    const node: Node = {
      id: s.newId(),
      type: "FRAME",
      name: a.name ?? "Frame",
      bbox,
      parent: a.parent,
      children: [],
      layout: { mode: "NONE" },
      // White card WITH a light border + radius — a borderless white frame is
      // invisible on the white page (the "said done but nothing showed" bug).
      style: { fills: [solid("#FFFFFF")], stroke: { color: "#D1D5DB", weight: 1 }, cornerRadius: 12 },
    };
    return [{ kind: "add", node }];
  },
  label: (a) => `createFrame${a.name ? ` "${a.name}"` : ""}`,
});

register({
  name: "createText",
  schema: {
    name: "createText",
    description:
      "Create a TEXT node with the given characters inside a parent. Call this to add a heading, label, " +
      "price, or paragraph to the design.",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the parent frame." },
        chars: { type: "string", description: "The text content." },
        bbox: {
          type: "array",
          items: { type: "number" },
          description: "[x,y,w,h]. Omit to default near the top-left of the parent.",
        },
        fontSize: { type: "number", description: "Font size in px. Default 16." },
        fontWeight: { type: "number", description: "100–900. Default 400." },
        color: { type: "string", description: 'Hex color, e.g. "#111111". Default "#111111".' },
      },
      required: ["parent", "chars"],
    },
  },
  validate: (a, s) => (s.has(a.parent) ? null : badId(a.parent)),
  plan: (a, s) => {
    const p = s.getNode(a.parent)!;
    const fontSize = a.fontSize ?? 16;
    const bbox: BBox = a.bbox ?? [p.bbox[0] + 16, p.bbox[1] + 16, p.bbox[2] - 32, fontSize + 8];
    const node: Node = {
      id: s.newId(),
      type: "TEXT",
      name: (a.chars as string).slice(0, 24) || "Text",
      bbox,
      parent: a.parent,
      children: [],
      text: { chars: a.chars, fontSize, fontWeight: a.fontWeight ?? 400, align: "LEFT" },
      style: { fills: [solid(a.color ?? "#111111")] },
    };
    return [{ kind: "add", node }];
  },
  label: (a) => `createText "${String(a.chars).slice(0, 30)}"`,
});

register({
  name: "createShape",
  schema: {
    name: "createShape",
    description: "Create a RECT or ELLIPSE shape inside a parent (e.g. a button background or an avatar).",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the parent frame." },
        kind: { type: "string", enum: ["RECT", "ELLIPSE"], description: "Shape kind." },
        bbox: { type: "array", items: { type: "number" }, description: "[x,y,w,h]." },
        color: { type: "string", description: 'Fill hex. Default "#E5E7EB".' },
        cornerRadius: { type: "number", description: "Corner radius (RECT only)." },
      },
      required: ["parent", "kind", "bbox"],
    },
  },
  validate: (a, s) => (s.has(a.parent) ? null : badId(a.parent)),
  plan: (a, s) => {
    const node: Node = {
      id: s.newId(),
      type: a.kind,
      name: a.kind === "ELLIPSE" ? "Ellipse" : "Rect",
      bbox: a.bbox,
      parent: a.parent,
      children: [],
      style: { fills: [solid(a.color ?? "#E5E7EB")], cornerRadius: a.cornerRadius ?? 0 },
    };
    return [{ kind: "add", node }];
  },
  label: (a) => `createShape ${a.kind}`,
});

// ---------- Style ----------
register({
  name: "setFill",
  schema: {
    name: "setFill",
    description: "Set the solid fill color of one or more nodes. Call this to recolor shapes, frames, or text.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to recolor." },
        color: { type: "string", description: 'Hex color, e.g. "#4F46E5".' },
      },
      required: ["ids", "color"],
    },
  },
  validate: (a, s) => {
    for (const id of a.ids) if (!s.has(id)) return badId(id);
    return null;
  },
  plan: (a) => a.ids.map((id: NodeId) => ({ kind: "set", id, path: "style.fills", value: [solid(a.color)] })),
  label: (a) => `setFill ${a.ids.length} node(s) -> ${a.color}`,
});

register({
  name: "setTextStyle",
  schema: {
    name: "setTextStyle",
    description: "Update typography on TEXT nodes: font size, weight, alignment, and/or color.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "TEXT NodeIds." },
        fontSize: { type: "number" },
        fontWeight: { type: "number" },
        align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT"] },
        color: { type: "string", description: "Hex color." },
      },
      required: ["ids"],
    },
  },
  validate: (a, s) => {
    for (const id of a.ids) {
      if (!s.has(id)) return badId(id);
      if (s.getNode(id)!.type !== "TEXT")
        return { error: "CONSTRAINT", detail: `${id} is not a TEXT node` };
    }
    return null;
  },
  plan: (a, s) => {
    const ops: Op[] = [];
    for (const id of a.ids) {
      const t = { ...s.getNode(id)!.text! };
      if (a.fontSize != null) t.fontSize = a.fontSize;
      if (a.fontWeight != null) t.fontWeight = a.fontWeight;
      if (a.align != null) t.align = a.align;
      ops.push({ kind: "set", id, path: "text", value: t });
      if (a.color != null) ops.push({ kind: "set", id, path: "style.fills", value: [solid(a.color)] });
    }
    return ops;
  },
  label: (a) => `setTextStyle ${a.ids.length} node(s)`,
});

// ---------- Transform (semantic-first) ----------
register({
  name: "placeBelow",
  schema: {
    name: "placeBelow",
    description:
      "Stack one or more nodes directly below a target node, with even vertical spacing. Use this for " +
      "relative positioning instead of raw coordinates — it is robust to canvas changes.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to move, top-to-bottom order." },
        target: { type: "string", description: "NodeId to place the first node beneath." },
        gap: { type: "number", description: "Vertical gap in px. Default 16." },
      },
      required: ["ids", "target"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.target)) return badId(a.target);
    for (const id of a.ids) if (!s.has(id)) return badId(id);
    return null;
  },
  plan: (a, s) => {
    const gap = a.gap ?? 16;
    const t = s.getNode(a.target)!;
    let cursor = t.bbox[1] + t.bbox[3] + gap;
    const ops: Op[] = [];
    for (const id of a.ids) {
      const n = s.getNode(id)!;
      const nb: BBox = [t.bbox[0], cursor, n.bbox[2], n.bbox[3]];
      ops.push({ kind: "set", id, path: "bbox", value: nb });
      cursor += n.bbox[3] + gap;
    }
    return ops;
  },
  label: (a) => `placeBelow ${a.ids.length} under ${a.target}`,
});

register({
  name: "alignDistribute",
  schema: {
    name: "alignDistribute",
    description:
      "Align a set of nodes along a common edge or center within their shared bounding box. Use this to " +
      "make scattered elements look intentional (e.g. left-align a column, center a row).",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to align (2+)." },
        align: {
          type: "string",
          enum: ["LEFT", "RIGHT", "TOP", "BOTTOM", "CENTER_X", "CENTER_Y"],
          description: "Edge or center to align to.",
        },
      },
      required: ["ids", "align"],
    },
  },
  validate: (a, s) => {
    if (a.ids.length < 2) return { error: "CONSTRAINT", detail: "need 2+ nodes to align" };
    for (const id of a.ids) if (!s.has(id)) return badId(id);
    return null;
  },
  plan: (a, s) => {
    const nodes = a.ids.map((id: NodeId) => s.getNode(id)!);
    const [bx, by, bw, bh] = bounds(nodes);
    return nodes.map((n: Node) => {
      const nb: BBox = [...n.bbox];
      switch (a.align) {
        case "LEFT": nb[0] = bx; break;
        case "RIGHT": nb[0] = bx + bw - n.bbox[2]; break;
        case "CENTER_X": nb[0] = bx + (bw - n.bbox[2]) / 2; break;
        case "TOP": nb[1] = by; break;
        case "BOTTOM": nb[1] = by + bh - n.bbox[3]; break;
        case "CENTER_Y": nb[1] = by + (bh - n.bbox[3]) / 2; break;
      }
      return { kind: "set", id: n.id, path: "bbox", value: nb } as Op;
    });
  },
  label: (a) => `alignDistribute ${a.ids.length} -> ${a.align}`,
});

// ---------- Layout (the "it actually designs" lever) ----------
register({
  name: "applyAutoLayout",
  schema: {
    name: "applyAutoLayout",
    description:
      "Arrange a frame's direct children in a row (H) or column (V) with even spacing, re-flowing their " +
      "positions. Call this to make a section look designed instead of scattered — it replaces ~20 manual " +
      "position edits with one call.",
    input_schema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "NodeId of the frame to lay out." },
        dir: { type: "string", enum: ["H", "V"], description: "Row (H) or column (V)." },
        gap: { type: "number", description: "Pixels between children. Default 16." },
        padding: { type: "number", description: "Inner padding. Default 24." },
        align: { type: "string", enum: ["START", "CENTER", "END"], description: "Cross-axis alignment." },
      },
      required: ["frame", "dir"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.frame)) return badId(a.frame);
    return s.getNode(a.frame)!.children.length
      ? null
      : { error: "CONSTRAINT", detail: "frame has no children to lay out" };
  },
  plan: (a, s) => {
    const gap = a.gap ?? 16;
    const pad = a.padding ?? 24;
    const align = a.align ?? "START";
    const f = s.getNode(a.frame)!;
    const kids = f.children.map((id) => s.getNode(id)!);
    const ops: Op[] = [];
    let cursor = (a.dir === "V" ? f.bbox[1] : f.bbox[0]) + pad;
    for (const k of kids) {
      const nb: BBox = [...k.bbox];
      if (a.dir === "V") {
        nb[1] = cursor;
        nb[0] = crossPos(f, k, align, "x", pad);
        cursor += k.bbox[3] + gap;
      } else {
        nb[0] = cursor;
        nb[1] = crossPos(f, k, align, "y", pad);
        cursor += k.bbox[2] + gap;
      }
      ops.push({ kind: "set", id: k.id, path: "bbox", value: nb });
    }
    ops.push({
      kind: "set",
      id: f.id,
      path: "layout",
      value: { mode: a.dir === "V" ? "VERTICAL" : "HORIZONTAL", gap, padding: pad, align },
    });
    return ops;
  },
  label: (a) => `applyAutoLayout ${a.dir} gap=${a.gap ?? 16} on ${a.frame}`,
});

function crossPos(
  frame: Node,
  kid: Node,
  align: "START" | "CENTER" | "END",
  axis: "x" | "y",
  pad: number,
): number {
  const fi = axis === "x" ? 0 : 1;
  const sizeI = axis === "x" ? 2 : 3;
  const start = frame.bbox[fi] + pad;
  const inner = frame.bbox[sizeI] - pad * 2;
  if (align === "START") return start;
  if (align === "END") return start + inner - kid.bbox[sizeI];
  return start + (inner - kid.bbox[sizeI]) / 2; // CENTER
}
