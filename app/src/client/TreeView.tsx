// The Layers tree (§5.6): a Figma/Claude-design-style outline of the whole scene
// graph, read off the read-only docMirror. Clicking a row selects the node (single,
// or shift/⌘/ctrl to toggle a multi-select) — the SAME selection path the canvas
// uses (docMirror.setSelection + a {t:"select"} frame). Dragging a row reparents the
// node: dropping ONTO a frame nests it inside; dropping between rows moves it into
// that row's parent at the drop index. Structural edits ship `reparentNodes`, exactly
// like the agent. Everything is LOCKED while a run is active (single-writer guard).

import { useState } from "react";
import { ChevronDown, ChevronRight, Circle, Frame, Minus, PenTool, Square, Type } from "lucide-react";
import { docMirror, useDocVersion, useRunState } from "./stores.js";
import { send, sendTool } from "./ws.js";
import type { NodeId, NodeType } from "../shared/types.js";

// Where a drop would land relative to the hovered row.
type DropZone = "before" | "inside" | "after";
interface DropTarget {
  id: NodeId;
  zone: DropZone;
}

const ROW_HEIGHT = 26;
const INDENT = 14; // px of indent added per depth level

// Per-type leading glyph so each row reads at a glance (mirrors the toolbar icons).
function NodeIcon({ type }: { type: NodeType }) {
  const size = 13;
  switch (type) {
    case "FRAME":
    case "GROUP":
    case "COMPONENT":
    case "INSTANCE":
      return <Frame size={size} />;
    case "TEXT":
      return <Type size={size} />;
    case "RECT":
      return <Square size={size} />;
    case "ELLIPSE":
      return <Circle size={size} />;
    case "VECTOR":
      return <PenTool size={size} />;
    default:
      return <Minus size={size} />;
  }
}

export function TreeView() {
  useDocVersion(); // re-render on doc (version) AND selection changes
  const run = useRunState();
  const runActive =
    run.phase !== "IDLE" && run.phase !== "DONE" && run.phase !== "ESCALATED";

  const store = docMirror.store;
  const root = store.getNode(store.rootId);

  // Collapsed subtrees (local view state). Default expanded — absence = open.
  const [collapsed, setCollapsed] = useState<Set<NodeId>>(new Set());
  // The node id being dragged, and the live drop target (row + zone) under the cursor.
  const [dragId, setDragId] = useState<NodeId | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  if (!root) return <div className="empty-state">No document.</div>;

  function toggle(id: NodeId) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Selection — identical semantics to the canvas click path.
  function selectRow(id: NodeId, additive: boolean) {
    const cur = docMirror.selection;
    let next: NodeId[];
    if (additive) next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    else next = [id];
    docMirror.setSelection(next);
    send({ t: "select", ids: next });
  }

  // The set of ids a drag may NOT drop onto: the node itself + its whole subtree
  // (reparenting into a descendant would corrupt the tree — the server rejects it).
  function subtree(id: NodeId, into: Set<NodeId>) {
    into.add(id);
    const n = store.getNode(id);
    if (n) for (const c of n.children) subtree(c, into);
  }

  // Resolve a drop (dragId onto target) into a structural edit. A move to a DIFFERENT
  // parent ships `reparentNodes`; a move WITHIN the current parent ships `reorderChild`
  // (restack among siblings). Self/descendant drops and no-op moves are dropped here so
  // they never hit the server.
  function commitDrop(id: NodeId, target: DropTarget) {
    const dragged = store.getNode(id);
    if (!dragged) return;
    const excl = new Set<NodeId>();
    subtree(id, excl);
    if (excl.has(target.id)) return; // onto self / own descendant

    // Resolve the destination parent + the insertion index in that parent's CURRENT
    // children array (the array as displayed, still containing the dragged node).
    let parentId: NodeId;
    let insertAt: number; // index in the current array; Infinity = append
    if (target.zone === "inside") {
      parentId = target.id; // nest at the end of the frame
      insertAt = Infinity;
    } else {
      const tNode = store.getNode(target.id);
      if (!tNode || !tNode.parent) return; // can't place a sibling of the root
      parentId = tNode.parent;
      const pos = (store.getNode(parentId)?.children ?? []).indexOf(target.id);
      insertAt = target.zone === "before" ? pos : pos + 1;
    }

    if (parentId === dragged.parent) {
      // Same parent → reorder. Translate the current-array insertion point into the
      // node's FINAL 0-based index, accounting for its own removal shifting later items.
      const siblings = store.getNode(parentId)?.children ?? [];
      const from = siblings.indexOf(id);
      const clamped = Math.min(insertAt, siblings.length); // Infinity (append) → length
      const finalIndex = Math.max(0, Math.min(from < clamped ? clamped - 1 : clamped, siblings.length - 1));
      if (finalIndex === from) return; // no-op
      sendTool("reorderChild", { id, index: finalIndex });
    } else {
      sendTool(
        "reparentNodes",
        insertAt === Infinity ? { id, parent: parentId } : { id, parent: parentId, index: insertAt },
      );
    }
  }

  return (
    <div
      style={{ userSelect: "none", opacity: runActive ? 0.55 : 1, maxHeight: "34vh", overflowY: "auto" }}
      onDragLeave={(e) => {
        // Only clear when the pointer truly leaves the tree (not on child crossings).
        if (!e.currentTarget.contains(e.relatedTarget as HTMLElement | null)) setDropTarget(null);
      }}
    >
      <Rows
        id={store.rootId}
        depth={0}
        store={store}
        collapsed={collapsed}
        selection={docMirror.selection}
        runActive={runActive}
        dragId={dragId}
        dropTarget={dropTarget}
        onToggle={toggle}
        onSelect={selectRow}
        onDragStart={setDragId}
        onDragEnd={() => {
          setDragId(null);
          setDropTarget(null);
        }}
        onDropTarget={setDropTarget}
        onCommitDrop={(t) => {
          if (dragId) commitDrop(dragId, t);
        }}
      />
    </div>
  );
}

interface RowsProps {
  id: NodeId;
  depth: number;
  store: typeof docMirror.store;
  collapsed: Set<NodeId>;
  selection: NodeId[];
  runActive: boolean;
  dragId: NodeId | null;
  dropTarget: DropTarget | null;
  onToggle: (id: NodeId) => void;
  onSelect: (id: NodeId, additive: boolean) => void;
  onDragStart: (id: NodeId) => void;
  onDragEnd: () => void;
  onDropTarget: (t: DropTarget | null) => void;
  onCommitDrop: (t: DropTarget) => void;
}

// One row + (when expanded) its children, recursively. The root frame renders as the
// tree's top row so the whole graph hangs off a single visible ancestor.
function Rows(props: RowsProps) {
  const { id, depth, store, collapsed } = props;
  const node = store.getNode(id);
  if (!node) return null;

  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(id);
  const selected = props.selection.includes(id);
  const isDragging = props.dragId === id;
  const isFrame =
    node.type === "FRAME" || node.type === "GROUP" || node.type === "COMPONENT" || node.type === "INSTANCE";
  const dt = props.dropTarget?.id === id ? props.dropTarget.zone : null;

  // Classify the hover position into before / inside / after. Only frames accept an
  // "inside" drop (everything else only gets a sibling line above/below).
  function zoneAt(e: React.DragEvent): DropZone {
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    if (isFrame) {
      if (y < r.height * 0.28) return "before";
      if (y > r.height * 0.72) return "after";
      return "inside";
    }
    return y < r.height / 2 ? "before" : "after";
  }

  return (
    <>
      <div
        draggable={!props.runActive && depth > 0}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          props.onDragStart(id);
        }}
        onDragEnd={props.onDragEnd}
        onDragOver={(e) => {
          if (props.runActive || !props.dragId || props.dragId === id) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const zone = zoneAt(e);
          if (props.dropTarget?.id !== id || props.dropTarget.zone !== zone)
            props.onDropTarget({ id, zone });
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (props.dropTarget) props.onCommitDrop(props.dropTarget);
          props.onDragEnd();
        }}
        onClick={(e) => props.onSelect(id, e.shiftKey || e.metaKey || e.ctrlKey)}
        title={`${node.name} · ${node.type}`}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: ROW_HEIGHT,
          paddingLeft: 6 + depth * INDENT,
          paddingRight: 6,
          borderRadius: 6,
          cursor: props.runActive ? "default" : "pointer",
          opacity: isDragging ? 0.4 : 1,
          color: selected ? "#fff" : "var(--text)",
          background: selected
            ? "var(--accent, #2563eb)"
            : dt === "inside"
              ? "rgba(37,99,235,0.12)"
              : "transparent",
          outline: dt === "inside" ? "1px solid var(--accent, #2563eb)" : "none",
          outlineOffset: -1,
        }}
      >
        {/* Sibling drop lines: a crisp rule at the row's top or bottom edge. */}
        {dt === "before" && <DropLine pos="top" />}
        {dt === "after" && <DropLine pos="bottom" />}

        {/* Expand / collapse twisty — only when there are children. */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) props.onToggle(id);
          }}
          style={{
            width: 14,
            display: "inline-flex",
            justifyContent: "center",
            color: selected ? "rgba(255,255,255,0.85)" : "var(--muted, #9ca3af)",
            cursor: hasChildren ? "pointer" : "default",
          }}
        >
          {hasChildren ? (
            isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />
          ) : null}
        </span>

        <span
          style={{
            display: "inline-flex",
            color: selected ? "rgba(255,255,255,0.9)" : "var(--muted, #6b7280)",
          }}
        >
          <NodeIcon type={node.type} />
        </span>

        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12.5,
            fontWeight: selected ? 600 : 400,
          }}
        >
          {node.name}
        </span>
      </div>

      {hasChildren &&
        !isCollapsed &&
        node.children.map((c) => <Rows key={c} {...props} id={c} depth={depth + 1} />)}
    </>
  );
}

function DropLine({ pos }: { pos: "top" | "bottom" }) {
  return (
    <span
      style={{
        position: "absolute",
        left: 4,
        right: 4,
        [pos]: -1,
        height: 2,
        borderRadius: 2,
        background: "var(--accent, #2563eb)",
        pointerEvents: "none",
      }}
    />
  );
}
