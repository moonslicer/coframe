// Plain tsx smoke (NOT a test framework). Run: npx tsx src/render/raster.test-smoke.ts
//
// Loads the seed, calls perception.render() WITH marks, and either:
//   - writes a real PNG to app/tmp/seed.png and prints byte size + dimensions, or
//   - (if resvg is unavailable on this platform) prints the documented fallback path
//     and still proves a valid markMap came back.

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DocStore } from "../shared/store.js";
import { SEED } from "../shared/seed.js";
import { render } from "./perception.js";
import { isRasterAvailable } from "./raster.js";

const store = new DocStore();
store.loadSeed(SEED);

const outDir = fileURLToPath(new URL("../../tmp/", import.meta.url));
const outPng = fileURLToPath(new URL("../../tmp/seed.png", import.meta.url));

console.log("resvg available on this platform:", await isRasterAvailable());

const r = await render(store, store.rootId, { marks: true, maxPx: 1024 });

if ("error" in r) {
  console.error("RENDER ERROR:", r.error, r.detail);
  process.exit(1);
}

console.log("\n--- markMap ---");
console.log(r.markMap);

const markCount = Object.keys(r.markMap).length;
if (markCount === 0) {
  console.error("\nSMOKE FAILED: empty markMap");
  process.exit(1);
}

if (r.rasterAvailable) {
  mkdirSync(outDir, { recursive: true });
  const buf = Buffer.from(r.image, "base64");
  writeFileSync(outPng, buf);
  console.log("\n--- raster OK ---");
  console.log("PNG written to:", outPng);
  console.log("PNG bytes:", buf.length);
  console.log("PNG dimensions:", `${r.width}x${r.height}`);
  console.log("version:", r.version, " marks:", markCount);
  console.log("\nSMOKE OK (real PNG rasterized on this platform)");
} else {
  console.log("\n--- raster FALLBACK ---");
  console.log("note:", r.note);
  console.log("svg length:", r.svg.length, "chars");
  console.log("version:", r.version, " marks:", markCount);
  console.log("\nSMOKE OK (raster unavailable; svg+markMap fallback returned — later milestones unblocked)");
}
