# Research Findings — Reconciled Against the Design

Deep-research pass: 5 angles, 23 sources, 107 claims extracted → 25 adversarially verified (3-0,
**0 refuted**). Below: verified claims, citations, and how each maps to our decisions.

## Thread 1 — Figma's actual architecture

### Sync (validates decision #3)
- **Figma deliberately did NOT use Operational Transforms (OT).** [primary]
- **Architecture is server-authoritative**; the server holds the source of truth. [primary]
- **Conflicts on object properties resolved by last-writer-wins (LWW)**, per-property. [primary]
- **Each change gets a server-assigned incrementing integer** (the version). [primary]
- It's **CRDT-*inspired*, not a full CRDT** — and explicitly not OT.

> **Why this matters / the interview insight:** Figma chose LWW-per-property *because a canvas is
> not a text buffer*. OT/CRDT exist to preserve intention on a shared character *sequence* (Google
> Docs). Figma's objects and their properties are largely independent, so there's no sequence to
> reconcile — last-writer-wins on each property is enough, and far simpler. The one place they *do*
> need sequence-CRDT logic is child ordering within a parent (fractional indexing).
>
> **Correction to our spec:** I'd written "vector clock / monotonic stamp." Figma's real mechanism
> is simpler — a single **server-assigned monotonically incrementing integer per change**. No vector
> clock needed because the server serializes everything. Updated in the specs.

Sources: figma.com/blog/how-figmas-multiplayer-technology-works, /making-multiplayer-more-reliable

### Document model (validates the scene-graph)
- **A document is a tree of objects, each with properties**; geometry uses a custom **vector
  network** (not plain paths). [primary] → matches our `Node` model.

### Renderer
- Editor **written in C++, cross-compiled to WASM**; **asm.js → WebAssembly cut load time ~3×**;
  renderer **built from scratch in WebGL, tile-based**, later **migrated WebGL → WebGPU**. [primary]
- Not load-bearing for the agent layer, but it's the answer to "why not the DOM" in an interview.

Sources: building-a-professional-design-tool-on-the-web, webassembly-cut-figmas-load-time-by-3x,
figma-rendering-powered-by-webgpu, madebyevan.com/figma

## Thread 2 — Agentic perception (validates decisions #1, #2, #4)

### Set-of-marks is real and effective (validates decision #1)
- **SoM uses off-the-shelf segmentation to overlay numbered marks on an image**; with SoM, **GPT-4V
  zero-shot outperforms prior SOTA** on grounding. [primary: arxiv 2310.11441, microsoft/SoM]
- Exactly the vision↔addressing bridge in `perception-spec.md §5`.

### ...but grounding is the ceiling — a critical caveat
- **SeeAct: GPT-4V completes only 51.1% of live-website tasks even with *oracle* grounding.** [primary: arxiv 2401.01614]
- **"Grounding — mapping an intended action to the actual target element — is the bottleneck."**

> **Implication:** even with perfect addressing, the model still fails ~half of complex tasks. So
> set-of-marks is necessary but not sufficient — this *raises* the value of decision #4 (structural
> verification) and of keeping a human in the loop on ambiguous edits. Don't oversell agent autonomy
> in the interview; lead with the verify-and-recover loop.

### Token cost of representation (strongly validates field projection, decision #1)
- **Inefficient UI representation is the *dominant* cost — 80–99% of total tokens.** [primary: arxiv 2512.13438]
- **UIFORMER synthesizes programs that compress the representation, cutting tokens 48.7–55.8%.**

> **Implication:** our progressive-disclosure + field-projection instinct targets the single biggest
> cost. New idea worth a line in the spec: beyond projection, a *program-synthesis* representation
> (emit a compact program that reconstructs the subtree) is an advanced compression lever. Caveat:
> UIFORMER is a Dec-2025 preprint — cite as "emerging," not settled.

### Real-world prior art
- **Figma has opened its canvas to agents** (figma.com/blog/the-figma-canvas-is-now-open-to-agents)
  — direct evidence this product class is real; worth studying their tool surface.

## Net effect on the design
| Decision | Verdict from research |
|----------|----------------------|
| #1 Hybrid perception (tree + marked render) | **Confirmed.** SoM validated; field projection targets the 80-99% cost. |
| #2 Semantic tool API | **Consistent.** Figma's own agent surface is high-level/semantic. |
| #3 Agent as participant via multiplayer + txns | **Confirmed & sharpened.** Figma = server-authoritative LWW-per-property + incrementing version. Simplify our "vector clock" to a server-assigned integer. |
| #4 Structural verify by default | **Reinforced.** 51.1% grounding ceiling makes verify + human-in-loop essential. |

## Caveats on the evidence
- SeeAct's grounding failures are **GPT-4V / web-DOM specific** — a purpose-built canvas with native
  ids should beat 51.1%, but treat it as the cautionary baseline.
- UIFORMER is a **Dec-2025 preprint** — promising, not proven.
