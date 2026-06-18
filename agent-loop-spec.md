# Agent Loop — Concrete Spec

The runtime that ties the four layers together. Input: a natural-language intent ("add a pricing
section that matches the hero"). Output: a committed, verified set of canvas mutations — or a clean
handback to the human. Grounded in `research-findings.md`: the **51.1% grounding ceiling** means the
loop is designed around *verify-and-recover*, not blind autonomy.

## 1. The loop

```
plan → perceive → act → verify → (reflect | escalate | done)
```

```ts
runTask(intent):
  plan = decompose(intent)              // ordered steps, each with a success check
  for step in plan:
    ctx   = perceive(step)              // scoped tree + marked render (perception-spec)
    txn   = beginTxn(step.label)
    try:
      ops = act(step, ctx)              // semantic tools (tool-vocabulary-spec)
      ok, evidence = verify(step, ops)  // structural by default (decision #4)
      if ok: commitTxn(txn)
      else:  abortTxn(txn); reflect(step, evidence)   // retry w/ correction, bounded
    catch STALE:    abortTxn(txn); re-perceive; retry(step)   // concurrency-spec
    catch CONSTRAINT/BAD_ID: abortTxn(txn); reflect(step)
    if attempts(step) > MAX or low_confidence(step): escalate(step)
  return summary(committed, skipped, escalated)
```

## 2. Plan — decompose before touching the canvas

- **Decompose** the intent into ordered steps, each with an explicit, checkable success criterion
  ("pricing card exists, auto-layout vertical, 3 tiers, aligned to hero's left edge").
- **Plan against names/structure, not pixels** — bind to the semantic index from perception, resolve
  to ids late. Robust to concurrent human edits.
- **Cheap plan, expensive act.** Planning is one perception + reasoning pass; don't over-plan a
  10-step lookahead that the first human edit invalidates. Re-plan is cheap; wasted acts are not.

## 3. Perceive — scoped, per step (not once up front)

- Re-perceive **per step**, scoped to the working region, because the doc moves under you (human
  edits, your own prior steps). Carry the `version`.
- Field-project to the step's need (layout step → geometry+layout; restyle → style). Recall UI
  representation is **80–99% of token cost** — this is where the loop's budget is won or lost.
- After your own mutation, prefer the **diff** (`getChanges`) over a fresh full read.

## 4. Act — semantic tools inside a transaction

- One step = one labeled transaction = one human-visible undo unit (concurrency-spec §5).
- Prefer semantic placement/layout tools over raw coords (fewer hallucinations, tool-vocabulary §1).
- `dryRun` the step first when the edit is destructive or low-confidence → preview the diff, then
  commit.

## 5. Verify — the heart of the loop (decision #4)

Tiered, cheapest-first:

| Tier | Check | Cost | When |
|------|-------|------|------|
| 1. Structural assertion | read back ops/tree: did the property/child/layout change as intended? | cheap | **every step** |
| 2. Spatial invariants | no unintended overlap, within parent bounds, alignment holds | cheap | layout/transform steps |
| 3. Vision re-check | render + marks, ask "does this match the intent / look right?" | expensive | end of task, or aesthetic steps, or on demand |

- **Structural catches "did it apply"; vision catches "does it look right."** Most steps need only
  tier 1. Reserve tier 3 — it's the same render path as perception, build once.
- A failed verify produces **evidence** (what's wrong) that feeds `reflect`.

## 6. Reflect & recover — bounded, evidence-driven

- On verify failure: feed the **specific evidence** back ("CTA overflows the frame by 40px") and
  retry the step with a correction — **bounded** (`MAX_ATTEMPTS`, e.g. 2–3). No infinite flailing.
- On `STALE`: not a failure — a concurrency event. Re-perceive, retry (the human just moved
  something). Distinguish these in telemetry.
- **Loop guard:** track attempts per step; identical failing op twice → stop retrying, escalate.

## 7. Escalate — designed-in, because of the 51.1% ceiling

The research is explicit: even with oracle grounding, the model fails ~half of complex tasks. So
**graceful handback is a first-class outcome, not an error path.**

Escalate when:
- attempts exceeded, or repeated identical failure
- ambiguous intent (multiple plausible targets — perception returned several name matches)
- low pre-commit confidence on a destructive op
- the step needs taste/judgment the structural checks can't adjudicate

Escalation UX: **partial progress is committed and labeled**, the agent states *what it did, what it's
unsure about, and the specific decision it needs* — and leaves the canvas in a clean, undoable state.
Never silently half-finish.

## 8. Context management (the agent runs long)

- The loop accumulates perceptions/acts/verifies → context grows. **Summarize older steps** to a
  compact running state ("built: pricing frame#abc with 3 tiers"); keep full detail only for the
  current step. (Mirrors Claude Code's own compaction.)
- The **running doc model is the durable memory** — patched by diffs — not the chat transcript.
  Perception re-grounds from the doc, so a summarized transcript loses little.

## 9. Failure modes (interview attack surface)

| Failure | Defense |
|---------|---------|
| Infinite retry on an impossible step | `MAX_ATTEMPTS` + identical-failure guard → escalate |
| Plan invalidated by human edit | per-step re-perceive + `STALE` handling; cheap re-plan |
| Verify passes structurally but looks wrong | tier-3 vision re-check at task end |
| Context blows up on long tasks | step summarization; doc model as durable memory |
| Silent half-done task | escalate = commit partial + labeled + explicit ask |
| Over-autonomy on ambiguous intent | escalate on multiple name matches / low confidence |

## 10. The two things to defend
1. **Verify-and-recover is the loop's backbone, not a bolt-on** — the 51.1% grounding ceiling makes
   tiered verification + bounded reflection + designed-in escalation the difference between a demo and
   a tool.
2. **Per-step scoped perception + transaction-per-step** — keeps token cost bounded (the 80–99%
   problem) and every action atomic, legible, and undoable under concurrent human editing.

> Full-system spine, one more time: **`{ops, version}`.** Perception emits it, tools return it,
> concurrency assigns/validates it, and the loop's verify/recover/escalate all pivot on it.
