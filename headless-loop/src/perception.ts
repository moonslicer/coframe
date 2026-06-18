// Headless perception: a compact textual scene-graph the agent reads each turn.
// (In the full product this is the structured-tree half of the hybrid; the
//  set-of-marks rendered image is days 3-4 and intentionally NOT in this slice.)

import type { DocStore } from "./store.js";
import type { Node, NodeId } from "./types.js";

function describe(n: Node): string {
  const [x, y, w, h] = n.bbox.map(Math.round);
  const parts = [`${n.id} ${n.type} "${n.name}" bbox=[${x},${y},${w},${h}]`];
  if (n.text) parts.push(`text="${n.text.chars}" size=${n.text.fontSize} weight=${n.text.fontWeight}`);
  if (n.style?.fills?.[0]) parts.push(`fill=${n.style.fills[0].color}`);
  if (n.layout && n.layout.mode !== "NONE")
    parts.push(`layout=${n.layout.mode} gap=${n.layout.gap ?? 0}`);
  return parts.join(" ");
}

export function getTreeText(store: DocStore): string {
  const lines: string[] = [];
  const walk = (id: NodeId, depth: number) => {
    const n = store.getNode(id);
    if (!n) return;
    lines.push("  ".repeat(depth) + describe(n));
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(store.rootId, 0);
  return lines.join("\n");
}
