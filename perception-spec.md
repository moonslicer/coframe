# Perception Layer — Concrete Spec

The agent must understand a 10k-node document it cannot afford to read. This spec makes the
hybrid perception layer buildable: data model, API contract, and the two algorithms that carry it
(progressive disclosure + set-of-marks).

## 1. Node model (what a scene-graph node is)

```ts
type NodeId = string;            // stable, survives moves/reorders (not an array index)

interface Node {
  id: NodeId;
  type: 'FRAME' | 'TEXT' | 'VECTOR' | 'COMPONENT' | 'INSTANCE' | 'GROUP';
  name: string;                  // semantic index — "CTA Button", "Hero"
  bbox: [x: number, y: number, w: number, h: number];
  parent: NodeId | null;
  children: NodeId[];            // ids only, not inlined
  // --- projectable fields (only sent when requested) ---
  style?: { fills?; strokes?; effects?; opacity? };
  text?: { chars: string; fontSize; fontWeight; align };
  layout?: { mode: 'NONE'|'HORIZONTAL'|'VERTICAL'; gap; padding; align };
  constraints?: { horizontal; vertical };
  component?: { mainId: NodeId; overrides? };
}
```

Default read returns only the **skeleton** — `{id, type, name, bbox, childCount}`. Everything under
"projectable fields" is opt-in via `fields`. This is the biggest single token lever — research
confirms **UI representation is 80–99% of an agent's total token cost** (arxiv 2512.13438), so
projecting only task-relevant fields attacks the dominant cost directly. (Advanced, emerging: a
*program-synthesis* representation — emit a compact program that reconstructs the subtree — cut
tokens 48.7–55.8% in UIFORMER; treat as a research lever, not a v1 requirement.)

## 2. Token math (why the API must be scoped)

| Strategy | Tokens / turn | Verdict |
|----------|---------------|---------|
| Full doc, all fields (10k nodes × ~300) | ~3,000,000 | impossible |
| Full doc, skeleton only (10k × ~25) | ~250,000 | still too big |
| Working frame, all fields (50 × 300) | ~15,000 | fine |
| Working frame skeleton + 1 marked render | ~3,000 | ideal default |

Conclusion: perception is **scoped + queryable + diff-based**, never a dump.

## 3. Perception API contract

```ts
// Structured read — scoped, depth-limited, field-projected
getTree(rootId: NodeId, opts: {
  depth?: number;          // default 1
  fields?: (keyof Node)[]; // default skeleton only
}): { nodes: Node[]; version: DocVersion }

// Annotated render — the vision channel
render(rootId: NodeId, opts: {
  marks?: boolean;         // overlay numbered bbox labels keyed to NodeId
  maxPx?: number;          // default 1024 on long edge
}): { image: ImageRef; markMap: Record<MarkId, NodeId>; version: DocVersion }

// Find nodes without scanning
query(pred:
  | { kind: 'region'; rect: Rect }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'name'; match: string }
  | { kind: 'selection' }
): { ids: NodeId[]; version: DocVersion }

// After a mutation: patch, don't re-dump
getChanges(since: DocVersion): { ops: Op[]; version: DocVersion }
```

Every response carries `version` — a **server-assigned monotonically incrementing integer** (this is
literally how Figma does it; no vector clock needed, the server serializes all changes). The agent
keeps a running model and patches it with `getChanges`.

## 4. Algorithm A — progressive disclosure

```
perceive(task):
  tree = getTree(currentPage, depth=1)          # pages + top frames, skeleton
  loop:
    target = pick frame by NAME/type matching task intent
    detail = getTree(target, depth=2,
                     fields=fieldsFor(task))     # e.g. layout task -> [bbox, layout]
    if ambiguous(detail): query(by name/region)  # resolve, don't expand blindly
    else: break
```
Field selection is task-driven: layout → `[bbox, layout, constraints]`; restyle → `[style]`;
copy edit → `[text]`. Depth caps + summarization prevent a huge frame from blowing the budget;
never auto-expand.

## 5. Algorithm B — set-of-marks (binds vision ↔ addressing)

The bridge that makes "hybrid" one system instead of two disconnected views.

```
img, markMap = render(target, marks=true)
# img shows numbered boxes [1][2][3]... drawn on each visible node
# markMap = { "1": "node:abc", "2": "node:def", ... }
# agent reasons spatially over img ("[3] overlaps [5]"), then acts on markMap[n]
```
Vision supplies what the tree can't cheaply express — alignment, overlap, visual hierarchy,
"does this look balanced." Marks supply the addressability vision lacks. Without marks the model
hallucinates references; with them, every visible thing is a typed, resolvable id. (SoM validated:
arxiv 2310.11441 / microsoft/SoM — GPT-4V with SoM beat prior SOTA on grounding.)

**Caveat — grounding is the ceiling, not the floor.** SeeAct (arxiv 2401.01614) found GPT-4V
completes only **51.1% of tasks even with *oracle* grounding** — "grounding is the bottleneck." Even
perfect addressing leaves the model failing ~half of complex edits. Implication: set-of-marks is
necessary but not sufficient — lean on structural verification (§7 / decision #4) and keep a human in
the loop for ambiguous edits. A native-id canvas should beat 51.1% (that number is web-DOM/GPT-4V
specific), but treat it as the cautionary baseline.

## 6. Grounding & staleness (concurrent human edits — decision #3)

- **Stable ids**: agent plans against ids, immune to reorder/move.
- **Version stamp on every perception**; mutations validated against it. On conflict the tool
  returns a structured error and the agent **re-perceives** rather than acting blind.
- **Id validation at the tool boundary**: unknown id → structured error → agent re-queries. Kills
  hallucinated references before they corrupt the doc.

## 7. Failure modes (interview attack surface)

| Failure | Defense |
|---------|---------|
| Human edits mid-plan → stale snapshot | version stamp + re-perceive |
| Hallucinated node id | validate at boundary, structured error, retry |
| Huge/deeply nested frame blows budget | depth caps + summarization, no auto-expand |
| Vision misreads dense canvas | marks + cross-check vs structured tree (= structural verify, decision #4) |

## 8. The two things to defend
1. **Set-of-marks** — binds vision ↔ addressing.
2. **Progressive disclosure + field projection** — binds 10k nodes ↔ token budget.

Perception and verification share machinery: the structural cross-check that catches a vision
misread *is* decision #4's structural assertion. Build it once.
