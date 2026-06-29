import assert from "node:assert/strict";
import { formatClarifiedIntent } from "./clarify.js";
import { coerceClarification } from "./llm-adapter.js";

// Clarification is now LLM-driven (assess_clarity forced tool-call), so the gate itself
// can't be exercised offline. We test the deterministic seams instead: how an assess_clarity
// result is coerced, and how an answered clarification is folded back into the intent.

// Model asks -> questions + assumptions surface, capped at 3.
const ask = coerceClarification({
  needsClarification: true,
  questions: ["What product?", "Who is the primary user?", "What visual direction?", "extra dropped"],
  assumptions: ["A productivity SaaS", "A first-time user", "Polished modern"],
});
assert(ask, "needsClarification:true with questions should clarify");
assert.equal(ask.questions.length, 3, "questions capped at 3");
assert.equal(ask.assumptions.length, 3);

// Model declines -> build now, regardless of any leftover fields.
assert.equal(
  coerceClarification({ needsClarification: false, questions: ["ignored"] }),
  null,
  "needsClarification:false should never interrupt",
);

// Defensive: an "ask" with nothing to actually ask falls through to building.
assert.equal(coerceClarification({ needsClarification: true, questions: [] }), null);
assert.equal(coerceClarification({}), null);
assert.equal(coerceClarification(null), null);

const clarified = formatClarifiedIntent("Design an app screen", "A travel app for families.");
assert(clarified.includes("A travel app for families."));
assert(clarified.includes("Use these answers as requirements"));

console.log("clarify smoke OK");
