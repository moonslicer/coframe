// All @anthropic-ai/sdk usage lives here. One model turn = act().
// Grounded in the claude-api skill: claude-opus-4-8, adaptive thinking,
// effort via output_config, parsed tool inputs, branch on stop_reason first.

import Anthropic from "@anthropic-ai/sdk";
import { buildAnthropicTools, assertValidToolSchemas } from "./tools.js";

const MODEL = "claude-opus-4-8";

// 4.8 narrates more and under-reaches for tools by default — both are tuned here.
export const SYSTEM_PROMPT = `You are a design agent that edits a Figma-like vector canvas by calling tools.

The canvas is a scene graph of nodes (FRAME, TEXT, RECT, ELLIPSE), each with a stable id like "node:7".
You will be shown the current scene graph as text before each step. Act on it by calling the provided tools.

Rules:
- ALWAYS act through tools. Do not describe what you would do — call the tool that does it.
- Prefer semantic tools (applyAutoLayout, alignDistribute, placeBelow) over raw coordinates.
- Reference nodes by their exact id from the scene graph. Never invent an id.
- When you create a frame, its new id is returned in the ops; use that id to add children on the NEXT turn.
- Work in small, verifiable steps. After each tool result you get the updated scene graph.
- Keep any text between tool calls to one short sentence. When the design goal is met, stop and give a one-line summary.`;

const TOOLS = buildAnthropicTools();

export type ActResult = {
  stopReason: string | null;
  text: string;
  thinking: string;
  toolUses: { id: string; name: string; input: unknown }[];
};

export class LLM {
  private client: Anthropic;
  constructor() {
    assertValidToolSchemas(); // fail fast if a generated schema is malformed
    this.client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }

  async act(messages: Anthropic.MessageParam[]): Promise<ActResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    };
    // Current API params the pinned SDK types don't expose yet (adaptive thinking + effort).
    (params as any).thinking = { type: "adaptive", display: "summarized" };
    (params as any).output_config = { effort: "high" };

    const msg = await this.client.messages.create(params);

    // Branch on stop_reason BEFORE reading content — a refusal returns 200 with empty content.
    if (msg.stop_reason === "refusal") {
      return { stopReason: "refusal", text: "", thinking: "", toolUses: [] };
    }

    let text = "";
    let thinking = "";
    const toolUses: ActResult["toolUses"] = [];
    for (const block of msg.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") thinking += block.thinking;
      else if (block.type === "tool_use")
        toolUses.push({ id: block.id, name: block.name, input: block.input }); // input already parsed
    }
    return { stopReason: msg.stop_reason, text, thinking, toolUses };
  }
}
