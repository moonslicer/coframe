// The document store: the ONE write path (commit), boundary validation, and the
// pure applyOps reducer. Mirrors IMPLEMENTATION.md §5.1.

import type { DocVersion, Node, NodeId, Op, ToolResult } from "./types.js";

/** Pure reducer. Clones the whole map (demo docs are small) so a snapshot can
 *  never be mutated by reference. */
export function applyOps(
  nodes: ReadonlyMap<NodeId, Node>,
  ops: Op[],
): Map<NodeId, Node> {
  const next = new Map<NodeId, Node>();
  for (const [k, v] of nodes) next.set(k, structuredClone(v));

  const removeSubtree = (id: NodeId) => {
    const n = next.get(id);
    if (!n) return;
    for (const c of [...n.children]) removeSubtree(c);
    next.delete(id);
  };

  for (const op of ops) {
    if (op.kind === "add") {
      next.set(op.node.id, structuredClone(op.node));
      if (op.node.parent) {
        const p = next.get(op.node.parent);
        if (p) {
          if (op.index == null) p.children.push(op.node.id);
          else p.children.splice(op.index, 0, op.node.id);
        }
      }
    } else if (op.kind === "remove") {
      const n = next.get(op.id);
      if (n?.parent) {
        const p = next.get(n.parent);
        if (p) p.children = p.children.filter((c) => c !== op.id);
      }
      removeSubtree(op.id);
    } else if (op.kind === "set") {
      const n = next.get(op.id);
      if (n) setPath(n as unknown as Record<string, unknown>, op.path, op.value);
    } else if (op.kind === "reparent") {
      const n = next.get(op.id);
      if (!n) continue;
      if (n.parent) {
        const old = next.get(n.parent);
        if (old) old.children = old.children.filter((c) => c !== op.id);
      }
      n.parent = op.parent;
      const np = next.get(op.parent);
      if (np) np.children.splice(op.index, 0, op.id);
    }
  }
  return next;
}

/** Dotted-path setter: "bbox" | "style.fills" | "layout" | "text.chars" ... */
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export class DocStore {
  private nodes = new Map<NodeId, Node>();
  private _rootId: NodeId = "";
  private _version: DocVersion = 0;
  private idSeq = 0; // injected determinism — no Math.random in tools

  get rootId() {
    return this._rootId;
  }
  get version() {
    return this._version;
  }
  getNode(id: NodeId) {
    return this.nodes.get(id);
  }
  has(id: NodeId) {
    return this.nodes.has(id);
  }
  all(): ReadonlyMap<NodeId, Node> {
    return this.nodes;
  }
  count() {
    return this.nodes.size;
  }
  newId(): NodeId {
    return `node:${++this.idSeq}`;
  }

  loadSeed(seed: { rootId: NodeId; nodes: Node[] }) {
    this.nodes = new Map(seed.nodes.map((n) => [n.id, structuredClone(n)]));
    this._rootId = seed.rootId;
    this._version = 1;
    this.idSeq = seed.nodes.length; // new ids won't collide with named seed ids
  }

  /** THE chokepoint. boundary-validate -> apply (pure) -> bump version. */
  commit(ops: Op[], baseVersion: DocVersion): ToolResult {
    if (baseVersion !== this._version)
      return { error: "STALE", detail: `base ${baseVersion} != ${this._version}` };
    for (const op of ops) {
      // perception-spec §6: kill hallucinated-id corruption before it mutates the doc
      const ref =
        op.kind === "add"
          ? op.node.parent
          : "id" in op
            ? op.id
            : null;
      if (ref && !this.nodes.has(ref))
        return { error: "BAD_ID", detail: `unknown node ${ref}` };
    }
    this.nodes = applyOps(this.nodes, ops);
    this._version += 1;
    return { ops, version: this._version };
  }
}
