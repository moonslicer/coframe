// The mutation / tool layer: 8 semantic tools + boundary validation + diff-return.
// One registry entry per tool is the single source of truth. Mirrors §5.3.

import type Anthropic from "@anthropic-ai/sdk";
import type {
  DocVersion,
  InputKind,
  InputSpec,
  LayoutStyle,
  Node,
  NodeId,
  Op,
  SizeMode,
  ToolResult,
} from "./types.js";
import { DocStore } from "./store.js";
import {
  type BBox,
  createFrameNode,
  createIconNode,
  createInputNode,
  createShapeNode,
  createTextNode,
  createVectorNode,
  defaultInputSize,
  gradientPaint,
  imagePaint,
  normalizeShadow,
  solid,
  type VectorKind,
} from "./primitives.js";
import { getIcon, ICON_NAMES } from "./icons.js";

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

type LayoutDir = "H" | "V";

const SIZE_MODE_VALUES = new Set<SizeMode>(["hug", "fixed", "fill"]);
const ALIGN_SELF_VALUES = new Set<NonNullable<LayoutStyle["alignSelf"]>>([
  "auto",
  "stretch",
  "flex-start",
  "center",
  "flex-end",
]);

function autoLayoutDir(frame: Node): LayoutDir | null {
  if (frame.layout?.mode === "HORIZONTAL") return "H";
  if (frame.layout?.mode === "VERTICAL") return "V";
  return null;
}

function isLayoutContainer(frame: Node | undefined): frame is Node {
  return !!frame && (frame.type === "FRAME" || frame.type === "GROUP") && autoLayoutDir(frame) != null;
}

function axisIndexes(vertical: boolean) {
  return {
    mainPosI: vertical ? 1 : 0,
    mainSizeI: vertical ? 3 : 2,
    crossPosI: vertical ? 0 : 1,
    crossSizeI: vertical ? 2 : 3,
  } as const;
}

function clampSize(value: number, min?: number, max?: number): number {
  let next = Math.max(MIN_DIMENSION, value);
  if (min != null && Number.isFinite(min)) next = Math.max(next, min);
  if (max != null && Number.isFinite(max)) next = Math.min(next, Math.max(MIN_DIMENSION, max));
  return next;
}

const MIN_DIMENSION = 4;

function minFor(layout: LayoutStyle | undefined, vertical: boolean, axis: "main" | "cross"): number | undefined {
  if (axis === "main") return vertical ? layout?.minHeight : layout?.minWidth;
  return vertical ? layout?.minWidth : layout?.minHeight;
}

function maxFor(layout: LayoutStyle | undefined, vertical: boolean, axis: "main" | "cross"): number | undefined {
  if (axis === "main") return vertical ? layout?.maxHeight : layout?.maxWidth;
  return vertical ? layout?.maxWidth : layout?.maxHeight;
}

function sizeModeFor(layout: LayoutStyle | undefined, vertical: boolean, axis: "main" | "cross"): SizeMode | undefined {
  if (axis === "main") return vertical ? layout?.heightMode : layout?.widthMode;
  return vertical ? layout?.widthMode : layout?.heightMode;
}

function childAlign(parentAlign: LayoutStyle["align"], alignSelf: LayoutStyle["alignSelf"]): "START" | "CENTER" | "END" {
  if (alignSelf === "center") return "CENTER";
  if (alignSelf === "flex-end") return "END";
  if (alignSelf === "flex-start") return "START";
  return parentAlign ?? "START";
}

function withLayoutOverride(node: Node, overrides?: Map<NodeId, LayoutStyle>): LayoutStyle | undefined {
  return overrides?.get(node.id) ?? node.layout;
}

/** Move a node and its subtree by dx/dy while only the node itself receives the new size. */
function placeSubtree(s: DocStore, id: NodeId, bbox: BBox): Op[] {
  const root = s.getNode(id);
  if (!root) return [];
  const dx = bbox[0] - root.bbox[0];
  const dy = bbox[1] - root.bbox[1];
  const ops: Op[] = [];
  const walk = (nid: NodeId) => {
    const n = s.getNode(nid);
    if (!n) return;
    if (nid === id) {
      ops.push({ kind: "set", id: nid, path: "bbox", value: bbox });
    } else {
      const [x, y, w, h] = n.bbox;
      ops.push({ kind: "set", id: nid, path: "bbox", value: [x + dx, y + dy, w, h] });
    }
    for (const c of n.children) walk(c);
  };
  walk(id);
  return ops;
}

function layoutChildrenOps(
  s: DocStore,
  frame: Node,
  childIds: NodeId[],
  layout: LayoutStyle,
  childLayoutOverrides?: Map<NodeId, LayoutStyle>,
): Op[] {
  const dir = layout.mode === "HORIZONTAL" ? "H" : layout.mode === "VERTICAL" ? "V" : null;
  if (!dir) return [];

  const gap = layout.gap ?? 16;
  const pad = layout.padding ?? 24;
  const align = layout.align ?? "START";
  const justify = layout.justify ?? "START";
  const vertical = dir === "V";
  const { mainPosI, mainSizeI, crossPosI, crossSizeI } = axisIndexes(vertical);
  const kids = childIds.map((id) => s.getNode(id)).filter((n): n is Node => !!n);
  const n = kids.length;
  const innerMain = frame.bbox[mainSizeI] - pad * 2;
  const innerCross = frame.bbox[crossSizeI] - pad * 2;
  const start = frame.bbox[mainPosI] + pad;
  const crossStart = frame.bbox[crossPosI] + pad;

  const mainSizes = kids.map((kid) => {
    const L = withLayoutOverride(kid, childLayoutOverrides);
    return clampSize(kid.bbox[mainSizeI], minFor(L, vertical, "main"), maxFor(L, vertical, "main"));
  });
  const mainFill = kids.map((kid) => {
    const L = withLayoutOverride(kid, childLayoutOverrides);
    return sizeModeFor(L, vertical, "main") === "fill" || (L?.grow ?? 0) > 0;
  });
  const fillIndexes = mainFill.map((yes, i) => (yes ? i : -1)).filter((i) => i >= 0);

  if (fillIndexes.length) {
    const fixedTotal = mainSizes.reduce((acc, size, i) => acc + (mainFill[i] ? 0 : size), 0);
    const available = innerMain - gap * Math.max(0, n - 1) - fixedTotal;
    const weights = fillIndexes.map((i) => Math.max(0, withLayoutOverride(kids[i], childLayoutOverrides)?.grow ?? 0) || 1);
    const totalWeight = weights.reduce((acc, w) => acc + w, 0) || fillIndexes.length;
    fillIndexes.forEach((kidIndex, weightIndex) => {
      const L = withLayoutOverride(kids[kidIndex], childLayoutOverrides);
      const raw = available > 0 ? (available * weights[weightIndex]) / totalWeight : MIN_DIMENSION;
      mainSizes[kidIndex] = clampSize(raw, minFor(L, vertical, "main"), maxFor(L, vertical, "main"));
    });
  }

  const sumMain = mainSizes.reduce((acc, size) => acc + size, 0);
  let cursor: number;
  let step = gap;
  if (fillIndexes.length) {
    cursor = start;
  } else if (justify === "SPACE_BETWEEN" && n > 1) {
    step = (innerMain - sumMain) / (n - 1);
    cursor = start;
  } else if (justify === "SPACE_AROUND" && n > 0) {
    const around = (innerMain - sumMain) / n;
    step = around;
    cursor = start + around / 2;
  } else if (justify === "CENTER") {
    const total = sumMain + gap * Math.max(0, n - 1);
    cursor = start + Math.max(0, (innerMain - total) / 2);
  } else if (justify === "END") {
    const total = sumMain + gap * Math.max(0, n - 1);
    cursor = start + Math.max(0, innerMain - total);
  } else {
    cursor = start;
  }

  const ops: Op[] = [];
  kids.forEach((kid, i) => {
    const L = withLayoutOverride(kid, childLayoutOverrides);
    const crossFill = sizeModeFor(L, vertical, "cross") === "fill" || L?.alignSelf === "stretch";
    const crossSize = crossFill
      ? clampSize(innerCross, minFor(L, vertical, "cross"), maxFor(L, vertical, "cross"))
      : clampSize(kid.bbox[crossSizeI], minFor(L, vertical, "cross"), maxFor(L, vertical, "cross"));
    const alignForKid = childAlign(align, L?.alignSelf);
    const cross =
      crossFill || alignForKid === "START"
        ? crossStart
        : alignForKid === "END"
          ? crossStart + innerCross - crossSize
          : crossStart + (innerCross - crossSize) / 2;

    const next: BBox = vertical
      ? [cross, cursor, crossSize, mainSizes[i]]
      : [cursor, cross, mainSizes[i], crossSize];
    ops.push(...placeSubtree(s, kid.id, next));
    cursor += mainSizes[i] + step;
  });

  ops.push({
    kind: "set",
    id: frame.id,
    path: "layout",
    value: {
      ...(frame.layout ?? { mode: "NONE" as const }),
      ...layout,
      mode: vertical ? "VERTICAL" : "HORIZONTAL",
      gap,
      padding: pad,
      align,
      justify,
    },
  });
  return ops;
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
  gradient?: { from: string; to: string; via?: string; angle?: number; radial?: boolean }; // overrides fill
  image?: string; // image src (data: URI or URL) — fills FRAME/RECT/ELLIPSE
  imageFit?: "cover" | "contain" | "fill";
  shadow?: { x?: number; y?: number; blur?: number; color?: string } | boolean; // drop shadow / elevation
  blur?: number; // gaussian blur on the node
  cornerRadius?: number;
  stroke?: string; // hex border color, or "none"
  layout?: { dir?: "H" | "V"; gap?: number; padding?: number; align?: "START" | "CENTER" | "END" };
  chars?: string; // TEXT content
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  color?: string; // TEXT color
  textAlign?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
  icon?: string; // icon name — makes this node an icon glyph (see ICON_NAMES)
  input?: ComposeInput; // makes this node a stateful form control bound to a variable
  screen?: boolean; // mark this FRAME a navigable screen (only meaningful on the root spec)
  children?: ComposeSpec[];
};

// An input control inside a composed subtree (a field bound to a {{variable}}).
type ComposeInput = {
  field: string;
  kind?: InputKind; // default "text"
  placeholder?: string;
  required?: boolean;
  options?: string[];
  defaultValue?: string;
  label?: string;
};

const INPUT_KINDS: InputKind[] = [
  "text",
  "email",
  "password",
  "number",
  "textarea",
  "select",
  "checkbox",
  "switch",
];

/** Normalize a loose input spec from the model into a canonical InputSpec. */
function toInputSpec(raw: ComposeInput): InputSpec {
  const kind = raw.kind && INPUT_KINDS.includes(raw.kind) ? raw.kind : "text";
  return {
    field: String(raw.field),
    kind,
    ...(raw.placeholder != null ? { placeholder: raw.placeholder } : {}),
    ...(raw.required != null ? { required: !!raw.required } : {}),
    ...(Array.isArray(raw.options) ? { options: raw.options.map(String) } : {}),
    ...(raw.defaultValue != null ? { defaultValue: String(raw.defaultValue) } : {}),
    ...(raw.label != null ? { label: raw.label } : {}),
  };
}

const VALID_COMPOSE_TYPES = new Set(["FRAME", "TEXT", "RECT", "ELLIPSE", "VECTOR"]);

// Gutter between side-by-side screens on the canvas filmstrip.
const SCREEN_GUTTER = 80;
// Default screen size when the model omits one — a phone-ish portrait artboard.
const DEFAULT_SCREEN: [number, number] = [390, 844];

/** Top-left origin for the NEXT screen: to the right of every existing screen (top-aligned),
 *  or just inside the root when this is the first one. Keeps generated screens in a tidy,
 *  left-to-right flow the Play mode and the human both read as a sequence. */
function nextScreenOrigin(store: DocStore, w: number, h: number): BBox {
  const root = store.getNode(store.rootId);
  const screens = (root?.children ?? [])
    .map((id) => store.getNode(id))
    .filter((n): n is Node => !!n && !!n.screen);
  if (!screens.length) {
    const r = root?.bbox ?? [0, 0, 0, 0];
    return [r[0] + 40, r[1] + 40, w, h];
  }
  const maxRight = Math.max(...screens.map((n) => n.bbox[0] + n.bbox[2]));
  const top = Math.min(...screens.map((n) => n.bbox[1]));
  return [maxRight + SCREEN_GUTTER, top, w, h];
}

/** Apply the shared decorative fields (gradient/image override fill; shadow; blur) onto a
 *  node's style. Used by both composeSubtree node-building and as the source of truth for
 *  what the rich-style fields mean. */
function applyDecor(node: Node, spec: ComposeSpec): void {
  node.style = node.style ?? {};
  if (spec.gradient) {
    const colors = [spec.gradient.from, spec.gradient.via, spec.gradient.to].filter(
      (c): c is string => typeof c === "string",
    );
    if (colors.length >= 2)
      node.style.fills = [
        gradientPaint(colors, {
          gradient: spec.gradient.radial ? "radial" : "linear",
          angle: spec.gradient.angle,
        }),
      ];
  } else if (spec.image) {
    node.style.fills = [imagePaint(spec.image, spec.imageFit)];
  }
  if (spec.shadow) node.style.shadow = normalizeShadow(spec.shadow === true ? true : spec.shadow);
  if (spec.blur != null) node.style.blur = spec.blur;
}

/** Default height for a node that omits `h`: text hugs its font; everything else gets a box. */
function defaultHeight(spec: ComposeSpec): number {
  if (spec.type === "TEXT") return (spec.fontSize ?? 16) + 8;
  if (spec.input) return defaultInputSize(toInputSpec(spec.input).kind)[1];
  if (spec.icon) return 24;
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
  // An `icon` makes the node an icon glyph regardless of declared type (falls through to a
  // styled frame if the icon name is unknown, so the build never silently drops the node).
  if (spec.icon) {
    const iconNode = createIconNode({
      id,
      parent,
      icon: spec.icon,
      bbox,
      stroke: spec.stroke && spec.stroke !== "none" ? spec.stroke : spec.color,
      fill: spec.fill,
      name: spec.name,
    });
    if (iconNode) return iconNode;
  }
  // An `input` makes the node a stateful form control regardless of declared type.
  if (spec.input && spec.input.field) {
    return createInputNode({ id, parent, input: toInputSpec(spec.input), bbox, name: spec.name });
  }
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
    if (spec.fontFamily) node.text!.fontFamily = spec.fontFamily;
    applyDecor(node, spec);
    return node;
  }
  if (type === "RECT" || type === "ELLIPSE") {
    const node = createShapeNode({
      id,
      parent,
      kind: type,
      bbox,
      color: spec.fill ?? spec.color,
      cornerRadius: spec.cornerRadius,
      name: spec.name,
    });
    if (spec.stroke === "none") node.style!.stroke = { color: "#000000", weight: 0, style: "none" };
    else if (spec.stroke) node.style!.stroke = { color: spec.stroke, weight: 1, style: "solid" };
    applyDecor(node, spec);
    return node;
  }
  // FRAME
  const node = createFrameNode({ id, parent, bbox, name: spec.name });
  if (spec.screen) node.screen = true;
  if (spec.fill) node.style!.fills = [solid(spec.fill)];
  if (spec.cornerRadius != null) node.style!.cornerRadius = spec.cornerRadius;
  if (spec.stroke === "none") node.style!.stroke = { color: "#000000", weight: 0, style: "none" };
  else if (spec.stroke) node.style!.stroke = { color: spec.stroke, weight: 1, style: "solid" };
  applyDecor(node, spec);
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
      "applyAutoLayout). Style as you go for a polished, non-wireframe result: FRAME/shape `fill` (hex), " +
      "`cornerRadius`, `stroke` (hex or 'none'); TEXT `chars`, `fontSize`, `fontWeight`, `color`, " +
      "`textAlign`, `fontFamily`. RICH STYLE (use these for depth and realism — flat solid fills read as a " +
      "wireframe): `gradient` {from,to,via?,angle?,radial?} for headers/buttons/backgrounds; `image` (a " +
      "data: URI or URL) to fill a photo/avatar area; `shadow` {y,blur,color} or true for card elevation; " +
      "`blur` for frosted panels; `icon` (a name like 'heart','comment','share','bookmark','home','search'," +
      "'user','settings','bell','star','play','plus','more','menu') for real glyphs instead of placeholder " +
      "squares. Fill containers with real content — a card needs its title TEXT + supporting text/shapes, a " +
      "list row its icon + label, an action bar its icons. For FORMS (sign-up, login, checkout, settings), " +
      "give a node an `input` {field, kind, placeholder, required} to make it a real typeable control bound to " +
      "a VARIABLE — its value persists across screens and is shown anywhere by putting {{field}} in a TEXT " +
      "node's chars (e.g. a confirmation screen reading 'Welcome, {{name}}!'). The whole tree commits " +
      "atomically and every created id is returned in the ops.",
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
            type: { type: "string", enum: ["FRAME", "TEXT", "RECT", "ELLIPSE", "VECTOR"] },
            name: { type: "string" },
            w: { type: "number", description: "Width in px." },
            h: { type: "number", description: "Height in px (TEXT may omit — hugs its font)." },
            x: { type: "number", description: "Offset x inside parent (only when parent has no layout)." },
            y: { type: "number", description: "Offset y inside parent (only when parent has no layout)." },
            fill: { type: "string", description: "Fill hex for FRAME/RECT/ELLIPSE." },
            gradient: {
              type: "object",
              description: "Gradient fill (overrides `fill`). angle is CSS deg (0=up,180=down,90=right).",
              properties: {
                from: { type: "string", description: "Start color hex." },
                to: { type: "string", description: "End color hex." },
                via: { type: "string", description: "Optional middle color hex." },
                angle: { type: "number" },
                radial: { type: "boolean", description: "Radial instead of linear." },
              },
            },
            image: { type: "string", description: "Image src (data: URI or URL) — fills the node as a photo." },
            imageFit: { type: "string", enum: ["cover", "contain", "fill"] },
            shadow: {
              type: "object",
              description: "Drop shadow for elevation. {y, blur, color} — or omit fields for a soft default.",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                blur: { type: "number" },
                color: { type: "string", description: "e.g. 'rgba(0,0,0,0.2)'." },
              },
            },
            blur: { type: "number", description: "Gaussian blur radius (px) — for frosted/glass panels." },
            cornerRadius: { type: "number" },
            stroke: { type: "string", description: "Border hex, or 'none'." },
            fontFamily: { type: "string", description: "TEXT font family." },
            icon: {
              type: "string",
              description: "Icon glyph name (e.g. heart, comment, share, bookmark, home, user). Makes this node an icon.",
            },
            input: {
              type: "object",
              description:
                "Makes this node a real, typeable FORM CONTROL bound to a variable. `field` is the variable " +
                "name; its typed value persists across screens and is shown anywhere by writing {{field}} in a " +
                "TEXT node's chars (e.g. a summary screen with chars 'Welcome, {{name}}!'). Give the field a " +
                "decent width (w ~240-320). Use for sign-up/checkout/settings forms. Add a separate label TEXT " +
                "above it if you want a caption (checkbox/switch use the `label` field instead).",
              properties: {
                field: { type: "string", description: "Variable name, e.g. 'email', 'name', 'password'." },
                kind: {
                  type: "string",
                  enum: INPUT_KINDS,
                  description: "Control type. Default 'text'. Use email/password for credentials, select for a choice list.",
                },
                placeholder: { type: "string", description: "Empty-state hint for text-like fields." },
                required: { type: "boolean", description: "Block a 'navigate' click until this field is filled." },
                options: { type: "array", items: { type: "string" }, description: "Choices for kind:'select'." },
                defaultValue: { type: "string", description: "Initial value ('true'/'false' for checkbox/switch)." },
                label: { type: "string", description: "Caption beside a checkbox/switch." },
              },
            },
            screen: {
              type: "boolean",
              description:
                "Set true ONLY on the ROOT node when building a navigable SCREEN of a multi-screen " +
                "prototype (a page the user can navigate to). Pass parent = the page root; the tool places " +
                "the screen to the RIGHT of existing screens as a filmstrip. Defaults to a 390×844 phone " +
                "artboard when w/h are omitted. Later, wire navigation to it with setInteraction(navigate).",
            },
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

    // Two-phase layout. WIDTH is fixed (flows top-down from the parent / declared size);
    // HEIGHT hugs content (flows bottom-up). This is what keeps a subtree inside its frame:
    // a horizontal row whose children would overflow the fixed width is SHRUNK to fit (no
    // off-frame spill), and every frame grows tall enough to contain its real content (so
    // siblings advance past it instead of overlapping). The model's `h` is only a floor —
    // it can't predict the resolved height of a nested auto-layout subtree, so the tool
    // resolves it here, the same way it already resolves position.
    type Measured = { w: number; h: number; kids: Measured[] };

    const measure = (spec: ComposeSpec, w: number, declaredH: number): Measured => {
      const kids = specChildren(spec);
      if (!kids.length) return { w, h: declaredH, kids: [] };
      const L = spec.layout;
      const pad = L?.padding ?? 16;
      const gap = L?.gap ?? 12;
      const horizontal = L?.dir === "H";

      if (!horizontal) {
        // Vertical stack (explicit V, or no-layout default). Children fill the width; the
        // frame's height hugs the stack (honoring any explicit per-child y in no-layout).
        let cursor = pad;
        let bottom = pad;
        const mk = kids.map((k) => {
          const m = measure(k, k.w ?? w - pad * 2, k.h ?? defaultHeight(k));
          const top = !L && k.y != null ? k.y : cursor;
          if (L || k.y == null) cursor = top + m.h + gap;
          bottom = Math.max(bottom, top + m.h);
          return m;
        });
        return { w, h: Math.max(declaredH, bottom + pad), kids: mk };
      }

      // Horizontal row. Flow children along the FIXED width; if their natural widths
      // overflow it, scale them down so the row stays inside the frame. Height hugs.
      const gaps = gap * Math.max(0, kids.length - 1);
      const natural = kids.map((k) => k.w ?? 120);
      const sum = natural.reduce((a, b) => a + b, 0);
      const avail = w - pad * 2 - gaps;
      const scale = sum > avail && avail > 0 ? avail / sum : 1;
      let maxH = 0;
      const mk = kids.map((k, i) => {
        const m = measure(k, natural[i] * scale, k.h ?? defaultHeight(k));
        maxH = Math.max(maxH, m.h);
        return m;
      });
      return { w, h: Math.max(declaredH, pad * 2 + maxH), kids: mk };
    };

    const place = (spec: ComposeSpec, m: Measured, parentId: NodeId, x: number, y: number) => {
      const id = s.newId();
      ops.push({ kind: "add", node: makeComposeNode(spec, id, parentId, [x, y, m.w, m.h]) });
      const kids = specChildren(spec);
      if (!kids.length) return;
      const L = spec.layout;
      const pad = L?.padding ?? 16;
      const gap = L?.gap ?? 12;
      const align = L?.align ?? "START";
      const horizontal = L?.dir === "H";

      if (!horizontal) {
        // No layout: stack vertically, honoring explicit per-child x/y. V: stack + align.
        let cursor = y + pad;
        kids.forEach((k, i) => {
          const cm = m.kids[i];
          const kx = !L ? (k.x != null ? x + k.x : x + pad) : crossAxis(x, m.w, cm.w, align, pad);
          const ky = !L && k.y != null ? y + k.y : cursor;
          if (L || k.y == null) cursor = ky + cm.h + gap;
          place(k, cm, id, kx, ky);
        });
        return;
      }
      let cursor = x + pad;
      kids.forEach((k, i) => {
        const cm = m.kids[i];
        place(k, cm, id, cursor, crossAxis(y, m.h, cm.h, align, pad));
        cursor += cm.w + gap;
      });
    };

    const rw = root.w ?? (root.screen ? DEFAULT_SCREEN[0] : 320);
    const rh = root.h ?? (root.screen ? DEFAULT_SCREEN[1] : 360);
    const rootM = measure(root, rw, rh);
    // Root placement:
    //  - explicit x/y       -> honor it (offset within the parent).
    //  - empty parent       -> build INSIDE it, centered horizontally near the top. Building a
    //                          top-level screen into an empty page must land ON the page, not
    //                          "below" it (the createFrame default would put it off-canvas at
    //                          y = pageHeight+24, which then tempts a non-translating setBBox move).
    //  - otherwise (append) -> below the parent's existing content, like createFrame.
    const positioned = root.x != null || root.y != null;
    let rx: number, ry: number;
    if (root.screen && !positioned) {
      // A screen lays out as a filmstrip to the right of existing screens, never "below".
      [rx, ry] = nextScreenOrigin(s, rootM.w, rootM.h);
    } else if (positioned) {
      rx = parent.bbox[0] + (root.x ?? 0);
      ry = parent.bbox[1] + (root.y ?? 0);
    } else if (parent.children.length === 0) {
      rx = parent.bbox[0] + Math.max(0, (parent.bbox[2] - rootM.w) / 2);
      ry = parent.bbox[1] + 24;
    } else {
      rx = parent.bbox[0];
      ry = parent.bbox[1] + parent.bbox[3] + 24;
    }
    place(root, rootM, a.parent, rx, ry);
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
        screen: {
          type: "boolean",
          description:
            "Mark this a navigable SCREEN of a prototype. Pass parent = the page root; the new " +
            "frame is placed to the RIGHT of existing screens (a filmstrip) and defaults to a 390×844 " +
            "phone artboard when bbox is omitted. Fill it next, then wire navigation with setInteraction.",
        },
      },
      required: ["parent"],
    },
  },
  validate: (a, s) => (s.has(a.parent) ? null : badId(a.parent)),
  plan: (a, s) => {
    const p = s.getNode(a.parent)!;
    const bbox: BBox = a.bbox
      ? a.bbox
      : a.screen
        ? nextScreenOrigin(s, DEFAULT_SCREEN[0], DEFAULT_SCREEN[1])
        : [p.bbox[0], p.bbox[1] + p.bbox[3] + 24, 320, 360];
    const node = createFrameNode({
      id: s.newId(),
      name: a.name,
      bbox,
      parent: a.parent,
    });
    if (a.screen) node.screen = true;
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

register({
  name: "createIcon",
  schema: {
    name: "createIcon",
    description:
      "Create an ICON glyph (a real symbol, not a placeholder square) inside a parent. Use for action bars " +
      "(like/comment/share/bookmark), tab/nav bars (home/search/user/settings/bell), and inline marks. " +
      `Available names: ${ICON_NAMES.join(", ")}. Stroke-drawn by default; pass a fill for a solid glyph.`,
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the parent frame." },
        icon: { type: "string", description: `Icon name, one of: ${ICON_NAMES.join(", ")}.` },
        bbox: { type: "array", items: { type: "number" }, description: "[x,y,w,h] (square recommended, e.g. 24×24)." },
        stroke: { type: "string", description: 'Stroke hex. Default "#111827".' },
        strokeWidth: { type: "number", description: "Stroke width in icon units. Default 2." },
        fill: { type: "string", description: 'Fill hex for a solid glyph, or "none". Default "none".' },
      },
      required: ["parent", "icon", "bbox"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.parent)) return badId(a.parent);
    if (!Array.isArray(a.bbox) || a.bbox.length !== 4) return { error: "CONSTRAINT", detail: "bbox must be [x,y,w,h]" };
    if (!getIcon(a.icon)) return { error: "CONSTRAINT", detail: `unknown icon "${a.icon}"` };
    return null;
  },
  plan: (a, s) => {
    const node = createIconNode({
      id: s.newId(),
      parent: a.parent,
      icon: a.icon,
      bbox: a.bbox,
      stroke: a.stroke,
      strokeWidth: a.strokeWidth,
      fill: a.fill,
    })!;
    return [{ kind: "add", node }];
  },
  label: (a) => `createIcon ${a.icon}`,
});

register({
  name: "createInput",
  schema: {
    name: "createInput",
    description:
      "Create a real FORM INPUT — a typeable control bound to a variable — inside a parent. Use for any " +
      "field the user fills in: a sign-up form's name/email/password, a search box, a settings toggle, a " +
      "checkout select. `field` is the variable name; its value persists across screens and is shown " +
      "anywhere by writing {{field}} in a TEXT node (e.g. a summary screen 'Welcome, {{name}}!'). Set " +
      "required:true to block a 'navigate' until the field is filled. Add a separate label TEXT above the " +
      "input for its caption (checkbox/switch use the `label` arg instead). Returns the new node id.",
    input_schema: {
      type: "object",
      properties: {
        parent: { type: "string", description: "NodeId of the parent frame." },
        field: { type: "string", description: "Variable name this control reads/writes, e.g. 'email'." },
        kind: {
          type: "string",
          enum: INPUT_KINDS,
          description: "Control type. Default 'text'. email/password for credentials; select needs `options`.",
        },
        bbox: {
          type: "array",
          items: { type: "number" },
          description: "[x,y,w,h]. Omit for a default-sized field below the parent's content.",
        },
        placeholder: { type: "string", description: "Empty-state hint (text-like kinds)." },
        required: { type: "boolean", description: "Block 'navigate' until filled." },
        options: { type: "array", items: { type: "string" }, description: "Choices for kind:'select'." },
        defaultValue: { type: "string", description: "Initial value ('true'/'false' for checkbox/switch)." },
        label: { type: "string", description: "Caption beside a checkbox/switch." },
      },
      required: ["parent", "field"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.parent)) return badId(a.parent);
    if (!a.field || typeof a.field !== "string")
      return { error: "CONSTRAINT", detail: "field (a variable name) is required" };
    if (a.kind && !INPUT_KINDS.includes(a.kind))
      return { error: "CONSTRAINT", detail: `unknown input kind "${a.kind}"` };
    return null;
  },
  plan: (a, s) => {
    const p = s.getNode(a.parent)!;
    const spec = toInputSpec(a as ComposeInput);
    const [dw, dh] = defaultInputSize(spec.kind);
    const bbox: BBox = a.bbox ?? [p.bbox[0] + 16, p.bbox[1] + p.bbox[3] + 24, dw, dh];
    const node = createInputNode({ id: s.newId(), parent: a.parent, input: spec, bbox });
    return [{ kind: "add", node }];
  },
  label: (a) => `createInput ${a.kind ?? "text"} "${a.field}"`,
});

const ALLOWED_SET_PROP_PATHS = new Set([
  "bbox",
  "name",
  "screen",
  "hidden",
  "interactions",
  "input",
  "style.fills",
  "style.opacity",
  "style.cornerRadius",
  "style.cornerRadiusUnit",
  "style.stroke",
  "style.overflow",
  "style.zIndex",
  "style.shadow",
  "style.blur",
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
  "vector.d",
  "vector.kind",
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
  name: "setGradient",
  schema: {
    name: "setGradient",
    description:
      "Give one or more nodes a GRADIENT fill — the fastest way to turn a flat panel/header/button into " +
      "something with depth. angle is CSS degrees (0=to top, 180=to bottom, 90=to right).",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to fill." },
        colors: {
          type: "array",
          items: { type: "string" },
          description: "2+ hex colors, gradient start→end.",
        },
        angle: { type: "number", description: "Linear angle in degrees. Default 180 (top→bottom)." },
        radial: { type: "boolean", description: "Radial instead of linear." },
      },
      required: ["ids", "colors"],
    },
  },
  validate: (a, s) => {
    if (!Array.isArray(a.colors) || a.colors.length < 2)
      return { error: "CONSTRAINT", detail: "need 2+ colors" };
    for (const id of a.ids) if (!s.has(id)) return badId(id);
    return null;
  },
  plan: (a) => {
    const paint = gradientPaint(a.colors, { gradient: a.radial ? "radial" : "linear", angle: a.angle });
    return a.ids.map((id: NodeId) => ({ kind: "set", id, path: "style.fills", value: [paint] }));
  },
  label: (a) => `setGradient ${a.ids.length} node(s)`,
});

// ---------- Prototype interactivity ----------
register({
  name: "setInteraction",
  schema: {
    name: "setInteraction",
    description:
      "Make a node INTERACTIVE in the played prototype: attach a click binding so tapping it navigates " +
      "to another screen, toggles an element, opens/closes an overlay, or goes back. Use this to wire a " +
      "multi-screen flow AFTER the screens exist — e.g. a nav tab or button that should switch the view " +
      "(action 'navigate', target = the destination SCREEN frame); a menu/switch that reveals a hidden " +
      "element ('toggle', target = that element); a button that opens a modal/sheet ('openOverlay', " +
      "target = the overlay frame); a close/X ('closeOverlay'); or a back chevron ('back'). " +
      "navigate/toggle/openOverlay REQUIRE a target; closeOverlay/back take none.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId of the element the user clicks (button, tab, row, icon)." },
        action: {
          type: "string",
          enum: ["navigate", "toggle", "openOverlay", "closeOverlay", "back"],
          description: "What the click does.",
        },
        target: {
          type: "string",
          description:
            "NodeId the action acts on: the destination SCREEN (navigate), or the element to show/float " +
            "(toggle/openOverlay). Omit for closeOverlay/back.",
        },
      },
      required: ["id", "action"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.id)) return badId(a.id);
    const needsTarget = a.action === "navigate" || a.action === "toggle" || a.action === "openOverlay";
    if (needsTarget) {
      if (!a.target) return { error: "CONSTRAINT", detail: `${a.action} requires a target` };
      if (!s.has(a.target)) return badId(a.target);
      if (a.action === "navigate" && !s.getNode(a.target)!.screen)
        return { error: "CONSTRAINT", detail: `navigate target ${a.target} is not a screen` };
    }
    return null;
  },
  plan: (a) => {
    const it: { trigger: "click"; action: string; target?: NodeId } = { trigger: "click", action: a.action };
    if (a.target) it.target = a.target;
    return [{ kind: "set", id: a.id as NodeId, path: "interactions", value: [it] }];
  },
  label: (a) => `setInteraction ${a.action}${a.target ? ` -> ${a.target}` : ""}`,
});

register({
  name: "setHidden",
  schema: {
    name: "setHidden",
    description:
      "Set whether nodes START hidden when the prototype is PLAYED (they still show on the editor canvas so " +
      "you can build them). Use hidden:true for the body of a dropdown, an accordion panel, a menu, or a " +
      "modal/sheet that should only appear after a 'toggle' or 'openOverlay' click. Pair it with a " +
      "setInteraction that reveals the same target.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to show/hide in Play mode." },
        hidden: { type: "boolean", description: "true = start hidden until revealed; false = always visible." },
      },
      required: ["ids", "hidden"],
    },
  },
  validate: (a, s) => {
    if (!Array.isArray(a.ids) || !a.ids.length) return { error: "CONSTRAINT", detail: "ids required" };
    for (const id of a.ids) if (!s.has(id)) return badId(id);
    return null;
  },
  plan: (a) => a.ids.map((id: NodeId) => ({ kind: "set", id, path: "hidden", value: !!a.hidden })),
  label: (a) => `setHidden ${a.ids.length} node(s) -> ${!!a.hidden}`,
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
      "Arrange a frame's direct children in a row (H) or column (V), re-flowing their positions. Call this " +
      "to make a section look designed instead of scattered — it replaces ~20 manual position edits with one " +
      "call. `align` is the cross-axis (align-items); `justify` is the main-axis distribution (justify-content), " +
      "where SPACE_BETWEEN pins the first/last child to the edges and spreads the gaps evenly.",
    input_schema: {
      type: "object",
      properties: {
        frame: { type: "string", description: "NodeId of the frame to lay out." },
        dir: { type: "string", enum: ["H", "V"], description: "Row (H) or column (V)." },
        gap: { type: "number", description: "Pixels between children (ignored for SPACE_* justify). Default 16." },
        padding: { type: "number", description: "Inner padding. Default 24." },
        align: { type: "string", enum: ["START", "CENTER", "END"], description: "Cross-axis alignment (align-items)." },
        justify: {
          type: "string",
          enum: ["START", "CENTER", "END", "SPACE_BETWEEN", "SPACE_AROUND"],
          description: "Main-axis distribution (justify-content). Default START.",
        },
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
    const f = s.getNode(a.frame)!;
    return layoutChildrenOps(s, f, f.children, {
      ...(f.layout ?? { mode: "NONE" as const }),
      mode: a.dir === "V" ? "VERTICAL" : "HORIZONTAL",
      gap: a.gap ?? 16,
      padding: a.padding ?? 24,
      align: a.align ?? "START",
      justify: a.justify ?? "START",
    });
  },
  label: (a) => `applyAutoLayout ${a.dir}${a.justify ? ` ${a.justify}` : ""} on ${a.frame}`,
});

register({
  name: "snapIntoLayout",
  schema: {
    name: "snapIntoLayout",
    description:
      "Drop or reorder a node inside a row/column layout frame and snap all children into their layout slots. " +
      "The target frame's layout.mode decides row vs column; child widthMode/heightMode/grow/alignSelf decide " +
      "whether a child keeps its size, fills the cross-axis, or shares remaining main-axis space.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId to drop into the layout container." },
        parent: { type: "string", description: "Row/column layout frame to receive the node." },
        index: { type: "number", description: "Optional final child index. Defaults from the node's dropped position." },
        widthMode: { type: "string", enum: ["hug", "fixed", "fill"], description: "Optional child width sizing mode." },
        heightMode: { type: "string", enum: ["hug", "fixed", "fill"], description: "Optional child height sizing mode." },
        grow: { type: "number", description: "Optional flex-grow weight for sharing main-axis free space." },
        alignSelf: {
          type: "string",
          enum: ["auto", "stretch", "flex-start", "center", "flex-end"],
          description: "Optional cross-axis self alignment.",
        },
      },
      required: ["id", "parent"],
    },
  },
  validate: (a, s) => {
    if (!s.has(a.id)) return badId(a.id);
    if (!s.has(a.parent)) return badId(a.parent);
    if (a.parent === a.id) return { error: "CONSTRAINT", detail: "cannot reparent a node into itself" };
    const parent = s.getNode(a.parent)!;
    if (!isLayoutContainer(parent))
      return { error: "CONSTRAINT", detail: `${a.parent} is not a row/column layout container` };
    if (isDescendant(s, a.id, a.parent))
      return { error: "CONSTRAINT", detail: `${a.parent} is a descendant of ${a.id}` };
    if (a.index != null && (typeof a.index !== "number" || !Number.isFinite(a.index)))
      return { error: "CONSTRAINT", detail: "index must be a finite number" };
    if (a.widthMode != null && !SIZE_MODE_VALUES.has(a.widthMode))
      return { error: "CONSTRAINT", detail: `invalid widthMode ${a.widthMode}` };
    if (a.heightMode != null && !SIZE_MODE_VALUES.has(a.heightMode))
      return { error: "CONSTRAINT", detail: `invalid heightMode ${a.heightMode}` };
    if (a.alignSelf != null && !ALIGN_SELF_VALUES.has(a.alignSelf))
      return { error: "CONSTRAINT", detail: `invalid alignSelf ${a.alignSelf}` };
    if (a.grow != null && (typeof a.grow !== "number" || !Number.isFinite(a.grow) || a.grow < 0))
      return { error: "CONSTRAINT", detail: "grow must be a non-negative finite number" };
    return null;
  },
  plan: (a, s) => {
    const node = s.getNode(a.id)!;
    const parent = s.getNode(a.parent)!;
    const dir = autoLayoutDir(parent)!;
    const vertical = dir === "V";
    const pad = parent.layout?.padding ?? 24;
    const { mainPosI, mainSizeI, crossSizeI } = axisIndexes(vertical);
    const existing = parent.children.filter((id) => id !== node.id);
    const center = node.bbox[mainPosI] + node.bbox[mainSizeI] / 2;
    const inferredIndex = existing.findIndex((id) => {
      const child = s.getNode(id);
      return child ? center < child.bbox[mainPosI] + child.bbox[mainSizeI] / 2 : false;
    });
    const rawIndex = a.index ?? (inferredIndex >= 0 ? inferredIndex : existing.length);
    const index = Math.max(0, Math.min(rawIndex, existing.length));
    const childIds = [...existing];
    childIds.splice(index, 0, node.id);

    const childLayout: LayoutStyle = { ...(node.layout ?? { mode: "NONE" as const }), positionMode: "inline" };
    const crossKey: "widthMode" | "heightMode" = vertical ? "widthMode" : "heightMode";
    const crossInner = parent.bbox[crossSizeI] - pad * 2;
    const droppedCrossSize = node.bbox[crossSizeI];
    const wasAbsolute = node.layout?.positionMode == null || node.layout.positionMode === "absolute";
    if (wasAbsolute && childLayout[crossKey] !== "fill" && crossInner > 0 && droppedCrossSize >= crossInner * 0.75) {
      childLayout[crossKey] = "fill";
    }
    if (a.widthMode != null) childLayout.widthMode = a.widthMode;
    if (a.heightMode != null) childLayout.heightMode = a.heightMode;
    if (a.grow != null) childLayout.grow = a.grow;
    if (a.alignSelf != null) childLayout.alignSelf = a.alignSelf;

    const childOverrides = new Map<NodeId, LayoutStyle>([[node.id, childLayout]]);
    const ops: Op[] = [];
    ops.push({ kind: "set", id: node.id, path: "layout", value: childLayout });
    if (node.parent !== parent.id || parent.children.indexOf(node.id) !== index) {
      ops.push({ kind: "reparent", id: node.id, parent: parent.id, index });
    }
    ops.push(...layoutChildrenOps(s, parent, childIds, parent.layout!, childOverrides));
    return ops;
  },
  label: (a) => `snapIntoLayout ${a.id} -> ${a.parent}`,
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
  name: "reorderChild",
  schema: {
    name: "reorderChild",
    description:
      "Reorder a node AMONG ITS CURRENT SIBLINGS (same parent), moving it to a new 0-based index. " +
      "Use this to restack siblings — change paint/draw order and the layers-tree position — without " +
      "changing the node's parent. `index` is the final position the node should occupy in the parent's " +
      "children array after the move (0 = first). To move between DIFFERENT parents, use reparentNodes instead.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "NodeId to restack." },
        index: { type: "number", description: "Final 0-based position among siblings (clamped to range)." },
      },
      required: ["id", "index"],
    },
  },
  validate: (a, s) => {
    const n = s.getNode(a.id);
    if (!n) return badId(a.id);
    if (!n.parent) return { error: "CONSTRAINT", detail: `${a.id} has no parent to reorder within` };
    if (typeof a.index !== "number" || !Number.isFinite(a.index))
      return { error: "CONSTRAINT", detail: `index must be a finite number` };
    const siblings = s.getNode(n.parent)!.children;
    const from = siblings.indexOf(a.id);
    // After removing the node, valid insertion indices are 0..(len-1). Clamp, then
    // reject a no-op (target == current position) so we never bump the version for nothing.
    const to = Math.max(0, Math.min(a.index, siblings.length - 1));
    if (to === from) return { error: "CONSTRAINT", detail: `${a.id} is already at index ${from}` };
    return null;
  },
  plan: (a, s) => {
    const n = s.getNode(a.id)!;
    const siblings = s.getNode(n.parent!)!.children;
    // applyOps removes the node FIRST then splices at op.index, so the desired FINAL
    // index is exactly the splice index (post-removal). Clamp to the post-removal range.
    const index = Math.max(0, Math.min(a.index, siblings.length - 1));
    return [{ kind: "reparent", id: a.id, parent: n.parent!, index }];
  },
  label: (a) => `reorderChild ${a.id} -> #${a.index}`,
});

register({
  name: "groupNodes",
  schema: {
    name: "groupNodes",
    description:
      "Wrap a set of nodes in a new GROUP container so they can be selected, moved, and reordered as one unit. " +
      "The group's bbox is the union of the members; members keep their on-screen positions (the group is an " +
      "invisible container). Use this to bundle related elements (e.g. an icon + its label) before laying them out.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "NodeIds to group (1+)." },
        name: { type: "string", description: 'Group name. Default "Group".' },
      },
      required: ["ids"],
    },
  },
  validate: (a, s) => {
    if (!Array.isArray(a.ids) || a.ids.length < 1)
      return { error: "CONSTRAINT", detail: "groupNodes needs at least one id" };
    for (const id of a.ids) {
      if (!s.has(id)) return badId(id);
      if (!s.getNode(id)!.parent) return { error: "CONSTRAINT", detail: `cannot group the root ${id}` };
    }
    return null;
  },
  plan: (a, s) => {
    // Group in stable DOCUMENT order (not click order) so paint/z-order is preserved.
    const want = new Set<NodeId>(a.ids);
    const ordered: NodeId[] = [];
    const walk = (id: NodeId) => {
      if (want.has(id)) ordered.push(id);
      for (const c of s.getNode(id)?.children ?? []) walk(c);
    };
    walk(s.rootId);
    // Parent the group under the first member's parent; drop it where that member sat.
    const parent = s.getNode(ordered[0])!.parent!;
    const siblings = s.getNode(parent)!.children;
    const at = Math.min(...ordered.map((id) => siblings.indexOf(id)).filter((i) => i >= 0));
    // Union bbox of the members.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ordered) {
      const [x, y, w, h] = s.getNode(id)!.bbox;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }
    const groupId = s.newId();
    const group: Node = {
      id: groupId,
      tid: groupId,
      type: "GROUP",
      name: a.name ?? "Group",
      bbox: [minX, minY, maxX - minX, maxY - minY],
      parent,
      children: [],
      template: { family: "box", domTag: "div" },
      style: { overflow: "visible" },
      layout: { mode: "NONE", positionMode: "absolute", widthMode: "fixed", heightMode: "fixed" },
    };
    const ops: Op[] = [{ kind: "add", node: group, index: Number.isFinite(at) ? at : undefined }];
    // Reparent members into the group, appending in document order.
    for (let i = 0; i < ordered.length; i++)
      ops.push({ kind: "reparent", id: ordered[i], parent: groupId, index: i });
    return ops;
  },
  label: (a) => `groupNodes ${a.ids?.length ?? 0} node(s)`,
});

register({
  name: "ungroupNodes",
  schema: {
    name: "ungroupNodes",
    description:
      "Dissolve a group/container: move its children up into the group's parent (keeping their positions and " +
      "order), then delete the now-empty container. The inverse of groupNodes.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", description: "NodeId of the group/container to dissolve." } },
      required: ["id"],
    },
  },
  validate: (a, s) => {
    const n = s.getNode(a.id);
    if (!n) return badId(a.id);
    if (!n.parent) return { error: "CONSTRAINT", detail: `cannot ungroup the root ${a.id}` };
    if (!n.children.length) return { error: "CONSTRAINT", detail: `${a.id} has no children to ungroup` };
    return null;
  },
  plan: (a, s) => {
    const g = s.getNode(a.id)!;
    const parent = g.parent!;
    const gi = s.getNode(parent)!.children.indexOf(a.id);
    const ops: Op[] = [];
    // Hoist each child to the group's slot in order; the group shifts right by one each
    // time, so gi + k lands them contiguously where the group used to be.
    g.children.forEach((c, k) => ops.push({ kind: "reparent", id: c, parent, index: gi + k }));
    ops.push({ kind: "remove", id: a.id });
    return ops;
  },
  label: (a) => `ungroupNodes ${a.id}`,
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
