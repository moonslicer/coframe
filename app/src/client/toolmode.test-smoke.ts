// Node smoke for the toolMode external store — plain (non-hook) parts only.
// Asserts: default "select"; setToolMode("rect") flips getToolMode(); a subscriber
// fires on change and does NOT fire when set to the same value again.
import { getToolMode, setToolMode, toolModeStore } from "./stores.js";

let ok = true;
const fail = (m: string) => {
  ok = false;
  console.error("FAIL:", m);
};

if (getToolMode() !== "select") fail(`default expected "select", got "${getToolMode()}"`);

let fires = 0;
const unsub = toolModeStore.subscribe(() => {
  fires += 1;
});

setToolMode("rect");
if (getToolMode() !== "rect") fail(`after set expected "rect", got "${getToolMode()}"`);
if (fires !== 1) fail(`subscriber should fire once on change, fired ${fires}`);

setToolMode("rect"); // unchanged -> no-op, no notify
if (fires !== 1) fail(`subscriber must NOT fire on unchanged set, fired ${fires}`);

unsub();

if (ok) {
  console.log("OK");
} else {
  process.exit(1);
}
