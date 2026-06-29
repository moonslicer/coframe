# Concurrency & Merge — Concrete Spec

How human and agent edits to one document reconcile. Decision #3: the agent is **just another
participant** through the multiplayer layer; each agent action is **one atomic transaction**.
Grounded in Figma's actual approach (see `research-findings.md`): **server-authoritative,
last-writer-wins per property, NOT OT** — only CRDT-inspired.

## 1. The core decision: why not OT or CRDT?

| Model | Built for | Cost | Fit for a canvas |
|-------|-----------|------|------------------|
| OT (Operational Transform) | shared **text sequence** (Google Docs) | transform functions for every op pair — notoriously hard to get right | overkill; a canvas has no character sequence to reconcile |
| Full CRDT | offline-first, P2P, no central server | metadata overhead, tombstones, larger payloads | more than we need if we have a server |
| **Server-authoritative LWW-per-property** (Figma) | central server, independent object properties | trivial: server serializes, last write wins | **pick this** |

**The insight (interview gold):** a canvas is *not* a text buffer. Objects and their properties are
largely **independent** — two users editing `fill` and `x` of the same node don't conflict; two
users editing `fill` do, and last-writer-wins is a perfectly acceptable resolution (you never get a
corrupt merge, just one of two intended values). OT/CRDT exist to preserve *intention on a sequence*;
there's no sequence here. The **one** exception is child ordering — handled separately (§4).

## 2. Mechanics

- **Server is the source of truth.** Clients (human and agent) send changes; server applies, assigns
  a **monotonically incrementing integer version**, broadcasts to all clients.
- **Granularity = (objectId, property).** The unit of conflict is one property of one node, not the
  whole node. Concurrent edits to *different* properties of the same node both apply.
- **LWW resolution.** If two changes target the same (objectId, property), the one the server orders
  last wins. No transforms, no merge function.
- **Object create/delete** are also changes; a property edit to a deleted object is dropped (the
  delete, if ordered later, wins — Figma's actual rule).

```
Client change:  { objectId, property, value, baseVersion }
Server:         version = ++docVersion
                apply (LWW), persist, broadcast { objectId, property, value, version }
Client:         patch local model, advance to version
```

## 3. The agent as a participant

The agent emits the **same change protocol** as a human client. What's different about an agent:

- **Bursts, not keystrokes.** A human dribbles changes; an agent emits 50 mutations for "add a
  pricing section" in milliseconds. → wrap them in a **transaction** (§5) so they land as one
  coherent, atomic, single-undo step — not 50 broadcasts the human watches flicker by.
- **Plans against a snapshot.** The agent perceived the doc at version `V`. By the time it acts, a
  human may have moved things to `V+k`. → every mutation carries `baseVersion`; on conflict the
  server returns **STALE** and the agent **re-perceives** (ties to perception + tool specs).
- **Can be wrong.** → every agent transaction is one undo unit, and ideally `dryRun`-previewable.

## 4. Child ordering — the one place you need sequence logic

LWW fails for "where in the child list does this node go" — two users inserting at index 3
shouldn't clobber each other. Solution: **fractional indexing** (Figma's approach).

- Each child holds a **fractional position key** (a string/rational between siblings), not an array
  index. Insert between `a` and `b` → pick a key strictly between `key(a)` and `key(b)`.
- Concurrent inserts get *different* keys → both survive, no renumbering, no conflict.
- Edge case: repeated inserts at the same spot shrink the gap → keys lengthen; periodic rebalancing
  (rare). Interleaving anomalies are possible but visually harmless for a canvas.

## 5. Transaction semantics

```ts
beginTxn(label): TxnId            // "Agent: add pricing section"
  ...mutations (share the TxnId)...
commitTxn(TxnId)  |  abortTxn(TxnId)
```
- **Atomic undo unit.** The whole txn is one entry on the undo stack — human Ctrl-Z reverts the
  agent's entire action, not one micro-edit.
- **All-or-nothing.** Partial failure (a `STALE` or `CONSTRAINT` mid-txn) → abort + rollback; never
  leave the doc half-edited. Agent re-perceives and retries.
- **Coherent broadcast.** Other clients see the txn's effects coalesced/labeled, not 50 flickers.

## 6. Undo/redo with a shared document

The hard part: undo is **per-user**, but the doc is shared.

- Each client keeps its **own undo stack** of *its own* transactions.
- Undo = emit the **inverse** of that transaction as new changes (don't rewind global version).
- If a later edit by someone else touched the same property, inverse-apply still resolves by LWW —
  acceptable (you may "undo" to a value another user has since changed; rare, tolerable).
- This is why diff-return (`{ops, version}`) matters: the inverse is computed from the recorded ops.

## 7. Presence & awareness (cheap but high-value)

- **Ephemeral, not persisted:** cursors, selection, viewport, "Agent is editing Hero…".
- Sent over the same socket on a separate, **non-versioned** channel (loss is fine; next tick fixes).
- Surfacing **"the agent is working here"** is a real safety feature — prevents humans and the agent
  fighting over the same node.

## 8. Failure modes (interview attack surface)

| Failure | Defense |
|---------|---------|
| Agent plan stale (human edited mid-plan) | `baseVersion` → `STALE` → re-perceive → retry txn |
| Agent burst floods other clients | transaction coalescing + labeled single undo step |
| Concurrent inserts into same child slot | fractional indexing — both survive |
| Concurrent same-property edit | LWW — deterministic, never corrupt, one intended value wins |
| Edit to a deleted object | delete wins if ordered later (Figma's rule) |
| Offline agent/human reconnect | replay buffered changes; server re-serializes by arrival, LWW |
| Human and agent fight over one node | presence channel surfaces "agent editing here" |

## 9. The two things to defend
1. **Server-authoritative LWW-per-property** — the right model *because a canvas isn't text*; OT/CRDT
   solve a sequence problem you don't have. Independent properties make LWW safe.
2. **Agent = participant + transaction boundary** — reusing the human sync path gives undo, merge,
   presence, and history for free; the transaction is what makes an agent's burst safe and legible.

> Connective tissue across all specs: **`{ops, version}` is the spine.** Perception emits it
> (`getChanges`), tools return it, concurrency assigns and validates it. One diff/version primitive
> unifies all three layers — the strongest single thing to put on the whiteboard.
