// A/B eval: composeSubtree (after) vs node-by-node (before), on the SAME generative
// prompts. Measures cost (turns, tokens, $, wall-clock) AND design quality via a BLIND
// visual judge (completeness, correctness, near-equivalence). Run:
//   npm run compose-eval
//
// For each prompt it spawns two child processes — baseline (NO_COMPOSE=1) and compose —
// each of which runs the REAL loop once and renders the final page to a PNG (see
// eval-run.ts). The two modes MUST be separate processes: the SDK tool list is frozen at
// import time, so NO_COMPOSE can't be toggled in-process. A judge (Sonnet, vision) then
// scores the two renders blind (labeled A/B, method hidden) and the orchestrator maps the
// scores back and prints a comparison table + aggregate savings.
//
// override:true so the committed app/.env wins over any stale shell key.
import dotenv from "dotenv";
dotenv.config({ override: true });

import Anthropic from "@anthropic-ai/sdk";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---- config ----
const SEED = "empty";
const JUDGE_MODEL = "claude-sonnet-4-6";
const PROMPTS = [
  "Design a weather app screen with a header, current conditions, an hourly forecast strip, and a 5-day forecast list",
  "Design a music player screen with album art, the track title and artist, a progress bar, and playback controls",
  "Design a sign-in screen with a logo, email and password fields, a primary Sign In button, and a sign-up link",
];

// claude-sonnet-4-6 rates, $/1M tokens (see claude-api skill: $3 in / $15 out;
// cache read 0.1x = $0.30; cache write 1.25x ephemeral = $3.75).
const RATE = { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 };
const dollars = (u: { input: number; output: number; cacheRead: number; cacheCreate: number }) =>
  (u.input * RATE.input + u.output * RATE.output + u.cacheRead * RATE.cacheRead + u.cacheCreate * RATE.cacheWrite) /
  1e6;

interface RunResult {
  mode: string;
  turns: number;
  usage: { input: number; output: number; cacheRead: number; cacheCreate: number };
  terminal: string;
  detail: string;
  threw: string | null;
  nodeCount: number;
  newNodes: number;
  ms: number;
  png: string | null;
}

function runChild(prompt: string, noCompose: boolean, pngOut: string): RunResult | null {
  const res = spawnSync("npx", ["tsx", "src/agent/eval-run.ts", prompt, SEED, pngOut], {
    env: { ...process.env, NO_COMPOSE: noCompose ? "1" : "" },
    encoding: "utf8",
    maxBuffer: 1 << 27,
    timeout: 600_000,
  });
  const out = (res.stdout || "").trim().split("\n").filter(Boolean);
  for (let i = out.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(out[i]) as RunResult;
    } catch {
      /* keep scanning upward for the JSON line */
    }
  }
  console.error(`  child failed (${noCompose ? "baseline" : "compose"}):`, (res.stderr || "").slice(-400));
  return null;
}

// ---- blind visual judge ----
const JUDGE_TOOL: Anthropic.Tool = {
  name: "score",
  description: "Score two candidate designs for the same request and rate their equivalence.",
  input_schema: {
    type: "object",
    properties: {
      imageA: {
        type: "object",
        properties: {
          completeness: { type: "number", description: "0-100: how fully it realizes everything the request asked for." },
          correctness: { type: "number", description: "0-100: free of overlap, clipping, broken layout, empty/placeholder regions, illegible contrast." },
          notes: { type: "string", description: "One or two sentences on the most important issues." },
        },
        required: ["completeness", "correctness", "notes"],
      },
      imageB: {
        type: "object",
        properties: {
          completeness: { type: "number" },
          correctness: { type: "number" },
          notes: { type: "string" },
        },
        required: ["completeness", "correctness", "notes"],
      },
      equivalence: {
        type: "number",
        description: "0-100: how near-equivalent A and B are in covering the request's intent (100 = same content/coverage, regardless of style).",
      },
      verdict: { type: "string", description: "One sentence: which is stronger and why, or 'comparable'." },
    },
    required: ["imageA", "imageB", "equivalence", "verdict"],
  },
};

async function judge(
  client: Anthropic,
  prompt: string,
  pngA: string,
  pngB: string,
): Promise<any | null> {
  const a = readFileSync(pngA).toString("base64");
  const b = readFileSync(pngB).toString("base64");
  const msg = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 1500,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: "score" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              `Two design tools each produced ONE attempt at this request:\n"${prompt}"\n\n` +
              `Both renders are the full app canvas as the user would see it (off-canvas content is clipped). ` +
              `Score each on completeness (did it build everything asked for) and correctness (overlap, clipping, ` +
              `broken layout, empty regions, contrast). Then rate how near-equivalent the two are in covering the ` +
              `request's intent. Be objective and specific; do not assume either is better by default.`,
          },
          { type: "text", text: "Image A:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: a } },
          { type: "text", text: "Image B:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: b } },
        ],
      },
    ],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  return block && block.type === "tool_use" ? block.input : null;
}

// ---- runner ----
async function main() {
  const client = new Anthropic();
  const dir = mkdtempSync(join(tmpdir(), "compose-eval-"));
  console.log(`Compose A/B eval — ${PROMPTS.length} prompt(s), seed="${SEED}". renders in ${dir}\n`);

  const rows: any[] = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`[${i + 1}/${PROMPTS.length}] ${prompt}`);
    const pngBase = join(dir, `p${i}-baseline.png`);
    const pngComp = join(dir, `p${i}-compose.png`);

    process.stdout.write("  running baseline (node-by-node)… ");
    const base = runChild(prompt, true, pngBase);
    console.log(base ? `${base.terminal} · ${base.turns} turns · ${base.newNodes} nodes · ${(base.ms / 1000).toFixed(0)}s` : "FAILED");

    process.stdout.write("  running compose…             ");
    const comp = runChild(prompt, false, pngComp);
    console.log(comp ? `${comp.terminal} · ${comp.turns} turns · ${comp.newNodes} nodes · ${(comp.ms / 1000).toFixed(0)}s` : "FAILED");

    let scored: any = null;
    if (base?.png && comp?.png) {
      process.stdout.write("  judging (blind A=baseline, B=compose)… ");
      try {
        scored = await judge(client, prompt, base.png, comp.png);
        console.log(scored ? `equivalence ${scored.equivalence}` : "no verdict");
      } catch (e) {
        console.log(`judge error: ${(e as Error).message}`);
      }
    } else {
      console.log("  (skipping judge — a render is missing)");
    }
    rows.push({ prompt, base, comp, scored });
    console.log();
  }

  // ---- report ----
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  const line = "─".repeat(96);
  console.log(line);
  console.log("PER-PROMPT COMPARISON  (B=baseline node-by-node, C=compose)");
  console.log(line);
  console.log(
    pad("prompt", 26) + pad("turns B→C", 12) + pad("tokens B→C", 18) + pad("$ B→C", 18) + pad("complete B→C", 14) + "correct B→C",
  );
  const tot = {
    bTurns: 0, cTurns: 0, bTok: 0, cTok: 0, bCost: 0, cCost: 0,
    bComplete: 0, cComplete: 0, bCorrect: 0, cCorrect: 0, equiv: 0, judged: 0,
  };
  for (const r of rows) {
    const b = r.base, c = r.comp, s = r.scored;
    const bTok = b ? b.usage.input + b.usage.output : 0;
    const cTok = c ? c.usage.input + c.usage.output : 0;
    const bCost = b ? dollars(b.usage) : 0;
    const cCost = c ? dollars(c.usage) : 0;
    console.log(
      pad(r.prompt.slice(8, 34), 26) +
        pad(`${b?.turns ?? "—"}→${c?.turns ?? "—"}`, 12) +
        pad(`${(bTok / 1000).toFixed(1)}k→${(cTok / 1000).toFixed(1)}k`, 18) +
        pad(`$${bCost.toFixed(3)}→$${cCost.toFixed(3)}`, 18) +
        pad(s ? `${s.imageA.completeness}→${s.imageB.completeness}` : "—", 14) +
        (s ? `${s.imageA.correctness}→${s.imageB.correctness}` : "—"),
    );
    if (b) { tot.bTurns += b.turns; tot.bTok += bTok; tot.bCost += bCost; }
    if (c) { tot.cTurns += c.turns; tot.cTok += cTok; tot.cCost += cCost; }
    if (s) {
      tot.judged++;
      tot.bComplete += s.imageA.completeness; tot.cComplete += s.imageB.completeness;
      tot.bCorrect += s.imageA.correctness; tot.cCorrect += s.imageB.correctness;
      tot.equiv += s.equivalence;
    }
  }
  console.log(line);
  const pct = (from: number, to: number) => (from === 0 ? "n/a" : `${(((from - to) / from) * 100).toFixed(0)}% ${to <= from ? "less" : "MORE"}`);
  console.log("AGGREGATE");
  console.log(`  turns:   baseline ${tot.bTurns}  →  compose ${tot.cTurns}   (${pct(tot.bTurns, tot.cTurns)})`);
  console.log(`  tokens:  baseline ${(tot.bTok / 1000).toFixed(1)}k  →  compose ${(tot.cTok / 1000).toFixed(1)}k   (${pct(tot.bTok, tot.cTok)})`);
  console.log(`  cost:    baseline $${tot.bCost.toFixed(3)}  →  compose $${tot.cCost.toFixed(3)}   (${pct(tot.bCost, tot.cCost)})`);
  if (tot.judged) {
    const j = tot.judged;
    console.log(
      `  quality: completeness ${(tot.bComplete / j).toFixed(0)}→${(tot.cComplete / j).toFixed(0)}, ` +
        `correctness ${(tot.bCorrect / j).toFixed(0)}→${(tot.cCorrect / j).toFixed(0)}  (avg of ${j} judged)`,
    );
    console.log(`  near-equivalence: ${(tot.equiv / j).toFixed(0)}/100 avg`);
  }
  console.log(line);
  for (const r of rows) if (r.scored) console.log(`  • ${r.prompt.slice(8, 50)}…  →  ${r.scored.verdict}`);
}

main().catch((e) => {
  console.error("EVAL THREW:", e);
  process.exit(1);
});
