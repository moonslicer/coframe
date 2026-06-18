// Tier-1 structural verification (§5.4, decision #4 default). NO model call.
//
// verifyStructural evaluates a step's plan-supplied SuccessCriterion against the
// LIVE post-commit doc state. Critically the criterion asserts the target node's
// STATE, not "did the tool I just called commit" — commit() already guarantees the
// ops landed, so checking that would be a tautology. This check can (and must be able
// to) DISAGREE with the tool calls, which is what gives the honest done/couldn't
// status its teeth.

import type { DocStore } from "../shared/store.js";
import type { Node, NodeId } from "../shared/types.js";
import type { Step, SuccessCriterion } from "./types.js";

export interface VerifyResult {
  ok: boolean;
  evidence: string;
}

/** Read a dotted path off live node state ("layout.mode", "bbox", "style.fills"). */
function readPath(node: Node, path: string): unknown {
  let cur: unknown = node;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Structural equality good enough for criterion values (primitives + JSON shapes). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a == null || b == null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

const bottom = (n: Node): number => n.bbox[1] + n.bbox[3];

const CONTENT_CONTEXT_RE =
  /\b(forecast|weather|hourly|daily|card|row|list|button|pricing|tier|task|stat|metric|dashboard|schedule|table)\b/i;
const PLACEHOLDER_CONTEXT_RE = /\b(placeholder|skeleton|wireframe|empty|outline|lo-fi|low fidelity)\b/i;

function isContentBearingFrameName(name: string, context: string): boolean {
  const lower = name.toLowerCase();
  if (/\b(hour\s*\d+|day\s+row|forecast\s+card)\b/.test(lower)) return true;
  if (/\b(card|button|tier|plan|task|stat|metric|item)\b/.test(lower)) return true;
  return /\brow\b/.test(lower) && /\b(forecast|daily|hourly|weather|task|list|table|schedule)\b/.test(context);
}

/** Does this frame hold any VISIBLE content anywhere in its subtree — a non-empty
 *  TEXT, or a shape (RECT/ELLIPSE)? Icon rows (nav bars, playback control rows, tab
 *  bars) are legitimately text-free: they hold only shapes. Requiring TEXT alone
 *  false-rejected those finished frames as "blank", failing the whole run on a
 *  correctly-built screen. A frame counts as populated if it has text OR a shape. */
function hasContentDescendant(store: DocStore, id: NodeId): boolean {
  const node = store.getNode(id);
  if (!node) return false;
  const queue: NodeId[] = [...node.children];
  while (queue.length) {
    const child = store.getNode(queue.shift()!);
    if (!child) continue;
    if (child.type === "TEXT" && child.text?.chars.trim()) return true;
    if (child.type === "RECT" || child.type === "ELLIPSE") return true;
    queue.push(...child.children);
  }
  return false;
}

function hasCandidateDescendant(store: DocStore, id: NodeId, candidateIds: ReadonlySet<NodeId>): boolean {
  const node = store.getNode(id);
  if (!node) return false;
  const queue: NodeId[] = [...node.children];
  while (queue.length) {
    const childId = queue.shift()!;
    if (candidateIds.has(childId)) return true;
    const child = store.getNode(childId);
    if (child) queue.push(...child.children);
  }
  return false;
}

export function verifyContentCompleteness(args: {
  intent: string;
  step: Step;
  store: DocStore;
  rootId: NodeId;
  originalIds?: ReadonlySet<NodeId>;
}): VerifyResult {
  const context = `${args.intent} ${args.step.label} ${JSON.stringify(args.step.criterion)}`;
  if (!CONTENT_CONTEXT_RE.test(context) || PLACEHOLDER_CONTEXT_RE.test(context))
    return { ok: true, evidence: "content completeness not required" };

  const root = args.store.getNode(args.rootId);
  if (!root) return { ok: true, evidence: `root ${args.rootId} does not exist` };

  const candidates: Node[] = [];
  const walk = (id: NodeId) => {
    const node = args.store.getNode(id);
    if (!node) return;
    const isNew = !args.originalIds || !args.originalIds.has(node.id);
    if (
      isNew &&
      node.type === "FRAME" &&
      isContentBearingFrameName(node.name, context) &&
      !hasContentDescendant(args.store, node.id)
    ) {
      candidates.push(node);
    }
    for (const childId of node.children) walk(childId);
  };
  for (const childId of root.children) walk(childId);

  const candidateIds = new Set(candidates.map((n) => n.id));
  const blankLeafContainers = candidates.filter(
    (n) => !hasCandidateDescendant(args.store, n.id, candidateIds),
  );
  if (blankLeafContainers.length === 0)
    return { ok: true, evidence: "content-bearing frames have text descendants" };

  const names = blankLeafContainers
    .slice(0, 6)
    .map((n) => `${n.id} "${n.name}"`)
    .join(", ");
  const more = blankLeafContainers.length > 6 ? `, +${blankLeafContainers.length - 6} more` : "";
  return {
    ok: false,
    evidence: `blank content frame(s) need visible TEXT or shape children: ${names}${more}`,
  };
}

/** Resolve a node CREATED during the run by parent + type + optional name substring.
 *  Searches the WHOLE subtree under `parentId` breadth-first (shallowest match wins),
 *  not just its direct children. A criterion for a frame the plan CREATES can only
 *  anchor on an id that exists at plan time — almost always the page root — yet the
 *  frame itself often lives 2+ levels down (page > screen > section). A direct-children
 *  scan never found it, so the criterion could NEVER pass and the loop escalated with
 *  "Couldn't complete" on a canvas that was actually correct. BFS makes the anchor work
 *  at any depth while still preferring the outermost (section) frame over its children. */
function findChild(
  store: DocStore,
  parentId: NodeId,
  type: Node["type"],
  nameLike: string | undefined,
): Node | undefined {
  const parent = store.getNode(parentId);
  if (!parent) return undefined;
  const want = nameLike?.toLowerCase();
  const queue: NodeId[] = [...parent.children];
  while (queue.length) {
    const node = store.getNode(queue.shift()!);
    if (!node) continue;
    if (node.type === type && (want === undefined || node.name.toLowerCase().includes(want)))
      return node;
    queue.push(...node.children);
  }
  return undefined;
}

export function verifyStructural(
  criterion: SuccessCriterion,
  store: DocStore,
): VerifyResult {
  switch (criterion.kind) {
    case "nodeExists": {
      if (!store.getNode(criterion.parentId))
        return { ok: false, evidence: `parent ${criterion.parentId} does not exist` };
      const match = findChild(store, criterion.parentId, criterion.type, criterion.nameLike);
      if (match)
        return {
          ok: true,
          evidence: `found ${criterion.type} ${match.id} ("${match.name}") under ${criterion.parentId}`,
        };
      return {
        ok: false,
        evidence:
          `no ${criterion.type}` +
          (criterion.nameLike ? ` matching "${criterion.nameLike}"` : "") +
          ` found among children of ${criterion.parentId}`,
      };
    }

    case "childCountNamed": {
      const frame = findChild(store, criterion.parentId, criterion.type, criterion.nameLike);
      if (!frame)
        return {
          ok: false,
          evidence:
            `no ${criterion.type}` +
            (criterion.nameLike ? ` matching "${criterion.nameLike}"` : "") +
            ` found under ${criterion.parentId} to count children of`,
        };
      const actual = frame.children.length;
      // `count` is a MINIMUM, not an exact match: the planner guesses a card/row
      // count before the act model decides how many to build, so `===` false-rejects
      // a complete design that simply has a different (often larger) count. "Holds at
      // least N children" is the intent — populated, not blank.
      return {
        ok: actual >= criterion.count,
        evidence: `${frame.id} ("${frame.name}") has ${actual} child(ren), wanted >= ${criterion.count}`,
      };
    }

    case "childCount": {
      const frame = store.getNode(criterion.frameId);
      if (!frame)
        return { ok: false, evidence: `frame ${criterion.frameId} does not exist` };
      const actual = frame.children.length;
      // Minimum, not exact — see childCountNamed above.
      return {
        ok: actual >= criterion.count,
        evidence: `${criterion.frameId} has ${actual} child(ren), wanted >= ${criterion.count}`,
      };
    }

    case "prop": {
      const node = store.getNode(criterion.id);
      if (!node) return { ok: false, evidence: `node ${criterion.id} does not exist` };
      const actual = readPath(node, criterion.path);
      const ok = deepEqual(actual, criterion.equals);
      return {
        ok,
        evidence:
          `${criterion.id}.${criterion.path} = ${JSON.stringify(actual)}, ` +
          `wanted ${JSON.stringify(criterion.equals)}`,
      };
    }

    case "childProp": {
      if (!store.getNode(criterion.parentId))
        return { ok: false, evidence: `parent ${criterion.parentId} does not exist` };
      const match = findChild(store, criterion.parentId, criterion.type, criterion.nameLike);
      if (!match)
        return {
          ok: false,
          evidence:
            `no ${criterion.type}` +
            (criterion.nameLike ? ` matching "${criterion.nameLike}"` : "") +
            ` found under ${criterion.parentId} to check .${criterion.path}`,
        };
      const actual = readPath(match, criterion.path);
      const ok = deepEqual(actual, criterion.equals);
      return {
        ok,
        evidence:
          `${match.id} ("${match.name}").${criterion.path} = ${JSON.stringify(actual)}, ` +
          `wanted ${JSON.stringify(criterion.equals)}`,
      };
    }

    case "belowOf": {
      const node = store.getNode(criterion.id);
      const target = store.getNode(criterion.targetId);
      if (!node) return { ok: false, evidence: `node ${criterion.id} does not exist` };
      if (!target)
        return { ok: false, evidence: `target ${criterion.targetId} does not exist` };
      const ok = node.bbox[1] >= bottom(target);
      return {
        ok,
        evidence:
          `${criterion.id}.y = ${node.bbox[1]} vs ${criterion.targetId} bottom = ${bottom(target)} ` +
          `(below? ${ok})`,
      };
    }

    case "aligned": {
      const tol = criterion.tol ?? 1.5;
      const nodes = criterion.ids.map((id) => store.getNode(id));
      const missing = criterion.ids.filter((id) => !store.getNode(id));
      if (missing.length)
        return { ok: false, evidence: `node(s) ${missing.join(", ")} do not exist` };
      if (criterion.ids.length < 2)
        return { ok: false, evidence: `aligned needs 2+ ids, got ${criterion.ids.length}` };
      const edgeOf = (n: Node): number => {
        const [x, y, w, h] = n.bbox;
        switch (criterion.edge) {
          case "LEFT": return x;
          case "RIGHT": return x + w;
          case "CENTER_X": return x + w / 2;
          case "TOP": return y;
          case "BOTTOM": return y + h;
          case "CENTER_Y": return y + h / 2;
        }
      };
      const vals = (nodes as Node[]).map(edgeOf);
      const spread = Math.max(...vals) - Math.min(...vals);
      return {
        ok: spread <= tol,
        evidence: `${criterion.edge} of ${criterion.ids.length} nodes spread ${spread.toFixed(1)}px (tol ${tol}) — values ${vals.map((v) => v.toFixed(0)).join(",")}`,
      };
    }

    case "belowOfNamed": {
      const target = store.getNode(criterion.targetId);
      if (!target)
        return { ok: false, evidence: `target ${criterion.targetId} does not exist` };
      const node = findChild(store, criterion.parentId, criterion.type, criterion.nameLike);
      if (!node)
        return {
          ok: false,
          evidence:
            `no ${criterion.type}` +
            (criterion.nameLike ? ` matching "${criterion.nameLike}"` : "") +
            ` found under ${criterion.parentId} to position`,
        };
      const ok = node.bbox[1] >= bottom(target);
      return {
        ok,
        evidence:
          `${node.id} ("${node.name}").y = ${node.bbox[1]} vs ${criterion.targetId} bottom = ${bottom(target)} ` +
          `(below? ${ok})`,
      };
    }
  }
}

/** Narrow an unknown to a usable NodeId for criterion construction. */
export const asNodeId = (v: unknown): NodeId | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
