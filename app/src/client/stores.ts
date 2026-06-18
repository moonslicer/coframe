// Two stores, never conflated (§5.6):
//   - useDocMirror: nodes / version / selection — the RENDERER subscribes.
//   - useRunStore:  phase / plan / activity entries / marks beat / history — the
//                   CHROME subscribes.
// Both are fed by the single WS event stream (wsClient). Plain React-external
// stores via useSyncExternalStore so the renderer and chrome re-render independently.

import { useSyncExternalStore } from "react";
import { DocStore } from "../shared/store.js";
import { applyOps } from "../shared/store.js";
import type { Node, NodeId, Op } from "../shared/types.js";
import type { RunPhase } from "../agent/run-controller.js";
import type { ServerMessage } from "../shared/protocol.js";

// ---------------------------------------------------------------------------
// Doc mirror — a READ-ONLY DocStore the browser renders from. Patched from
// ops-applied (node-by-node snap-in) and replaced wholesale on doc-sync/undone.
// ---------------------------------------------------------------------------
class DocMirror {
  store = new DocStore();
  selection: NodeId[] = [];
  seedDocId = "landing"; // which curated seed is loaded (drives the chips)
  version = 0; // authoritative doc version (display); changes on every doc mutation
  private tick = 0; // monotonic snapshot primitive — bumps on ANY change (doc OR selection)
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private notify() {
    this.tick += 1;
    for (const l of this.listeners) l();
  }
  // useSyncExternalStore snapshot: bumps on doc mutations AND selection changes,
  // so the SelectionLayer / prompt placeholder re-render on multi-select toggles.
  getTick = () => this.tick;

  sync(nodes: Node[], rootId: NodeId, version: number, seedDocId?: string) {
    this.store.loadSeed({ rootId, nodes });
    // loadSeed forces version=1; carry the authoritative version for display.
    this.version = version;
    if (seedDocId) this.seedDocId = seedDocId;
    // A full doc replace (seed change / undo / resync) invalidates any selection:
    // stale ids must not leak into the next prompt or across docs.
    this.selection = [];
    this.notify();
  }

  applyOps(ops: Op[], version: number) {
    // Patch the live mirror in place (single-writer => immediate == optimistic).
    const next = applyOps(this.store.all(), ops);
    // Re-seed the internal store from the patched map (cheap at demo scale).
    this.store.loadSeed({
      rootId: this.store.rootId,
      nodes: [...next.values()],
    });
    this.version = version;
    this.notify();
  }

  setSelection(ids: NodeId[]) {
    this.selection = ids;
    this.notify();
  }

  clearSelection() {
    if (this.selection.length === 0) return;
    this.selection = [];
    this.notify();
  }
}

export const docMirror = new DocMirror();

// Re-render trigger for anything reading the doc mirror (nodes, version, selection).
// Returns the internal tick (bumps on every change) — callers needing the display
// doc version read docMirror.version directly.
export function useDocVersion(): number {
  return useSyncExternalStore(docMirror.subscribe, docMirror.getTick);
}

// ---------------------------------------------------------------------------
// Run store — ephemeral run/chrome state. Activity entries, marks beat, history.
// ---------------------------------------------------------------------------
export interface ActivityEntry {
  id: string;
  text: string;
  tool?: string;
  status: "running" | "ok" | "failed";
  detail?: string;
}
export interface HistoryEntry {
  label: string;
  summary: string;
  fromVersion: number;
  toVersion: number;
  status: "done" | "escalated";
}
export interface MarksBeat {
  image: string; // base64 PNG (agent's-eye thumbnail); "" if raster unavailable
  markMap: Record<string, NodeId>;
  at: number; // timestamp, drives the transient flash
}

export interface RunState {
  phase: RunPhase;
  planLabels: string[];
  activity: ActivityEntry[];
  marks: MarksBeat | null;
  history: HistoryEntry[];
  banner: string | null; // single-writer rejection / transient notice
  canUndo: boolean;
}

class RunStore {
  private state: RunState = {
    phase: "IDLE",
    planLabels: [],
    activity: [],
    marks: null,
    history: [],
    banner: null,
    canUndo: false,
  };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;
  private set(patch: Partial<RunState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  startRun() {
    this.set({
      phase: "PLANNING",
      planLabels: [],
      activity: [],
      marks: null,
      banner: null,
    });
  }
  setBanner(text: string | null) {
    this.set({ banner: text });
  }
  /** Switching seeds loads a different doc — its run history/activity no longer apply. */
  resetForSeed() {
    this.set({
      phase: "IDLE",
      planLabels: [],
      activity: [],
      marks: null,
      history: [],
      banner: null,
      canUndo: false,
    });
  }

  apply(e: ServerMessage) {
    switch (e.t) {
      case "phase":
        this.set({ phase: e.phase });
        break;
      case "plan":
        this.set({ planLabels: e.steps.map((s) => s.label) });
        break;
      case "activity":
        this.set({
          activity: [
            ...this.state.activity,
            { id: e.id, text: e.text, tool: e.tool, status: e.status },
          ],
        });
        break;
      case "activity-update":
        this.set({
          activity: this.state.activity.map((a) =>
            a.id === e.id
              ? {
                  ...a,
                  text: e.text ?? a.text,
                  status: e.status ?? a.status,
                  detail: e.status === "failed" ? e.text ?? a.detail : a.detail,
                }
              : a,
          ),
        });
        break;
      case "marks":
        this.set({ marks: { image: e.image, markMap: e.markMap, at: Date.now() } });
        break;
      case "done":
        this.set({
          phase: "DONE",
          canUndo: e.toVersion > e.fromVersion,
          history: [
            ...this.state.history,
            {
              label: e.label,
              summary: e.summary,
              fromVersion: e.fromVersion,
              toVersion: e.toVersion,
              status: "done",
            },
          ],
        });
        break;
      case "escalated":
        this.set({
          phase: "ESCALATED",
          history: [
            ...this.state.history,
            {
              label: e.label,
              summary: e.reason,
              fromVersion: 0,
              toVersion: 0,
              status: "escalated",
            },
          ],
        });
        break;
      case "undone":
        this.set({ canUndo: false });
        break;
      case "rejected":
        this.set({ banner: e.reason });
        break;
    }
  }
}

export const runStore = new RunStore();

export function useRunState(): RunState {
  return useSyncExternalStore(runStore.subscribe, runStore.getState);
}
