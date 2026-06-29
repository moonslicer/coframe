# Headless agent loop — "prove the bet first"

> **Archived prototype.** This was the earliest standalone proof-of-concept and has
> been superseded by the full app under [`/app`](../../../app). It is kept here for
> historical reference only; it is not wired into the main project.

The **day 1–2 slice** from [`../../IMPLEMENTATION.md`](../../IMPLEMENTATION.md): a real
Anthropic tool-use loop over a vector scene graph, with **no UI and no rendering**.

It exists to answer the one question the whole project hangs on:

> **Can Claude Opus 4.8 reliably turn one English sentence into correct semantic
> tool calls against a canvas?**

If this feels solid, the UI / set-of-marks rendering / app shell are known-solvable.
If it's shaky, no amount of polish saves the demo — so we test it here, cheaply, first.

## What's in (and deliberately out)

In: the scene-graph document model, the 8 semantic tools, boundary validation +
diff-return, and the perceive → act → apply loop on `claude-opus-4-8`.

Out (days 3–4, on purpose): the browser canvas, SVG rendering, the **set-of-marks**
image channel, structural-verify-and-retry, persistence, and multiplayer. Perception
here is the **structured text tree only** — the agent never sees pixels.

## Run it

```bash
cd headless-loop
npm install
cp .env.example .env   # then paste your key, or just export ANTHROPIC_API_KEY

# tidy the scattered hero
npm start -- "tidy the hero: stack its contents in a centered column with even spacing"

# build something new
npm start -- "add a pricing section below the hero with 3 cards, each with a title, price, and a button"

# recolor / restyle
npm start -- "make the CTA button green and the headline bigger and bolder"
```

Each run prints the **before** tree, a live trace of the model's thinking + every
tool call (`✓`/`✗`), the **after** tree, and a verify summary. You judge by eye
whether the result matches the intent — that human judgment *is* the day-1/2 gate.

## The 8 tools (`src/tools.ts`)

`createFrame` · `createText` · `createShape` · `setFill` · `setTextStyle` ·
`placeBelow` · `alignDistribute` · `applyAutoLayout`

Each is one registry entry = schema + `validate` (the `BAD_ID`/`CONSTRAINT` boundary)
+ `plan` (emits ops) + `label`. Adding a tool = adding one entry.

## Files

| File | Role |
|------|------|
| `src/types.ts` | scene-graph + op types |
| `src/store.ts` | `DocStore.commit()` (the one write path) + pure `applyOps` |
| `src/seed.ts` | the starting document (a scattered hero) — edit to add demo cases |
| `src/tools.ts` | the 8 semantic tools, registry, `dispatch` |
| `src/perception.ts` | scene graph → compact text the agent reads each turn |
| `src/llm.ts` | the only file that imports the Anthropic SDK |
| `src/loop.ts` | the manual agentic loop |
| `src/index.ts` | CLI: load seed → run → print before/after + verify |

## If the bet is shaky

Per the IMPLEMENTATION.md review, if the loop can't reliably produce a sensible
result here, spend the next 2–4 days on **prompt + tool-description iteration**
(the system prompt in `src/llm.ts`, the tool `description` fields in `src/tools.ts`)
*before* any UI work — that iteration, not rendering, is the real schedule risk.
