// The ephemeral RunController FSM (§4.1, §5.6) — run state kept SEPARATE from doc
// state. It holds the plan, attempts, the pre-run snapshot, the resolved selection,
// the baseVersion, and the message history. It exposes a typed event stream matching
// the §5.6 ServerEvent shape. Day 6 attaches a WS to emit(); for Day 5 events are
// observable via a callback registered with on().
//
// This module has NO SDK and NO doc-mutation logic — it only routes events and holds
// run-scoped state. The loop drives transitions; the store owns the doc.

import type { DocStore } from "../shared/store.js";
import type { DocVersion, Node, NodeId, Op } from "../shared/types.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam } from "./llm-adapter.js";
import type { Step } from "./types.js";

export type RunPhase =
  | "IDLE"
  | "PLANNING"
  | "PERCEIVING"
  | "ACTING"
  | "VERIFYING"
  | "DONE"
  | "ESCALATED";

// The typed, discriminated-union event stream (§5.6 ServerEvent). A plain union —
// not a production telemetry taxonomy (cut by review).
export type ServerEvent =
  | { t: "phase"; phase: RunPhase }
  | { t: "plan"; steps: { label: string }[] }
  | { t: "activity"; id: string; text: string; tool?: string; status: "running" }
  | { t: "activity-update"; id: string; text?: string; status?: "ok" | "failed" }
  | { t: "marks"; image: string; markMap: Record<string, NodeId> }
  | { t: "ops-applied"; ops: Op[]; version: DocVersion; activityId?: string }
  | {
      t: "done";
      label: string;
      summary: string;
      fromVersion: DocVersion;
      toVersion: DocVersion;
    }
  | { t: "escalated"; label: string; reason: string };

export type SnapshotData = ReturnType<DocStore["snapshot"]>;
export type EventListener = (e: ServerEvent) => void;

export class RunController {
  phase: RunPhase = "IDLE";

  // run-scoped state (ephemeral; never the doc store's concern)
  plan: Step[] = [];
  step: Step | null = null;
  attempts = 0;
  snapshot: SnapshotData | null = null;
  selection: NodeId[] = [];
  baseVersion: DocVersion = 0;
  fromVersion: DocVersion = 0;
  messages: Anthropic.MessageParam[] = [];

  private listeners = new Set<EventListener>();
  private activitySeq = 0;

  /** Register an event listener; returns an unsubscribe fn. */
  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent) {
    for (const l of this.listeners) l(e);
  }

  transition(phase: RunPhase) {
    this.phase = phase;
    this.emit({ t: "phase", phase });
  }

  setStep(step: Step) {
    this.step = step;
    this.attempts = 0;
  }

  newActivityId(): string {
    return `act:${++this.activitySeq}`;
  }

  // --- convenience emitters used by the loop ---

  emitPlan(steps: Step[]) {
    this.plan = steps;
    this.emit({ t: "plan", steps: steps.map((s) => ({ label: s.label })) });
  }

  emitMarks(image: string, markMap: Record<string, NodeId>) {
    this.emit({ t: "marks", image, markMap });
  }

  emitActivity(text: string, tool?: string): string {
    const id = this.newActivityId();
    this.emit({ t: "activity", id, text, tool, status: "running" });
    return id;
  }

  updateActivity(id: string, status?: "ok" | "failed", text?: string) {
    this.emit({ t: "activity-update", id, status, text });
  }

  /** A transient "Thinking…" beat on the first reasoning/text delta of an ACT turn,
   *  so the adaptive-thinking pause never reads as a dead spinner (§4.3). It is a
   *  self-resolving line — the verb line that follows is the real activity. */
  emitThinking(): void {
    const id = this.newActivityId();
    this.emit({ t: "activity", id, text: "Thinking…", status: "running" });
    this.emit({ t: "activity-update", id, status: "ok" });
  }

  emitOpsApplied(ops: Op[], version: DocVersion, activityId?: string) {
    this.emit({ t: "ops-applied", ops, version, activityId });
  }

  // --- terminal transitions ---

  finishDone(summary: string): void {
    this.transition("DONE");
    this.emit({
      t: "done",
      label: "Agent run",
      summary,
      fromVersion: this.fromVersion,
      toVersion: this.baseVersion,
    });
  }

  finishEscalated(reason: string): void {
    this.transition("ESCALATED");
    this.emit({ t: "escalated", label: "Agent run", reason });
  }

  // --- message-history helpers (the manual tool-use loop, §5.4) ---

  /** Append the assistant turn (must include tool_use blocks) to history. */
  pushAssistant(content: ContentBlockParam[]) {
    this.messages.push({ role: "assistant", content });
  }

  /** Append a user turn carrying tool_results (+ optional reflection text). */
  pushUser(content: ContentBlockParam[]) {
    this.messages.push({ role: "user", content });
  }
}

// helper re-exported for the loop's convenience
export type { Node };
