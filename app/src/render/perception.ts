// The real hybrid perception API (IMPLEMENTATION.md §5.2, §6 Day 4 row).
//
// Two entry points behind the fixed envelope {tree | image, markMap, version}:
//   - getTree(store, rootId, {depth, fields}) — scoped, depth-limited, FIELD-PROJECTED
//     structured read. Skeleton by default (id,type,name,bbox,childCount); opt-in
//     fields (style/text/layout) only when the task needs them. This projection is
//     the single biggest token lever: full-fields is a ~5x blowup (§4.4).
//   - render(store, rootId, {marks, maxPx}) — the marked image. PNG via raster.ts
//     when resvg is available, else the svg string + a note. Always returns markMap
//     + version so addressing works even without raster.
//
// Tools take NodeIds only; the agent resolves markMap[n] -> NodeId before any call.

import type { DocStore } from "../shared/store.js";
import type { Node, NodeId } from "../shared/types.js";
import { renderPng } from "./raster.js";

// ---- getTree: scoped, depth-limited, field-projected structured read ----

// Skeleton fields (id,type,name,bbox,childCount) are ALWAYS emitted; everything
// else is opt-in via `fields` — the big token lever.

/** Projectable opt-in fields (must be keys of Node that carry per-task detail). */
export type ProjectableField = "style" | "text" | "layout";

export interface TreeNode {
  id: NodeId;
  type: Node["type"];
  name: string;
  bbox: Node["bbox"];
  childCount: number;
  // opt-in projected fields
  style?: Node["style"];
  text?: Node["text"];
  layout?: Node["layout"];
}

export interface GetTreeOpts {
  /** Levels below rootId to include. Default 2 (working frame + its children). */
  depth?: number;
  /** Opt-in fields to project onto each node beyond the skeleton. */
  fields?: ProjectableField[];
}

export interface GetTreeOk {
  nodes: TreeNode[];
  version: number;
}
export interface GetTreeError {
  error: "BAD_ID";
  detail: string;
}
export type GetTreeResult = GetTreeOk | GetTreeError;

export function getTree(
  store: DocStore,
  rootId: NodeId,
  opts: GetTreeOpts = {},
): GetTreeResult {
  if (!store.has(rootId)) return { error: "BAD_ID", detail: rootId };
  const depth = opts.depth ?? 2;
  const fields = opts.fields ?? [];
  const nodes: TreeNode[] = [];

  const walk = (id: NodeId, d: number) => {
    const n = store.getNode(id);
    if (!n) return;
    const row: TreeNode = {
      id: n.id,
      type: n.type,
      name: n.name,
      bbox: n.bbox,
      childCount: n.children.length,
    };
    for (const f of fields) {
      const v = n[f];
      if (v !== undefined) (row as unknown as Record<string, unknown>)[f] = v; // project task-relevant fields only
    }
    nodes.push(row);
    if (d < depth) for (const c of n.children) walk(c, d + 1);
  };
  walk(rootId, 0);
  return { nodes, version: store.version };
}

// ---- fieldsFor: task-intent -> projected fields (keeps a turn near ~3k tokens) ----

export type TaskHint = "layout" | "restyle" | "copy" | "create" | "skeleton";

/**
 * Map a coarse task hint to the fields worth projecting. The loop calls this so a
 * layout task pays for layout fields, a restyle pays for style, etc. — never a full
 * dump. Unknown / skeleton hints project nothing (the cheapest read).
 */
export function fieldsFor(taskHint: TaskHint | string | undefined): ProjectableField[] {
  switch (taskHint) {
    case "layout":
      // spec mapping is layout -> [bbox, layout]; bbox already ships in the
      // skeleton, so only `layout` needs projecting.
      return ["layout"];
    case "restyle":
      return ["style"];
    case "copy":
      return ["text"];
    case "create":
      // creating below/inside needs to know neighbours' boxes (already skeleton) +
      // a little layout context to place things sanely.
      return ["layout"];
    default:
      return [];
  }
}

// ---- render: the marked vision channel (PNG via raster.ts, or svg + note) ----

export interface RenderOpts {
  marks?: boolean;
  maxPx?: number;
}

export interface RenderOk {
  /** base64 PNG (no data: prefix) — ready for an Anthropic image content block. */
  image: string;
  width: number;
  height: number;
  svg: string;
  markMap: Record<string, NodeId>;
  version: number;
  rasterAvailable: true;
}
export interface RenderFallback {
  /** raster unavailable on this platform — svg string is the carrier instead. */
  rasterAvailable: false;
  note: string;
  svg: string;
  markMap: Record<string, NodeId>;
  version: number;
}
export interface RenderError {
  error: "BAD_ID";
  detail: string;
}
export type RenderResult = RenderOk | RenderFallback | RenderError;

export async function render(
  store: DocStore,
  rootId: NodeId,
  opts: RenderOpts = {},
): Promise<RenderResult> {
  if (!store.has(rootId)) return { error: "BAD_ID", detail: rootId };
  const r = await renderPng(store, rootId, { marks: opts.marks ?? true, maxPx: opts.maxPx ?? 1024 });

  if (!r.rasterAvailable) {
    return {
      rasterAvailable: false,
      note:
        `Raster unavailable (${r.reason}). Falling back to the SVG string as the ` +
        `vision carrier; markMap + version are still valid so addressing works.`,
      svg: r.svg,
      markMap: r.markMap,
      version: r.version,
    };
  }

  return {
    rasterAvailable: true,
    image: r.png.toString("base64"),
    width: r.width,
    height: r.height,
    svg: r.svg,
    markMap: r.markMap,
    version: r.version,
  };
}
