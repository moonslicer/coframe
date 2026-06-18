# Tool Vocabulary — Concrete Spec

The "what the agent can **do**" half. Pairs with `perception-spec.md` ("what it can see").
Decision #2: a high-level **semantic** mutation API + a low-level escape hatch. Each call is an
atomic transaction (decision #3), returns a diff (not full state), and operates on stable
`NodeId`s from perception.

## 1. Design principles

- **Semantic over primitive.** `applyAutoLayout(frame, {dir:'V', gap:16})` not 20 `setProperty`
  calls. Matches designer intent, fewer tokens, fewer ways to be wrong.
- **Semantic coordinates over raw pixels.** Prefer `placeBelow(target, {gap:16})` and
  `align(ids, 'LEFT')` over `setPosition(x,y)`. Robust to canvas changes, far less hallucination.
- **Explicit id sets, not implicit "current selection."** The agent passes the ids it means; no
  hidden state to desync.
- **Atomic + labeled.** One tool call = one undo step. A multi-tool task is wrapped in a named
  transaction so the human sees "Agent: add a pricing section," not 200 micro-edits.
- **Diff in, diff out.** Every mutation returns `{ops, version}` — feeds straight back into
  perception's running model (`getChanges`). No re-dump.
- **Validate at the boundary.** Bad id / constraint violation / stale version → structured error,
  agent retries or re-perceives. Never silently corrupt the doc.
- **Previewable.** `dryRun: true` returns the diff without committing → supports the "preview
  before apply" safety property.

## 2. Granularity tradeoff (the core decision)

| Approach | Pro | Con |
|----------|-----|-----|
| Few low-level primitives | tiny API surface | agent composes everything → token-heavy, error-prone |
| Many hyper-specific tools | each call trivial | prompt bloat, tool-selection overhead, maintenance |
| **~20 semantic tools + escape hatch** | covers ~90% of intent cheaply, rare cases still reachable | must curate the vocabulary |

Pick the middle. The escape hatch (`setProperty`/`batch`) means coverage is never blocked by the
curated set — the same lesson as Claude Code: good tools beat raw primitives, but keep a primitive.

## 3. The tool set

```ts
// ---- Create ----
createFrame(parent, { bbox?, name? }): NodeId
createText(parent, { chars, at?, style? }): NodeId
createShape(parent, { kind:'RECT'|'ELLIPSE'|'LINE', bbox }): NodeId
createInstance(componentId, parent, { at? }): NodeId

// ---- Structure ----
reparent(ids, newParent, { index? })        // move in hierarchy
reorder(ids, 'FRONT'|'BACK'|'FORWARD'|'BACK')// z-order
group(ids, { name? }): NodeId
ungroup(groupId)
duplicate(ids, { offset? }): NodeId[]
remove(ids)

// ---- Transform (semantic-first) ----
placeBelow|placeRightOf(ids, target, { gap? })
align(ids, 'LEFT'|'RIGHT'|'TOP'|'BOTTOM'|'CENTER_X'|'CENTER_Y')
distribute(ids, 'HORIZONTAL'|'VERTICAL', { gap? })
resize(id, { w?, h? })
setPosition(id, { x, y })                    // raw — use when semantic won't do

// ---- Layout ----
applyAutoLayout(frame, { dir:'H'|'V', gap?, padding?, align? })
setConstraints(id, { horizontal, vertical })

// ---- Style ----
setFill(ids, paint)                          // paint = solid|gradient|image
setStroke(ids, { paint, weight, align })
setEffect(ids, effect)                       // shadow|blur
setOpacity(ids, n); setCornerRadius(ids, n)

// ---- Text ----
setText(id, chars)
setTextStyle(ids, { fontSize?, fontWeight?, align?, color? })

// ---- Component ----
createComponent(ids): NodeId
detachInstance(id)
setOverride(instanceId, path, value)

// ---- Escape hatch ----
setProperty(id, path, value)                 // arbitrary single property
batch(ops: Op[])                             // multiple primitives, one transaction
```

All mutating calls share the envelope:
```ts
(args, opts?: { dryRun?: boolean; txnLabel?: string })
  => { ops: Op[]; version: DocVersion } | { error: 'BAD_ID'|'STALE'|'CONSTRAINT'; detail }
```

## 4. Transaction semantics (ties to decision #3)

- Each tool call commits atomically through the multiplayer layer = one undo unit.
- For a multi-step task the agent opens a labeled transaction; nested tool calls coalesce into one
  human-visible step. Partial failure rolls back the whole txn (don't leave the doc half-edited).
- A `STALE` error (human edited concurrently) aborts the txn → agent re-perceives → retries. Staleness
  is detected by the **server-assigned incrementing version** (Figma's actual mechanism), not a
  vector clock — the server serializes all changes, so a single integer suffices.

## 5. Worked example (perception → action loop)

```
img, markMap = render(heroFrame, marks=true)     # sees [1] logo, [2] headline, [3] CTA
# intent: "stack the hero contents with even spacing"
beginTxn("tidy hero")
  applyAutoLayout(markMap["heroFrame"], {dir:'V', gap:24, align:'CENTER_X'})
  setTextStyle([markMap["2"]], {fontSize:48, fontWeight:700})
commitTxn()                                       # one undo step for the human
diff = getChanges(since=version)                  # patch running model, no re-dump
```

## 6. Failure modes (interview attack surface)

| Failure | Defense |
|---------|---------|
| Agent emits raw coords that overlap existing nodes | prefer semantic placement; structural verify catches overlap |
| Stale version mid-transaction | `STALE` error → rollback → re-perceive → retry |
| Constraint/layout conflict (e.g. auto-layout + fixed pos) | boundary validation returns `CONSTRAINT`, agent adapts |
| Tool-selection errors from too-big API | keep ~20 curated tools; escape hatch for the long tail |
| Destructive op on wrong node | `dryRun` preview + atomic undo |

## 7. The two things to defend
1. **Semantic-first interface** (intent-level tools + semantic coordinates) — fewer tokens, fewer
   hallucinations, human-legible undo steps.
2. **Atomic labeled transactions with diff-return** — safety (clean undo) + efficiency (no re-dump)
   in one mechanism, and the join point with both perception and concurrency.
