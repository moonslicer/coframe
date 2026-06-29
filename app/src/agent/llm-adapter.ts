// LLM provider access lives behind this adapter. Anthropic remains the internal
// message/tool-history shape used by the loop; the OpenAI path translates that shape
// to Responses API function calls at the boundary. It exposes:
//   - SYSTEM_PROMPT — silence-default + prescriptive tone, ported from
//     headless-loop/src/llm.ts (full silence tuning + count_tokens is Day 6).
//   - plan(intent, rootId, store, selection) -> Step[] via a forced tool-call
//     (tool_choice: emit_plan) whose schema is the Step[] shape.
//   - act(messages, ctx) -> one provider-specific tool-use turn; branches on
//     stop_reason==='refusal' BEFORE reading content.
//
// The pinned SDK types (0.32.1) lag the API — adaptive thinking / effort / structured
// fields are cast through `any`, exactly the pattern headless-loop/src/llm.ts uses.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  FunctionTool as OpenAIFunctionTool,
  Response as OpenAIResponse,
  ResponseInputContent,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import type { DocStore } from "../shared/store.js";
import type { NodeId } from "../shared/types.js";
import type { DesignSystemProfile } from "../shared/design-system.js";
import { buildAnthropicTools, assertValidToolSchemas } from "../shared/tools.js";
import { getTree } from "../render/perception.js";
import type { Step, SuccessCriterion } from "./types.js";

type LLMProvider = "anthropic" | "openai";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? process.env.LLM_MODEL ?? "claude-sonnet-4-6";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? process.env.LLM_MODEL ?? "gpt-5.5";
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
- Use DEPTH and real detail, not flat solid blocks (flat fills read as a wireframe). The build tools take
  rich style: gradients (composeSubtree \`gradient\`{from,to,angle} or setGradient) for headers, buttons,
  hero/background fills; drop shadows (composeSubtree \`shadow\` or setProps style.shadow) to elevate cards
  and floating bars; \`blur\` for frosted/glass panels; and REAL icons (composeSubtree \`icon\` or createIcon —
  heart, comment, share, bookmark, home, search, user, settings, bell, star, play, plus, more, menu, …)
  instead of placeholder squares for any like/comment/share/nav/tab affordance. Reach for these whenever
  the style is meant to feel polished, modern, premium, glossy, glassy, or app-like.
- Match the prompt's platform conventions when named: mobile screens should feel mobile-sized and touchable;
  iOS-like UIs use larger radii, translucent panels, generous vertical rhythm, and centered/aligned symbols;
  operational dashboards are denser, quieter, and scan-friendly.
- If an imported design system brief is provided in the user turn, treat it as the default source for
  colors, typography, spacing, radii, component families, and interaction patterns. Use it for generated
  apps/components unless the human explicitly asks for a different style.

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
  preamble, no recap. When the step's goal is met, stop calling tools.

Interactive prototypes (multi-screen apps):
- When the request is for an APP, PROTOTYPE, FLOW, or names MULTIPLE screens/pages or interaction
  ("tappable", "clickable", "navigate", "with a working nav/tab bar", "toggle"), build something the user
  can CLICK THROUGH — several screens wired together, not one static frame.
- Build EACH screen as its own composeSubtree with screen:true and parent = the page root. Give every
  screen complete, realistic content (header, body, and a nav/tab bar where the platform implies one).
  Screens auto-arrange left-to-right as a filmstrip — you never position them.
- AFTER the screens exist, WIRE them with setInteraction: a nav tab / button / list row that should
  change the view gets action 'navigate' with target = the destination SCREEN; a back chevron gets 'back'.
  For a dropdown / menu / accordion, create its body, setHidden it true, then wire its trigger with
  'toggle'. For a modal / sheet, create it, setHidden it true, wire the opener with 'openOverlay' and its
  close/X with 'closeOverlay'. Wire every primary affordance the request implies so the prototype plays.
- For a single-screen or pure-styling request, do NOT add screens or interactions — behave exactly as before.

Forms & cross-screen variables (sign-up, login, checkout, settings):
- For any field the user FILLS IN, make a real input: give a composeSubtree node an \`input\` {field, kind,
  placeholder, required}, or call createInput. \`field\` is a VARIABLE name (e.g. name, email, password);
  \`kind\` is text|email|password|number|textarea|select|checkbox|switch. Don't fake a field with a plain
  RECT — it won't be typeable and won't carry a value.
- A value typed on one screen is shown on any later screen by putting {{field}} inside a TEXT node's chars.
  So a sign-up flow collects {field:'name'} and {field:'email'} on screen 1, and the confirmation screen
  has a TEXT like "You're all set, {{name}}!" — at play time it fills in what was typed.
- Pair each input with a label TEXT above it (checkbox/switch take a \`label\` instead). Mark the fields a
  step can't proceed without as required:true — a 'navigate' button is blocked until they're filled.`;

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
    "{id: one of the OTHER selected EXISTING ids, path:'style.fills', equals: X's current fills array}.\n" +
    "INTERACTIVE PROTOTYPES — only when the intent asks for an APP / PROTOTYPE / FLOW / multiple screens or " +
    "interaction (otherwise ignore this entirely and plan as above): plan ONE step per screen (build it with " +
    "composeSubtree screen:true) PLUS a final 'wire the interactions' step. Verify a multi-screen build with " +
    "`screenCount` {count: number of screens}; verify the wiring with `hasInteraction` {action, and EITHER an " +
    "existing `id` OR parentId+type+nameLike for a node created this run}. Do not over-split: 3 screens + 1 " +
    "wiring step is 4 steps, not 10.",
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
                    "screenCount",
                    "hasInteraction",
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
                action: {
                  type: "string",
                  enum: ["navigate", "toggle", "openOverlay", "closeOverlay", "back"],
                  description:
                    "hasInteraction: the click action the node must carry. " +
                    "(screenCount reuses `count`; hasInteraction resolves the node by `id` OR parentId+type+nameLike.)",
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

// ---- clarify: one cheap forced tool-call deciding whether to ask the human first ----

// A short, dedicated intake prompt (NOT the big build SYSTEM_PROMPT — this turn writes
// no tools, it only judges ambiguity). The model, not a regex, decides when a generative
// request is under-specified enough that 1-3 questions would change what gets built.
const CLARIFY_SYSTEM = `You are the intake step of a design agent that builds and edits a Figma-like vector canvas.
Before a build starts, decide whether the user's request is ambiguous enough that asking 1-3 short
clarifying questions would MATERIALLY change what gets designed.

Ask ONLY when the request is open-ended/generative (e.g. "design a dashboard", "make an app",
"build a landing page") AND under-specified along dimensions that would send the result in genuinely
different directions — typically the product/domain or user job, the primary user and their first
action, or the visual direction. As a rule of thumb, ask when TWO OR MORE of those are missing.

Do NOT ask when:
- the request is a concrete edit to existing canvas nodes (align, distribute, move, resize, recolor,
  restyle, rename, delete, "make these…", "the selected…") — node(s) are likely selected,
- the user already named enough to proceed (e.g. product + audience, or a clear style + domain),
- a sensible default would obviously satisfy the request. ONE missing dimension is usually safe to infer.

When you DO ask: 1-3 SHORT, specific questions concrete to THIS request (not generic boilerplate),
each paired with a reasonable default assumption the user can accept with one click. When you don't,
return needsClarification:false with empty arrays. Prefer building over interrogating — only interrupt
when the ambiguity is real.`;

const CLARIFY_TOOL: Anthropic.Tool = {
  name: "assess_clarity",
  description:
    "Report whether to ask the human clarifying questions before building, and if so, which. " +
    "Set needsClarification true ONLY for genuinely ambiguous open-ended design requests; for concrete " +
    "edits or already-specified requests set it false with empty arrays.",
  input_schema: {
    type: "object",
    properties: {
      needsClarification: {
        type: "boolean",
        description: "true to pause and ask the human; false to build immediately.",
      },
      questions: {
        type: "array",
        items: { type: "string" },
        description: "1-3 short, specific questions. Empty when needsClarification is false.",
      },
      assumptions: {
        type: "array",
        items: { type: "string" },
        description:
          "A reasonable default answer for each question (same order), so the human can proceed " +
          "in one click. Empty when needsClarification is false.",
      },
    },
    required: ["needsClarification", "questions", "assumptions"],
  },
};

let schemasAsserted = false;
let sharedAnthropicClient: Anthropic | null = null;
let sharedOpenAIClient: OpenAI | null = null;

function ensureToolSchemas(): void {
  if (schemasAsserted) return;
  assertValidToolSchemas(); // fail fast on a malformed generated schema
  schemasAsserted = true;
}

function provider(): LLMProvider {
  const raw = (process.env.LLM_PROVIDER ?? process.env.MODEL_PROVIDER ?? "").toLowerCase();
  if (raw === "openai" || raw === "anthropic") return raw;
  if (process.env.OPENAI_API_KEY || process.env.OPENAI_MODEL) return "openai";
  return "anthropic";
}

function anthropicClient(): Anthropic {
  ensureToolSchemas();
  if (!sharedAnthropicClient) sharedAnthropicClient = new Anthropic(); // reads ANTHROPIC_API_KEY
  return sharedAnthropicClient;
}

function openAIClient(): OpenAI {
  ensureToolSchemas();
  if (!process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai or OPENAI_MODEL is set.");
  if (!sharedOpenAIClient) sharedOpenAIClient = new OpenAI(); // reads OPENAI_API_KEY
  return sharedOpenAIClient;
}

function toOpenAITool(tool: Anthropic.Tool): OpenAIFunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.input_schema as Record<string, unknown>,
    strict: false,
  };
}

function shouldSendReasoning(model: string): boolean {
  return /^(gpt-5|o\d|o[1-9]-)/i.test(model);
}

function openAIParams(
  input: string | ResponseInputItem[],
  tools: Anthropic.Tool[],
  maxOutputTokens: number,
  toolChoice?: "auto" | "required" | { type: "function"; name: string },
  effort?: "low" | "medium" | "high" | "xhigh",
  instructions?: string,
): Record<string, unknown> {
  const model = OPENAI_MODEL;
  const params: Record<string, unknown> = {
    model,
    instructions: instructions ?? SYSTEM_PROMPT,
    input,
    max_output_tokens: maxOutputTokens,
    parallel_tool_calls: false,
    store: false,
    tools: tools.map(toOpenAITool),
    tool_choice: toolChoice ?? "auto",
  };
  if (effort && shouldSendReasoning(model)) params.reasoning = { effort };
  return params;
}

function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return raw;
  }
}

function stringifyToolOutput(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as { type?: string; text?: string };
        return p.type === "text" && typeof p.text === "string" ? p.text : JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content ?? "");
}

function readOpenAIUsage(u: unknown): Usage {
  const x = (u ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  return {
    input: x.input_tokens ?? 0,
    output: x.output_tokens ?? 0,
    cacheRead: x.input_tokens_details?.cached_tokens ?? 0,
    cacheCreate: 0,
  };
}

function extractOpenAIResult(response: OpenAIResponse): ActResult {
  let text = "";
  let stopReason: string | null = response.status ?? null;
  const toolUses: ActResult["toolUses"] = [];
  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content) {
        if (c.type === "output_text") text += c.text;
        else if (c.type === "refusal") {
          text += c.refusal;
          stopReason = "refusal";
        }
      }
    } else if (item.type === "function_call") {
      toolUses.push({
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item.arguments),
      });
    }
  }
  return {
    stopReason,
    toolUses,
    text,
    usage: readOpenAIUsage(response.usage),
  };
}

function anthropicBlocks(content: Anthropic.MessageParam["content"]): ContentBlockParam[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

function openAIInputFromAnthropic(messages: Anthropic.MessageParam[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  const flushUser = (content: ResponseInputContent[]) => {
    if (content.length) items.push({ type: "message", role: "user", content });
  };
  const flushAssistant = (texts: string[]) => {
    const text = texts.join("\n").trim();
    if (text) items.push({ type: "message", role: "assistant", content: text });
  };

  for (const message of messages) {
    if (message.role === "user") {
      let pending: ResponseInputContent[] = [];
      for (const block of anthropicBlocks(message.content)) {
        const b = block as {
          type: string;
          text?: string;
          source?: { type?: string; media_type?: string; data?: string };
          tool_use_id?: string;
          content?: unknown;
        };
        if (b.type === "text") {
          pending.push({ type: "input_text", text: b.text ?? "" });
        } else if (b.type === "image" && b.source?.type === "base64" && b.source.data) {
          pending.push({
            type: "input_image",
            detail: "auto",
            image_url: `data:${b.source.media_type ?? "image/png"};base64,${b.source.data}`,
          });
        } else if (b.type === "tool_result" && b.tool_use_id) {
          flushUser(pending);
          pending = [];
          items.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: stringifyToolOutput(b.content),
          });
        }
      }
      flushUser(pending);
    } else if (message.role === "assistant") {
      let pendingText: string[] = [];
      for (const block of anthropicBlocks(message.content)) {
        const b = block as { type: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === "text") {
          pendingText.push(b.text ?? "");
        } else if (b.type === "tool_use" && b.id && b.name) {
          flushAssistant(pendingText);
          pendingText = [];
          items.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          });
        }
      }
      flushAssistant(pendingText);
    }
  }

  return items;
}

/** Plan the intent into ordered, criterion-carrying steps (one forced tool-call). */
export async function plan(
  intent: string,
  rootId: NodeId,
  store: DocStore,
  selection: NodeId[],
  onUsage?: (u: Usage) => void,
  designSystem?: DesignSystemProfile | null,
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
  const designSystemLine = designSystem
    ? `Active design system brief:\n${designSystem.promptSummary}\n\n`
    : "";

  const baseUser =
    `Intent: ${intent}\n\n` +
    designSystemLine +
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
    `plan it as the usual single step; never return an empty plan for it.)\n\n` +
    `If — and only if — the intent asks for an APP, PROTOTYPE, FLOW, multiple screens/pages, or interaction ` +
    `(tappable, clickable, navigate, working nav/tab bar, toggle), plan a MULTI-SCREEN prototype: one step ` +
    `per screen (each built with composeSubtree screen:true, verified by screenCount), then a final step that ` +
    `wires navigation/toggles/overlays with setInteraction (verified by hasInteraction). For any ordinary ` +
    `single-screen or styling request, ignore this and plan as usual.`;

  // Two attempts: an empty plan is almost always a model slip (esp. on align/distribute
  // of EXISTING nodes), not a genuine "nothing to do" — so retry once with a hard nudge
  // before the loop escalates. Keeps the common align/tidy prompts from a false failure.
  const NUDGE =
    `\n\nIMPORTANT: you returned an empty plan. If the intent describes ANY canvas edit, it has at ` +
    `least one step — for "arrange/align/distribute/even out" of existing nodes that is ONE step ` +
    `(applyAutoLayout on their shared parent, or alignDistribute on the id set), verified with a ` +
    `prop criterion on layout.mode (HORIZONTAL/VERTICAL) or a childCount on the parent. Emit it now.`;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (provider() === "openai") {
      const response = (await openAIClient().responses.create(
        openAIParams(
          attempt === 0 ? baseUser : baseUser + NUDGE,
          [PLAN_TOOL],
          4000,
          { type: "function", name: "emit_plan" },
          "high",
        ) as any,
      )) as OpenAIResponse;
      const result = extractOpenAIResult(response);
      onUsage?.(result.usage);
      if (result.stopReason === "refusal") throw new Error("Planner refused the request.");

      const toolCall = result.toolUses.find((t) => t.name === "emit_plan");
      if (!toolCall) throw new Error("Planner did not emit a plan tool-call.");

      const steps = coercePlanSteps(toolCall.input);
      if (steps.length > 0) return steps;
      continue;
    }

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: ANTHROPIC_MODEL,
      max_tokens: 4000,
      system: cachedSystem(SYSTEM_PROMPT),
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: "emit_plan" },
      messages: [{ role: "user", content: attempt === 0 ? baseUser : baseUser + NUDGE }],
    };
    // pinned SDK types lag the API: effort only (forced tool_choice ⇒ no adaptive thinking).
    (params as any).output_config = { effort: "high" };

    const msg = await anthropicClient().messages.create(params);
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

/** Parse an assess_clarity tool input into a clarification, or null to build now.
 *  Defensive like coercePlanSteps: only clarify when the model explicitly asked AND
 *  gave at least one usable question — a true flag with no questions is nothing to ask,
 *  so we fall through to building. Exported for the offline smoke test. */
export function coerceClarification(
  input: unknown,
): { questions: string[]; assumptions: string[] } | null {
  const raw = (input ?? {}) as {
    needsClarification?: unknown;
    questions?: unknown;
    assumptions?: unknown;
  };
  if (raw.needsClarification !== true) return null;
  const clean = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 3) : [];
  const questions = clean(raw.questions);
  if (questions.length === 0) return null;
  return { questions, assumptions: clean(raw.assumptions) };
}

/** One cheap forced tool-call: should we ask the human before building? Returns the
 *  questions+assumptions to surface, or null to proceed straight to plan(). Runs at LOW
 *  effort with a tiny budget — it taxes every prompt by one fast round-trip, so keep it
 *  small. Selection / active design-system context nudge the model away from interrupting
 *  concrete edits. */
export async function assessClarification(
  intent: string,
  selection: NodeId[] = [],
  onUsage?: (u: Usage) => void,
  designSystem?: DesignSystemProfile | null,
): Promise<{ questions: string[]; assumptions: string[] } | null> {
  const selectionLine = selection.length
    ? `The user has ${selection.length} canvas node(s) selected — this is most likely a direct edit to them.\n`
    : "";
  const designSystemLine = designSystem
    ? `An imported design system brief is active, so the visual direction is already constrained.\n`
    : "";
  const user =
    `User request: ${intent}\n\n` +
    selectionLine +
    designSystemLine +
    `Decide whether to ask clarifying questions before building, then call assess_clarity.`;

  if (provider() === "openai") {
    const response = (await openAIClient().responses.create(
      openAIParams(
        user,
        [CLARIFY_TOOL],
        600,
        { type: "function", name: "assess_clarity" },
        "low",
        CLARIFY_SYSTEM,
      ) as any,
    )) as OpenAIResponse;
    const result = extractOpenAIResult(response);
    onUsage?.(result.usage);
    if (result.stopReason === "refusal") return null;
    const call = result.toolUses.find((t) => t.name === "assess_clarity");
    return coerceClarification(call?.input);
  }

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: ANTHROPIC_MODEL,
    max_tokens: 600,
    system: cachedSystem(CLARIFY_SYSTEM),
    tools: [CLARIFY_TOOL],
    tool_choice: { type: "tool", name: "assess_clarity" },
    messages: [{ role: "user", content: user }],
  };
  // pinned SDK types lag the API: effort only (forced tool_choice ⇒ no adaptive thinking).
  (params as any).output_config = { effort: "low" };

  const msg = await anthropicClient().messages.create(params);
  onUsage?.(readUsage(msg.usage));
  if ((msg.stop_reason as string) === "refusal") return null;
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;
  return coerceClarification(block.input);
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
  /** Optional imported design system that should guide this app/component generation. */
  designSystem?: DesignSystemProfile | null;
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
      (ctx.designSystem
        ? `Active design system brief:\n${ctx.designSystem.promptSummary}\n\n`
        : "") +
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
  if (provider() === "openai") {
    onDelta?.({ kind: "thinking" });
    const response = (await openAIClient().responses.create(
      openAIParams(openAIInputFromAnthropic(messages), TOOLS, 8000, "auto", "medium") as any,
    )) as OpenAIResponse;
    return extractOpenAIResult(response);
  }

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: ANTHROPIC_MODEL,
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

  const stream = anthropicClient().messages.stream(params);

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
