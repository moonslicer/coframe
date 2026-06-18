# Agentic Vector Canvas — Implementation Document

> An AI agent that perceives and edits a Figma-like vector design canvas, co-editing alongside a human.
> **This document is the build spec.** A developer opens this file and starts building. It assembles the
> locked decisions, the cut list, the cross-cutting design choices, the per-subsystem detail, the
> riskiest-first build order, and the production evolution path into one coherent whole — with the
> adversarial review's fixes applied and its scope-creep flagged items deferred.

Status: v1 draft, 2026-06-16. Author is the final integrator; this supersedes scattered notes in
`agentic-canvas-design.md`, `perception-spec.md`, and `tool-vocabulary-spec.md` where they conflict
(conflicts are called out inline).

> **Since-build addendum (2026-06-17):** the user-editable-canvas feature shipped after this
> snapshot. Two statements below are now stale: the browser is **no longer a read-only mirror** —
> it mutates the authoritative doc directly via a `{t:"tool"}` client→server message (through the
> same `dispatch → commit` pipeline), and the tool registry grew from **8 to 14** tools. The
> "human edits are hard-disabled during a run" invariant still holds. See the
> "Feature: user-editable canvas" entry in `BUILD_PROGRESS.md` for the current state.

---

## 1. Objective & the demo script (the success criterion)

**Objective.** In a single **2-minute screen recording**, a human types one plain-English sentence
into a prompt bar, watches Claude **visibly perceive** the canvas (a numbered set-of-marks overlay
flashes on screen), then watches a **real designed result snap into place** as **one labeled,
single-click-undoable step**.

This is a **demoable product** the author will run themselves and share with friends. It is NOT a
production system at Figma scale, NOT a CRDT multiplayer engine, NOT interview prep. The bar is: the
intelligence is *legible* (you can see it see, plan, act, and verify), the result is *designed* (not
scattered), and the agent is a *well-behaved co-editor* (one Cmd-Z reverts everything).

> **Naming:** do NOT call this "Claude Design" (a different, real Anthropic product). Pick an
> unrelated working name for the repo/UI (e.g. "Loom Canvas", "Verso", "Marker"). The doc refers to it
> as "the canvas agent".

### The demo script (the literal success criterion)

1. Open the app on a **hand-picked seed doc** — a half-finished landing page with a hero frame and a
   few loose, misaligned elements — so the viewer instantly sees a real (not toy) canvas.
2. Type one **curated sentence** into the always-present prompt bar, e.g.
   *"Add a pricing section with three tiers below the hero, aligned and evenly spaced."*
3. Hit Enter; the activity log immediately streams **"Planning…"** then **"Perceiving canvas…"** —
   no blank spinner. (Target: first log line on screen **< 2.5 s** after Enter.)
4. The **marked thumbnail flashes**: numbered bounding boxes `[1][2][3]` overlaid on the existing
   nodes — the "it can actually SEE the design" beat.
5. The activity log streams labeled tool calls in real time — *"Creating frame", "Creating 3 text
   tiers", "Applying vertical auto-layout, gap 24", "Aligning + distributing cards"* — while the new
   pricing section **visibly snaps into place** on the canvas, op by op.
6. The log ends with an **honest confirmation**: *"Done — added pricing section, 3 tiers, aligned,
   gap 24"* (structural verify), and the history panel shows a single labeled step *"Agent: add
   pricing section."*
7. **Mic drop:** press **Cmd-Z once** — the entire ~30-mutation section cleanly vanishes in one undo.
8. *(Optional repeat-use beat — P1)* Select three existing buttons on the canvas, type *"make these
   match the primary one and even out the spacing"* — the agent restyles + distributes the selected
   id set, then one Cmd-Z again.

If a developer can produce this recording reliably against the curated seed+prompt pairs, the project
has succeeded. Everything below serves that recording.

---

## 2. Must-have feature list + the cut list

### 2.1 Must-haves (with rationale)

| # | Feature | Why it's load-bearing | Pri |
|---|---------|----------------------|-----|
| F1 | **In-browser renderable scene graph** (FRAME, TEXT, RECT, ELLIPSE) with the verbatim Node shape from `perception-spec §1` minus heavy types, plus a monotonic integer `version` on every mutation. | The substrate every layer reads/writes. No live pixels → no demo. Keeping the exact Node shape makes re-adding VECTOR/COMPONENT/INSTANCE/GROUP **additive, not a rewrite**. | P0 |
| F2 | **SVG renderer with a dual-purpose `render(rootId,{marks})` path**: draws the scene for the human AND returns `{svg, image, markMap, version}` with numbered bbox labels keyed to NodeId. | One render path is the human's live view AND the agent's vision channel — **build once, used twice**. The single biggest underrated wow lever. | P0 |
| F3 | **Visible set-of-marks beat**: when the agent perceives, briefly surface the numbered marked thumbnail in the UI. | Converts an invisible API call into a visible act of perception. Highest wow-per-pixel feature; proves Claude reasons over layout, not blind-generates. | P0 |
| F4 | **Scoped + field-projected perception read**: `getTree(rootId,{depth,fields})` returning a skeleton by default + one marked render; **fresh scoped re-read each step** (no `query`/`getChanges`). | Keeps a turn ~3k tokens so latency feels snappy on a real doc. At demo scale a fresh re-read is nearly free and deletes the patch-the-running-model subsystem. | P0 |
| F5 | **~8 semantic tools** wired as Claude tool-use on Opus 4.8 via the Anthropic SDK: `createFrame, createText, createShape, setFill, setTextStyle, applyAutoLayout, alignDistribute, placeBelow` — each returns `{ops,version}`, with id/version validated at the boundary (`BAD_ID`/`STALE`). | `createFrame/createText/createShape` carry the build-something story; `applyAutoLayout + alignDistribute + placeBelow` are exactly what make output look **designed** rather than scattered. Boundary validation is the few lines that kill hallucinated-id corruption. | P0 |
| F6 | **Real Claude agent loop** (plan → perceive → act → verify → done) driving the tools via native tool-use, with **tier-1 structural verification** (read back: did the property/child actually change?) and a **bounded retry** on failure. | The heart of the project — the one thing that cannot be faked. Honest done/couldn't status guards against the ~51% grounding ceiling eroding trust. | P0 |
| F7 | **Always-present prompt bar + live streaming activity log**: each plan step and tool call shown as a labeled line as it happens (not a spinner). | A 10–20 s LLM task behind a blank spinner kills the demo. Streaming turns dead latency into a thriller and delivers the legible-steps property without a multiplayer layer. | P0 |
| F8 | **Atomic labeled run = exactly one undo step**, shown in a history panel ("Agent: add pricing section"), reverted by one Cmd-Z / Undo button via a **pre-run doc snapshot**. | The mic-drop ending: 30 mutations vanish on one keystroke. The trust-plus-delight gesture. At single-user scale a snapshot gives the identical user-visible guarantee as inverse-op transactions for a fraction of the build. | P0 |
| F9 | **Prompt bar resolves the human's current canvas selection to NodeIds** and passes them as the agent's target id set. | Turns the demo from a one-time greenfield trick into the daily loop ("align these and even out the spacing"). Cheap: selection state already lives in the renderer. | P1 |
| F10 | **2–3 hand-picked seed documents** paired with curated known-good prompts. | Demo reliability beats generality. The ~51% grounding ceiling means a live flop is unshareable; a known-good doc+prompt pair guarantees the wow lands every time. Cheap insurance for the share moment. | P1 |

### 2.2 The cut list (and the production path for each)

These are deliberately **out of scope for v1**. Each has a defined re-entry point so v1 is not a throwaway.

| Cut | Why cut | Production path |
|-----|---------|-----------------|
| **Live two-way human+agent concurrency / multiplayer merge** (server-authoritative LWW, fractional indexing, presence, STALE-from-concurrent-human re-perceive, per-user undo). | Invisible in a 2-min solo recording and the single biggest build cost. In a single-writer demo the agent is the only mutator → no conflicts. | Re-add the sync server; the agent rejoins as a participant on the existing `{ops,version}` spine; the already-wired `STALE` path activates. |
| **Atomic-transaction system with inverse-op rollback** (`beginTxn/commitTxn/abortTxn`). | Its real value is multi-step atomicity under concurrency + a shared undo stack. Single-user gets the identical user-visible guarantee from a pre-run snapshot. | Swap snapshot-undo for the transaction/inverse-op model when multiplayer lands; the recorded run ops become the inverse source. |
| **`dryRun` preview-before-apply with accept/reject UX.** | The extra confirm step dampens the "it just did it" punch in a 2-min share. Kept in the tool envelope; just not wired into the demo flow. | Wire the (already-present) `dryRun` diff into a ghosted preview + Apply gate for long, ambiguous, or destructive tasks. |
| **`query()` and `getChanges()` / diff-based incremental perception.** | Token optimizations for 10k-node docs. At demo scale a fresh scoped `getTree` per step is nearly free and removes the patch-the-running-model subsystem + its staleness edge cases. | Add `getChanges` to patch the running model and `query()` to find nodes without scanning when docs grow large. |
| **Tier-2 spatial-invariant + tier-3 vision verification.** | Decision #4 makes vision check on-demand. Tier-1 structural verify is enough to make v1 trustworthy and is cheap; tier-3 adds a model round-trip + latency for a gain the audience won't see. | Add tiers 2–3, reusing the render path, exposed as an explicit "does this look balanced?" check. |
| **Full 20-tool vocabulary + escape hatch + components/instances, groups, vector/boolean ops, constraints, gradients, effects.** | None makes a more impressive 2-min demo; each adds surface to break. FRAME/TEXT/RECT/ELLIPSE + solid fills + auto-layout + align already build a convincing artifact. | Re-introduce node TYPES additively against the same Node model; add matching tools + the `setProperty`/`batch` escape hatch as new registry entries. |
| **Multi-turn conversation / iterative refinement ("now make it blue") + a persistent chat panel.** | Doubles loop state management and risk surface; a chat panel competes with the canvas. One sentence → one stunning result is a tighter 2-min story; the selection-scoped prompt bar already lets a user fire a second independent command. | Layer multi-turn context + escalate-with-specific-ask + step summarization on top of the single-shot loop as tasks grow longer. |

#### Scope creep CUT by the adversarial review (do NOT build in v1)

The review flagged a large amount of "cheap hedge" plumbing that is individually small but collectively
days of invisible work competing with the loop-reliability iteration that actually decides whether the
demo lands. **The following are explicitly NOT in v1** (keep the informal discipline, drop the machinery):

- **Recording run ops as a parallel data path** "for the future inverse-op path" — undo is a
  `structuredClone` snapshot; do not maintain a second op-log the demo never reads. *(See §6 risk note —
  if you want the production hedge, it costs nothing to keep the `{ops}` the tools already return in
  the RunController's in-memory run record; do not build a separate persisted log.)*
- **`actorId` / `changeSource` threaded through every op** — there is one writer (the agent). Add it
  when auth lands.
- **Dead `STALE`/`CONSTRAINT` branches "kept structurally exercised" with a concurrent-bump test.**
  Keep `BAD_ID` (the LLM hallucinates ids regardless). `STALE`/`CONSTRAINT` are a stubbed no-op that
  returns the structured error shape if ever hit — but **no test simulating concurrency**.
- **Production-grade structured telemetry event taxonomy** — the activity log renders labeled lines;
  it does not need `{phase,step,tool,ops,version,outcome,latencyMs}` with STALE-vs-failure
  distinction for a 2-min local demo. (A plain discriminated-union event type for the WS is fine — see
  §5.6 — but don't gold-plate it for observability.)
- **A formal scored eval harness running the real loop nightly.** The curated seed+prompt pairs ARE
  the eval; the day-1 headless harness doubles as the smoke test.
- **Deterministic replay harness + recorded-LLM response cache.** Genuinely useful for a production
  LLM app; v1 never benefits. Defer.
- **5 strict modules with a dependency-cruiser/import lint.** Keep the seam discipline informally
  (SDK confined to the agent module; `applyOps` pure). A couple of files, no lint rule.
- **`schemaVersion` + `migrate()` chokepoint.** Seed docs are committed TS literals you control. Skip
  until there are persisted user docs.
- **Fractional-position-key hedging.** v1 uses array indices in `children` — correct for single-writer.
  Flag it as a known (non-additive) migration cost; spend zero v1 cycles on it.
- **Selection-prefetch / speculative perception.** Optimizing a P1 feature's latency before it exists.
  The ~50 ms saved is invisible next to 12–25 s of model time.
- **Redo + a ring of N snapshots.** The locked contract is one undo per run; the script needs exactly
  one Cmd-Z. Keep one pre-run snapshot.

---

## 3. Architecture overview

### 3.1 Locked decisions (the four pillars)

1. **Hybrid perception.** A structured tree (`getTree`) for *addressing* + a rendered thumbnail with
   set-of-marks for *spatial grounding*. Tools take **NodeIds only**, never mark numbers; the agent
   resolves `markMap[n] → NodeId` before any call.
2. **High-level semantic tool API + a low-level escape hatch.** v1 ships the ~8 semantic tools; the
   escape hatch (`setProperty`/`batch`) is a production addition against the same registry.
3. **The agent is a participant via the doc layer; each action = one atomic transaction = one undo
   step.** v1 realizes "one undo step" with a pre-run snapshot (identical user-visible guarantee).
4. **Structural assertion verification by default, vision check on demand.** v1 ships tier-1
   structural verify; tiers 2–3 are cut.

### 3.2 One diagram

```
                         ┌──────────────────────── SERVER (Node 22, tsx) ───────────────────────┐
  BROWSER (Vite/React)   │  doc-model:  Map<NodeId,Node> + rootId + version + snapshot/restore   │
  ┌──────────────────┐   │  renderer:   buildSvg(store,rootId,{marks}) -> ONE svg string         │
  │ App Shell        │   │  perception: getTree(rootId,{depth,fields})  (reads store, stamps ver)│
  │  - SVG viewport  │◀──┤  rasterize:  same svg string -> PNG via @resvg/resvg-js (vision chan) │
  │  - prompt bar    │WS │  tools:      8 semantic commands -> {ops,version} | {error}           │
  │  - activity log  │──▶│  agent:      plan→perceive→act→verify→done  (Anthropic SDK, streaming)│
  │  - history panel │   │  RunController FSM: IDLE→PLANNING→PERCEIVING→ACTING→VERIFYING→DONE/ESC │
  │  - marks beat    │   └──────────────────────────────────────────────────────────────────────┘
  └──────────────────┘
        ▲   the browser holds a READ-ONLY mirror, patched from {ops,version} events and re-rendered.
        │   The marked-thumbnail PNG comes pre-rasterized FROM THE SERVER — the exact bytes the model saw.
        │   ANTHROPIC_API_KEY lives server-side and never reaches the browser.
```

**The frozen contract is `{ops, version}`.** Perception stamps it, tools return it, the loop pivots on
it, the browser mirror patches on it, the history entry is keyed by the version range of the run. Get
this contract right on day one and every layer can be built and swapped independently.

**Single source of truth for rendering (contradiction the review found — RESOLVED).** There is **ONE**
function `buildSvg(store, rootId, {marks}) -> { svg: string, markMap }`. The browser injects that exact
string into the DOM (a thin React wrapper around `dangerouslySetInnerHTML`, or — simpler and equally
valid at demo scale — a per-type React component tree *that is generated from the same draw table*).
The server passes the **identical** string to `@resvg/resvg-js`. Every element carries `data-node-id`
so selection is a DOM hit-test. **There is no parallel renderer.** "Build once, used twice" is a hard
guarantee, not an aspiration. (See §5.2 for the resolved choice and the one bundled font that keeps
human pixels == agent pixels.)

---

## 4. Cross-cutting design decisions (by dimension)

### 4.1 Design patterns & architecture

- **Canvas state = mutable normalized scene-graph store**, not event sourcing. A flat
  `Map<NodeId, Node>` + `rootId` is the single source of truth. The monotonic integer `version` bumps
  on every committed mutation. Undo is a coarse pre-run `structuredClone` of the Map. Event sourcing
  earns its keep only with per-op inverse for a shared undo stack, diff-based patching, and
  audit/replay — v1 has none. **Production:** promote ops to invertible, persist an append-only log,
  replace snapshot-restore with op-replay.
- **Tool layer = Command pattern via one registry.** Each tool is a registry entry bundling
  `{ schema, validate, plan, label }`. One boundary wrapper does id-existence + version validation
  before the command body runs. The Anthropic tool schema is **generated from the same registry**, so
  the tool list the model sees can never drift from what executes. Commands are **forward-only** (no
  `unexecute`) — matches snapshot undo.
- **Rendering = coarse version-keyed observer.** The store exposes `subscribe`; every mutation bumps
  `version` and notifies. The renderer re-renders from the current store on each version change. No
  fine-grained per-node reactivity (well under a 16 ms frame budget at dozens of nodes).
- **Agent loop = plan-then-ReAct hybrid** driven by the **native Anthropic tool-use loop** (a manual
  agentic loop, not the SDK tool-runner — you need the per-step interception point for validation,
  verify, snapshot, and streaming). One cheap planning pass decomposes intent into ordered labeled
  steps; a per-step ReAct inner loop does perceive → act → structural verify → bounded retry/done.
- **Run-level state = explicit `RunController` FSM, separate from doc state.** Two stores: the doc
  store (persisted scene graph + version) and the RunController (ephemeral run state: plan, attempts,
  pre-run snapshot, streamed log, resolved selection). The renderer subscribes to the doc store; the
  UI chrome subscribes to the RunController. They meet only when a Command commits.

### 4.2 Stack & tools

- **TypeScript end-to-end**, strict mode, ESM, **Node 22**. One repo, one language for browser +
  agent backend. The Node shape and the `{ops,version}` envelope live in a shared `shared/types.ts`
  imported by both sides — boundary validation is `import`, not re-spec.
- **SVG renderer (DOM-based) via React**, NOT Canvas2D / WebGL / PixiJS. FRAME/RECT/ELLIPSE/TEXT map
  1:1 to `<rect>/<ellipse>/<text>/<g>`; selection is a `closest('[data-node-id]')` hit-test; the
  set-of-marks overlay is a second `<g>` of numbered rects. The render contract is renderer-agnostic,
  so the WebGL swap later doesn't touch the agent or marks logic.
- **Set-of-marks rasterization: server-side `@resvg/resvg-js`** (prebuilt native binding, works on the
  author's arm64 Mac; no headless browser). Render the marked SVG string to a ~1024px PNG, base64,
  send as an image content block. The same SVG string is pushed to the browser for the visible beat —
  the agent's eyes the viewer sees IS the bytes the model saw.
- **LLM integration: Anthropic TypeScript SDK** (`@anthropic-ai/sdk`), model **`claude-opus-4-8`**,
  `thinking: { type: 'adaptive' }`, a **manual** agentic loop, **streaming** via `messages.stream()`.
- **Transport: single Node process** — a thin HTTP/WS server (Hono + `ws`) holding the authoritative
  graph in memory; the browser sends prompt+selection over one WebSocket and receives a typed event
  stream. The browser keeps a read-only mirror only for rendering and selection.
- **Build tooling:** Vite + React + TS frontend; `tsx` to run the Node/WS backend in dev; Tailwind for
  the chrome; `.env` for `ANTHROPIC_API_KEY`; 2–3 seed docs as **committed TS object literals**.

### 4.3 Latency (with target numbers)

The whole run is a **~10–20 s wall-clock event dominated by LLM round-trips**, not render or tool
execution. Concrete budget at demo scale (one frame, ~dozens of nodes):

| Stage | Cost | Note |
|-------|------|------|
| LLM round-trips | **~2–4 s TTFT per turn; 4–6 turns → 12–25 s** | This is ~95% of perceived latency. |
| Perception read (`getTree` + render) | **< 50 ms** | In-process SVG raster of ~50 nodes to a 1024px PNG; ~3k-token payload. |
| Tool execution (against in-memory graph) | **< 5 ms each; ~30 ops < 150 ms** | Pure reducer. |
| Tier-1 structural verify | **< 5 ms** | No model call. |

Levers (in order of leverage):

- **Streaming is the primary latency-hiding mechanism.** Wire `messages.stream()` content-block /
  input-json deltas directly to the activity log. **Render the verb on `content_block_start`, append
  params on `input_json_delta`** so the log shows "Applying auto-layout…" then "…gap 24" without
  flicker. **Target: first activity-log line < 2.5 s after Enter; a new labeled line every 2–4 s.**
- **Emit the "Planning…" line on stream open / `message_start`, not on the first text delta** — the
  adaptive-thinking pause must never read as a dead spinner. Set
  `thinking: { type: 'adaptive', display: 'summarized' }` so reasoning streams as a "Planning…" line
  rather than a silent gap (default `display` is `"omitted"` on Opus 4.8 — an empty thinking field).
- **Apply mutations immediately as tool calls return** (single-writer → "optimistic" == "immediate",
  zero reconciliation). Each op reflected on canvas < 16 ms after its tool result; the section
  assembles node by node *during* the run.
- **Prompt caching to cut per-turn TTFT.** Cache the stable prefix (system + 8 tool schemas) with a
  `cache_control: {type:'ephemeral'}` breakpoint; keep the volatile per-turn perception **after** the
  breakpoint. **Pre-warm with a `max_tokens: 0` request on app load** so the first real run isn't cold.
  Target: shave ~1–1.5 s off TTFT on turns 2–6. **Verify `usage.cache_read_input_tokens > 0`** — the
  cache silently misses if anything volatile leaks into the prefix. *(Note: the minimum cacheable
  prefix on Opus 4.8 is **4096 tokens**. The system prompt + 8 tool schemas should clear that; if the
  prefix is smaller, caching silently no-ops — measure with `count_tokens`.)* **The warmup call CANNOT
  reuse the streaming `act()` path:** `max_tokens: 0` is rejected with `stream: true`,
  `output_config.format`, `thinking.type:'enabled'`, or `tool_choice` of `tool`/`any`. Make it a
  separate non-streaming request carrying only the cached prefix (system + tools), with the
  `cache_control` breakpoint on the last shared block — never on the throwaway user turn.
- **Tier-1 verify only by default** (< 5 ms). A vision verify would add a full Opus round-trip
  (~2–4 s + an image) per run for a gain the 2-min audience can't see.
- **Model: Opus 4.8 throughout v1. Do NOT split models mid-run** — prompt caching is model-scoped, so
  a mid-conversation switch invalidates the entire tools+system+history cache and can cost more latency
  than it saves on a short loop. The Sonnet-for-planning idea is a *production* lever (a Sonnet/Haiku
  **subagent** for parallel-safe sub-tasks, which preserves the main cache), not a v1 one. Tune with
  `output_config.effort` instead (`high` for plan/perceive where grounding gates the ceiling; `low`
  acceptable on simple act turns).

### 4.4 Cost (token + dollar estimates)

Anchored to the `perception-spec §2` ideal-default row; **the review correctly flags these as
estimates, not measurements — run `count_tokens` on the real seed docs before quoting a number to
friends** (see §8 open questions).

- **Per-turn perception payload target ~3,000 input tokens:** scoped `getTree` skeleton of ~50 nodes
  (~25 tok/node ≈ 1,250) + one set-of-marks render at maxPx=1024 (~1,000–1,200 image tok) + tool
  results (~300) + the cached system/tools prefix. Skeleton-only is the single biggest lever:
  full-fields would be ~15,000 tok/turn (a 5× blowup). Image tokens scale roughly as `(w×h)/750`, so a
  1024px PNG ≈ ~1,050 tok — keep `maxPx=1024`, render **once per perceive beat**, do not re-render
  every turn.
- **Per-run cost (Opus 4.8 at $5 / $25 per 1M):** a 5–6 turn loop with caching on the ~2,500-tok
  prefix ≈ **~$0.20/run**; a heavier "add pricing section" run (8–10 turns) ≈ **$0.30–$0.45/run**.
  1,000 runs ≈ $200–$450 — trivial for a creator and friends. The risk is not the happy path but an
  unbounded-retry or full-fields-every-step loop turning a $0.20 run into dollars.
- **Caching strategy:** one breakpoint on the last block of the stable prefix (frozen system prompt +
  the 8 tool schemas, deterministically ordered). Volatile content (perception read, marked render,
  version stamps) goes **after** the breakpoint. **Never interpolate version/selection/timestamp into
  the system prompt** — it invalidates the cache every turn (`cache_read_input_tokens` drops to 0).
- **Guardrails:** a hard turn cap (~12) + a single bounded retry per step + structural-only verify.
  Keep tool outputs compact (semantic calls + diff-return, not prose). A **silence-default system
  instruction** keeps the activity-log narration terse (Opus 4.8 narrates *more* than 4.7 by default —
  see §4.8) and the output cheap ($25/1M output).

### 4.5 Maintainability

- **Module boundaries (informal, no lint rule).** Five conceptual modules mirroring the specs:
  `doc-model`, `perception`, `renderer`, `tools`, `agent`. Dependency rule (enforced by discipline,
  not tooling): `agent → {perception, tools, doc-model}`; `perception → {renderer, doc-model}`;
  `tools → doc-model`; `doc-model → nothing`. The Anthropic SDK lives **only** in the agent module, so
  4 of 5 modules are deterministic and testable with no API key.
- **The load-bearing seam:** `applyOps(doc, ops, baseVersion) -> {version} | {error}` is the single
  mutation chokepoint — no I/O, no time, no randomness, id generation injected. Tools return `ops` as
  data; only `doc-model` applies them and bumps `version`. This makes any sequence of agent actions a
  replayable list of ops and makes one-undo-step trivial.
- **Testing an LLM-driven app:** separate the deterministic 90% (doc, tools, ops, undo, perception
  scoping — fast unit tests, no API key) from the nondeterministic 10% (the model's choices). For the
  latter, the **day-1 headless harness** that runs the real loop against the curated seed+prompt pairs
  and asserts on doc-model *structure* (not pixels, not prose) is the eval. Assertions are semantic
  invariants — *"a FRAME named ~pricing exists below the hero bbox; layout.mode=VERTICAL gap=24; 3 TEXT
  children; children left-aligned"* — tolerant of the model picking different coords. Run it
  deliberately (pre-record, pre-share), not in a tight CI loop. **(Cut by review:** a formal scored
  nightly suite, a replay harness, and a recorded-LLM cache — defer all three.)
- **Confine the SDK to one thin adapter** inside the agent module: build the tool-use request
  (8 schemas + system prompt + perception payload), call the SDK, return parsed tool-call intents. The
  loop's state machine consumes parsed intents and never touches the SDK, streaming format, or model id
  directly. The model id (`claude-opus-4-8`) is a single constant.

### 4.6 Flexibility

- **One registry entry is the single source of truth for a tool** — schema + validate + apply + label
  in one object. Adding the 9th tool is appending one object; the model learns it automatically
  because the schema's `description` is where behavior lives (do **not** restate tool semantics in the
  system prompt — two sources of truth that drift, and prompt-cache bloat).
- **Tools address nodes by NodeId only.** The markMap (`MarkId → NodeId`) is resolved by the agent
  *before* the call. Semantic-coordinate tools (`placeBelow`, `alignDistribute`) take a target NodeId
  set, not pixels — killing overlap/coordinate hallucination and keeping perception/addressing/mutation
  three swappable stages joined by one stable type.
- **New node types are additive.** Keep the full Node shape now (style/text/layout/constraints/
  component fields), populate the v1 subset. A new type = one new draw function + (optionally) one new
  projectable field + one new `create*` tool. The marks pass marks any node with a bbox, so new types
  are visible to the agent the moment they render.
- **Model swap behind one adapter.** Opus 4.8 ↔ Sonnet 4.6 is one config constant *if* you never
  depend on a removed param. **On Opus 4.8 / Sonnet 4.6, `budget_tokens`, `temperature`, `top_p`,
  `top_k` all 400 — use `thinking: {type:'adaptive'}` only.** Parse all tool `input` with `JSON.parse`,
  never string-match (4.x models vary Unicode/slash escaping, which would false-trigger `BAD_ID`).
- **The perception envelope is fixed:** `{ tree, image, markMap, version }`. `getTree` + `render` are
  the only two perception entry points; the implementation behind them (tree walk, mark drawing, field
  projection) is freely swappable. `getChanges`/`query` slot in behind the identical envelope later.

### 4.7 Dev velocity (build order at a glance — full version in §6)

- **Riskiest-thing-first:** validate the LLM tool-use loop on day 1 against a stubbed canvas, before
  any rendering exists. The loop's success rate is the dominant unknown (the ~51% grounding ceiling).
- **Stub order:** fake perception render (static placeholder PNG + hand-built markMap) → fake plan as a
  single system-prompt instruction → fake verify as `{ok:true}` → fake streaming as `console.log`.
  **Never stub:** the scene graph, the tool functions, the real Anthropic tool-use call, or boundary
  id-validation.
- **Buy vs build:** SVG is the renderer you hand-write (no library); Opus 4.8 via the SDK is the
  agent (~40-line manual loop, not the tool-runner); `structuredClone(graph)` is undo. Build small:
  the graph, the 8 tools, the ~30-line marks overlay, the log, the prompt bar.

### 4.8 Evolvability to production (consolidated in §7)

The seams chosen above (the `applyOps` chokepoint, the `{ops,version}` spine, the fixed perception
envelope, the SDK adapter, the WS event protocol, the two-store split) are exactly where the cut
multiplayer/transaction/diff/vision-verify stacks re-attach. **Critical fork:** snapshot-undo silently
clobbers a second writer — the moment multiplayer is even prototyped, undo MUST move to the inverse-op
log. That is a hard architectural fork, not an incremental tweak.

**Opus 4.8 prompting note (apply from day 1, not as later hardening).** Opus 4.8 narrates more than 4.7
and under-reaches for tools/structured behavior unless explicitly prompted. Both bite this project:
verbose inter-tool narration inflates output cost and clutters the activity log, and under-eager tool
use threatens the loop. The system prompt MUST, from the first run, include (a) a **silence-default**
("default to silence between tool calls; one terse line per action"), (b) **prescriptive tool
descriptions** ("call this when…", not just what it does — measurable lift on 4.8), and (c) explicit
loop policy (plan → perceive → act → verify → done) and the addressing contract (resolve marks to
NodeIds; tools take NodeIds only).

---

## 5. Per-subsystem implementation detail

### 5.1 Document Model — scene graph, ops, versioning, undo

The substrate. Pure, deterministic, dependency-free (no SDK, no React, no rendering, no
`Math.random`/`Date.now` inside) so it unit-tests in milliseconds and replays byte-identically.

```ts
// shared/types.ts — imported byte-identically by client + server
export type NodeId = string;        // "node:<n>" — stable, survives reorder/move (NOT an array index)
export type DocVersion = number;    // monotonic integer, server-assigned

export interface Node {
  id: NodeId;
  type: 'FRAME' | 'TEXT' | 'RECT' | 'ELLIPSE'        // v1-populated
      | 'VECTOR' | 'COMPONENT' | 'INSTANCE' | 'GROUP'; // reserved, additive
  name: string;                                       // semantic index — "Hero", "CTA Button"
  bbox: [x: number, y: number, w: number, h: number];
  parent: NodeId | null;
  children: NodeId[];                                 // ids only, NEVER inlined nodes
  // --- projectable fields (only emitted by perception when requested) ---
  style?: { fills?: Paint[]; strokes?: Stroke[]; opacity?: number; cornerRadius?: number };
  text?:  { chars: string; fontSize: number; fontWeight: number; align: 'LEFT'|'CENTER'|'RIGHT' };
  layout?:{ mode: 'NONE'|'HORIZONTAL'|'VERTICAL'; gap?: number; padding?: number; align?: 'START'|'CENTER'|'END' };
  constraints?: { horizontal: string; vertical: string };          // reserved
  component?:   { mainId: NodeId; overrides?: Record<string, unknown> }; // reserved
}
export type Paint  = { type: 'SOLID'; color: string; opacity?: number }; // hex; gradient/image reserved
export type Stroke = { paint: Paint; weight: number; align?: 'INSIDE'|'CENTER'|'OUTSIDE' };

// The unit of {ops, version}. v1 ops are DESCRIPTIVE (not guaranteed-invertible).
export type Op =
  | { kind: 'add';      node: Node; index?: number }
  | { kind: 'remove';   id: NodeId }
  | { kind: 'set';      id: NodeId; path: string; value: unknown }      // "style.fills" | "bbox" | "layout.gap"
  | { kind: 'reparent'; id: NodeId; parent: NodeId; index: number };

export type ToolOk    = { ops: Op[]; version: DocVersion };
export type ToolError = { error: 'BAD_ID' | 'STALE' | 'CONSTRAINT'; detail: string };
export type ToolResult = ToolOk | ToolError;
export const isErr = (r: ToolResult): r is ToolError => 'error' in r;
```

**The store.** Mutable `Map<NodeId,Node>` + `rootId` + `version` + a coarse observer. `commit()` is the
ONLY write path — tools, the seed loader, and any future human edit all route through it. Boundary
validation (the `BAD_ID` defense) runs FIRST, before any mutation.

```ts
export class DocStore {
  private nodes = new Map<NodeId, Node>();
  private _rootId!: NodeId;
  private _version: DocVersion = 0;
  private listeners = new Set<() => void>();
  private idSeq = 0;                                   // injected determinism — no Math.random in tools

  get rootId() { return this._rootId; }
  get version() { return this._version; }
  getNode(id: NodeId) { return this.nodes.get(id); }
  has(id: NodeId) { return this.nodes.has(id); }
  all(): ReadonlyMap<NodeId, Node> { return this.nodes; }
  newId(): NodeId { return `node:${++this.idSeq}`; }

  loadSeed(seed: { rootId: NodeId; nodes: Node[] }) {
    this.nodes = new Map(seed.nodes.map(n => [n.id, n]));
    this._rootId = seed.rootId; this._version = 1;
  }

  /** THE chokepoint. boundary-validate -> apply (pure) -> bump version -> notify. */
  commit(ops: Op[], baseVersion: DocVersion): ToolResult {
    if (baseVersion !== this._version)                 // STALE — always passes single-writer; wired, not tested
      return { error: 'STALE', detail: `base ${baseVersion} != ${this._version}` };
    for (const op of ops) {                            // perception-spec §6: kill hallucinated-id corruption
      const refs: (NodeId | null)[] =                  // ALL referenced ids, not just the primary one
        op.kind === 'add'      ? [op.node.parent]      // new node's parent must exist
      : op.kind === 'reparent' ? [op.id, op.parent]    // BOTH the moved node AND its destination parent
      : op.kind === 'set'      ? [op.id]
      : op.kind === 'remove'   ? [op.id]
      : [];
      for (const ref of refs)
        if (ref && !this.nodes.has(ref)) return { error: 'BAD_ID', detail: `unknown node ${ref}` };
    }
    const next = applyOps(this.nodes, ops);            // pure reducer, clone-on-write touched nodes
    this.nodes = next;
    this._version += 1;
    for (const l of this.listeners) l();
    return { ops, version: this._version };
  }

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // ---- pre-run snapshot undo (the one-Cmd-Z mechanism) ----
  snapshot() { return { nodes: structuredClone(this.nodes), version: this._version, idSeq: this.idSeq }; }
  restore(s: ReturnType<DocStore['snapshot']>) {
    this.nodes = structuredClone(s.nodes); this._version = s.version; this.idSeq = s.idSeq;
    for (const l of this.listeners) l();
  }
}
```

`applyOps` is the pure reducer; it `structuredClone`s touched nodes so a captured snapshot can never be
mutated by reference (a flagged risk — a unit test asserts `restore` yields a doc structurally equal to
the pre-run snapshot, and that the snapshot is not aliased into the live map).

**Versioning.** `version` starts at the seed's value and increments by exactly 1 per commit. **Two
version concepts are never conflated:** the runtime `version` (above) and a future on-disk schema
version (cut for v1 — seed docs are committed literals).

**Undo.** `RunController` calls `store.snapshot()` on entering `PLANNING` and `store.restore()` on
Cmd-Z. **Resolved contradiction (escalation vs clean undo):** with forward-only ops + snapshot undo you
cannot have both partial-progress-commit and a clean single undo. **v1 picks full-snapshot rollback on
any verify failure** — `ESCALATED` restores the pre-run snapshot. The clean one-Cmd-Z mic-drop wins;
partial-progress-commit is a production feature. One undo level only (no redo, no snapshot ring).

### 5.2 Canvas Rendering + Perception

The bridge between *visual* perception (the marked thumbnail) and *structured* perception (the NodeId
tree). Pure function of `(store, version) -> pixels | tree`. **Zero** SDK or agent imports.

**Resolved: ONE renderer (the review's `gap` + `contradiction`).** `buildSvg(store, rootId, {marks})`
produces a single SVG string. The browser renders that exact string; the server rasterizes that exact
string. Choose the simplest path that preserves the single-source guarantee: a per-type **draw table**
of string-builders shared by both sides (the server uses it directly; the browser wraps the output in a
thin React component via `dangerouslySetInnerHTML`, or — if you prefer real React elements for the
selection layer — generate React nodes from the *same* draw table so they cannot diverge). **Do not
write a second, parallel React component tree by hand.** Validate mark legibility and font match on the
densest seed doc before recording.

```ts
// perception/svg-build.ts — the single source of pixels
type DrawFn = (n: Node) => string;
const DRAW: Record<Node['type'], DrawFn> = {
  RECT:    n => `<rect ${pos(n)} ${fill(n)} rx="${n.style?.cornerRadius ?? 0}" data-node-id="${n.id}"/>`,
  ELLIPSE: n => `<ellipse cx="${cx(n)}" cy="${cy(n)}" rx="${n.bbox[2]/2}" ry="${n.bbox[3]/2}" ${fill(n)} data-node-id="${n.id}"/>`,
  TEXT:    n => `<text x="${n.bbox[0]}" y="${n.bbox[1] + (n.text?.fontSize ?? 16)}"
      font-family="Inter" font-size="${n.text?.fontSize ?? 16}" font-weight="${n.text?.fontWeight ?? 400}"
      fill="${n.style?.fills?.[0]?.color ?? '#111'}" data-node-id="${n.id}">${esc(n.text?.chars ?? '')}</text>`,
  FRAME:   n => `<rect ${pos(n)} ${fill(n)} rx="${n.style?.cornerRadius ?? 0}" data-node-id="${n.id}"/>`,
  VECTOR: () => '', COMPONENT: () => '', INSTANCE: () => '', GROUP: () => '', // reserved; additive
};

export function buildSvg(store: DocStore, rootId: NodeId, o: { marks: boolean; maxPx?: number }) {
  const root = store.getNode(rootId)!;
  const [vx, vy, vw, vh] = root.bbox;                  // crop viewBox to the working frame
  const body: string[] = [], markRects: string[] = [];
  const markMap: Record<string, NodeId> = {};
  let mark = 0;
  const walk = (id: NodeId) => {
    const n = store.getNode(id)!;
    body.push(DRAW[n.type](n));
    if (o.marks && n.id !== rootId) {                  // don't mark the root frame itself
      const m = String(++mark); markMap[m] = n.id;
      const [x, y, w, h] = n.bbox;
      markRects.push(
        `<g class="som-mark">
           <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#7c3aed" stroke-width="2" stroke-dasharray="4 3"/>
           <rect x="${x}" y="${y}" width="20" height="16" fill="#7c3aed" rx="3"/>
           <text x="${x+10}" y="${y+12}" font-size="12" fill="#fff" text-anchor="middle" font-weight="700">${m}</text>
         </g>`);
    }
    for (const c of n.children) walk(c);
  };
  walk(rootId);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" width="${vw}" height="${vh}">
       <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fff"/>
       ${body.join('\n')}
       ${o.marks ? `<g class="som-layer">${markRects.join('\n')}</g>` : ''}
     </svg>`;
  return { svg, markMap };
}
```

**Numbering is deterministic (pre-order DFS), so markMap is stable per render.** The agent reasons
"[3] overlaps [5]" on the image, then acts on `markMap["3"]` (a NodeId). **Tools only ever take
NodeIds, never mark numbers**, so re-rendering with a different mark order can't silently re-target a
tool. Treat the marked thumbnail as a transient snapshot image tied to one render+version — never let
the UI reference a mark number across renders.

```ts
// perception/render.ts — the dual-purpose vision channel (build once, used twice)
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
const fontBuf = readFileSync(new URL('../assets/Inter.ttf', import.meta.url)); // bundle the SAME font both sides

export async function render(store: DocStore, rootId: NodeId, o: { marks?: boolean; maxPx?: number } = {}) {
  if (!store.has(rootId)) return { error: 'BAD_ID' as const, detail: rootId };
  const maxPx = o.maxPx ?? 1024;
  const { svg, markMap } = buildSvg(store, rootId, { marks: o.marks ?? false, maxPx });
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: maxPx },            // pin long edge ~1024 to cap image tokens (~1,050)
    font: { fontBuffers: [fontBuf], defaultFontFamily: 'Inter' },
    background: 'white',
  }).render().asPng();
  return { svg, image: png.toString('base64'), markMap, version: store.version };
}
```

```ts
// perception/get-tree.ts — scoped, depth-limited, field-projected (skeleton default = the big token lever)
export function getTree(store: DocStore, rootId: NodeId, opts: { depth?: number; fields?: string[] } = {}) {
  if (!store.has(rootId)) return { error: 'BAD_ID' as const, detail: rootId };
  const depth = opts.depth ?? 2, fields = opts.fields ?? [];
  const out: any[] = [];
  const walk = (id: NodeId, d: number) => {
    const n = store.getNode(id)!;
    const row: any = { id: n.id, type: n.type, name: n.name, bbox: n.bbox, childCount: n.children.length };
    for (const f of fields) if ((n as any)[f] !== undefined) row[f] = (n as any)[f]; // project task fields only
    out.push(row);
    if (d < depth) for (const c of n.children) walk(c, d + 1);
  };
  walk(rootId, 0);
  return { nodes: out, version: store.version };
}
```

The loop picks `fields` by task intent (a layout task → `['layout']`; restyle → `['style']`), keeping a
turn near the ~3k-token target. `query`/`getChanges` are **cut** for v1 — fresh scoped re-read each
step.

**Fidelity (the review's top risk #3 — mitigated, not assumed):** bundle the exact same web font in the
SVG and the browser; render both from one SVG string; **verify visually on the seed docs before
recording.** Keep seed-doc TEXT single-line / simple-wrap so resvg and the browser wrap identically.
**Every `<text>` carries an explicit `font-family="Inter"`** (resvg is pinned via `defaultFontFamily`,
but the browser would otherwise fall back to the document/CSS default — silently diverging on exactly
the pixels this risk is about). Ship Inter to the browser via `@font-face` so the on-screen SVG and the
rasterized PNG resolve the same face.

### 5.3 Mutation / Tool Layer

The "what the agent can **do**" half. Owns the 8 semantic tools, the boundary validation, and the
`{ops,version}` diff-return. One registry entry per tool is the single source of truth.

```ts
// tools/registry.ts
export interface ToolDef<A = any> {
  name: string;
  schema: Anthropic.Tool;                               // shown to the model; generated from here
  validate(args: A, store: DocStore): ToolError | null; // BAD_ID etc., BEFORE the body runs
  plan(args: A, store: DocStore): Op[];                 // pure-ish: compute ops; does NOT commit
  label(args: A): string;                               // the streamed activity-log verb+params
}
export const REGISTRY = new Map<string, ToolDef>();
export const register = (d: ToolDef) => REGISTRY.set(d.name, d);
export const buildAnthropicTools = (): Anthropic.Tool[] =>
  [...REGISTRY.values()].map(d => d.schema).sort((a, b) => a.name.localeCompare(b.name)); // byte-stable -> cache

export function dispatch(name: string, rawInput: unknown, store: DocStore, baseVersion: DocVersion): ToolResult {
  const def = REGISTRY.get(name);
  if (!def) return { error: 'BAD_ID', detail: `unknown tool ${name}` };
  const args = rawInput as any;                          // SDK already parsed JSON — never string-match
  const err = def.validate(args, store); if (err) return err;
  const ops = def.plan(args, store);
  return store.commit(ops, baseVersion);                // single chokepoint; returns {ops,version}|{error}
}
```

**Startup assertion (guards "a malformed generated schema silently breaks ALL tool-use"):** at boot,
assert every registry entry produces a valid Anthropic tool schema (`schema.name === def.name`,
`input_schema.type === 'object'`). One bad schema would otherwise take down the whole demo.

Two representative commands:

```ts
// tools/commands/createFrame.ts — carries the build-something story
register({
  name: 'createFrame',
  schema: { name: 'createFrame',
    description: 'Create a new FRAME (container) inside an existing parent. Call this when the design needs a ' +
      'new section, card, or grouping box. Returns the created node id in the ops.',
    input_schema: { type: 'object', properties: {
      parent: { type: 'string', description: 'NodeId of the parent frame to nest inside.' },
      name:   { type: 'string', description: 'Human-readable name, e.g. "Pricing Section".' },
      bbox:   { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4,
                description: '[x,y,w,h] in canvas coords. Omit to default below the parent.' },
    }, required: ['parent'] } },
  validate: (a, store) => store.has(a.parent) ? null : { error: 'BAD_ID', detail: a.parent },
  plan: (a, store) => {
    const p = store.getNode(a.parent)!;
    const bbox = a.bbox ?? [p.bbox[0], p.bbox[1] + p.bbox[3] + 24, p.bbox[2], 200];
    const node: Node = { id: store.newId(), type: 'FRAME', name: a.name ?? 'Frame',
      bbox, parent: a.parent, children: [], layout: { mode: 'NONE' }, style: { fills: [] } };
    return [{ kind: 'add', node }];
  },
  label: a => `Creating frame${a.name ? ` "${a.name}"` : ''}`,
});

// tools/commands/applyAutoLayout.ts — the "it actually designs" lever (one call replaces ~20 setPosition)
register({
  name: 'applyAutoLayout',
  schema: { name: 'applyAutoLayout',
    description: "Arrange a frame's direct children in a row (H) or column (V) with even spacing, re-flowing " +
      'their positions. Call this to make a section look designed instead of scattered.',
    input_schema: { type: 'object', properties: {
      frame: { type: 'string', description: 'NodeId of the frame to lay out.' },
      dir:   { type: 'string', enum: ['H','V'], description: 'Row (H) or column (V).' },
      gap:   { type: 'number', description: 'Pixels between children. Default 16.' },
      padding: { type: 'number', description: 'Inner padding. Default 0.' },
      align: { type: 'string', enum: ['START','CENTER','END'], description: 'Cross-axis alignment.' },
    }, required: ['frame','dir'] } },
  validate: (a, store) => {
    if (!store.has(a.frame)) return { error: 'BAD_ID', detail: a.frame };
    const f = store.getNode(a.frame)!;
    return f.children.length ? null : { error: 'CONSTRAINT', detail: 'frame has no children to lay out' };
  },
  plan: (a, store) => {
    const gap = a.gap ?? 16, pad = a.padding ?? 0, f = store.getNode(a.frame)!;
    const kids = f.children.map(id => store.getNode(id)!);
    const ops: Op[] = [];
    let cursor = (a.dir === 'V' ? f.bbox[1] : f.bbox[0]) + pad;
    for (const k of kids) {
      const nx: [number,number,number,number] = [...k.bbox];
      if (a.dir === 'V') { nx[1] = cursor; nx[0] = cross(f, k, a.align, 'x', pad); cursor += k.bbox[3] + gap; }
      else               { nx[0] = cursor; nx[1] = cross(f, k, a.align, 'y', pad); cursor += k.bbox[2] + gap; }
      ops.push({ kind: 'set', id: k.id, path: 'bbox', value: nx });
    }
    ops.push({ kind: 'set', id: f.id, path: 'layout',
               value: { mode: a.dir === 'V' ? 'VERTICAL' : 'HORIZONTAL', gap, padding: pad, align: a.align } });
    return ops;
  },
  label: a => `Applying ${a.dir === 'V' ? 'vertical' : 'horizontal'} auto-layout, gap ${a.gap ?? 16}`,
});
```

The other six (`createText`, `createShape`, `setFill`, `setTextStyle`, `alignDistribute`, `placeBelow`)
follow the identical shape: `validate` checks every id arg; `plan` emits `add`/`set` ops; `label`
returns the streamed line. `placeBelow` takes `{ ids, target, gap }` and emits `set bbox` ops computed
from the target's bbox — **no raw pixels from the model**.

**`dryRun`** is supported in the wrapper envelope (return `ops` without committing) but **not wired into
the demo flow** (the cut). **Errors** are `BAD_ID` (fires in v1 — the LLM hallucinates ids regardless),
`STALE` (wired, dead single-writer), `CONSTRAINT` (one real check: auto-layout on an empty frame).
**Caching contract:** `buildAnthropicTools()` must be byte-stable across turns/runs — insertion-order
deterministic, static literal schemas, nothing volatile interpolated.

### 5.4 Agent Loop + LLM Integration

The runtime heart — a real Anthropic tool-use loop on `claude-opus-4-8`, streaming, with tier-1 verify
and bounded retry. A **manual** agentic loop (not the SDK tool-runner): every tool result must pass
through boundary validation + structural verify *before* it goes back to the model, with the snapshot
and per-call log emission in between — exactly the interception point the tool-runner hides.

```ts
// agent/loop.ts (shape; the SDK call lives in agent/llmAdapter.ts)
const MAX_TURNS = 12;        // hard ceiling so a run can't blow its token budget
const MAX_ATTEMPTS = 3;      // bounded retry per failing step

// A plan step carries an INDEPENDENT, machine-checkable post-condition — NOT just a human label.
// This is what makes tier-1 verify a real check instead of a tautology: verify asserts the target
// node's STATE, not "did the tool I just called commit" (commit already guarantees that).
type SuccessCriterion =
  | { kind: 'nodeExists'; parentId: NodeId; type: Node['type']; nameLike?: string }
  | { kind: 'childCount'; frameId: NodeId; count: number }
  | { kind: 'prop'; id: NodeId; path: string; equals: unknown }      // e.g. path 'layout.mode' equals 'VERTICAL'
  | { kind: 'belowOf'; id: NodeId; targetId: NodeId };               // bbox.y(id) >= bbox bottom(target)
interface Step { index: number; label: string; criterion: SuccessCriterion }

async function runTask(rc: RunController, intent: string, selection: NodeId[]) {
  rc.transition('PLANNING');
  rc.snapshot = store.snapshot();                 // one-Cmd-Z: capture BEFORE any mutation
  rc.emit({ kind: 'plan', text: 'Planning…' });   // emit on stream open, not on first text delta

  const rootId = resolveRoot(selection);          // selection's parent frame, or the page root
  const plan = await llm.plan(intent, rootId, selection); // streams "Planning…"; each Step carries label + criterion
  for (const step of plan) rc.emit({ kind: 'plan', step: step.index, text: step.label });

  let turns = 0;
  for (const step of plan) {
    rc.setStep(step); let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      if (++turns > MAX_TURNS) return rc.finishEscalated('Hit step budget.');

      // PERCEIVE: fresh scoped re-read each step (no getChanges)
      rc.transition('PERCEIVING');
      const tree = getTree(store, rootId, { depth: 2, fields: fieldsFor(step) });
      const r = await render(store, rootId, { marks: true, maxPx: 1024 });
      if (isErr(r)) return rc.finishEscalated(`Lost the working frame (${r.detail}).`); // guard the union — never feed an undefined image to the model
      const { image, markMap, version } = r;
      rc.baseVersion = version;
      rc.emit({ kind: 'perceive', text: 'Perceiving canvas…', image, markMap }); // flashes the marks beat

      // ACT: one model turn emitting tool_use, executed via the registry
      rc.transition('ACTING');
      const turn = await llm.act(rc.messages, { tree, image, markMap, version, step });
      if (turn.stopReason === 'refusal') return rc.finishEscalated('Declined.'); // branch BEFORE reading content
      if (turn.toolUses.length === 0) break;     // step done per model

      for (const tu of turn.toolUses) {
        rc.emit({ kind: 'act', tool: tu.name, text: labelFor(tu) });
        const result = dispatch(tu.name, tu.input, store, rc.baseVersion); // {ops,version}|{error}
        if (!isErr(result)) { rc.baseVersion = result.version; rc.emitOpsApplied(result.ops, result.version); }
        rc.pushToolResult(tu.id, result);        // is_error:true on a structured error
      }

      // VERIFY: tier-1 structural read-back (no model call, <5ms)
      rc.transition('VERIFYING');
      const v = verifyStructural(step.criterion, store);  // asserts STATE against the step's post-condition, not the tool calls
      if (v.ok) break;                            // step succeeded -> advance plan
      rc.pushReflection(v.evidence); attempts++;  // feed evidence back; retry
    }
    if (attempts >= MAX_ATTEMPTS) return rc.finishEscalated(`Couldn't complete: ${step.label}`);
  }
  rc.finishDone(summary(plan));                   // "Done — added pricing section, 3 tiers, gap 24"
}
```

```ts
// agent/llmAdapter.ts — ALL @anthropic-ai/sdk usage lives here
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic();                   // ANTHROPIC_API_KEY from .env
const MODEL = 'claude-opus-4-8';
const TOOLS = buildAnthropicTools();              // byte-stable, deterministically ordered -> cacheable
for (const t of TOOLS) assertValidToolSchema(t);  // startup assertion

async function act(messages, ctx, onDelta) {
  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive', display: 'summarized' }, // 4.8: adaptive only; display defaults to "omitted"
    output_config: { effort: 'high' },            // grounding gates the demo — keep quality high
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }], // cached prefix
    tools: TOOLS,                                  // render at position 0; byte-stable across turns
    messages: [...messages, { role: 'user', content: perceptionBlocks(ctx) }], // volatile: AFTER the breakpoint
  });
  // NB: the aggregated `contentBlock` helper fires on block STOP, too late for "verb first".
  // Use the raw stream event so the verb renders the instant the tool_use block OPENS.
  stream.on('streamEvent', e => {
    if (e.type === 'content_block_start' && e.content_block.type === 'tool_use')
      onDelta({ verb: e.content_block.name });                                                // verb on content_block_start
  });
  stream.on('inputJson', d => onDelta({ argsDelta: d }));                                     // params appended as they stream
  stream.on('text', t => onDelta({ thinking: t }));                                          // "Planning…"
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') return { stopReason: 'refusal' };  // branch BEFORE reading content[0]
  return { stopReason: msg.stop_reason,
           toolUses: msg.content.filter(b => b.type === 'tool_use') };  // input already parsed — never string-match
}
```

**Correctness points the SDK guidance enforces:** branch on `stop_reason` before reading `content`
(a refusal returns HTTP 200 with empty content — reading `content[0]` crashes mid-run); `tool_use.input`
is parsed JSON, pass it straight to `dispatch`; cache only the stable prefix and verify
`usage.cache_read_input_tokens > 0` across turns; the model id is a single constant.

**Verification (tier-1 structural, decision #4 default):** `verifyStructural` evaluates the step's
**plan-supplied `SuccessCriterion`** against the post-commit doc state (e.g. for `applyAutoLayout`:
`{kind:'prop', id:frame, path:'layout.mode', equals:'VERTICAL'}`). **Critically, the criterion is
independent of which tools ran** — it asserts the target node's *state*, not "did the tool I just
called commit." Verifying the latter would be a tautology, since `commit()` already guarantees the ops
landed; the honest `done`/`couldn't` status only has teeth if the check can disagree with the tool
calls (agent-loop-spec §5: every step has "an explicit, checkable success criterion"). No model
round-trip. A step whose criterion fails is caught, retried once, and if still failing the run
**escalates with a clean message and restores the pre-run snapshot** (see §5.1 resolved contradiction).
This is why `llm.plan` must emit a structured criterion per step, not just a human label.

### 5.5 Persistence + Transport (demo altitude)

A single Node process holds the authoritative graph in memory; the browser holds a read-only mirror;
every mutation flows through `store.commit()`. Nothing is persisted to disk except seed docs (committed
TS literals). Hono serves the static Vite bundle (and keeps the API key server-side); `ws` carries the
live channel. The agent loop runs server-side and pushes events as it streams.

**Single-writer guard (the review's `gap` — RESOLVED).** Human edits during a run are **hard-disabled**
while `RunController.phase !== 'IDLE'`. Selection stays read-only (so a user can eyeball / queue a
prompt), but drag/restyle is blocked. This prevents the snapshot/restore from clobbering a human edit
and the version counter from desyncing structural verify — a silent corruption that could happen on
camera. (The production fix is the STALE path + inverse-op undo.)

**Reconnect recovery (cheap insurance for recording):** on a dropped socket the client sends
`{ t:'resync' }`; the server replies with a full `doc-sync` snapshot. One handler; prevents a flaky
network during a recording from stranding the UI. v1 re-syncs the doc and marks the run "interrupted";
it does not resume the LLM stream (the server run keeps going; the client rejoins its event feed).

### 5.6 App Shell + UX

The thing a friend actually opens. A thin, deterministic React front-end over the read-only mirror; it
never calls the Anthropic API and never mutates the doc directly. Two stores, never conflated:
`useDocMirror` (nodes, version, selection — renderer subscribes) and `useRunStore` (phase, plan,
activity entries, marks beat, history — UI chrome subscribes).

**The WS protocol (one socket, typed both ways).** A plain discriminated union — *not* a
production-grade telemetry taxonomy (cut by review). Client → server: `{ t:'prompt', text, selection,
seedDocId } | { t:'undo' } | { t:'select', ids } | { t:'loadSeed', seedDocId }`. Server → client:

```ts
type ServerEvent =
  | { t: 'doc-sync';  nodes: Node[]; rootId: NodeId; version: DocVersion }  // full state (load/undo/resync)
  | { t: 'phase';     phase: RunPhase }
  | { t: 'plan';      steps: { label: string }[] }                         // first activity beat
  | { t: 'activity';  id: string; text: string; tool?: string; status: 'running' }
  | { t: 'activity-update'; id: string; text?: string; status?: 'ok'|'failed' }
  | { t: 'marks';     image: string /* data:image/png;base64 */; markMap: Record<string, NodeId> }
  | { t: 'ops-applied'; ops: Op[]; version: DocVersion; activityId?: string } // canvas snaps in
  | { t: 'done';      label: string; summary: string; fromVersion: DocVersion; toVersion: DocVersion }
  | { t: 'escalated'; label: string; reason: string }
  | { t: 'undone';    nodes: Node[]; rootId: NodeId; version: DocVersion };  // restored snapshot
```

**Canvas viewport.** A single `<svg>` with a pan/zoom group, rendered from the shared draw table so the
human's pixels and the agent's rasterized image are the same composition. `data-node-id` makes selection
a DOM hit-test (disabled while a run is active — single-writer guard). The **marks beat** is a transient
`<g>` flashed during `PERCEIVING`, driven by `useRunStore` (NOT the doc store) so ephemeral perception
UI never pollutes the persisted doc or its undo snapshot. Draw the numbered boxes from the live mirror's
bboxes (crisp, perfectly aligned) while keeping the server PNG available for a small corner
"agent's eye" thumbnail that confirms the boxes the model saw match the boxes on screen.

**Prompt bar.** Always present at the bottom. On submit it resolves the current selection to NodeIds
(F9) and ships them as the agent's target id set. Show 2–3 curated seed-prompt **suggestion chips** per
doc — the cheap insurance for the share moment (a friend who doesn't know what to type clicks a
known-good prompt). *(The review CUT selection-prefetch — do not warm perception speculatively.)*

**Activity log.** One labeled line per plan step and per tool call as the server streams them. First
line ("Planning…") appears on stream open. A running line shows a pulse; on `ops-applied` it flips to a
check; on failure, an honest "couldn't." The server emits `activity` (verb) on `content_block_start`,
then `activity-update` (params) on `input_json_delta` completion — verb immediately, params without
flicker.

**History + one-key undo (mic drop).** A 30-mutation run appears as ONE labeled entry. Cmd-Z / the Undo
button sends `{ t:'undo' }`; the server restores its pre-run snapshot and broadcasts `undone` with the
full restored doc, which the mirror applies via `doc-sync` semantics. History is keyed by
`{fromVersion,toVersion}` and is conceptually "revert this run" (not "jump to version N"), so the
production swap to inverse-op emission doesn't touch the history-panel UI. One undo level; a second
Cmd-Z is a no-op.

**Share path.** `pnpm dev` runs Vite + `tsx server/index.ts`; `ANTHROPIC_API_KEY` is server-side. The
shareable artifact is a **single deployed host** (Vite static bundle + one Node WS server on
Vercel/Render) so friends use a URL, not a local build — which also sidesteps the `@resvg/resvg-js`
native-binding install on a different OS/arch (the review's `gap`). Document one supported local run
path (the author's arm64 Mac) for everyone else.

---

## 6. Riskiest-first build order / milestones

Treat **`{ops,version}` as the frozen contract from hour one.** The ordering front-loads the only
research-risky layer (the loop) and keeps a single never-changing data contract so layers can be built
and swapped independently.

| Day | Milestone | Notes |
|-----|-----------|-------|
| **1–2** | **Scene graph + 8 tools + monotonic version + manual Opus 4.8 tool-use loop, HEADLESS.** Assert on the resulting node tree in the console. Faked perceive (static placeholder PNG + hand-built markMap) and faked verify (`{ok:true}`). **Boundary id-validation is real from the start.** | The de-risking event. The loop's success rate is the dominant unknown. Prove it here, against the curated prompts, before any UI. The day-1 harness becomes the eval/smoke test. |
| **2 (gate)** | **GO / NO-GO.** If the headless loop can't hit ~9/10 on 2–3 curated prompt+seed pairs after a day of prompt/tool-description tuning → fall back to a narrower demo (fewer tool types, more constrained prompts, or pre-resolved target ids via selection-only) BEFORE building UI. | The project's existential risk has an explicit Plan B (the review's #1 `gap`). Lean on prescriptive tool descriptions ("call this when…") and the silence-default system prompt from hour one. |
| **3** | **SVG renderer (human view)** via the shared draw table. | The single source of pixels; no parallel renderer. |
| **4** | **Set-of-marks overlay + SVG→PNG raster.** Swap faked perceive for real `getTree` (skeleton) + marked `render`; field-project to ~3k tokens/turn. **Validate font/wrap fidelity on the densest seed doc.** | Build once, used twice. |
| **5** | **Real tier-1 structural verify + bounded retry + honest done/couldn't.** Snapshot undo. | Gate: real verify is a MUST before any screen-record attempt (a faked verify reporting false "Done" on camera is fatal). |
| **6** | **Streaming activity log + prompt bar + the visible marks beat in the UI.** Wire the silence-default + `count_tokens` measurement of the real seed-doc payloads. | Wire streaming early enough to *feel* the latency. Measure TTFT explicitly — don't assume < 2.5 s. |
| **7** | **Curate 2–3 seed docs + known-good prompts.** Tune the system prompt against the day-1 headless harness as a regression gate. | Demo reliability beats generality. |
| **8** | **Selection-scoping (F9, P1) + polish + record.** | The repeat-use beat. |

**Calendar reality (the review's `topRisk`):** these are ~8 *focused* days. For a solo dev with a job,
plan **2–3 calendar weeks**. The wow-beats land deliberately late (days 6+) — socialize the
riskiest-thing-first plan so the headless-but-working **day-2** milestone is recognized as the real
de-risking event, not the pretty canvas.

**Safe corner cuts:** hardcode seed docs as TS literals; single document, no save/open; no responsive/
mobile; ignore z-order/groups/components; one undo level; localhost-or-single-deploy sharing.
**Fatal to cut:** the marked-thumbnail beat, the streaming log, real structural verify with honest
status, boundary id-validation, the curated seed+prompt pairs.

---

## 7. Production evolution path (consolidated)

Every v1 seam was chosen to make the cut features additive — except undo, which is a hard fork.

| v1 mechanism | Production replacement | Re-entry seam |
|--------------|------------------------|---------------|
| In-memory `Map` store | Server-authoritative persisted store: `commit()` moves server-side, assigns the version, persists an event-log + periodic snapshot checkpoint, applies LWW per `(nodeId, path)`, broadcasts | `commit()` is already the single chokepoint taking `baseVersion` and returning `STALE`. |
| **Snapshot undo** ⚠️ | **Inverse-op log + per-user undo stack.** Add an `inverse` to each Op (or compute in `applyOps`); undo emits inverse ops as new changes. | **HARD FORK** — snapshot-restore clobbers a second writer, so it MUST change the moment multiplayer is prototyped. The history label ("Agent: …") and the "revert this run" semantics are unchanged. |
| Single writer; `STALE` dead | Multiplayer: a concurrent human edit bumps the version past the agent's baseVersion → the already-wired `STALE` branch activates → the loop re-perceives and retries. Add presence + an `actorId` tag. | The loop's `catch STALE` branch is structurally present (currently dead). |
| Fresh scoped re-read each step | `getChanges(since=version)` patches the running model; `query()` finds nodes without scanning. | Both slot in behind the identical perception envelope. |
| Tier-1 structural verify only | Tiers 2–3 (spatial-invariant overlap/bounds checks; render+ask-Claude "does it look right?") reusing the render path, as an explicit user-triggered check. | The verify stage; the render path is already built. |
| 8 semantic tools | The full ~20-tool vocabulary + `setProperty`/`batch` escape hatch + components/instances/groups/vector/constraints/gradients/effects. Re-add node TYPES additively against the same Node model. | One new registry entry per tool; `tool-search` (appends, not swaps) preserves the cache past ~20 tools. |
| `dryRun` in envelope, unwired | Ghosted preview + Apply gate for long/ambiguous/destructive tasks. | `dryRun` already returns ops without committing. |
| Single-shot loop | Multi-turn conversational context + escalate-with-specific-ask + step summarization. | Layered on the plan-then-ReAct skeleton as richer verify/reflect/escalate branches. |
| SVG renderer | PixiJS/WebGL behind the same `buildSvg(rootId,{marks})` contract; offscreen/worker rasterize for the vision channel. | The `(store, version) -> pixels` contract is preserved; only the rasterizer changes. |
| Array `children` order | Fractional position keys (the one place LWW fails). | The **least-additive** change — flagged as a known migration cost, deliberately not hedged in v1. |
| Committed TS seed literals | Real document model + import; `schemaVersion` + `migrate()` chokepoint. | Added when persisted user docs exist. |
| Opus 4.8 throughout | Spawn a Sonnet 4.6 / Haiku 4.5 **subagent** for parallel-safe sub-tasks (preserves the main cache); tier by step value, never a blanket mid-run model switch. | The SDK adapter is the home for routing/fallback. |

---

## 8. Open questions & top risks

### Top risks (riskiest first)

1. **Loop reliability is the whole ball game.** The ~51% grounding ceiling means Opus 4.8 may not
   reliably turn one English sentence into correct tool calls over the set-of-marks image, often enough
   that even curated pairs feel fragile. **Mitigation:** prove it day 1–2 headless; keep the harness as
   a regression eval; curated seed+prompt pairs for recordings; the day-2 GO/NO-GO with a narrower
   Plan B; structural verify + bounded retry; tighter prescriptive tool descriptions.
2. **Time-to-first-token / felt latency.** A 4–6 turn loop at 2–4 s TTFT each is 12–25 s — long for a
   2-min recording, and the adaptive-thinking "Planning…" pause is exactly the dead-spinner failure the
   log exists to prevent. **Mitigation:** emit "Planning…" on stream open; cache pre-warm on load;
   `display: 'summarized'`; keep demo prompts ≤ 6 turns; **measure TTFT, don't assume**.
3. **Set-of-marks rasterization fidelity.** If resvg renders fonts/text-wrap differently from the
   browser, the agent's image won't match the human view, weakening the "it sees THIS design" claim.
   **Mitigation:** ONE renderer (resolved), bundle the same font both sides, single-line seed-doc text,
   verify visually before recording.
4. **Opus 4.8 verbosity + cost drift.** 4.8 narrates more than 4.7 and under-reaches for tools unless
   prompted. **Mitigation:** silence-default + prescriptive tool descriptions in the system prompt from
   day 1; verify `cache_read_input_tokens > 0`.
5. **Scope-creep via "cheap hedges."** The aggregate of the deferred production plumbing (§2.2) is days
   of invisible work competing with loop-reliability iteration. **Mitigation:** hold the line on the
   cut list; build the BAD_ID branch, the snapshot, and the informal seams — nothing else.
6. **Calendar vs effort.** "8 days" is 8 *focused* days ≈ 2–3 calendar weeks for a solo dev. State it
   honestly to avoid a day-6 morale cliff when the wow-beats land late.

### Open questions (decide before / during the build)

- **Seed-doc token reality (decide before quoting cost/latency to friends).** Run
  `client.messages.countTokens({ model: 'claude-opus-4-8', messages: [...] })` on the actual seed-doc
  skeleton + a 1024px marked render. The 3k/turn and ~$0.20/run numbers are spec estimates, not
  measurements. Also confirm the cached prefix clears the **4096-token** Opus 4.8 minimum (else caching
  silently no-ops).
- **`MAX_TURNS` / `MAX_ATTEMPTS` values** that keep curated demos ≤ 6 turns while still recovering from
  a single BAD_ID — measure against the real seed docs.
- **Plan turn: separate call vs folded into turn 1?** v1 leans single-model Opus (cache integrity);
  plan-as-first-turn vs plan-as-forced-tool-call needs a latency measurement.
- **Marks beat duration:** auto-dismiss after ~2.5 s, persist until the first ACTING op, or dock to a
  corner thumbnail for the run? Current design: float center ~2.5 s, then dock to a corner thumbnail.
- **Render viewBox crop** when loose seed elements sit partly outside the working frame's bbox — clip
  to the frame (lose context) or expand to the union of child bboxes (pay more image tokens)?
- **Mark legibility ceiling:** numbered boxes get cramped past ~100 visible nodes at 1024px — out of
  scope for the curated docs, but note the rule (crop deeper vs raise maxPx) before a friend pastes a
  denser doc.
- **Fractional child-order keys:** accept array indices as a known non-additive migration cost (the v1
  choice), or store a position key now? v1 accepts the cost — flagged, not hedged.
