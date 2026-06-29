// The §5.4 agent loop, EXACTLY: snapshot BEFORE any mutation -> plan -> for each
// step: PERCEIVE (fresh scoped getTree + marked render) -> ACT (one model turn,
// dispatch tool_uses through store.commit) -> VERIFY (verifyStructural against the
// step's criterion) -> bounded retry (feed evidence back). A step that never verifies
// is KEPT (its committed ops stay) and the run continues; the run finishes done (with a
// caveat if some steps were unconfirmed) and only escalates when NOTHING verified. The
// loop does NOT restore on failure — the clean one-undo guarantee is the SERVER's
// pre-run snapshot (pushed before runTask, restored on `undo`), not a loop-internal
// rollback (see the keep-partial-work note at the end of runTask).
//
// A MANUAL tool-use loop: every tool result passes boundary validation + structural
// verify before going back to the model, with snapshot + log emission in between —
// the interception point the SDK tool-runner hides.

import type Anthropic from "@anthropic-ai/sdk";
import type { DocStore } from "../shared/store.js";
import type { NodeId } from "../shared/types.js";
import type { DesignSystemProfile } from "../shared/design-system.js";
import { isErr } from "../shared/types.js";
import { dispatch, REGISTRY } from "../shared/tools.js";
import { getTree, fieldsFor, render, getMarks } from "../render/perception.js";
import type { TaskHint } from "../render/perception.js";
import { verifyContentCompleteness, verifyStructural } from "./verify.js";
import type { RunController } from "./run-controller.js";
import { perceptionBlocks, pruneStalePerception } from "./llm-adapter.js";
import type { ContentBlockParam, ActDelta } from "./llm-adapter.js";
import type { Step } from "./types.js";

const MAX_ATTEMPTS = 3; // bounded retry for a SIMPLE step (create/restyle/align verifies in 1-2 turns)
// A multi-item content step (a 6-card hourly strip, a 7-day list, a 4-tile grid) is the
// hard case: the act model emits ONE tool call per turn (it re-perceives between calls and
// will not batch a whole set into one response, no matter how the prompt asks), and each
// item costs ~2 calls (its frame + the text/shape inside). At MAX_ATTEMPTS=3 such a step
// can place at most ~3 nodes, so it ALWAYS ships half-built (2 cards instead of 6) and
// verify rightly fails. The fix is to size the per-step budget to the count the step asks
// for, so one-tool-per-turn building can actually finish. Simple steps are unaffected: they
// verify and break long before the larger ceiling.
const MAX_ATTEMPTS_CEILING = 16;
const MAX_TURNS_CAP = 80;

/** The item count a step targets, for budgeting: its childCount criterion's minimum, raised
 *  by any explicit count in the label ("6 cards", "7-day", "4 tiles"). 0 when not a set. */
function targetCount(step: Step): number {
  const c = step.criterion as { kind: string; count?: number };
  let n = (c.kind === "childCount" || c.kind === "childCountNamed") && typeof c.count === "number" ? c.count : 0;
  // A count followed (possibly across a few filler words like "time/icon/temp") by a
  // content unit: "6 time/icon/temp cards", "5 time-slot cards", "7-day", "4 tiles",
  // "8 video thumbnails", "6 game levels", "5 track rows". The curated nouns keep the
  // common singular-with-count forms ("7-day"), and the trailing `[a-z]{4,}s` catches
  // ANY novel plural unit so a non-demo design system ("thumbnails"/"levels"/"tracks"/
  // "stories"/"avatars") still sizes its budget. Over-counting is safe: it only RAISES
  // the ceiling, which a simple step never reaches (it verifies and breaks early).
  const m = /(\d+)[^\d]{0,24}?\b(?:cards?|tiles?|rows?|items?|days?|slots?|columns?|cols?|tiers?|bars?|dots?|pills?|[a-z]{4,}s)\b/i.exec(
    step.label,
  );
  if (m) n = Math.max(n, parseInt(m[1], 10));
  return n;
}

/** Per-step retry budget: simple steps get MAX_ATTEMPTS; a set of N items gets ~2 turns
 *  per item (frame + child), bounded by the ceiling. */
function attemptsFor(step: Step): number {
  const n = targetCount(step);
  return n <= MAX_ATTEMPTS ? MAX_ATTEMPTS : Math.min(MAX_ATTEMPTS_CEILING, n * 2 + 2);
}

/** Total turn ceiling: the SUM of every step's budget (+ slack), so a legitimately heavy
 *  multi-section plan never trips the global abort mid-build, while a runaway still stops. */
const turnBudgetFor = (plan: Step[]): number =>
  Math.min(MAX_TURNS_CAP, plan.reduce((sum, s) => sum + attemptsFor(s), 0) + plan.length);

/** Resolve the working frame: the selection's common parent, else the page root. */
function resolveRoot(store: DocStore, selection: NodeId[]): NodeId {
  if (selection.length) {
    const first = store.getNode(selection[0]);
    if (first?.parent) return first.parent;
  }
  return store.rootId;
}

/**
 * Should THIS turn pay for the rasterized vision channel (~1k image tokens to the
 * model + a full-res PNG over the wire)? Vision is high-value for the FIRST look at a
 * spatial step (grounding what to build / where) and for re-judging a layout re-flow.
 * It is low-value on restyle/skeleton turns (decided from style/text fields) and on
 * create/restyle RETRIES — those are driven by the fresh scene-graph tree (exact
 * post-edit bboxes) plus the structural-verify evidence, so re-screenshotting just
 * re-pays for a near-identical picture. Net effect: an N-turn build sends ~1 image,
 * not N, with no loss of the spatial grounding that drives output quality.
 */
function wantImage(hint: TaskHint, attempt: number): boolean {
  if (hint === "restyle" || hint === "skeleton") return false;
  if (attempt === 0) return true; // first look at a create/layout step
  return hint === "layout"; // only layout retries need to re-see the result
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

/** True when a tool call would REPOSITION (change x or y of) a FRAME that has children
 *  via the absolute setBBox/setBBoxes path — which leaves the children behind. Used to veto
 *  such an op in the refine pass (pure resizes and leaf moves return false). */
function movesPopulatedFrame(name: string, input: unknown, store: DocStore): boolean {
  if (name !== "setBBox" && name !== "setBBoxes") return false;
  const items =
    name === "setBBox"
      ? [(input as { id?: NodeId; bbox?: number[] })]
      : ((input as { items?: { id?: NodeId; bbox?: number[] }[] }).items ?? []);
  for (const it of items) {
    const node = it?.id ? store.getNode(it.id) : undefined;
    if (!node || node.type !== "FRAME" || node.children.length === 0) continue;
    const b = it.bbox;
    if (Array.isArray(b) && (b[0] !== node.bbox[0] || b[1] !== node.bbox[1])) return true;
  }
  return false;
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
  designSystem: DesignSystemProfile | null = null,
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
    plan = await planIntent(intent, rootId, store, selection, (u) => rc.addUsage(u), designSystem);
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
  const maxTurns = turnBudgetFor(plan);
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
    const stepAttempts = attemptsFor(step);

    while (rc.attempts < stepAttempts) {
      if (++turns > maxTurns) {
        store.restore(rc.snapshot);
        return rc.finishEscalated("Hit the turn budget; restored pre-run state.");
      }

      // PERCEIVE: fresh scoped re-read each step (no getChanges)
      rc.transition("PERCEIVING");
      const hint = hintFor(step);
      const tree = getTree(store, rootId, { depth: 5, fields: fieldsFor(hint) });
      if ("error" in tree) {
        store.restore(rc.snapshot);
        return rc.finishEscalated(`Lost the working frame (${tree.detail}).`);
      }
      // Rasterize ONLY when this turn wants vision (see wantImage). Otherwise compute
      // the markMap alone — no resvg, no PNG bytes — so the turn runs text-only on the
      // fresh scene-graph tree + verify evidence. The client overlay needs only markMap.
      let image: string | null = null;
      let markMap: Record<string, NodeId> = {};
      let version: number;
      // Skip the FIRST image of a build that starts from a near-empty canvas: a marked
      // render of an empty (or root-only) frame teaches the model nothing yet costs ~1.4k
      // image tokens + a resvg rasterize. Once content exists (a later attempt, or an edit
      // on an already-populated canvas) the image is worth it again — that's the refine look.
      const emptyish = tree.nodes.length <= 3;
      const useImage =
        wantImage(hint, rc.attempts) && !(!process.env.NO_COMPOSE && emptyish && rc.attempts === 0);
      if (useImage) {
        const r = await render(store, rootId, { marks: true, maxPx: 1024 });
        if ("error" in r) {
          store.restore(rc.snapshot);
          return rc.finishEscalated(`Lost the working frame (${r.detail}).`);
        }
        image = r.rasterAvailable ? r.image : null; // guard the render union
        markMap = r.markMap;
        version = r.version;
      } else {
        const m = getMarks(store, rootId, { maxPx: 1024 });
        if ("error" in m) {
          store.restore(rc.snapshot);
          return rc.finishEscalated(`Lost the working frame (${m.detail}).`);
        }
        markMap = m.markMap;
        version = m.version;
      }
      rc.baseVersion = version;
      // The client draws its overlay boxes from markMap; the PNG (only present on vision
      // turns) just refreshes the decorative "agent's-eye" thumbnail. On text-only turns
      // image is "" (falsy) so the thumbnail holds — markMap still flows for the overlay,
      // and the full-res PNG never crosses the wire.
      rc.emitMarks(image ?? "", markMap);
      const modelImage = image;

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
      rc.pushUser(
        perceptionBlocks({
          tree,
          image: modelImage,
          markMap: modelImage ? markMap : {},
          version,
          step,
          selection: rc.selection,
          designSystem,
        }),
      );
      // Strip stale images + scene-graphs from prior turns: each turn re-perceives, so
      // only THIS perception is current — keeping the rest is an O(n²) token blowup.
      pruneStalePerception(rc.messages);
      const turn = await act(rc.messages, onDelta);
      rc.addUsage(turn.usage);
      rc.turns = turns;
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

  // REFINE — the "render once, then fix" pass. Bulk building (composeSubtree) is fast but
  // skips the per-node visual feedback that catches overlap / misalignment / weak hierarchy.
  // We restore that quality gate ONCE for the whole run instead of once per node: render the
  // finished frame a single time and let the model make targeted fixes. Gated on having built
  // real content and not having already failed outright. One image + one act turn — its own
  // fresh context so it never bloats the build history.
  const newNodes = store.count() - originalIds.size;
  if (!process.env.NO_COMPOSE && newNodes >= 4 && failedSteps.length < plan.length) {
    rc.transition("PERCEIVING");
    const r = await render(store, rootId, { marks: true, maxPx: 1024 });
    const tree = getTree(store, rootId, { depth: 6, fields: ["style", "text", "layout"] });
    if (!("error" in r) && r.rasterAvailable && !("error" in tree)) {
      rc.baseVersion = r.version;
      rc.emitMarks(r.image, r.markMap);
      const reviewId = rc.emitActivity("Reviewing the design…");
      const messages: ContentBlockParam[] = [
        {
          type: "text",
          text:
            `You just built this design for the request: "${intent}". Now do an ART-DIRECTOR pass on the ` +
            `RENDERED image — judge it as a finished visual, not a wireframe.\n\n` +
            `First fix any CLEAR defect: overlapping or clipped elements, misalignment, uneven spacing, ` +
            `weak hierarchy, or low contrast.\n` +
            `Then RAISE THE FIDELITY where it reads flat or placeholder-y — this is what separates a polished ` +
            `product mock from a wireframe:\n` +
            `  • Flat solid headers/buttons/hero or background panels → give them a GRADIENT (setGradient, or ` +
            `setProps style.fills) when it suits the style.\n` +
            `  • Cards / floating bars / modals sitting flat on the page → add a drop SHADOW for elevation ` +
            `(setProps style.shadow = {y,blur,color}).\n` +
            `  • Placeholder squares/circles standing in for like / comment / share / bookmark / nav / tab ` +
            `icons → replace them with REAL glyphs (createIcon: heart, comment, share, bookmark, home, search, ` +
            `user, settings, bell, star, play, plus, more, menu, …).\n` +
            `  • Frosted/glass panels → add \`blur\` (setProps style.blur).\n` +
            `Make targeted edits only — do NOT rebuild what already works, and keep the requested style ` +
            `(don't gild a deliberately minimal/brutalist design).\n` +
            `IMPORTANT: to REPOSITION a frame that has children, use alignDistribute or placeBelow (they carry ` +
            `the children with it). Do NOT use setBBox/setBBoxes to move a container — that moves the frame ` +
            `alone and leaves its children behind. setBBox is only for a single leaf node or a pure resize.\n\n` +
            `Scene graph (v${r.version}):\n${JSON.stringify(tree)}\n\n` +
            `markMap (number -> NodeId): ${JSON.stringify(r.markMap)}`,
        },
        { type: "image", source: { type: "base64", media_type: "image/png", data: r.image } },
        { type: "text", text: "If it already looks polished and has real depth, make NO tool calls and stop." },
      ];
      rc.transition("ACTING");
      rc.turns += 1;
      const turn = await act([{ role: "user", content: messages }]);
      rc.addUsage(turn.usage);
      rc.updateActivity(reviewId, "ok");
      if (turn.stopReason !== "refusal") {
        for (const tu of turn.toolUses) {
          const actId = rc.emitActivity(labelFor(tu.name, tu.input), tu.name);
          // GUARD: a refine fix must never MOVE a container with setBBox/setBBoxes — those
          // are absolute single-node ops that leave the frame's children behind (the SVG/DOM
          // uses absolute coords, so a moved parent orphans its subtree). composeSubtree
          // already places sections correctly; if the model still tries to reposition a
          // populated frame this way, skip it rather than corrupt the layout. (Pure resizes
          // and leaf moves are fine — only a moved FRAME-with-children is blocked.)
          if (movesPopulatedFrame(tu.name, tu.input, store)) {
            rc.updateActivity(actId, "failed", "skipped: setBBox would orphan the frame's children");
            continue;
          }
          const result = dispatch(tu.name, tu.input, store, rc.baseVersion);
          if (!isErr(result)) {
            rc.baseVersion = result.version;
            rc.emitOpsApplied(result.ops, result.version, actId);
            rc.updateActivity(actId, "ok");
          } else {
            rc.updateActivity(actId, "failed", `${result.error}: ${result.detail}`);
          }
        }
      }
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
