// THE SHARED DRAW TABLE — the single source of pixels (IMPLEMENTATION.md §5.2).
//
// `buildSvg(store, rootId, opts)` walks the scene graph in deterministic pre-order
// DFS and emits ONE SVG string via a per-node-type table of string-builders. The
// browser injects this exact string into the DOM; the server (later milestone) will
// rasterize the IDENTICAL string with @resvg/resvg-js. There is no parallel renderer.
//
// Every element carries `data-node-id` so selection is a DOM hit-test.

import type { Node, NodeId, Paint, Shadow } from "../shared/types.js";
import { boundsOf, contentBounds, type DocStore } from "../shared/store.js";
import { ICON_VIEWBOX } from "../shared/icons.js";

export interface BuildOpts {
  /** Draw the numbered set-of-marks overlay (the agent's vision channel). */
  marks?: boolean;
  /** Long-edge pixel cap; pinned by the rasterizer later. Carried for parity. */
  maxPx?: number;
  /** Play-mode: when set, a node (and its subtree) is skipped when `isHidden(id)` is
   *  true — this is what makes toggles/overlays appear and disappear at runtime. The
   *  editor path leaves `play` undefined, so hidden nodes still render and stay editable.
   *  `values` is the live form state (field -> typed value); when present, TEXT nodes
   *  interpolate `{{field}}` placeholders and input boxes show their current value. */
  play?: { isHidden?: (id: NodeId) => boolean; values?: Record<string, string> };
}

// A {{field}} variable placeholder inside TEXT chars or an input value.
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;
/** Resolve `{{field}}` against the live form values (unknown/empty -> ""). */
export function interpolate(s: string, values: Record<string, string>): string {
  return s.replace(VAR_RE, (_m, k) => values[k] ?? "");
}

export interface BuildResult {
  svg: string;
  /** MarkId ("1","2",…) -> NodeId. Stable per render (pre-order DFS). */
  markMap: Record<string, NodeId>;
}

// ---- small attribute helpers (kept pure, no I/O) ----
const num = (n: number) => (Number.isFinite(n) ? n : 0);
const pos = (n: Node) =>
  `x="${num(n.bbox[0])}" y="${num(n.bbox[1])}" width="${num(n.bbox[2])}" height="${num(n.bbox[3])}"`;
const cx = (n: Node) => num(n.bbox[0] + n.bbox[2] / 2);
const cy = (n: Node) => num(n.bbox[1] + n.bbox[3] / 2);
// A solid color, when the first paint IS solid — used for TEXT color fallback only.
const fillColor = (n: Node) => {
  const p = n.style?.fills?.find((f) => f.type === "SOLID");
  return p && p.type === "SOLID" ? p.color : undefined;
};

// Defs collector: gradients / image patterns / shadow+blur filters are emitted ONCE into a
// shared <defs> and referenced by url(#id). Ids are deterministic (keyed by node id), so a
// given store always serializes byte-identically (the determinism contract the smoke test
// asserts and the prompt cache relies on).
type Defs = { items: string[] };

/** The `fill="…"` attribute for a shape/frame, registering any gradient/image def needed.
 *  Falls back to transparent (FRAME) / none (shape) when the node has no paint. */
function fill(n: Node, defs: Defs): string {
  const paint = n.style?.fills?.find((p) => p && (p.type === "SOLID" || p.type === "GRADIENT" || p.type === "IMAGE"));
  if (!paint) return `fill="${n.type === "FRAME" ? "transparent" : "none"}"`;
  if (paint.type === "SOLID") {
    const op = paint.opacity != null ? ` fill-opacity="${num(paint.opacity)}"` : "";
    return `fill="${esc(paint.color)}"${op}`;
  }
  const id = paint.type === "GRADIENT" ? `grad-${n.id}` : `img-${n.id}`;
  defs.items.push(paint.type === "GRADIENT" ? gradientDef(id, paint) : imageDef(id, n, paint));
  const op = paint.opacity != null ? ` fill-opacity="${num(paint.opacity)}"` : "";
  return `fill="url(#${id})"${op}`;
}

/** Build a linear/radial gradient <def>. Angle is CSS-convention degrees (0=to top,
 *  180=to bottom, 90=to right); default 180. objectBoundingBox so it scales with the node. */
function gradientDef(id: string, p: Extract<Paint, { type: "GRADIENT" }>): string {
  const stops = (p.stops ?? [])
    .map(
      (s) =>
        `<stop offset="${num(s.offset)}" stop-color="${esc(s.color)}"${
          s.opacity != null ? ` stop-opacity="${num(s.opacity)}"` : ""
        }/>`,
    )
    .join("");
  if ((p.gradient ?? "linear") === "radial") {
    return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`;
  }
  const a = ((p.angle ?? 180) * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const x1 = 0.5 - dx / 2,
    y1 = 0.5 - dy / 2,
    x2 = 0.5 + dx / 2,
    y2 = 0.5 + dy / 2;
  return `<linearGradient id="${id}" x1="${rnd(x1)}" y1="${rnd(y1)}" x2="${rnd(x2)}" y2="${rnd(y2)}">${stops}</linearGradient>`;
}

/** A single-tile <pattern> holding the node's image, fitted to its bbox (no tiling). */
function imageDef(id: string, n: Node, p: Extract<Paint, { type: "IMAGE" }>): string {
  const [x, y, w, h] = n.bbox.map(num);
  const par = p.fit === "contain" ? "xMidYMid meet" : p.fit === "fill" ? "none" : "xMidYMid slice";
  return (
    `<pattern id="${id}" patternUnits="userSpaceOnUse" x="${x}" y="${y}" width="${w}" height="${h}">` +
    `<image href="${esc(p.src)}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="${par}"/>` +
    `</pattern>`
  );
}

/** Shadow(s) + blur as ONE filter; "" when the node needs neither. Drop shadows are built
 *  from SourceAlpha (offset+blur+flood+composite) and merged UNDER the (optionally blurred)
 *  source — all primitives resvg rasterizes, so the agent SEES the depth, unlike CSS box-shadow. */
function filterAttr(n: Node, defs: Defs): string {
  const raw = n.style?.shadow;
  const shadows: Shadow[] = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
  const blur = n.style?.blur && n.style.blur > 0 ? num(n.style.blur) : 0;
  if (!shadows.length && !blur) return "";
  const id = `fx-${n.id}`;
  const parts: string[] = [];
  const merges: string[] = [];
  shadows.forEach((s, i) => {
    const b = num(s.blur ?? 4);
    const dx = num(s.x ?? 0);
    const dy = num(s.y ?? 2);
    const color = esc(s.color ?? "rgba(0,0,0,0.25)");
    parts.push(
      `<feGaussianBlur in="SourceAlpha" stdDeviation="${b / 2}" result="b${i}"/>` +
        `<feOffset in="b${i}" dx="${dx}" dy="${dy}" result="o${i}"/>` +
        `<feFlood flood-color="${color}" result="c${i}"/>` +
        `<feComposite in="c${i}" in2="o${i}" operator="in" result="s${i}"/>`,
    );
    merges.push(`<feMergeNode in="s${i}"/>`);
  });
  const fg = blur
    ? `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur / 2}" result="fg"/>`
    : "";
  const fgNode = blur ? `<feMergeNode in="fg"/>` : `<feMergeNode in="SourceGraphic"/>`;
  defs.items.push(
    `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">` +
      parts.join("") +
      fg +
      `<feMerge>${merges.join("")}${fgNode}</feMerge>` +
      `</filter>`,
  );
  return ` filter="url(#${id})"`;
}

const rnd = (n: number) => Math.round(n * 1000) / 1000;
// Interaction data-attrs from the node's first click binding — Play mode hit-tests the
// DOM for these. Empty (zero extra bytes) when the node has no interaction, so the
// editor SVG for a non-interactive doc is byte-identical to before (determinism contract).
const interactionAttrs = (n: Node): string => {
  const it = n.interactions?.find((i) => i.trigger === "click");
  if (!it) return "";
  return ` data-action="${esc(it.action)}"${it.target ? ` data-target="${esc(it.target)}"` : ""}`;
};
const nodeAttrs = (n: Node) =>
  `data-node-id="${n.id}" data-dc-tpl="${esc(n.tid ?? n.id)}"${interactionAttrs(n)}`;
// Border, when present — what keeps a white card visible on the white page.
const stroke = (n: Node) => {
  const s = n.style?.stroke;
  if (!s || s.style === "none") return "";
  const dash =
    s.style === "dashed"
      ? ` stroke-dasharray="${num(s.weight ?? 1) * 3} ${num(s.weight ?? 1) * 2}"`
      : s.style === "dotted"
        ? ` stroke-dasharray="0 ${num(s.weight ?? 1) * 2}"`
        : "";
  return ` stroke="${s.color}" stroke-width="${num(s.weight ?? 1)}"${dash}`;
};
const opacity = (n: Node) => (n.style?.opacity != null ? ` opacity="${num(n.style.opacity)}"` : "");

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- the draw table: one string-builder per node type ----
type DrawFn = (n: Node, defs: Defs) => string;

const DRAW: Record<Node["type"], DrawFn> = {
  RECT: (n, defs) =>
    `<rect ${pos(n)} ${fill(n, defs)}${stroke(n)}${opacity(n)}${filterAttr(n, defs)} rx="${num(n.style?.cornerRadius ?? 0)}" ${nodeAttrs(n)}/>`,

  ELLIPSE: (n, defs) =>
    `<ellipse cx="${cx(n)}" cy="${cy(n)}" rx="${num(n.bbox[2] / 2)}" ry="${num(
      n.bbox[3] / 2,
    )}" ${fill(n, defs)}${stroke(n)}${opacity(n)}${filterAttr(n, defs)} ${nodeAttrs(n)}/>`,

  TEXT: (n, defs) => {
    const fs = n.text?.fontSize ?? 16;
    const fw = n.text?.fontWeight ?? 400;
    const color = n.text?.color ?? fillColor(n) ?? "#111111";
    const family = n.text?.fontFamily ?? "Inter, system-ui, sans-serif";
    const anchor =
      n.text?.align === "CENTER" ? "middle" : n.text?.align === "RIGHT" ? "end" : "start";
    // text-anchor x reference: left/center/right edge of the bbox.
    const tx =
      n.text?.align === "CENTER"
        ? num(n.bbox[0] + n.bbox[2] / 2)
        : n.text?.align === "RIGHT"
          ? num(n.bbox[0] + n.bbox[2])
          : num(n.bbox[0]);
    const ty = num(n.bbox[1] + fs); // baseline ~ top + fontSize
    const styleBits = [
      n.text?.fontStyle === "italic" ? `font-style="italic"` : "",
      n.text?.textDecoration?.length ? `text-decoration="${esc(n.text.textDecoration.join(" "))}"` : "",
      n.text?.letterSpacingEm != null ? `letter-spacing="${num(n.text.letterSpacingEm)}em"` : "",
    ].filter(Boolean);
    return (
      `<text x="${tx}" y="${ty}" font-family="${esc(family)}" ` +
      `font-size="${fs}" font-weight="${fw}" fill="${color}" ` +
      `text-anchor="${anchor}"${styleBits.length ? ` ${styleBits.join(" ")}` : ""}${opacity(n)}${filterAttr(n, defs)} ` +
      `${nodeAttrs(n)}>${esc(n.text?.chars ?? "")}</text>`
    );
  },

  FRAME: (n, defs) =>
    `<rect ${pos(n)} ${fill(n, defs)}${stroke(n)}${opacity(n)}${filterAttr(n, defs)} rx="${num(n.style?.cornerRadius ?? 0)}" ${nodeAttrs(n)}/>`,

  VECTOR: (n, defs) => vectorNode(n, defs),
  COMPONENT: () => "",
  INSTANCE: () => "",
  GROUP: () => "",
};

function vectorNode(n: Node, defs: Defs): string {
  const v = n.vector;
  if (!v) return "";
  // Icon glyph: a raw path `d` in the icon viewBox, scaled into the bbox. Stroke-drawn
  // by default (fill:none); a concrete `fill` makes it a solid glyph (e.g. a filled like).
  if (v.kind === "icon" && v.d) {
    const [bx, by, bw, bh] = n.bbox.map(num);
    const vb = (v.viewBox?.[2] ?? ICON_VIEWBOX) || ICON_VIEWBOX;
    const vbh = (v.viewBox?.[3] ?? ICON_VIEWBOX) || ICON_VIEWBOX;
    const sx = rnd(bw / vb);
    const sy = rnd(bh / vbh);
    const stroke = esc(v.stroke ?? "#111827");
    const sw = num(v.strokeWidth ?? 2);
    const f = v.fill && v.fill !== "none" ? esc(v.fill) : "none";
    return (
      `<g transform="translate(${bx} ${by}) scale(${sx} ${sy})"${filterAttr(n, defs)} ${nodeAttrs(n)}>` +
      `<path d="${esc(v.d)}" fill="${f}" stroke="${stroke}" stroke-width="${sw}" ` +
      `stroke-linecap="${v.linecap ?? "round"}" stroke-linejoin="${v.linejoin ?? "round"}"/>` +
      `</g>`
    );
  }
  if (v.points.length < 2) return "";
  const points = v.points.map((p) => vectorPoint(n, p));
  const d = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${num(x)} ${num(y)}`)
    .join(" ");
  const strokeWidth = num(v.strokeWidth ?? 4);
  const path =
    `<path d="${d}" fill="${esc(v.fill ?? "none")}" stroke="${esc(v.stroke)}" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="${v.linecap ?? "round"}" ` +
    `stroke-linejoin="${v.linejoin ?? "round"}"${opacity(n)} ${nodeAttrs(n)}/>`;
  if (v.kind !== "arrow") return path;
  const head = arrowHead(points, strokeWidth, n);
  return path + head;
}

function vectorPoint(n: Node, p: [number, number]): [number, number] {
  const v = n.vector;
  if (!v) return [n.bbox[0] + p[0], n.bbox[1] + p[1]];
  const [vx, vy, vw, vh] = v.viewBox;
  const sx = n.bbox[2] / Math.max(1, vw);
  const sy = n.bbox[3] / Math.max(1, vh);
  return [n.bbox[0] + (p[0] - vx) * sx, n.bbox[1] + (p[1] - vy) * sy];
}

function arrowHead(points: Array<[number, number]>, strokeWidth: number, n: Node): string {
  const end = points[points.length - 1];
  const prev = points[points.length - 2];
  const angle = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
  const size = Math.max(8, strokeWidth * 3);
  const spread = Math.PI / 7;
  const left: [number, number] = [
    end[0] - Math.cos(angle - spread) * size,
    end[1] - Math.sin(angle - spread) * size,
  ];
  const right: [number, number] = [
    end[0] - Math.cos(angle + spread) * size,
    end[1] - Math.sin(angle + spread) * size,
  ];
  const d = `M ${num(left[0])} ${num(left[1])} L ${num(end[0])} ${num(end[1])} L ${num(right[0])} ${num(right[1])}`;
  return (
    `<path d="${d}" fill="none" stroke="${esc(n.vector?.stroke ?? "#8A8378")}" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="${n.vector?.linecap ?? "round"}" ` +
    `stroke-linejoin="${n.vector?.linejoin ?? "round"}"${opacity(n)} ${nodeAttrs(n)}/>`
  );
}

// ---- input fields ----
// A form control rendered as static SVG so it looks like a real field on the editor
// canvas AND in the agent's raster (perception). In Play mode a real HTML control is
// overlaid on top by PlayMode; this SVG is the visual fallback underneath.
const INPUT_TEXT = "#111827";
const INPUT_PLACEHOLDER = "#94A3B8";
const INPUT_ACCENT = "#4F46E5";

function inputNode(n: Node, defs: Defs, values?: Record<string, string>): string {
  const inp = n.input!;
  const [x, y, w, h] = n.bbox.map(num);
  const fontSize = Math.min(16, Math.max(12, h * 0.34));
  const family = "Inter, system-ui, sans-serif";
  const raw = values ? values[inp.field] ?? "" : "";
  const hasVal = raw !== "";

  // checkbox / switch: a control glyph + caption, no full field box.
  if (inp.kind === "checkbox" || inp.kind === "switch") {
    const on = raw === "true" || (!values && inp.defaultValue === "true");
    const caption = inp.label ?? inp.placeholder ?? inp.field;
    const cy0 = y + h / 2;
    let control: string;
    if (inp.kind === "switch") {
      const tw = 40;
      const th = Math.min(24, h);
      const ty0 = cy0 - th / 2;
      const knob = th / 2 - 2;
      const kcx = on ? x + tw - th / 2 : x + th / 2;
      control =
        `<rect x="${x}" y="${ty0}" width="${tw}" height="${th}" rx="${th / 2}" fill="${on ? INPUT_ACCENT : "#CBD5E1"}"/>` +
        `<circle cx="${kcx}" cy="${cy0}" r="${knob}" fill="#FFFFFF"/>`;
    } else {
      const bs = Math.min(22, h);
      const by0 = cy0 - bs / 2;
      control =
        `<rect x="${x}" y="${by0}" width="${bs}" height="${bs}" rx="5" fill="${on ? INPUT_ACCENT : "#FFFFFF"}" stroke="${on ? INPUT_ACCENT : "#CBD5E1"}" stroke-width="1.5"/>` +
        (on
          ? `<path d="M ${x + bs * 0.25} ${cy0} L ${x + bs * 0.45} ${cy0 + bs * 0.22} L ${x + bs * 0.78} ${cy0 - bs * 0.22}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
          : "");
    }
    const cx0 = x + (inp.kind === "switch" ? 52 : 34);
    const text =
      `<text x="${cx0}" y="${cy0 + fontSize * 0.35}" font-family="${family}" font-size="${fontSize}" ` +
      `fill="${INPUT_TEXT}" text-anchor="start">${esc(caption)}</text>`;
    return `<g ${nodeAttrs(n)}>${control}${text}</g>`;
  }

  // text-like field (text/email/password/number/textarea/select): a box + value/placeholder.
  const box = `<rect ${pos(n)} ${fill(n, defs)}${stroke(n)}${opacity(n)} rx="${num(n.style?.cornerRadius ?? 10)}" ${nodeAttrs(n)}/>`;
  let display = hasVal ? raw : inp.placeholder ?? "";
  if (inp.kind === "password" && hasVal) display = "•".repeat([...raw].length);
  const color = hasVal ? INPUT_TEXT : INPUT_PLACEHOLDER;
  const padX = 14;
  const ty = inp.kind === "textarea" ? y + fontSize + 12 : y + h / 2 + fontSize * 0.35;
  const label =
    display !== ""
      ? `<text x="${x + padX}" y="${ty}" font-family="${family}" font-size="${fontSize}" fill="${color}" text-anchor="start">${esc(display)}</text>`
      : "";
  // select chevron at the right edge.
  const chevron =
    inp.kind === "select"
      ? `<path d="M ${x + w - 26} ${y + h / 2 - 3} L ${x + w - 20} ${y + h / 2 + 3} L ${x + w - 14} ${y + h / 2 - 3}" fill="none" stroke="#64748B" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : "";
  return box + label + chevron;
}

function markFor(m: string, n: Node): string {
  const [x, y, w, h] = n.bbox.map(num);
  return (
    `<g class="som-mark">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#7c3aed" stroke-width="2" stroke-dasharray="4 3"/>` +
    `<rect x="${x}" y="${y}" width="20" height="16" fill="#7c3aed" rx="3"/>` +
    `<text x="${x + 10}" y="${y + 12}" font-family="Inter, system-ui, sans-serif" font-size="12" fill="#fff" text-anchor="middle" font-weight="700">${m}</text>` +
    `</g>`
  );
}

/** The single source of pixels. Pure function of (store, rootId, opts). */
export function buildSvg(store: DocStore, rootId: NodeId, opts: BuildOpts = {}): BuildResult {
  const root = store.getNode(rootId);
  if (!root) {
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>`, markMap: {} };
  }
  // Editor: frame ALL content (root UNION every node) so escaped nodes stay visible.
  // Play mode: frame ONLY the screen we render from (other screens sit off to the side).
  const [vx, vy, vw, vh] = (opts.play ? boundsOf(store, rootId) : contentBounds(store, rootId)).map(num);
  const body: string[] = [];
  const defs: Defs = { items: [] };
  const markRects: string[] = [];
  const markMap: Record<string, NodeId> = {};
  let mark = 0;

  const walk = (id: NodeId) => {
    const n = store.getNode(id);
    if (!n) return;
    // Play mode: a hidden node (default `hidden`, or toggled off at runtime via the
    // isHidden predicate) drops itself AND its subtree. The root we render from is never
    // skipped. Editor renders everything (opts.play undefined).
    if (opts.play && id !== rootId) {
      const hidden = opts.play.isHidden ? opts.play.isHidden(id) : !!n.hidden;
      if (hidden) return;
    }
    const values = opts.play?.values;
    if (n.input) {
      body.push(inputNode(n, defs, values));
    } else if (values && n.type === "TEXT" && n.text?.chars.includes("{{")) {
      // Live text: resolve {{field}} placeholders against the form state.
      body.push(DRAW.TEXT({ ...n, text: { ...n.text, chars: interpolate(n.text.chars, values) } }, defs));
    } else {
      body.push(DRAW[n.type](n, defs));
    }
    if (opts.marks && n.id !== rootId) {
      const m = String(++mark);
      markMap[m] = n.id;
      markRects.push(markFor(m, n));
    }
    for (const c of n.children) walk(c);
  };
  walk(rootId);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">` +
    (defs.items.length ? `<defs>${defs.items.join("")}</defs>` : "") +
    `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#FFFFFF"/>` +
    body.join("") +
    (opts.marks ? `<g class="som-layer">${markRects.join("")}</g>` : "") +
    `</svg>`;

  return { svg, markMap };
}
