// THE SHARED DRAW TABLE — the single source of pixels (IMPLEMENTATION.md §5.2).
//
// `buildSvg(store, rootId, opts)` walks the scene graph in deterministic pre-order
// DFS and emits ONE SVG string via a per-node-type table of string-builders. The
// browser injects this exact string into the DOM; the server (later milestone) will
// rasterize the IDENTICAL string with @resvg/resvg-js. There is no parallel renderer.
//
// Every element carries `data-node-id` so selection is a DOM hit-test.

import type { Node, NodeId } from "../shared/types.js";
import type { DocStore } from "../shared/store.js";

export interface BuildOpts {
  /** Draw the numbered set-of-marks overlay (the agent's vision channel). */
  marks?: boolean;
  /** Long-edge pixel cap; pinned by the rasterizer later. Carried for parity. */
  maxPx?: number;
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
const fillColor = (n: Node) => n.style?.fills?.find((f) => f.type === "SOLID")?.color;
const fill = (n: Node) => `fill="${fillColor(n) ?? "none"}"`;
// Border, when present — what keeps a white card visible on the white page.
const stroke = (n: Node) => {
  const s = n.style?.stroke;
  return s ? ` stroke="${s.color}" stroke-width="${num(s.weight ?? 1)}"` : "";
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- the draw table: one string-builder per node type ----
type DrawFn = (n: Node) => string;

const DRAW: Record<Node["type"], DrawFn> = {
  RECT: (n) =>
    `<rect ${pos(n)} ${fill(n)}${stroke(n)} rx="${num(n.style?.cornerRadius ?? 0)}" data-node-id="${n.id}"/>`,

  ELLIPSE: (n) =>
    `<ellipse cx="${cx(n)}" cy="${cy(n)}" rx="${num(n.bbox[2] / 2)}" ry="${num(
      n.bbox[3] / 2,
    )}" ${fill(n)}${stroke(n)} data-node-id="${n.id}"/>`,

  TEXT: (n) => {
    const fs = n.text?.fontSize ?? 16;
    const fw = n.text?.fontWeight ?? 400;
    const color = fillColor(n) ?? "#111111";
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
    return (
      `<text x="${tx}" y="${ty}" font-family="Inter, system-ui, sans-serif" ` +
      `font-size="${fs}" font-weight="${fw}" fill="${color}" ` +
      `text-anchor="${anchor}" data-node-id="${n.id}">${esc(n.text?.chars ?? "")}</text>`
    );
  },

  FRAME: (n) =>
    `<rect ${pos(n)} ${fill(n)}${stroke(n)} rx="${num(n.style?.cornerRadius ?? 0)}" data-node-id="${n.id}"/>`,

  // reserved types — additive. Stubbed to '' until their milestone.
  VECTOR: () => "",
  COMPONENT: () => "",
  INSTANCE: () => "",
  GROUP: () => "",
};

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
  const [vx, vy, vw, vh] = root.bbox.map(num);
  const body: string[] = [];
  const markRects: string[] = [];
  const markMap: Record<string, NodeId> = {};
  let mark = 0;

  const walk = (id: NodeId) => {
    const n = store.getNode(id);
    if (!n) return;
    body.push(DRAW[n.type](n));
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
    `<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#FFFFFF"/>` +
    body.join("") +
    (opts.marks ? `<g class="som-layer">${markRects.join("")}</g>` : "") +
    `</svg>`;

  return { svg, markMap };
}
