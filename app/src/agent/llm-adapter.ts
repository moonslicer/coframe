// ALL @anthropic-ai/sdk usage is confined to this module (the only file that imports
// the SDK, per §4.5). It exposes:
//   - SYSTEM_PROMPT — silence-default + prescriptive tone, ported from
//     headless-loop/src/llm.ts (full silence tuning + count_tokens is Day 6).
//   - plan(intent, rootId, store, selection) -> Step[] via a forced tool-call
//     (tool_choice: emit_plan) whose schema is the Step[] shape.
//   - act(messages, ctx) -> one NON-streaming tool-use turn (streaming is Day 6);
//     branches on stop_reason==='refusal' BEFORE reading content.
//
// The pinned SDK types (0.32.1) lag the API — adaptive thinking / effort / structured
// fields are cast through `any`, exactly the pattern headless-loop/src/llm.ts uses.

import Anthropic from "@anthropic-ai/sdk";
import type { DocStore } from "../shared/store.js";
import type { NodeId } from "../shared/types.js";
import { buildAnthropicTools, assertValidToolSchemas } from "../shared/tools.js";
import { getTree } from "../render/perception.js";
import type { Step, SuccessCriterion } from "./types.js";

const MODEL = "claude-sonnet-4-6";
const TOOLS = buildAnthropicTools();

// The pinned SDK (0.32.1) does not export ContentBlockParam; reconstruct it from
// MessageParam's content element type so the loop + run-controller can share it.
export type ContentBlockParam = Exclude<Anthropic.MessageParam["content"], string>[number];

// A cached system text block. cache_control is a current API field the pinned SDK
// types don't expose yet — cast through any (same pattern as headless-loop/src/llm.ts).
const cachedSystem = (text: string): Anthropic.TextBlockParam[] =>
  [{ type: "text", text, cache_control: { type: "ephemeral" } } as any];

// 4.8 narrates more and under-reaches for tools by default — both tuned here.
// (a) silence-default, (b) prescriptive loop policy, (c) the addressing contract.
export const SYSTEM_PROMPT = `You are a design agent that edits a Figma-like vector canvas by calling tools.

The canvas is a scene graph of nodes (FRAME, TEXT, RECT, ELLIPSE), each with a stable id like "node:7".
Before each step you are shown the scoped scene graph as text AND a rendered image with numbered marks
([1], [2], ...) drawn over each node. A markMap maps each number to a NodeId. Reason about layout on the
image, then act with tools using the NodeId — resolve markMap[n] -> NodeId yourself; tools take NodeIds
ONLY, never mark numbers.

Loop policy: plan -> perceive -> act -> verify -> done. You are inside one step of a pre-made plan; do the
minimum tool calls that satisfy THIS step, then stop.

Design quality defaults:
- Treat every open-ended request as a product design task, not a wireframe task. Infer a coherent style
  direction from the user's words, domain, and platform: iOS, editorial, playful, luxury, brutalist,
  dashboard, SaaS, game-like, minimal, etc. Do not reuse one generic purple/card look for every prompt.
- A polished result has hierarchy, spacing, alignment, rhythm, contrast, and intentional shape language.
  Use rounded corners, separators, soft panels, badges, charts, icons, or illustration-like shapes when
  they fit the requested style. If the requested style is sharp/brutalist, make that sharpness intentional.
- Build complete visible states. Screens need realistic content, headers, controls, labels, lists, empty
  states, and enough surrounding context to feel usable. Components need their expected inner details.
- Avoid bare rectangles. When you create a panel, card, button, toolbar, row, or modal, style its fill,
  radius, border/stroke, text hierarchy, and internal spacing so it reads as a finished object.
- Match the prompt's platform conventions when named: mobile screens should feel mobile-sized and touchable;
  iOS-like UIs use larger radii, translucent panels, generous vertical rhythm, and centered/aligned symbols;
  operational dashboards are denser, quieter, and scan-friendly.

Rules:
- ALWAYS act through tools. Do not describe what you would do — call the tool that does it.
- To BUILD new content (a section, screen, card grid, list, form, header — anything more than ~2 new
  nodes), strongly prefer ONE composeSubtree call describing the whole nested subtree at once, rather than
  many createFrame/createText/createShape turns. Think through the entire composition, then emit it in a
  single call: give each FRAME a layout {dir,gap,padding,align} and its children, with sizes (w,h) and
  inline styling. This is faster and produces a more coherent result than building node-by-node.
- Prefer semantic tools (applyAutoLayout, alignDistribute, placeBelow) over raw coordinates.
- Reference nodes by their exact id from the scene graph or markMap. Never invent an id.
- When you create a frame, its new id is returned in the ops; use that id to add children on the NEXT turn.
- createFrame WITHOUT a bbox already places the new frame directly below its parent. Do NOT follow it
  with a separate placeBelow to move it under the same parent — that is a redundant, wasted call.
- To make several elements look intentional, use ONE call: applyAutoLayout on their shared parent frame
  (a row=H or column=V with even spacing), or alignDistribute on a set of ids (a shared edge/center).
  Do not hand-set positions one node at a time.
- If the human has selected NodeIds, those are your targets — operate on exactly that set, not the
  whole canvas.
- A container is not finished until it HOLDS its requested contents. A new FRAME is only a styled shell
  until you add the content and layout it needs. Whatever the domain, fill it with the parts that unit is
  actually made of — infer them from the element and the requested style, do not leave a created frame
  empty. For example: a button needs its label TEXT; a card needs its title plus the supporting
  text/shapes the request implies; a list row needs its leading icon/avatar shape AND its label TEXT; a
  media tile needs its thumbnail shape, title, and meta line; a stat needs its number AND its label; a
  nav/tab bar needs its icon shapes. After createFrame for such an element, create those children
  (createText / createShape into that frame) in the SAME step before you stop.
- BATCH repeated sets in ONE turn. When a step calls for a SET of similar items — a row of cards, a
  multi-day list, a grid of tiles, a stack of rows, a set of tabs — emit ALL of them (every frame AND
  every text/shape inside them) as multiple tool calls in a SINGLE response. Do NOT create one example
  item and stop: you get only a few turns per step, so one-item-per-turn runs out of budget and ships a
  half-built section. If the step names a count ("5 cards", "7 days", "8 thumbnails"), produce that many.
- Use the EXACT words the user specified for a label or title. If they said the title is "Sign In",
  create the text "Sign In", not "Log In" or any paraphrase.
- If the user named a color for an element (e.g. "a blue button"), set that fill with setFill — a
  created frame is white by default and will not look blue on its own.
- When MOVING a node, preserve its existing width and height (read them from the scene graph) and change
  only x and y. Do not resize a node unless the user explicitly asked to resize it.
- Default to SILENCE between tool calls. Emit at most one short terse line per action. No narration, no
  preamble, no recap. When the step's goal is met, stop calling tools.`;

// ---- plan: one Opus call, forced emit_plan tool-call returning Step[] ----

const PLAN_TOOL: Anthropic.Tool = {
  name: "emit_plan",
  description:
    "Emit the ordered list of steps that accomplish the user's intent. Each step has a human label AND " +
    "an independent, machine-checkable success criterion describing the TARGET NODE'S STATE after the step " +
    "(not which tool ran). Keep the plan tight (2-5 steps for a typical request).\n" +
    "CRITICAL — criterion id rules (a criterion naming an id that won't exist when it runs can NEVER pass, " +
    "forcing a false failure):\n" +
    "- For a node THIS plan creates, you do NOT know its id. Verify it BY NAME: existence with `nodeExists`, its " +
    "child count with `childCountNamed`, and any property (layout.mode, style.fills) with `childProp` (each takes " +
    "parentId + type + nameLike). NEVER put a created node's guessed id into `prop`/`belowOf`/`childCount.frameId`.\n" +
    "- `prop`, `belowOf`, and `childCount` may reference an id ONLY if it ALREADY appears in the scene graph below.\n" +
    "- ORDERING: a step that lays out / distributes / styles a frame's children MUST come AFTER the step that " +
    "creates those children (auto-layout on an empty frame errors). Create children first, lay out last.\n" +
    "- Do NOT split 'create X' and 'position X below Y' into two steps — make ONE step that creates X below Y, " +
    "verified by `nodeExists` (parentId + nameLike). createFrame already defaults BELOW its parent, so a " +
    "separate 'place it below' step is redundant — never emit one.\n" +
    "- Keep the plan MINIMAL: one step per distinct outcome the user asked for. Do NOT add steps for things " +
    "the tools do automatically (default positioning, even spacing inside applyAutoLayout). Aligning OR " +
    "distributing a set of existing children is usually ONE step. Re-styling a selected set to match one of " +
    "them is ONE step. A typical request is 1-3 steps, not 4-5.\n" +
    "- For broad generative prompts like 'design an app screen', 'make a landing page', or 'create a dashboard', " +
    "plan for a finished composition: structure, representative content, style/hierarchy, and final layout. " +
    "It is valid for one step to create multiple children and style them together, but do not verify only an " +
    "empty container.\n" +
    "- If the prompt names a style, platform, or theme, ensure at least one step makes that visual direction " +
    "observable through properties such as fills, corner radius, typography, spacing, and layout. If no style is " +
    "named, pick a coherent direction that fits the product category instead of a generic default.\n" +
    "ALWAYS emit at least one step — NEVER return an empty plan. Every request below maps to tool calls; " +
    "if the goal is align/distribute/restyle of EXISTING nodes, you CAN still write a checkable criterion:\n" +
    "- 'arrange/line up/row/column the children of frame F' -> ONE step calling applyAutoLayout on F; verify " +
    "with `prop` {id: F (an EXISTING id), path: 'layout.mode', equals: 'HORIZONTAL' (row) or 'VERTICAL' (col)}.\n" +
    "- 'left-align / top-align nodes A,B,C' (alignDistribute, no layout flag) -> ONE step; verify the move with " +
    "`belowOf` if the request stacks them, OR `prop` {id: an EXISTING node id, path:'bbox', equals:<predicted>} " +
    "only if you can predict it; otherwise verify the parent still holds them with `childCount` " +
    "{frameId: their EXISTING parent, count:<n>} — a permissive but valid criterion so the step can pass.\n" +
    "- 'make the selected nodes match node X's style' -> ONE setFill/setTextStyle step; verify with `prop` " +
    "{id: one of the OTHER selected EXISTING ids, path:'style.fills', equals: X's current fills array}.",
  input_schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered steps. index starts at 0 and increments by 1.",
        items: {
          type: "object",
          properties: {
            index: { type: "number", description: "0-based step order." },
            label: {
              type: "string",
              description: 'Short human label, e.g. "Create pricing section frame".',
            },
            criterion: {
              type: "object",
              description:
                "A machine-checkable post-condition. Pick ONE kind. " +
                "nodeExists: a child of `parentId` with `type` (and optional `nameLike` substring) exists. " +
                "childCount: existing `frameId` has AT LEAST `count` direct children (count is a " +
                "minimum). When the user NAMES a count for the set ('6 tiles', '7 days', '4 stats', " +
                "'8 thumbnails'), set `count` to THAT number so a half-built set fails verify and the " +
                "loop finishes it. Only when NO count is named pick a small lower bound (2-3 for a vague " +
                "'a row of cards') and let the act model decide the exact number. " +
                "childCountNamed: like childCount but the frame is RESOLVED BY `parentId`+`type`+`nameLike` — " +
                "use this to assert the child count of a frame THIS plan creates. " +
                "prop: live `id`.`path` deep-equals `equals` (e.g. path 'layout.mode' equals 'VERTICAL') — " +
                "`id` MUST already exist in the scene graph. " +
                "childProp: like prop but the node is RESOLVED BY `parentId`+`type`+`nameLike` — use this to " +
                "assert a property (e.g. 'layout.mode'='HORIZONTAL', 'style.fills') of a node THIS plan creates, " +
                "whose id is unknown at plan time. " +
                "belowOf: existing node `id` sits below existing node `targetId` (top y >= target's bottom). " +
                "belowOfNamed: like belowOf but the moved node is RESOLVED BY `parentId`+`type`+`nameLike` " +
                "(for a node THIS plan creates) and sits below the existing `targetId`. " +
                "aligned: a SET of EXISTING nodes (`ids`, 2+) share an `edge` " +
                "(LEFT/RIGHT/TOP/BOTTOM/CENTER_X/CENTER_Y). THIS is how you verify an align/distribute step — " +
                "e.g. top-aligning three card titles -> {kind:'aligned', ids:[<title ids>], edge:'TOP'}. " +
                "Do NOT verify an alignment with childCount (that ignores position) or a guessed bbox prop.",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "nodeExists",
                    "childCount",
                    "childCountNamed",
                    "prop",
                    "childProp",
                    "belowOf",
                    "belowOfNamed",
                    "aligned",
                  ],
                },
                parentId: { type: "string", description: "nodeExists: parent NodeId." },
                type: {
                  type: "string",
                  enum: ["FRAME", "TEXT", "RECT", "ELLIPSE"],
                  description: "nodeExists: expected node type.",
                },
                nameLike: {
                  type: "string",
                  description: "nodeExists: optional case-insensitive name substring.",
                },
                frameId: { type: "string", description: "childCount: frame NodeId." },
                count: { type: "number", description: "childCount: MINIMUM child count (>=). Use the user's NAMED count when given ('6 tiles' -> 6); else a small lower bound (2-3)." },
                id: { type: "string", description: "prop/belowOf: target NodeId." },
                path: {
                  type: "string",
                  description: "prop: dotted path, e.g. 'layout.mode' or 'bbox'.",
                },
                equals: { description: "prop: value the path must deep-equal." },
                targetId: { type: "string", description: "belowOf: reference NodeId." },
                ids: {
                  type: "array",
                  items: { type: "string" },
                  description: "aligned: 2+ existing NodeIds that should share the edge.",
                },
                edge: {
                  type: "string",
                  enum: ["LEFT", "RIGHT", "TOP", "BOTTOM", "CENTER_X", "CENTER_Y"],
                  description: "aligned: which edge/center the ids must agree on.",
                },
              },
              required: ["kind"],
            },
          },
          required: ["index", "label", "criterion"],
        },
      },
    },
    required: ["steps"],
  },
};

let sharedClient: Anthropic | null = null;
function client(): Anthropic {
  if (!sharedClient) {
    assertValidToolSchemas(); // fail fast on a malformed generated schema
    sharedClient = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return sharedClient;
}

/** Plan the intent into ordered, criterion-carrying steps (one forced tool-call). */
export async function plan(
  intent: string,
  rootId: NodeId,
  store: DocStore,
  selection: NodeId[],
  onUsage?: (u: Usage) => void,
): Promise<Step[]> {
  // The planner projects ALL task-relevant fields (layout + style + text) so it can
  // both choose the right tool AND copy concrete values (e.g. a button's fills) into a
  // `prop` criterion's `equals`. The per-step act() calls stay narrowly projected.
  // Depth 5 so nested elements (e.g. a title TEXT inside a card inside a board) are
  // visible to the planner — it can't reference ids it can't see. Cheap at demo scale.
  const tree = getTree(store, rootId, { depth: 5, fields: ["layout", "style", "text"] });
  const selectionLine = selection.length
    ? `The human has selected these NodeIds: ${selection.join(", ")}.\n`
    : "";

  const baseUser =
    `Intent: ${intent}\n\n` +
    selectionLine +
    `Working frame root: ${rootId}\n` +
    `Current scene graph (scoped):\n${JSON.stringify(tree)}\n\n` +
    `Decompose this into an ordered plan. Each step MUST carry a success criterion that asserts the ` +
    `resulting node state (so it can be verified independently of the tools you call). ` +
    `Only the NodeIds listed above exist right now; any node your plan creates has NO id yet, so verify ` +
    `created nodes with nodeExists/childCount, and use prop/belowOf only on the existing ids above.\n\n` +
    `For broad design-generation intents, plan a complete composition rather than a skeleton: include ` +
    `representative content, visual hierarchy, style treatment, and final layout. If the user names a ` +
    `style/theme/platform, make that direction visible through node properties such as fills, corner radius, ` +
    `typography, spacing, and layout. If no style is named, pick one coherent visual direction that fits the ` +
    `product category.\n\n` +
    `If the intent names an element that should CONTAIN content — a labeled button, a card with a ` +
    `title and supporting detail, a list row with a leading icon/avatar and a label, a stat with a number ` +
    `and a label, a media tile with a thumbnail/title/meta, or any repeated content unit for the domain at ` +
    `hand — plan ` +
    `the step(s) that CREATE that inner content and verify the CONTENT (e.g. nodeExists TEXT by nameLike, or ` +
    `childCountNamed on the container), NOT just the container: a frame with no children renders blank. ` +
    `(A request that only aligns, distributes, restyles, or moves EXISTING nodes creates no new content — ` +
    `plan it as the usual single step; never return an empty plan for it.)`;

  // Two attempts: an empty plan is almost always a model slip (esp. on align/distribute
  // of EXISTING nodes), not a genuine "nothing to do" — so retry once with a hard nudge
  // before the loop escalates. Keeps the common align/tidy prompts from a false failure.
  const NUDGE =
    `\n\nIMPORTANT: you returned an empty plan. If the intent describes ANY canvas edit, it has at ` +
    `least one step — for "arrange/align/distribute/even out" of existing nodes that is ONE step ` +
    `(applyAutoLayout on their shared parent, or alignDistribute on the id set), verified with a ` +
    `prop criterion on layout.mode (HORIZONTAL/VERTICAL) or a childCount on the parent. Emit it now.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 4000,
      system: cachedSystem(SYSTEM_PROMPT),
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: "emit_plan" },
      messages: [{ role: "user", content: attempt === 0 ? baseUser : baseUser + NUDGE }],
    };
    // pinned SDK types lag the API: effort only (forced tool_choice ⇒ no adaptive thinking).
    (params as any).output_config = { effort: "high" };

    const msg = await client().messages.create(params);
    onUsage?.(readUsage(msg.usage));
    if ((msg.stop_reason as string) === "refusal")
      throw new Error("Planner refused the request.");

    const block = msg.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use")
      throw new Error("Planner did not emit a plan tool-call.");

    const steps = coercePlanSteps(block.input);
    if (steps.length > 0) return steps;
  }
  return []; // still empty after the nudge — the loop reports it honestly
}

/** Parse the emit_plan tool input into Step[], tolerant of a malformed shape.
 *  The model intermittently emits `steps` as a mangled string (leaking tool-call
 *  markup) and hoists the lone step's label/criterion to the top level. A naive
 *  `Array.isArray(steps)` check silently dropped that into an EMPTY plan — a false
 *  "can't make that edit" for valid single-step requests (recolor/align/restyle).
 *  When `steps` isn't a usable array but a top-level `criterion` is present, treat
 *  the whole input AS that one step. Exported for the recovery smoke test. */
export function coercePlanSteps(input: unknown): Step[] {
  const raw = (input ?? {}) as { steps?: unknown; label?: unknown; criterion?: unknown; index?: unknown };
  const rawSteps = Array.isArray(raw.steps)
    ? raw.steps
    : raw.criterion && typeof raw.criterion === "object"
      ? [{ index: raw.index, label: raw.label, criterion: raw.criterion }]
      : [];
  return rawSteps.map((s: any, i: number): Step => ({
    index: typeof s.index === "number" ? s.index : i,
    label: String(s.label ?? `Step ${i + 1}`),
    criterion: s.criterion as SuccessCriterion,
  }));
}

// ---- act: one NON-streaming tool-use turn (streaming is Day 6) ----

export interface ActContext {
  /** scoped getTree result for this step (already field-projected). */
  tree: unknown;
  /** base64 PNG of the marked render, or null when raster is unavailable. */
  image: string | null;
  markMap: Record<string, NodeId>;
  version: number;
  step: Step;
  /** The human's resolved selection, if any. The act model MUST act on EVERY id in
   *  this set for a bulk request ("delete each", "recolor all") — without it, a step
   *  labeled "delete the selected titles" is ambiguous and the model touches only one
   *  node, completing partially while verify (a single post-condition) still passes. */
  selection?: NodeId[];
}

/** Per-call token usage, surfaced so the loop can measure the cost of a run. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** Pull the (possibly cache-augmented) usage off a finished message, defaulting to 0. */
function readUsage(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, number | undefined>;
  return {
    input: x.input_tokens ?? 0,
    output: x.output_tokens ?? 0,
    cacheRead: x.cache_read_input_tokens ?? 0,
    cacheCreate: x.cache_creation_input_tokens ?? 0,
  };
}

export interface ActResult {
  stopReason: string | null;
  toolUses: { id: string; name: string; input: unknown }[];
  text: string;
  usage: Usage;
}

// Streamed callback payloads (§4.3 latency levers). The loop turns these into
// activity-log lines: verb on content_block_start, params as input_json_delta
// arrive, "Planning…" on the first thinking/text delta.
export type ActDelta =
  | { kind: "verb"; index: number; name: string }
  | { kind: "args"; index: number; partialJson: string }
  | { kind: "thinking" };
export type OnActDelta = (d: ActDelta) => void;

/** Build the volatile per-turn user content: tree text + marked image + markMap.
 *  Exported so the loop can persist it into rc.messages as a user turn BEFORE act
 *  (so every request — incl. retries and step 2+ — starts with a user turn). */
export function perceptionBlocks(ctx: ActContext): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  blocks.push({
    type: "text",
    text:
      `Current step [${ctx.step.index}]: ${ctx.step.label}\n\n` +
      (ctx.selection && ctx.selection.length
        ? `The human selected these NodeIds — they are your targets for THIS step. If the step ` +
          `acts on "the selected"/"each"/"every"/"all" of them, apply the change to EVERY id ` +
          `listed (one tool call per node); do not stop after the first: ${ctx.selection.join(", ")}\n\n`
        : "") +
      `Scene graph (scoped, v${ctx.version}):\n${JSON.stringify(ctx.tree)}\n\n` +
      `markMap (number -> NodeId): ${JSON.stringify(ctx.markMap)}`,
  });
  if (ctx.image) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: ctx.image },
    });
  }
  blocks.push({
    type: "text",
    text: "Make the edits for THIS step by calling tools. Then stop.",
  });
  return blocks;
}

/**
 * Stale-perception pruner — the single biggest token lever for a multi-turn run.
 *
 * Every ACT turn ships a FRESH scene-graph + marked image (the loop re-perceives
 * before each turn), so the perceptions from PRIOR turns are redundant AND show an
 * OLDER canvas state — yet they accumulate in `messages` and are re-sent on every
 * subsequent turn. That is an O(n²) blowup of the most expensive content (a 1024px
 * PNG is ~1.4k tokens) and it dominates the bill on any heavy multi-section build,
 * since the cached prefix is only system+tools, not the message history.
 *
 * We keep ONLY the latest perception intact and, in every earlier user turn, drop the
 * stale image and collapse the (now-misleading) scene-graph JSON to a stub. The
 * tool_use + tool_result pairs — the actual record of what the model did — are left
 * untouched, so action continuity is fully preserved. Idempotent: re-running on
 * already-pruned history is a no-op.
 */
export function pruneStalePerception(messages: Anthropic.MessageParam[]): void {
  // Find the last user turn carrying a perception image — that is the one to keep.
  let keepIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (Array.isArray(c) && c.some((b) => (b as { type: string }).type === "image")) {
      keepIndex = i;
      break;
    }
  }
  if (keepIndex < 0) return;

  for (let i = 0; i < messages.length; i++) {
    if (i === keepIndex) continue;
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    m.content = m.content.flatMap((b) => {
      const block = b as { type: string; text?: string };
      if (block.type === "image") return []; // drop the stale marked render
      if (block.type === "text" && block.text?.includes("Scene graph (scoped"))
        return [{ type: "text", text: "[earlier perception elided to save tokens]" } as ContentBlockParam];
      return [b];
    });
  }
}

/**
 * One STREAMING model turn: cached system+tools prefix, then the volatile
 * perception turn. The verb of each tool_use renders the instant its block OPENS
 * (content_block_start) — not on block stop, which the aggregated helper fires too
 * late for "verb first" (§4.3). Params append as input_json_delta arrive. Thinking
 * / text deltas drive the "Planning…" line on stream open.
 *
 * finalMessage() yields the parsed result; we branch on stop_reason==='refusal'
 * BEFORE reading content (a refusal is 200 with empty content). input is parsed
 * JSON — never string-match.
 */
export async function act(
  messages: Anthropic.MessageParam[],
  onDelta?: OnActDelta,
): Promise<ActResult> {
  const params: Anthropic.MessageCreateParamsStreaming = {
    model: MODEL,
    max_tokens: 8000,
    system: cachedSystem(SYSTEM_PROMPT),
    tools: TOOLS, // byte-stable, deterministically ordered -> cacheable
    messages, // perception now lives in history (pushed by the loop before act)
    stream: true,
  };
  // pinned SDK types lag the API: adaptive thinking + effort (cast via any).
  // ACT runs at `medium` effort, not `high`: the hard reasoning (decomposition, style
  // direction, criteria) already happened in plan() at high effort, so ACT is the
  // comparatively mechanical job of emitting the right tool calls for ONE pre-decided
  // step. Medium cuts thinking/output tokens materially with no observed quality drop on
  // the probe; the planner stays at high (it drives the whole run's quality).
  (params as any).thinking = { type: "adaptive", display: "summarized" };
  (params as any).output_config = { effort: "medium" };

  const stream = client().messages.stream(params);

  // Raw stream events: the verb must render the instant the tool_use block OPENS.
  stream.on("streamEvent", (e: Anthropic.MessageStreamEvent) => {
    if (!onDelta) return;
    if (e.type === "content_block_start") {
      const block = e.content_block;
      if (block.type === "tool_use")
        onDelta({ kind: "verb", index: e.index, name: block.name });
    } else if (e.type === "content_block_delta") {
      const d = e.delta as { type: string; partial_json?: string };
      if (d.type === "input_json_delta")
        onDelta({ kind: "args", index: e.index, partialJson: d.partial_json ?? "" });
      else if (d.type === "text_delta" || (d.type as string) === "thinking_delta")
        onDelta({ kind: "thinking" });
    }
  });

  const msg = await stream.finalMessage();

  const usage = readUsage(msg.usage);

  // Branch on stop_reason BEFORE reading content — a refusal is 200 w/ empty content.
  if ((msg.stop_reason as string) === "refusal")
    return { stopReason: "refusal", toolUses: [], text: "", usage };

  let text = "";
  const toolUses: ActResult["toolUses"] = [];
  for (const block of msg.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use")
      toolUses.push({ id: block.id, name: block.name, input: block.input }); // already parsed JSON
  }
  return { stopReason: msg.stop_reason, toolUses, text, usage };
}
