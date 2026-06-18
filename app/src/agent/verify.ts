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
import type { SuccessCriterion } from "./types.js";

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

/** Resolve a node CREATED during the run by parent + type + optional name substring. */
function findChild(
  store: DocStore,
  parentId: NodeId,
  type: Node["type"],
  nameLike: string | undefined,
): Node | undefined {
  const parent = store.getNode(parentId);
  if (!parent) return undefined;
  const want = nameLike?.toLowerCase();
  return parent.children
    .map((id) => store.getNode(id))
    .find(
      (c): c is Node =>
        !!c && c.type === type && (want === undefined || c.name.toLowerCase().includes(want)),
    );
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
      return {
        ok: actual === criterion.count,
        evidence: `${frame.id} ("${frame.name}") has ${actual} child(ren), wanted ${criterion.count}`,
      };
    }

    case "childCount": {
      const frame = store.getNode(criterion.frameId);
      if (!frame)
        return { ok: false, evidence: `frame ${criterion.frameId} does not exist` };
      const actual = frame.children.length;
      return {
        ok: actual === criterion.count,
        evidence: `${criterion.frameId} has ${actual} child(ren), wanted ${criterion.count}`,
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
