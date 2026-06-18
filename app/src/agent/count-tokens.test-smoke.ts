// count_tokens measurement (§4.4) — REPLACES the spec's ~3k/turn ESTIMATE with a
// real measurement of the per-turn perception payload for the SEED. Run once:
//   npm run smoke:tokens
//
// Builds the actual ACT-turn payload: the cached system prompt + the 8 tool schemas
// (the cacheable prefix) + the volatile user turn (scoped getTree skeleton + a 1024px
// MARKED render image block). Calls client.messages.countTokens twice — once for the
// full payload, once for the prefix alone — and reports:
//   - total input tokens for a turn
//   - the image-block contribution (full minus the same payload sans image)
//   - whether the cached system+tools prefix clears the 4096-token Opus 4.8 minimum.
//
// override:true so the committed app/.env wins over a stale exported shell key.
import dotenv from "dotenv";
dotenv.config({ override: true });

import Anthropic from "@anthropic-ai/sdk";
import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
import { buildAnthropicTools } from "../shared/tools.js";
import { getTree, fieldsFor, render } from "../render/perception.js";
import { SYSTEM_PROMPT } from "./llm-adapter.js";
import type { ContentBlockParam } from "./llm-adapter.js";

const MODEL = "claude-opus-4-8";

type Block = ContentBlockParam;

async function count(
  client: Anthropic,
  system: Anthropic.TextBlockParam[],
  tools: Anthropic.Tool[],
  content: Block[],
): Promise<number> {
  // In the pinned SDK (0.32.1) count_tokens lives under the BETA namespace
  // (client.beta.messages.countTokens). Cast through any to dodge the beta-typed
  // param/return shapes — the codebase's adaptive-field pattern.
  const res = await (client as any).beta.messages.countTokens({
    model: MODEL,
    system,
    tools,
    messages: [{ role: "user", content }],
  });
  return res.input_tokens as number;
}

async function main() {
  const store = new DocStore();
  store.loadSeed(SEED);
  const rootId = store.rootId;

  const tools = buildAnthropicTools();
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: SYSTEM_PROMPT }];

  // The real volatile per-turn content: scoped skeleton tree + markMap text + the
  // 1024px MARKED render image (the exact image channel the loop sends).
  const tree = getTree(store, rootId, { depth: 2, fields: fieldsFor("layout") });
  const r = await render(store, rootId, { marks: true, maxPx: 1024 });
  const image = "rasterAvailable" in r && r.rasterAvailable ? r.image : null;

  const textBlock: Block = {
    type: "text",
    text:
      `Current step [0]: Add a pricing section\n\n` +
      `Scene graph (scoped, v${store.version}):\n${JSON.stringify(tree)}\n\n` +
      `markMap (number -> NodeId): ${JSON.stringify(
        "markMap" in r ? r.markMap : {},
      )}`,
  };
  const imageBlock: Block | null = image
    ? { type: "image", source: { type: "base64", media_type: "image/png", data: image } }
    : null;

  const client = new Anthropic();

  const withImage: Block[] = imageBlock ? [textBlock, imageBlock] : [textBlock];
  const withoutImage: Block[] = [textBlock];

  console.log(`Measuring per-turn count_tokens against the SEED (model ${MODEL})…\n`);

  const total = await count(client, system, tools, withImage);
  const noImage = await count(client, system, tools, withoutImage);
  // Prefix-only = system + tools with a trivial user turn (countTokens requires a
  // non-empty message). Subtract that minimal turn to approximate the cached prefix.
  const minTurn: Block[] = [{ type: "text", text: "." }];
  const prefixApprox = await count(client, system, tools, minTurn);

  const imageContribution = image ? total - noImage : 0;
  const CACHE_MIN = 4096;

  console.log("───────────────────────────────────────────────");
  console.log(`Total input tokens (per ACT turn):     ${total}`);
  console.log(`  · skeleton tree + markMap (no image): ${noImage}`);
  console.log(
    `  · image block contribution (1024px):  ${image ? imageContribution : "n/a (raster unavailable)"}`,
  );
  console.log(`Cacheable prefix (system + 8 tools):   ~${prefixApprox} tokens`);
  console.log(
    `Clears the 4096-token Opus 4.8 cache minimum? ${
      prefixApprox >= CACHE_MIN ? "YES" : "NO — caching would silently no-op"
    }`,
  );
  console.log("───────────────────────────────────────────────");
  console.log(
    "\nThese are MEASUREMENTS replacing the spec's ~3k/turn estimate (§4.4).",
  );
}

main().catch((e) => {
  console.error("\nsmoke:tokens THREW:", e);
  process.exit(1);
});
