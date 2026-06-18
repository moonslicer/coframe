// The §5.4 agent loop, EXACTLY: snapshot BEFORE any mutation -> plan -> for each
// step: PERCEIVE (fresh scoped getTree + marked render) -> ACT (one model turn,
// dispatch tool_uses through store.commit) -> VERIFY (verifyStructural against the
// step's criterion) -> bounded retry (feed evidence back) -> on persistent failure
// finishEscalated AND restore the pre-run snapshot (clean one-undo guarantee).
//
// A MANUAL tool-use loop: every tool result passes boundary validation + structural
// verify before going back to the model, with snapshot + log emission in between —
// the interception point the SDK tool-runner hides.

import type Anthropic from "@anthropic-ai/sdk";
import type { DocStore } from "../shared/store.js";
import type { NodeId } from "../shared/types.js";
import { isErr } from "../shared/types.js";
import { dispatch, REGISTRY } from "../shared/tools.js";
import { getTree, fieldsFor, render } from "../render/perception.js";
import type { TaskHint } from "../render/perception.js";
import { verifyContentCompleteness, verifyStructural } from "./verify.js";
import type { RunController } from "./run-controller.js";
import { perceptionBlocks } from "./llm-adapter.js";
import type { ContentBlockParam, ActDelta } from "./llm-adapter.js";
import type { Step } from "./types.js";

const MAX_ATTEMPTS = 3; // bounded retry per failing step
// Hard ceiling on total model turns so a run can't blow its token budget. A flat 12
// starved thorough multi-element plans (a 6-step login form needs ~1-2 turns/step plus
// retries) — escalating them half-built. Scale with plan length, floored at 12 and
// capped so a runaway plan still can't spin forever.
const MAX_TURNS_PER_STEP = 4;
const MAX_TURNS_CAP = 40;
const turnBudgetFor = (planLength: number) =>
  Math.min(MAX_TURNS_CAP, Math.max(12, planLength * MAX_TURNS_PER_STEP));

/** Resolve the working frame: the selection's common parent, else the page root. */
function resolveRoot(store: DocStore, selection: NodeId[]): NodeId {
  if (selection.length) {
    const first = store.getNode(selection[0]);
    if (first?.parent) return first.parent;
  }
  return store.rootId;
}

/** Coarse task hint for field projection, derived from a step's criterion. */
function hintFor(step: Step): TaskHint {
  switch (step.criterion.kind) {
    case "nodeExists":
      return "create";
    case "childCount":
    case "childCountNamed":
      return "create";
    case "prop":
    case "childProp":
      return step.criterion.path.startsWith("style") ||
        step.criterion.path.startsWith("text")
        ? "restyle"
        : "layout";
    case "belowOf":
    case "belowOfNamed":
    case "aligned":
      return "layout";
    default:
      return "skeleton";
  }
}

/** The streamed activity verb+params for a tool call (label from the registry). */
function labelFor(name: string, input: unknown): string {
  const def = REGISTRY.get(name);
  return def ? def.label(input) : name;
}

/** A coarse present-tense verb shown the instant a tool_use block OPENS, before
 *  any params have streamed (§4.3 "verb first"). Params refine it as they arrive. */
function verbFor(name: string): string {
  const map: Record<string, string> = {
    createFrame: "Creating frame…",
    createText: "Creating text…",
    createShape: "Creating shape…",
    setFill: "Setting fill…",
    setTextStyle: "Styling text…",
    applyAutoLayout: "Applying auto-layout…",
    alignDistribute: "Aligning + distributing…",
    placeBelow: "Placing below…",
  };
  return map[name] ?? `${name}…`;
}

function summary(plan: Step[]): string {
  return `Done — ${plan.length} step(s): ${plan.map((s) => s.label).join("; ")}`;
}

export async function runTask(
  store: DocStore,
  rc: RunController,
  intent: string,
  selection: NodeId[],
): Promise<void> {
  // Lazily import the SDK adapter so non-agent code paths never load the SDK.
  const { plan: planIntent, act } = await import("./llm-adapter.js");

  rc.selection = selection;
  rc.transition("PLANNING");
  rc.snapshot = store.snapshot(); // one-Cmd-Z: capture BEFORE any mutation
  rc.fromVersion = store.version;
  rc.baseVersion = store.version;
  rc.emitActivity("Planning…");

  const rootId = resolveRoot(store, selection);

  let plan: Step[];
  try {
    plan = await planIntent(intent, rootId, store, selection);
  } catch (e) {
    return rc.finishEscalated(`Planning failed: ${(e as Error).message}`);
  }
  if (plan.length === 0)
    return rc.finishEscalated(
      "That doesn't look like a canvas edit I can make — try describing a design change, " +
        'e.g. "add a pricing section" or "align these and even out the spacing".',
    );
  rc.emitPlan(plan);

  let turns = 0;
  const maxTurns = turnBudgetFor(plan.length);
  const originalIds = new Set(rc.snapshot.nodes.keys());

  // Steps whose criterion never verified after MAX_ATTEMPTS. A single such step must
  // NOT sink the whole run: a multi-section design (a weather/instagram/settings
  // screen) builds 4-6 sections, and one section's strict criterion mis-firing (or a
  // genuinely-missed sub-step) shouldn't report "couldn't complete" over an otherwise
  // finished screen. We keep going, and decide done-vs-escalated from the WHOLE plan.
  const failedSteps: string[] = [];

  for (const step of plan) {
    rc.setStep(step);
    let verified = false;

    while (rc.attempts < MAX_ATTEMPTS) {
      if (++turns > maxTurns) {
        store.restore(rc.snapshot);
        return rc.finishEscalated("Hit the turn budget; restored pre-run state.");
      }

      // PERCEIVE: fresh scoped re-read each step (no getChanges)
      rc.transition("PERCEIVING");
      const tree = getTree(store, rootId, { depth: 5, fields: fieldsFor(hintFor(step)) });
      if ("error" in tree) {
        store.restore(rc.snapshot);
        return rc.finishEscalated(`Lost the working frame (${tree.detail}).`);
      }
      const r = await render(store, rootId, { marks: true, maxPx: 1024 });
      if ("error" in r) {
        store.restore(rc.snapshot);
        return rc.finishEscalated(`Lost the working frame (${r.detail}).`);
      }
      // guard the render union — never feed an undefined image to the model
      const image = r.rasterAvailable ? r.image : null;
      rc.baseVersion = r.version;
      rc.emitMarks(image ?? "", r.markMap);

      // ACT: one streaming model turn emitting tool_use, executed via the registry.
      // The stream's onDelta emits the activity line the INSTANT a tool_use block
      // opens (verb), then refines it with params as input_json_delta arrive —
      // verb-first, no flicker. We key activity ids by stream block index so the
      // dispatch phase reuses the same line (flipping it to ok / failed).
      rc.transition("ACTING");
      const actIdByIndex = new Map<number, string>();
      let planningEmitted = false;
      const onDelta = (d: ActDelta) => {
        if (d.kind === "thinking") {
          // First reasoning/text delta of the turn — keep the log alive (§4.3).
          if (!planningEmitted) {
            planningEmitted = true;
            rc.emitThinking();
          }
        } else if (d.kind === "verb") {
          // Verb the instant the tool_use block opens; params finalize at dispatch.
          const id = rc.emitActivity(verbFor(d.name), d.name);
          actIdByIndex.set(d.index, id);
        }
        // (args deltas are observed by the stream but the final label is derived
        //  from the fully-parsed tu.input at dispatch time — no partial-JSON parse.)
      };
      // Persist the per-turn perception as a user turn BEFORE act, so the request
      // ALWAYS starts with a user turn (otherwise call #2+ would begin with the prior
      // assistant tool_use turn -> Anthropic 400 "first message must be user").
      rc.pushUser(perceptionBlocks({ tree, image, markMap: r.markMap, version: r.version, step, selection: rc.selection }));
      const turn = await act(rc.messages, onDelta);
      if (turn.stopReason === "refusal") {
        store.restore(rc.snapshot);
        return rc.finishEscalated("The model declined the request.");
      }

      // Echo the assistant turn (must include tool_use blocks) into history.
      const assistantContent: ContentBlockParam[] = [];
      if (turn.text.trim()) assistantContent.push({ type: "text", text: turn.text });
      for (const tu of turn.toolUses)
        assistantContent.push({
          type: "tool_use",
          id: tu.id,
          name: tu.name,
          input: tu.input as Record<string, unknown>,
        });
      // Only push an assistant turn if it has content (an empty one is invalid).
      if (assistantContent.length) rc.pushAssistant(assistantContent);

      // Dispatch each tool through the boundary (store.commit chokepoint).
      // Reuse the activity line the stream already opened (matched in tool order);
      // fall back to a fresh line if the stream produced no verb (e.g. raster path
      // that emitted no deltas). Finalize its label from the fully-parsed args.
      const streamedIds = [...actIdByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, id]) => id);
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      turn.toolUses.forEach((tu, i) => {
        const finalLabel = labelFor(tu.name, tu.input);
        let actId = streamedIds[i];
        if (actId) rc.updateActivity(actId, undefined, finalLabel);
        else actId = rc.emitActivity(finalLabel, tu.name);
        const result = dispatch(tu.name, tu.input, store, rc.baseVersion);
        if (!isErr(result)) {
          rc.baseVersion = result.version;
          rc.emitOpsApplied(result.ops, result.version, actId);
          rc.updateActivity(actId, "ok");
        } else {
          rc.updateActivity(actId, "failed", `${result.error}: ${result.detail}`);
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: isErr(result),
          content: JSON.stringify(result),
        });
      });

      if (turn.toolUses.length === 0) {
        // Model emitted no tool calls — let VERIFY decide if the step is satisfied.
        const structural = verifyStructural(step.criterion, store);
        const v = structural.ok
          ? verifyContentCompleteness({ intent, step, store, rootId, originalIds })
          : structural;
        if (v.ok) {
          verified = true;
          break;
        }
        // nudge the model with the evidence and retry
        rc.pushUser([
          {
            type: "text",
            text: `Step not yet satisfied: ${v.evidence}\nMake the edits for this step by calling tools.`,
          },
        ]);
        rc.attempts++;
        continue;
      }

      // VERIFY: tier-1 structural read-back (no model call, <5ms)
      rc.transition("VERIFYING");
      const structural = verifyStructural(step.criterion, store);
      const v = structural.ok
        ? verifyContentCompleteness({ intent, step, store, rootId, originalIds })
        : structural;
      const reflection = `Verify: ${v.evidence}`;

      // Push tool results (+ verify reflection on failure) as the next user turn.
      const userContent: ContentBlockParam[] = [...toolResults];
      if (!v.ok)
        userContent.push({
          type: "text",
          text: `Step NOT yet satisfied. ${reflection}\nFix it with another tool call.`,
        });
      rc.pushUser(userContent);

      if (v.ok) {
        verified = true;
        break; // step succeeded -> advance plan
      }
      rc.attempts++; // feed evidence back; retry
    }

    if (!verified) {
      // KEEP every committed step (including this step's partial ops) and CONTINUE to
      // the next step. Discarding a whole run on a single verify miss is the "built the
      // design, then showed an empty canvas" bug — and a too-strict criterion can
      // mis-reject a step whose work was actually correct. The one-undo guarantee is the
      // SERVER's pre-run snapshot (restored on `undo`), not a loop-internal rollback; the
      // run-end doc-sync mirrors whatever we keep here, so a single Cmd-Z still clears it.
      failedSteps.push(step.label);
    }
  }

  // Decide the run's terminal status from the WHOLE plan, not the first miss:
  // - every step verified            -> clean done
  // - some verified, some did not     -> done WITH a caveat naming the unconfirmed steps
  //   (the screen is mostly built; reporting a hard failure over it is the worse lie)
  // - NOTHING verified                -> honest escalation (the run truly accomplished nothing)
  if (failedSteps.length === 0) {
    rc.finishDone(summary(plan));
  } else if (failedSteps.length < plan.length) {
    rc.finishDone(
      `${summary(plan)} — couldn't fully verify ${failedSteps.length} of ${plan.length} step(s): ${failedSteps.join("; ")}`,
    );
  } else {
    rc.finishEscalated(`Couldn't complete: ${failedSteps[0]}.`);
  }
}
