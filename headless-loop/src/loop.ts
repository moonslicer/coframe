// The perceive -> act -> apply loop. A manual agentic loop so every tool result
// passes through boundary validation before going back to the model. Mirrors §5.4
// (minus the set-of-marks render + structural-verify retry, which are days 3-4).

import type Anthropic from "@anthropic-ai/sdk";
import { DocStore } from "./store.js";
import { LLM } from "./llm.js";
import { dispatch, REGISTRY } from "./tools.js";
import { getTreeText } from "./perception.js";
import { isErr } from "./types.js";

const MAX_TURNS = 12;

export async function runTask(store: DocStore, intent: string) {
  const llm = new LLM();
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Task: ${intent}\n\n` +
        `Current canvas (scene graph):\n${getTreeText(store)}\n\n` +
        `Make the edits by calling tools.`,
    },
  ];

  let turns = 0;
  let lastError: string | null = null;

  while (turns < MAX_TURNS) {
    turns++;
    const turn = await llm.act(messages);

    if (turn.stopReason === "refusal") {
      console.log("\n⚠️  Model refused the request.");
      break;
    }
    if (turn.thinking.trim()) console.log(`\n💭 ${turn.thinking.trim()}`);
    if (turn.text.trim()) console.log(`\n🗣️  ${turn.text.trim()}`);

    if (turn.toolUses.length === 0) {
      console.log(`\n✅ Model finished after ${turns} turn(s) (stop_reason=${turn.stopReason}).`);
      break;
    }

    // Echo the assistant turn (must include tool_use blocks) back into history.
    const assistantContent: Anthropic.ContentBlockParam[] = [];
    if (turn.text.trim()) assistantContent.push({ type: "text", text: turn.text });
    for (const tu of turn.toolUses)
      assistantContent.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input as any });
    messages.push({ role: "assistant", content: assistantContent });

    // Execute each tool through the boundary.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of turn.toolUses) {
      const def = REGISTRY.get(tu.name);
      const label = def ? def.label(tu.input) : tu.name;
      const result = dispatch(tu.name, tu.input, store, store.version);
      if (isErr(result)) {
        lastError = `${result.error}: ${result.detail}`;
        console.log(`   ✗ ${label}  ->  ${result.error}: ${result.detail}`);
      } else {
        console.log(`   ✓ ${label}  ->  ${result.ops.length} op(s), v${result.version}`);
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        is_error: isErr(result),
        content: JSON.stringify(result),
      });
    }

    // Fresh perception goes back with the results (the diff-in / re-perceive step).
    messages.push({
      role: "user",
      content: [
        ...toolResults,
        { type: "text", text: `Updated canvas:\n${getTreeText(store)}` },
      ],
    });
  }

  if (turns >= MAX_TURNS) console.log(`\n⏹️  Hit MAX_TURNS (${MAX_TURNS}).`);
  return { turns, lastError };
}
