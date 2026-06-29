// CLI entry: load seed, print the before tree, run the agent loop on the prompt,
// print the after tree + a verification summary. This is the day-1/2 smoke test:
// can Opus 4.8 turn one English sentence into correct semantic tool calls?
//
//   ANTHROPIC_API_KEY=... npm start -- "add a pricing section with 3 cards below the hero"
//   ANTHROPIC_API_KEY=... npm start -- "tidy the hero: stack the contents in a column, even spacing"

import { readFileSync } from "node:fs";
import { DocStore } from "./store.js";
import { SEED } from "./seed.js";
import { getTreeText } from "./perception.js";
import { runTask } from "./loop.js";

// Minimal .env loader (no dependency): KEY=VALUE lines.
function loadDotenv() {
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* no .env — rely on the ambient environment */
  }
}

async function main() {
  loadDotenv();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY (env var or headless-loop/.env). See .env.example.");
    process.exit(1);
  }

  const intent =
    process.argv.slice(2).join(" ").trim() ||
    "Tidy the hero: stack its contents in a centered vertical column with even spacing.";

  const store = new DocStore();
  store.loadSeed(SEED);

  const before = { version: store.version, count: store.count() };
  console.log("=== INTENT ===");
  console.log(intent);
  console.log("\n=== BEFORE (v" + before.version + ") ===");
  console.log(getTreeText(store));
  console.log("\n=== RUN ===");

  const { turns, lastError } = await runTask(store, intent);

  console.log("\n=== AFTER (v" + store.version + ") ===");
  console.log(getTreeText(store));

  console.log("\n=== VERIFY (judge by eye — does the result match the intent?) ===");
  console.log(`turns:           ${turns}`);
  console.log(`version delta:   ${before.version} -> ${store.version} (${store.version - before.version} commits)`);
  console.log(`node count:      ${before.count} -> ${store.count()} (${store.count() - before.count >= 0 ? "+" : ""}${store.count() - before.count})`);
  console.log(`doc changed:     ${store.version > before.version ? "YES" : "NO"}`);
  console.log(`last tool error: ${lastError ?? "none"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
