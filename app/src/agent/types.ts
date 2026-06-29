// Agent-loop types shared across the loop, the verifier, and the LLM adapter.
// The SuccessCriterion union is the §5.4 contract: a per-step, machine-checkable
// post-condition that asserts the TARGET NODE'S STATE — independent of which tools
// ran, so verify can disagree with the tool calls (not a tautology).

import type { InteractionAction, Node, NodeId } from "../shared/types.js";

export type SuccessCriterion =
  | { kind: "nodeExists"; parentId: NodeId; type: Node["type"]; nameLike?: string }
  | { kind: "childCount"; frameId: NodeId; count: number }
  // childCount but the frame is RESOLVED BY parent+type+name — to assert the child count
  // of a frame CREATED during the run (whose id is unknown at plan time).
  | {
      kind: "childCountNamed";
      parentId: NodeId;
      type: Node["type"];
      nameLike?: string;
      count: number;
    }
  | { kind: "prop"; id: NodeId; path: string; equals: unknown } // dotted path equals live state
  // Like `prop`, but the target node is RESOLVED BY parent+type+name instead of a fixed
  // id — the only way to assert a property of a node CREATED during the run (whose id is
  // unknown at plan time). Keeps verify reachable for the create-then-style/layout flow.
  | {
      kind: "childProp";
      parentId: NodeId;
      type: Node["type"];
      nameLike?: string;
      path: string;
      equals: unknown;
    }
  | { kind: "belowOf"; id: NodeId; targetId: NodeId } // bbox.y(id) >= bbox bottom(target)
  // A SET of existing nodes share an edge/center (the only way to verify an
  // align/distribute step — e.g. "the three titles are top-aligned"). All ids must
  // already exist; checks they agree on the chosen edge within `tol` px.
  | {
      kind: "aligned";
      ids: NodeId[];
      edge: "LEFT" | "RIGHT" | "TOP" | "BOTTOM" | "CENTER_X" | "CENTER_Y";
      tol?: number;
    }
  // belowOf but the moved node is RESOLVED BY parent+type+name — to assert a node CREATED
  // this run sits below an EXISTING `targetId`.
  | {
      kind: "belowOfNamed";
      parentId: NodeId;
      type: Node["type"];
      nameLike?: string;
      targetId: NodeId;
    }
  // --- prototype interactivity ---
  // The root holds at least `count` navigable screens (verifies a "build N screens" step).
  | { kind: "screenCount"; count: number }
  // A node carries a click interaction with `action`. The node is resolved by a fixed
  // existing `id`, OR (for a node created this run) by parent+type+name like childProp.
  | {
      kind: "hasInteraction";
      action: InteractionAction;
      id?: NodeId;
      parentId?: NodeId;
      type?: Node["type"];
      nameLike?: string;
    };

export interface Step {
  index: number;
  label: string;
  criterion: SuccessCriterion;
}
