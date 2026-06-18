// The mutation / tool layer: 8 semantic tools + boundary validation + diff-return.
// One registry entry per tool is the single source of truth. Mirrors §5.3.

import type Anthropic from "@anthropic-ai/sdk";
import type { DocVersion, Node, NodeId, Op, ToolResult } from "./types.js";
import { DocStore } from "./store.js";
import {
  type BBox,
  createFrameNode,
  createShapeNode,
  createTextNode,
  createVectorNode,
  solid,
  type VectorKind,
} from "./primitives.js";

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
  [...REGISTRY.values()]
    // NO_COMPOSE: drop the bulk tool to measure the old node-by-node baseline (probe A/B).
    .filter((d) => !(process.env.NO_COMPOSE && d.name === "composeSubtree"))
    .map((d) => d.schema)
    .sort((a, b) => a.name.localeCompare(b.name)); // byte-stable -> cacheable

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
const isObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === "object" && !Array.isArray(v);

/** Ops that shift `id` and its ENTIRE subtree by (dx,dy). A semantic move must carry
 *  the node's descendants — repositioning only the node leaves its children behind
 *  (the "auto-layout moved the cards but their titles stayed put" bug). Used by the
 *  semantic placement tools (placeBelow / alignDistribute / applyAutoLayout); NOT by
 *  setBBox/setBBoxes, where the client already emits one absolute bbox per dragged
 *  node and an auto-translate here would double-apply. */
function translateSubtree(s: DocStore, id: NodeId, dx: number, dy: number): Op[] {
  if (dx === 0 && dy === 0) return [];
  const ops: Op[] = [];
  const walk = (nid: NodeId) => {
    const n = s.getNode(nid);
    if (!n) return;
    const [x, y, w, h] = n.bbox;
    ops.push({ kind: "set", id: nid, path: "bbox", value: [x + dx, y + dy, w, h] });
    for (const c of n.children) walk(c);
  };
  walk(id);
  return ops;
}

function bounds(nodes: Node[]): BBox {
  const xs = nodes.map((n) => n.bbox[0]);
  const ys = nodes.map((n) => n.bbox[1]);
  const xe = nodes.map((n) => n.bbox[0] + n.bbox[2]);
  const ye = nodes.map((n) => n.bbox[1] + n.bbox[3]);
  const x = Math.min(...xs),
    y = Math.min(...ys);
  return [x, y, Math.max(...xe) - x, Math.max(...ye) - y];
}

// ---------- Bulk compose (the "build a whole section in ONE turn" lever) ----------
//
// The incremental create loop emits ~1 tool call per node and re-perceives between each,
// so a 6-card strip costs ~12 model turns and re-ships a fresh scene-graph + PNG every
// turn. For GENERATIVE building (a new section/screen/grid from a near-empty frame) that
// per-node round-trip buys almost nothing: there is nothing on canvas to perceive and
// verify only counts children. composeSubtree lets the model think ONCE and emit the whole
// nested subtree — frames, text, shapes, and per-frame auto-layout — in a single atomic
// commit. The model gives SIZES + a layout direction per frame; the tool resolves absolute
// coordinates (the same flow math as applyAutoLayout), so the model never hand-positions
// pixels. Coordinates are resolved here, deterministically, instead of over many turns.

type ComposeSpec = {
  type?: Node["type"];
  name?: string;
  w?: number;
  h?: number;
  x?: number; // offset within the parent's box; used only when the parent has no `layout`
  y?: number;
  fill?: string; // hex — FRAME/RECT/ELLIPSE fill
  cornerRadius?: number;
  stroke?: string; // hex border color, or "none"
  layout?: { dir?: "H" | "V"; gap?: number; padding?: number; align?: "START" | "CENTER" | "END" };
  chars?: string; // TEXT content
  fontSize?: number;
  fontWeight?: number;
  color?: string; // TEXT color
  textAlign?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
  children?: ComposeSpec[];
};

const VALID_COMPOSE_TYPES = new Set(["FRAME", "TEXT", "RECT", "ELLIPSE"]);

/** Default height for a node that omits `h`: text hugs its font; everything else gets a box. */
function defaultHeight(spec: ComposeSpec): number {
  if (spec.type === "TEXT") return (spec.fontSize ?? 16) + 8;
  return 80;
}

/** Cross-axis position of a child of `size` inside a track [start, start+extent]. */
function crossAxis(start: number, extent: number, size: number, align: string, pad: number): number {
  if (align === "CENTER") return start + (extent - size) / 2;
  if (align === "END") return start + extent - pad - size;
  return start + pad; // START
}

/** Materialize one spec node into a real Node with props baked in (no extra `set` ops). */
function makeComposeNode(spec: ComposeSpec, id: NodeId, parent: NodeId, bbox: BBox): Node {
  const type = spec.type ?? "FRAME";
  if (type === "TEXT") {
    const node = createTextNode({
      id,
      parent,
      chars: spec.chars ?? "",
      bbox,
      fontSize: spec.fontSize,
      fontWeight: spec.fontWeight,
      color: spec.color,
      name: spec.name,
    });
    if (spec.textAlign) node.text!.align = spec.textAlign;
    return node;
  }
  if (type === "RECT" || type === "ELLIPSE") {
    return createShapeNode({
      id,
      parent,
      kind: type,
      bbox,
      color: spec.fill ?? spec.color,
      cornerRadius: spec.cornerRadius,
      name: spec.name,
    });
  }
  // FRAME
  const node = createFrameNode({ id, parent, bbox, name: spec.name });
  if (spec.fill) node.style!.fills = [solid(spec.fill)];
  if (spec.cornerRadius != null) node.style!.cornerRadius = spec.cornerRadius;
  if (spec.stroke === "none") node.style!.stroke = { color: "#000000", weight: 0, style: "none" };
  else if (spec.stroke) node.style!.stroke = { color: spec.stroke, weight: 1, style: "solid" };
  if (spec.layout) {
    const dir = spec.layout.dir ?? "V";
    node.layout = {
      ...node.layout,
      mode: dir === "H" ? "HORIZONTAL" : "VERTICAL",
      gap: spec.layout.gap ?? 12,
      padding: spec.layout.padding ?? 16,
      align: spec.layout.align ?? "START",
    };
  }
  return node;
}

/** A spec node's well-formed object children (drops null/undefined/primitive entries the
 *  model occasionally emits — those would otherwise crash the recursive walkers). */
function specChildren(spec: ComposeSpec): ComposeSpec[] {
  if (!Array.isArray(spec.children)) return [];
  return spec.children.filter((c): c is ComposeSpec => c != null && typeof c === "object");
}

/** Recursively count nodes in a spec tree (for the activity label). */
function countComposeNodes(spec: ComposeSpec): number {
  if (spec == null || typeof spec !== "object") return 0;
  return 1 + specChildren(spec).reduce((n, c) => n + countComposeNodes(c), 0);
}

/** Reject a spec whose any node carries an unknown `type` (default FRAME is fine). */
function badComposeType(spec: ComposeSpec): string | null {
  if (spec == null || typeof spec !== "object") return null;
  if (spec.type && !VALID_COMPOSE_TYPES.has(spec.type)) return spec.type;
  for (const c of specChildren(spec)) {
    const bad = badComposeType(c);
    if (bad) return bad;
  }
  return null;
}

register({
  name: "composeSubtree",
  schema: {
    name: "composeSubtree",
    description:
      "Build a WHOLE nested subtree — a section, screen, card grid, list, or any multi-element unit — in " +
      "ONE call, instead of many createFrame/createText/createShape turns. Strongly prefer this whenever a " +
      "step needs more than ~2 new nodes (a row of cards, a multi-day list, a form, a header + body, a " +
      "tab bar): think through the entire composition once and emit it here.\n" +
      "Provide a nested `tree`. Each node has: type (FRAME|TEXT|RECT|ELLIPSE, default FRAME), name, and a " +
      "SIZE (w,h). You do NOT position nodes with coordinates — instead give a FRAME a `layout` " +
      "{dir:'H'|'V', gap, padding, align} and list its `children`; the tool flows them into place (same as " +
      "applyAutoLayout). Style as you go: FRAME/shape `fill` (hex), `cornerRadius`, `stroke` (hex or " +
      "'none'); TEXT `chars`, `fontSize`, `fontWeight`, `color`, `textAlign`. Fill containers with real " +
      "content — a card needs its title TEXT + supporting text/shapes, a list row its icon shape + label. " +
      "The whole tree commits atomically and every created id is returned in the ops.",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the existing frame to build the subtree inside." },
        tree: {
          type: "object",
          description:
            "Root node of the subtree to create. Shape (recursive): { type, name, w, h, fill, cornerRadius, " +
            "stroke, layout:{dir,gap,padding,align}, chars, fontSize, fontWeight, color, textAlign, children[] }. " +
            "A FRAME with a `layout` flows its `children`; give every node a sensible w and h.",
          properties: {
            type: { type: "string", enum: ["FRAME", "TEXT", "RECT", "ELLIPSE"] },
            name: { type: "string" },
            w: { type: "number", description: "Width in px." },
            h: { type: "number", description: "Height in px (TEXT may omit — hugs its font)." },
            x: { type: "number", description: "Offset x inside parent (only when parent has no layout)." },
            y: { type: "number", description: "Offset y inside parent (only when parent has no layout)." },
            fill: { type: "string", description: "Fill hex for FRAME/RECT/ELLIPSE." },
            cornerRadius: { type: "number" },
            stroke: { type: "string", description: "Border hex, or 'none'." },
            layout: {
              type: "object",
              description: "Auto-layout for THIS frame's children.",
              properties: {
                dir: { type: "string", enum: ["H", "V"] },
                gap: { type: "number" },
                padding: { type: "number" },
                align: { type: "string", enum: ["START", "CENTER", "END"] },
              },
            },
            chars: { type: "string", description: "TEXT content." },
            fontSize: { type: "number" },
            fontWeight: { type: "number" },
            color: { type: "string", description: "TEXT color hex." },
            textAlign: { type: "string", enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFY"] },
            children: {
              type: "array",
              description: "Child nodes, each with the SAME shape as this object (recursive).",
              items: { type: "object" },
            },
          },
          required: ["type"],
        },
      },
      required: ["parent", "tree"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.parent)) return badId(a.parent);
    if (!isObject(a.tree)) return { error: "CONSTRAINT", detail: "tree must be an object" };
    const bad = badComposeType(a.tree as ComposeSpec);
    if (bad) return { error: "CONSTRAINT", detail: `unknown node type "${bad}"` };
    return null;
  },
  plan: (a, s) => {
    const parent = s.getNode(a.parent)!;
    const root = a.tree as ComposeSpec;
    const ops: Op[] = [];

    const build = (spec: ComposeSpec, parentId: NodeId, x: number, y: number, w: number, h: number) => {
      const id = s.newId();
      ops.push({ kind: "add", node: makeComposeNode(spec, id, parentId, [x, y, w, h]) });
      const kids = specChildren(spec);
      if (!kids.length) return;
      const L = spec.layout;
      const pad = L?.padding ?? 16;
      const gap = L?.gap ?? 12;
      const align = L?.align ?? "START";
      const dir = L?.dir ?? "V";
      if (!L) {
        // No layout: stack children vertically, honoring any explicit per-child x/y.
        let cursor = y + pad;
        for (const k of kids) {
          const kw = k.w ?? w - pad * 2;
          const kh = k.h ?? defaultHeight(k);
          const kx = k.x != null ? x + k.x : x + pad;
          const ky = k.y != null ? y + k.y : cursor;
          if (k.y == null) cursor = ky + kh + gap;
          build(k, id, kx, ky, kw, kh);
        }
        return;
      }
      let cursor = (dir === "V" ? y : x) + pad;
      for (const k of kids) {
        const kh = k.h ?? defaultHeight(k);
        const kw = k.w ?? (dir === "V" ? w - pad * 2 : 120);
        let kx: number, ky: number;
        if (dir === "V") {
          ky = cursor;
          kx = crossAxis(x, w, kw, align, pad);
          cursor += kh + gap;
        } else {
          kx = cursor;
          ky = crossAxis(y, h, kh, align, pad);
          cursor += kw + gap;
        }
        build(k, id, kx, ky, kw, kh);
      }
    };

    const rw = root.w ?? 320;
    const rh = root.h ?? 360;
    // Root placement:
    //  - explicit x/y       -> honor it (offset within the parent).
    //  - empty parent       -> build INSIDE it, centered horizontally near the top. Building a
    //                          top-level screen into an empty page must land ON the page, not
    //                          "below" it (the createFrame default would put it off-canvas at
    //                          y = pageHeight+24, which then tempts a non-translating setBBox move).
    //  - otherwise (append) -> below the parent's existing content, like createFrame.
    const positioned = root.x != null || root.y != null;
    let rx: number, ry: number;
    if (positioned) {
      rx = parent.bbox[0] + (root.x ?? 0);
      ry = parent.bbox[1] + (root.y ?? 0);
    } else if (parent.children.length === 0) {
      rx = parent.bbox[0] + Math.max(0, (parent.bbox[2] - rw) / 2);
      ry = parent.bbox[1] + 24;
    } else {
      rx = parent.bbox[0];
      ry = parent.bbox[1] + parent.bbox[3] + 24;
    }
    build(root, a.parent, rx, ry, rw, rh);
    return ops;
  },
  label: (a) => `composeSubtree ${countComposeNodes(a.tree as ComposeSpec)} node(s)`,
});

// ---------- Create ----------
register({
  name: "createFrame",
  schema: {
    name: "createFrame",
    description:
      "Create a new FRAME (a container/section/card) inside an existing parent. Call this whenever the " +
      "design needs a new grouping box, e.g. a pricing card, translucent panel, mobile screen, modal, " +
      "content section, toolbar, or list row. New frames have a visible polished default fill, border, " +
      "and corner radius, but you should still override fills/radius/strokes when the prompt names a " +
      "style or platform. The new frame's id is returned in the ops so you can add children to it on the next turn.",
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
    const node = createFrameNode({
      id: s.newId(),
      name: a.name,
      bbox,
      parent: a.parent,
    });
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
    const node = createTextNode({
      id: s.newId(),
      chars: a.chars,
      bbox,
      parent: a.parent,
      fontSize,
      fontWeight: a.fontWeight,
      color: a.color,
    });
    return [{ kind: "add", node }];
  },
  label: (a) => `createText "${String(a.chars).slice(0, 30)}"`,
});

register({
  name: "createShape",
  schema: {
    name: "createShape",
    description:
      "Create a RECT or ELLIPSE shape inside a parent. Use these for visible UI details and icon-like " +
      "marks: button backgrounds, toggles, dividers, avatar circles, weather symbols, chart bars, status " +
      "dots, handles, separators, and decorative accents that make a design feel complete.",
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
    const node = createShapeNode({
      id: s.newId(),
      kind: a.kind,
      bbox: a.bbox,
      parent: a.parent,
      color: a.color,
      cornerRadius: a.cornerRadius,
    });
    return [{ kind: "add", node }];
  },
  label: (a) => `createShape ${a.kind}`,
});

register({
  name: "createVector",
  schema: {
    name: "createVector",
    description: "Create a VECTOR line, arrow, or freehand draw stroke inside a parent.",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the parent frame." },
        kind: { type: "string", enum: ["line", "arrow", "draw"], description: "Vector primitive kind." },
        bbox: { type: "array", items: { type: "number" }, description: "[x,y,w,h]." },
        points: {
          type: "array",
          description: "Local points inside bbox, each [x,y].",
          items: { type: "array", items: { type: "number" } },
        },
        stroke: { type: "string", description: 'Stroke hex. Default "#8A8378".' },
        strokeWidth: { type: "number", description: "Stroke width in px. Default 4." },
        fill: { type: "string", description: 'Fill color or "none". Default "none".' },
      },
      required: ["parent", "kind", "bbox"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.parent)) return badId(a.parent);
    if (!["line", "arrow", "draw"].includes(a.kind)) return { error: "CONSTRAINT", detail: "bad vector kind" };
    if (!Array.isArray(a.bbox) || a.bbox.length !== 4) return { error: "CONSTRAINT", detail: "bbox must be [x,y,w,h]" };
    return null;
  },
  plan: (a, s) => {
    const node = createVectorNode({
      id: s.newId(),
      kind: a.kind as VectorKind,
      bbox: a.bbox,
      parent: a.parent,
      points: a.points,
      stroke: a.stroke,
      strokeWidth: a.strokeWidth,
      fill: a.fill,
    });
    return [{ kind: "add", node }];
  },
  label: (a) => `createVector ${a.kind}`,
});

const ALLOWED_SET_PROP_PATHS = new Set([
  "bbox",
  "name",
  "style.fills",
  "style.opacity",
  "style.cornerRadius",
  "style.cornerRadiusUnit",
  "style.stroke",
  "style.overflow",
  "style.zIndex",
  "style.boxShadow",
  "style.textShadow",
  "style.transform",
  "style.filter",
  "text.chars",
  "text.fontFamily",
  "text.fontSize",
  "text.fontWeight",
  "text.fontStyle",
  "text.textDecoration",
  "text.align",
  "text.lineHeight",
  "text.color",
  "text.textTransform",
  "text.letterSpacingEm",
  "layout.display",
  "layout.mode",
  "layout.gap",
  "layout.padding",
  "layout.paddingSides",
  "layout.marginSides",
  "layout.align",
  "layout.wrap",
  "layout.grow",
  "layout.alignSelf",
  "layout.widthMode",
  "layout.heightMode",
  "layout.minWidth",
  "layout.maxWidth",
  "layout.minHeight",
  "layout.maxHeight",
  "layout.positionMode",
  "layout.inset",
  "vector.stroke",
  "vector.strokeWidth",
  "vector.fill",
  "vector.linecap",
  "vector.linejoin",
  "vector.scaling",
  "vector.points",
]);

register({
  name: "setProps",
  schema: {
    name: "setProps",
    description:
      "Patch canonical node properties by dotted path. Use for inspector-style edits such as stroke, opacity, radius, typography, layout, bbox, or vector style.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId to edit." },
        patch: {
          type: "object",
          description: "Map of allowed dotted paths to values, e.g. {\"style.opacity\":0.5}.",
        },
      },
      required: ["id", "patch"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.id)) return badId(a.id);
    if (!isObject(a.patch)) return { error: "CONSTRAINT", detail: "patch must be an object" };
    for (const path of Object.keys(a.patch)) {
      if (!ALLOWED_SET_PROP_PATHS.has(path))
        return { error: "CONSTRAINT", detail: `setProps path not allowed: ${path}` };
      if (path.startsWith("text.") && s.getNode(a.id)!.type !== "TEXT")
        return { error: "CONSTRAINT", detail: `${a.id} is not a TEXT node` };
      if (path.startsWith("vector.") && s.getNode(a.id)!.type !== "VECTOR")
        return { error: "CONSTRAINT", detail: `${a.id} is not a VECTOR node` };
    }
    return null;
  },
  plan: (a) =>
    Object.entries(a.patch).map(([path, value]) => ({ kind: "set", id: a.id as NodeId, path, value })),
  label: (a) => `setProps ${a.id}`,
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
        align: { type: "string", enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFY"] },
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
      // translate (move), carrying the subtree — never resize, never orphan children
      ops.push(...translateSubtree(s, id, t.bbox[0] - n.bbox[0], cursor - n.bbox[1]));
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
    const ops: Op[] = [];
    for (const n of nodes) {
      let dx = 0,
        dy = 0;
      switch (a.align) {
        case "LEFT": dx = bx - n.bbox[0]; break;
        case "RIGHT": dx = bx + bw - n.bbox[2] - n.bbox[0]; break;
        case "CENTER_X": dx = bx + (bw - n.bbox[2]) / 2 - n.bbox[0]; break;
        case "TOP": dy = by - n.bbox[1]; break;
        case "BOTTOM": dy = by + bh - n.bbox[3] - n.bbox[1]; break;
        case "CENTER_Y": dy = by + (bh - n.bbox[3]) / 2 - n.bbox[1]; break;
      }
      // move the whole subtree so children stay locked to their parent
      ops.push(...translateSubtree(s, n.id, dx, dy));
    }
    return ops;
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
      let nx = k.bbox[0],
        ny = k.bbox[1];
      if (a.dir === "V") {
        ny = cursor;
        nx = crossPos(f, k, align, "x", pad);
        cursor += k.bbox[3] + gap;
      } else {
        nx = cursor;
        ny = crossPos(f, k, align, "y", pad);
        cursor += k.bbox[2] + gap;
      }
      // re-flow each child by translating its whole subtree (carry grandchildren)
      ops.push(...translateSubtree(s, k.id, nx - k.bbox[0], ny - k.bbox[1]));
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

// ---------- Direct manipulation (client-driven edits) ----------
register({
  name: "setBBox",
  schema: {
    name: "setBBox",
    description:
      "Set the absolute position and size of a single node to [x,y,w,h] in canvas coords. Use this for a " +
      "direct move or resize when you already know the exact target rectangle. For multi-node drags the " +
      "client emits one call per node.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId to move/resize." },
        bbox: {
          type: "array",
          items: { type: "number" },
          description: "[x,y,w,h] in canvas coords — the new absolute rectangle.",
        },
      },
      required: ["id", "bbox"],
    },
  },
  validate: (a, s) => (s.has(a.id) ? null : badId(a.id)),
  plan: (a) => [{ kind: "set", id: a.id, path: "bbox", value: a.bbox }],
  label: (a) => `setBBox ${a.id}`,
});

register({
  name: "setBBoxes",
  schema: {
    name: "setBBoxes",
    description:
      "Set absolute bbox for MULTIPLE nodes in one atomic commit — use for multi-node drag-move so all " +
      "nodes move under one version. Each item is { id, bbox:[x,y,w,h] } in canvas coords.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Nodes to move, each as { id, bbox } where bbox is [x,y,w,h].",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "NodeId to move/resize." },
              bbox: {
                type: "array",
                items: { type: "number" },
                description: "[x,y,w,h] in canvas coords — the new absolute rectangle.",
              },
            },
            required: ["id", "bbox"],
          },
        },
      },
      required: ["items"],
    },
  },
  validate: (a, s) => {
    for (const it of a.items) if (!s.has(it.id)) return badId(it.id);
    return null;
  },
  plan: (a) =>
    a.items.map((it: { id: NodeId; bbox: BBox }) => ({ kind: "set", id: it.id, path: "bbox", value: it.bbox })),
  label: (a) => `setBBoxes ${a.items.length} node(s)`,
});

register({
  name: "deleteNodes",
  schema: {
    name: "deleteNodes",
    description:
      "Delete one or more nodes and their entire subtrees. Call this to remove elements from the design. " +
      "The page root can never be deleted.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to delete." },
      },
      required: ["ids"],
    },
  },
  validate: (a, s) => {
    for (const id of a.ids) {
      if (!s.has(id)) return badId(id);
      if (id === s.rootId) return { error: "CONSTRAINT", detail: `cannot delete the page root ${id}` };
    }
    return null;
  },
  plan: (a) => a.ids.map((id: NodeId) => ({ kind: "remove", id })),
  label: (a) => `deleteNodes ${a.ids.length} node(s)`,
});

register({
  name: "reparentNodes",
  schema: {
    name: "reparentNodes",
    description:
      "Move a node to a new parent frame, inserting it at the given index (appended to the end by " +
      "default). Use this to nest an element inside a different container. A node can never be reparented " +
      "into itself or one of its own descendants.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId to move." },
        parent: { type: "string", description: "NodeId of the new parent frame." },
        index: { type: "number", description: "Child index to insert at. Omit to append." },
      },
      required: ["id", "parent"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.id)) return badId(a.id);
    if (!s.has(a.parent)) return badId(a.parent);
    if (a.parent === a.id) return { error: "CONSTRAINT", detail: "cannot reparent a node into itself" };
    // Reparenting into the CURRENT parent would compute an off-by-one default index
    // (store removes then splices), so reject it as a no-op.
    if (a.parent === s.getNode(a.id)!.parent)
      return { error: "CONSTRAINT", detail: `${a.id} is already a child of ${a.parent}` };
    // cycle guard: reparenting into a descendant of id would corrupt the tree.
    if (isDescendant(s, a.id, a.parent))
      return { error: "CONSTRAINT", detail: `${a.parent} is a descendant of ${a.id}` };
    return null;
  },
  plan: (a, s) => {
    const p = s.getNode(a.parent)!;
    const index = a.index ?? p.children.length;
    return [{ kind: "reparent", id: a.id, parent: a.parent, index }];
  },
  label: (a) => `reparentNodes ${a.id} -> ${a.parent}`,
});

register({
  name: "setText",
  schema: {
    name: "setText",
    description: "Replace the text content (characters) of a TEXT node. Call this to edit a label, heading, or paragraph.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId of the TEXT node." },
        chars: { type: "string", description: "The new text content." },
      },
      required: ["id", "chars"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.id)) return badId(a.id);
    if (s.getNode(a.id)!.type !== "TEXT")
      return { error: "CONSTRAINT", detail: `${a.id} is not a TEXT node` };
    return null;
  },
  plan: (a) => [{ kind: "set", id: a.id, path: "text.chars", value: a.chars }],
  label: (a) => `setText ${a.id}`,
});

/** True if `maybe` is `id` itself or anywhere in id's subtree (walk children). */
function isDescendant(s: DocStore, id: NodeId, maybe: NodeId): boolean {
  const n = s.getNode(id);
  if (!n) return false;
  for (const c of n.children) {
    if (c === maybe || isDescendant(s, c, maybe)) return true;
  }
  return false;
}

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
