# Agentic Design Canvas — Design Doc

**Product:** An AI agent that perceives and edits a Figma-like vector document, co-editing alongside humans.

## Requirements

**Functional**
- Document model: scene graph (frames, layers, vectors, text, components, auto-layout/constraints)
- Agent can perceive canvas state and mutate it (create / move / restyle / group / componentize)
- Human + agent co-edit the same document
- Undo/redo + history (the agent's safety net)
- Agent loop: perceive → plan → act → verify

**Non-functional**
- Responsive agent edits (sub-second for simple ops)
- Agent's model stays consistent with actual doc
- Safety: every agent action undoable, ideally previewable
- Scale: large docs (10k+ nodes) + human/agent concurrency
- Reproducibility: same intent → predictable result

## Core decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| 1 | Perception | Hybrid: structured tree (addressing/props) + rendered thumbnail (spatial) | Tree can't cheaply convey layout/aesthetics; vision can't address precisely |
| 2 | Mutation interface | High-level semantic tools + low-level escape hatch | Token-efficient, matches designer intent; mirrors Claude Code's "good tools > primitives" |
| 3 | Concurrency | Agent is a participant via multiplayer layer; each action = 1 atomic transaction | Free undo/merge/history; human sees coherent steps not 200 micro-edits |
| 4 | Verification | Structural assertion by default; vision check on demand / end of task | Controls cost & latency |

## Architecture (high level)

```
Human editor ──mutations──► Document model + sync layer (authoritative scene graph)
Agent loop  ──perceive────►        │ render
(LLM+tools) ──act(tools)──►        ▼
            ◄─verify──────  GPU renderer
```

## Open / next

- [x] Perception layer deep-dive → see `perception-spec.md`
- [x] Deep research pass → see `research-findings.md` (all 4 decisions confirmed; 25 claims verified 3-0)
- [x] Tool vocabulary design → see `tool-vocabulary-spec.md`
- [x] Concurrency/merge model → see `concurrency-spec.md` (server-authoritative LWW + fractional indexing)
- [x] Agent loop: planning, verification, error recovery → see `agent-loop-spec.md`

## Status: design complete

All five layers specified + research-grounded. Companion files:
`perception-spec.md` (see) · `tool-vocabulary-spec.md` (do) · `concurrency-spec.md` (merge) ·
`agent-loop-spec.md` (runtime) · `research-findings.md` (cited evidence).
