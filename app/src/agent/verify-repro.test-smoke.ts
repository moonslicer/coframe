// No-API repro of the "Couldn't complete: hourly forecast row" bug.
// Builds the EXACT tree probe run 2 produced (page > Weather Screen > Hourly
// Forecast Row > 4 Hour Cards, each with 2 texts) — a COMPLETE, CORRECT design —
// then runs verifyStructural against the criteria the planner can express for a
// frame it creates nested 2 levels deep. Shows the verify FALSELY rejects it.
import { DocStore } from "../shared/store.js";
import { dispatch } from "../shared/tools.js";
import { verifyContentCompleteness, verifyStructural } from "./verify.js";
import type { Node } from "../shared/types.js";
import type { Step } from "./types.js";

const store = new DocStore();
store.loadSeed({
  rootId: "page",
  nodes: [
    { id: "page", type: "FRAME", name: "Page", parent: null, children: [],
      bbox: [0, 0, 1440, 1024], style: { fills: [] }, layout: { mode: "NONE" } } as unknown as Node,
  ],
});

const v = () => store.version;
const id = (r: any) => r.ops[0].node?.id ?? r.ops[0].id;

// page > Weather Screen
const screen = id(dispatch("createFrame", { parent: "page", name: "Weather Screen" }, store, v()));
// screen > Hourly Forecast Row
const row = id(dispatch("createFrame", { parent: screen, name: "Hourly Forecast Row" }, store, v()));
// row > 4 Hour Cards, each with 2 texts (time + temp) — the complete design
for (let i = 0; i < 4; i++) {
  const card = id(dispatch("createFrame", { parent: row, name: "Hour Card" }, store, v()));
  dispatch("createText", { parent: card, chars: `${i}PM` }, store, v());
  dispatch("createText", { parent: card, chars: `${70 + i}°` }, store, v());
}

const rowNode = store.getNode(row)!;
console.log(`Built: Weather Screen(${screen}) > Hourly Forecast Row(${row}) with ${rowNode.children.length} Hour Cards.`);
console.log("This is a COMPLETE, correct hourly forecast. Now the planner's criteria:\n");

// The planner only knows the page root id at plan time (screen+row are created by
// the plan, so it must resolve them BY NAME via parentId+nameLike).
const cases: { why: string; crit: any; want: boolean }[] = [
  {
    why: "A) parentId = page root (the only id the planner has), nameLike='hourly', count 4 — was FAIL (nesting), must now PASS",
    crit: { kind: "childCountNamed", parentId: "page", type: "FRAME", nameLike: "hourly", count: 4 },
    want: true,
  },
  {
    why: "B) planner over-guessed count=6 as a MINIMUM; act model made 4 — was FAIL (exact ===), must now PASS",
    crit: { kind: "childCountNamed", parentId: "page", type: "FRAME", nameLike: "hourly", count: 6 },
    want: false, // 4 >= 6 is false; over-guess is mitigated by the planner-side "count is a minimum" guidance, not here
  },
  {
    why: "C) planner under-guessed count=2 as a MINIMUM; act model made 4 — must PASS",
    crit: { kind: "childCountNamed", parentId: "page", type: "FRAME", nameLike: "hourly", count: 2 },
    want: true,
  },
  {
    why: "D) nodeExists for the row anchored at page root (2 levels up) — must resolve via BFS, PASS",
    crit: { kind: "nodeExists", parentId: "page", type: "FRAME", nameLike: "hourly" },
    want: true,
  },
];

let allOk = true;
for (const c of cases) {
  const r = verifyStructural(c.crit, store);
  const pass = r.ok === c.want;
  allOk = allOk && pass;
  console.log(`${pass ? "EXPECTED ✓" : "REGRESSION ✗"}  [verify ${r.ok ? "PASS" : "FAIL"}]  ${c.why}`);
  console.log(`        evidence: ${r.evidence}\n`);
}

const hourlyStep: Step = {
  index: 0,
  label: "Create hourly forecast row frame with hour cards inside the phone frame",
  criterion: { kind: "childCountNamed", parentId: "page", type: "FRAME", nameLike: "hourly", count: 4 },
};
const completeContent = verifyContentCompleteness({
  intent: "Create an iOS weather app with hourly and daily forecasts",
  step: hourlyStep,
  store,
  rootId: "page",
  originalIds: new Set(["page"]),
});
const completePass = completeContent.ok === true;
allOk = allOk && completePass;
console.log(
  `${completePass ? "EXPECTED ✓" : "REGRESSION ✗"}  [content ${completeContent.ok ? "PASS" : "FAIL"}]  Complete hour cards with text must pass`,
);
console.log(`        evidence: ${completeContent.evidence}\n`);

const blankStore = new DocStore();
blankStore.loadSeed({
  rootId: "page",
  nodes: [
    { id: "page", type: "FRAME", name: "Page", parent: null, children: [],
      bbox: [0, 0, 1440, 1024], style: { fills: [] }, layout: { mode: "NONE" } } as unknown as Node,
  ],
});
const bv = () => blankStore.version;
const bid = (r: any) => r.ops[0].node?.id ?? r.ops[0].id;
const blankScreen = bid(dispatch("createFrame", { parent: "page", name: "Weather Screen" }, blankStore, bv()));
const blankRow = bid(dispatch("createFrame", { parent: blankScreen, name: "Hourly Forecast Row" }, blankStore, bv()));
for (let i = 1; i <= 4; i++)
  dispatch("createFrame", { parent: blankRow, name: `Hour ${i}` }, blankStore, bv());
const blankContent = verifyContentCompleteness({
  intent: "Create an iOS weather app with hourly and daily forecasts",
  step: hourlyStep,
  store: blankStore,
  rootId: "page",
  originalIds: new Set(["page"]),
});
const blankPass = blankContent.ok === false && blankContent.evidence.includes("Hour 1");
allOk = allOk && blankPass;
console.log(
  `${blankPass ? "EXPECTED ✓" : "REGRESSION ✗"}  [content ${blankContent.ok ? "PASS" : "FAIL"}]  Blank hour frames must fail`,
);
console.log(`        evidence: ${blankContent.evidence}\n`);

// Repro of the "create an iOS weather app -> empty white boxes" bug: the act model
// builds the section frames but leaves them childless, and verify FALSELY passed
// because their prose names ("Hourly Forecast Strip", "5-Day Forecast", "Temp Hero")
// matched none of the content-bearing name patterns. Each empty section must now fail
// the content check so the loop retries and the model fills it in.
const sectionStore = new DocStore();
sectionStore.loadSeed({
  rootId: "page",
  nodes: [
    { id: "page", type: "FRAME", name: "Page", parent: null, children: [],
      bbox: [0, 0, 1440, 1024], style: { fills: [] }, layout: { mode: "NONE" } } as unknown as Node,
  ],
});
const sv = () => sectionStore.version;
const sid = (r: any) => r.ops[0].node?.id ?? r.ops[0].id;
// The exact frame the probe produced: a screen shell whose sections are empty boxes.
const appScreen = sid(dispatch("createFrame", { parent: "page", name: "Weather App" }, sectionStore, sv()));
for (const name of ["Temp Hero", "Hourly Forecast Strip", "5-Day Forecast"])
  dispatch("createFrame", { parent: appScreen, name }, sectionStore, sv());
const sectionStep: Step = {
  index: 0,
  label: "Add hourly forecast strip with 5 time+icon+temp cards in a horizontal row",
  criterion: { kind: "nodeExists", parentId: "page", type: "FRAME", nameLike: "hourly" },
};
const sectionContent = verifyContentCompleteness({
  intent: "create an iOS weather app",
  step: sectionStep,
  store: sectionStore,
  rootId: "page",
  originalIds: new Set(["page"]),
});
// The screen SHELL ("Weather App") must NOT be flagged (a later step fills it); the
// three empty prose-named sections MUST be flagged as blank.
const sectionPass =
  sectionContent.ok === false &&
  !sectionContent.evidence.includes("Weather App") &&
  ["Temp Hero", "Hourly Forecast Strip", "5-Day Forecast"].every((n) =>
    sectionContent.evidence.includes(n),
  );
allOk = allOk && sectionPass;
console.log(
  `${sectionPass ? "EXPECTED ✓" : "REGRESSION ✗"}  [content ${sectionContent.ok ? "PASS" : "FAIL"}]  Empty prose-named sections must fail; screen shell must not`,
);
console.log(`        evidence: ${sectionContent.evidence}\n`);

console.log(allOk ? "ALL EXPECTATIONS MET ✓" : "SOME EXPECTATIONS FAILED ✗");
process.exit(allOk ? 0 : 1);
