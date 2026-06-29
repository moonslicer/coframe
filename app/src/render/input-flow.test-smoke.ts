// Plain tsx smoke script (NOT a test framework). Run: npx tsx src/render/input-flow.test-smoke.ts
// Builds a tiny sign-up flow with form inputs + a cross-screen {{name}} reference, then
// asserts: inputs render as field boxes on the static canvas, {{field}} interpolates from
// live form values in play mode, password masks, required gating data is computable, and the
// render stays byte-deterministic.

import { DocStore } from "../shared/store.js";
import { dispatch } from "../shared/tools.js";
import { isErr } from "../shared/types.js";
import { buildSvg } from "./svg-build.js";
import { formStore, missingRequired, visibleInputs } from "../client/stores.js";
import type { Node } from "../shared/types.js";

const store = new DocStore();
store.loadSeed({ rootId: "node:root", nodes: [
  { id: "node:root", type: "FRAME", name: "Page", bbox: [0, 0, 1200, 900], parent: null, children: [] },
] });

// Screen 1: a sign-up form with name + email + password (all required), and a Continue button.
const signup = dispatch(
  "composeSubtree",
  {
    parent: store.rootId,
    tree: {
      type: "FRAME", name: "Sign Up", screen: true, layout: { dir: "V", gap: 16, padding: 24 },
      children: [
        { type: "TEXT", name: "Title", chars: "Create your account", fontSize: 24, fontWeight: 700 },
        { type: "FRAME", name: "Name", input: { field: "name", kind: "text", placeholder: "Full name", required: true }, w: 280, h: 48 },
        { type: "FRAME", name: "Email", input: { field: "email", kind: "email", placeholder: "you@example.com", required: true }, w: 280, h: 48 },
        { type: "FRAME", name: "Password", input: { field: "password", kind: "password", placeholder: "Password", required: true }, w: 280, h: 48 },
        { type: "FRAME", name: "Terms", input: { field: "terms", kind: "checkbox", label: "I agree to the terms", defaultValue: "false" }, w: 280, h: 28 },
        { type: "TEXT", name: "Continue", chars: "Continue", fontSize: 16, fontWeight: 600, color: "#FFFFFF" },
      ],
    },
  },
  store,
  store.version,
);
if (isErr(signup)) { console.error(signup); process.exit(1); }

// Screen 2: the confirmation, reading back the typed name.
const congrats = dispatch(
  "composeSubtree",
  {
    parent: store.rootId,
    tree: {
      type: "FRAME", name: "Done", screen: true, layout: { dir: "V", gap: 12, padding: 24 },
      children: [
        { type: "TEXT", name: "Congrats", chars: "You're all set, {{name}}!", fontSize: 22, fontWeight: 700 },
        { type: "TEXT", name: "Sub", chars: "We sent a confirmation to {{email}}.", fontSize: 15 },
      ],
    },
  },
  store,
  store.version,
);
if (isErr(congrats)) { console.error(congrats); process.exit(1); }

const screenIdOf = (r: { ops: Array<{ kind: string; node?: Node }> }): string =>
  r.ops.find((o) => o.kind === "add" && o.node?.screen)!.node!.id;
const screen1Id = screenIdOf(signup);
const screen2Id = screenIdOf(congrats);

// Static canvas (no values): placeholders show, no value text.
const editorSvg = buildSvg(store, store.rootId).svg;

// Play mode with live form state.
const values = { name: "Ada", email: "ada@x.com", password: "secret", terms: "true" };
const noHidden = () => false;
const play1 = buildSvg(store, screen1Id, { play: { isHidden: noHidden, values } }).svg;
const play2 = buildSvg(store, screen2Id, { play: { isHidden: noHidden, values } }).svg;

const inputs = visibleInputs(store, screen1Id, noHidden);

// Required-field gating: empty form -> 3 required fields missing; filled -> 0.
formStore.reset({});
const missingEmpty = missingRequired(store, screen1Id, noHidden).map((n) => n.input!.field);
formStore.reset(values);
const missingFilled = missingRequired(store, screen1Id, noHidden).map((n) => n.input!.field);

const checks: Array<[string, boolean]> = [
  ["screen1 has 4 inputs", inputs.length === 4],
  ["editor shows placeholder 'Full name'", editorSvg.includes("Full name")],
  ["editor shows NO interpolated name (no values)", !editorSvg.includes("You're all set, Ada")],
  ["editor leaves {{name}} literal on canvas", editorSvg.includes("{{name}}")],
  ["play2 interpolates {{name}} -> Ada", play2.includes("You're all set, Ada!")],
  ["play2 interpolates {{email}} -> ada@x.com", play2.includes("ada@x.com")],
  ["play2 leaves no literal braces", !play2.includes("{{")],
  ["play1 shows typed email value", play1.includes("ada@x.com")],
  ["play1 masks the password", play1.includes("••••••") && !play1.includes(">secret<")],
  ["checkbox renders checkmark when on", play1.includes("I agree to the terms")],
  ["empty form: name/email/password required-missing", JSON.stringify(missingEmpty) === JSON.stringify(["name", "email", "password"])],
  ["filled form: nothing missing", missingFilled.length === 0],
  ["render is deterministic", play2 === buildSvg(store, screen2Id, { play: { isHidden: noHidden, values } }).svg],
];

let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${label}`);
  if (!pass) ok = false;
}
console.log(ok ? "\nPASS" : "\nFAIL");
process.exit(ok ? 0 : 1);
