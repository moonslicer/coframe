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
import type { DesignSystemProfile } from "../shared/design-system.js";
import type { BBox } from "./canvas-math.js";
import type { RunPhase } from "../agent/run-controller.js";
import type { ClarificationRequestMessage, ServerMessage } from "../shared/protocol.js";

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
  // One-shot resolvers drained the next time applyOps runs (server-echo sequencing).
  private opsAppliedWaiters = new Set<() => void>();
  // One-shot flag: select the node added by the NEXT applyOps that contains an `add`.
  private selectNextAddedFlag = false;

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
    // Auto-select a freshly-created node: if the create flag is set AND this echo
    // carries an `add`, select it. Runs AFTER the nodes are patched in above so the
    // SelectionLayer can resolve the new id. setSelection() notifies for us.
    if (this.selectNextAddedFlag) {
      const added = ops.find((o) => o.kind === "add");
      this.selectNextAddedFlag = false;
      if (added && added.kind === "add") {
        this.setSelection([added.node.id]);
      } else {
        this.notify();
      }
    } else {
      this.notify();
    }
    // Drain any awaiters of "the next applied ops" (setBBox -> reparent sequencing).
    if (this.opsAppliedWaiters.size) {
      const waiters = [...this.opsAppliedWaiters];
      this.opsAppliedWaiters.clear();
      for (const w of waiters) w();
    }
  }

  // A ONE-SHOT promise that resolves the next time applyOps runs (i.e. the server
  // echoed an ops-applied frame and this.version advanced). Used to await the echo
  // before sending a dependent tool call (e.g. setBBox THEN reparent) so the second
  // call's baseVersion isn't stale. CAUTION: if no echo ever arrives this never
  // resolves — callers MUST race it against a timeout (and resync on timeout).
  nextOpsApplied(): Promise<void> {
    return new Promise((resolve) => this.opsAppliedWaiters.add(resolve));
  }

  // Arm a one-shot: the next applyOps carrying an `add` selects the added node.
  selectNextAdded() {
    this.selectNextAddedFlag = true;
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

  // LOCAL preview for direct-manipulation drags: re-seed the store with overridden
  // bboxes for live feedback, WITHOUT bumping this.version. The authoritative version
  // only changes when the server echoes ops-applied on commit — a preview is purely
  // optimistic-local and must not be mistaken for an applied mutation.
  previewBboxes(overrides: Map<NodeId, BBox>) {
    const nodes = [...this.store.all().values()].map((n) =>
      overrides.has(n.id) ? { ...n, bbox: overrides.get(n.id)! } : n,
    );
    // NOTE: loadSeed resets the INTERNAL store._version to 1 — harmless because
    // sendTool's baseVersion reads docMirror.version (this.version), never
    // store.version. Do NOT wire baseVersion to store.version or drags will 400.
    this.store.loadSeed({ rootId: this.store.rootId, nodes });
    this.notify(); // deliberately does NOT touch this.version — local preview only
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
  clarification: ClarificationRequestMessage | null;
  designSystem: DesignSystemProfile | null;
  designSystemError: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

class RunStore {
  private state: RunState = {
    phase: "IDLE",
    planLabels: [],
    activity: [],
    marks: null,
    history: [],
    banner: null,
    clarification: null,
    designSystem: null,
    designSystemError: null,
    canUndo: false,
    canRedo: false,
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
      clarification: null,
      designSystemError: null,
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
      clarification: null,
      canUndo: false,
      canRedo: false,
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
        break;
      case "redone":
        break;
      case "history-state":
        this.set({ canUndo: e.canUndo, canRedo: e.canRedo });
        break;
      case "rejected":
        this.set({ banner: e.reason });
        break;
      case "clarification-request":
        this.set({
          phase: "IDLE",
          planLabels: [],
          activity: [],
          marks: null,
          banner: null,
          clarification: e,
        });
        break;
      case "design-system":
        this.set({
          designSystem: e.designSystem,
          designSystemError: e.error ?? null,
        });
        break;
    }
  }
}

export const runStore = new RunStore();

export function useRunState(): RunState {
  return useSyncExternalStore(runStore.subscribe, runStore.getState);
}

// ---------------------------------------------------------------------------
// Tool mode — which canvas tool the human has active (select / draw shapes).
// A minimal external store: the snapshot is the mode STRING itself (a stable
// primitive), so useSyncExternalStore never tears or loops.
// ---------------------------------------------------------------------------
export type ToolMode =
  | "select"
  | "clickthrough"
  | "frame"
  | "text"
  | "rect"
  | "oval"
  | "line"
  | "arrow"
  | "draw";

class ToolModeStore {
  private mode: ToolMode = "select";
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  // Snapshot getter: returns the primitive mode (stable across reads).
  getSnapshot = (): ToolMode => this.mode;
  // Plain getter for event handlers outside React.
  getToolMode = (): ToolMode => this.mode;

  setToolMode(m: ToolMode) {
    if (this.mode === m) return; // no-op on unchanged, like clearSelection
    this.mode = m;
    for (const l of this.listeners) l();
  }
}

export const toolModeStore = new ToolModeStore();

export function getToolMode(): ToolMode {
  return toolModeStore.getToolMode();
}
export function setToolMode(m: ToolMode): void {
  toolModeStore.setToolMode(m);
}

export function useToolMode(): ToolMode {
  return useSyncExternalStore(toolModeStore.subscribe, toolModeStore.getSnapshot);
}

// ---------------------------------------------------------------------------
// Play mode — the prototype RUNTIME (client-only, read-only over the mirror).
// Holds which screen is shown, the navigation stack (for `back`), the open
// overlay stack, and the set of nodes whose default `hidden` is toggled. Never
// mutates the doc or sends tools — single-writer is preserved.
// ---------------------------------------------------------------------------
export interface PlayState {
  active: boolean;
  currentScreen: NodeId | null;
  navStack: NodeId[]; // screens visited before currentScreen (back pops this)
  overlays: NodeId[]; // open overlays, bottom→top
  toggled: NodeId[]; // nodes whose `hidden` default is flipped this screen
}

const IDLE_PLAY: PlayState = {
  active: false,
  currentScreen: null,
  navStack: [],
  overlays: [],
  toggled: [],
};

class PlayStore {
  private state: PlayState = IDLE_PLAY;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): PlayState => this.state;
  private set(next: Partial<PlayState>) {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  enter(entryScreen: NodeId) {
    this.state = { active: true, currentScreen: entryScreen, navStack: [], overlays: [], toggled: [] };
    for (const l of this.listeners) l();
  }
  exit() {
    this.state = IDLE_PLAY;
    for (const l of this.listeners) l();
  }
  /** Go to a screen: remember the current one for `back`, and reset per-screen overlay/toggle state. */
  navigate(target: NodeId) {
    if (!this.state.currentScreen || target === this.state.currentScreen) {
      this.set({ overlays: [], toggled: [] });
      return;
    }
    this.set({
      currentScreen: target,
      navStack: [...this.state.navStack, this.state.currentScreen],
      overlays: [],
      toggled: [],
    });
  }
  back() {
    // An open overlay swallows back first (closes it); otherwise pop the screen stack.
    if (this.state.overlays.length) return this.closeOverlay();
    const stack = this.state.navStack;
    if (!stack.length) return;
    this.set({
      currentScreen: stack[stack.length - 1],
      navStack: stack.slice(0, -1),
      overlays: [],
      toggled: [],
    });
  }
  toggle(target: NodeId) {
    const has = this.state.toggled.includes(target);
    this.set({
      toggled: has ? this.state.toggled.filter((x) => x !== target) : [...this.state.toggled, target],
    });
  }
  openOverlay(target: NodeId) {
    if (this.state.overlays.includes(target)) return;
    this.set({ overlays: [...this.state.overlays, target] });
  }
  closeOverlay() {
    if (!this.state.overlays.length) return;
    this.set({ overlays: this.state.overlays.slice(0, -1) });
  }
}

export const playStore = new PlayStore();

export function usePlayState(): PlayState {
  return useSyncExternalStore(playStore.subscribe, playStore.getState);
}

// ---------------------------------------------------------------------------
// Form store — Play-mode VARIABLE state (field -> typed value). Like playStore it
// is client-only and read-only over the doc mirror: form values are runtime state,
// never committed, so the single-writer guarantee holds. Reset (seeded with each
// input's defaultValue) every time Play mode is entered. `{{field}}` text and input
// boxes read it back through buildSvg's play.values.
// ---------------------------------------------------------------------------
class FormStore {
  // A single object reference, REPLACED on every change so useSyncExternalStore's
  // snapshot identity is stable between renders (no tearing / infinite loop).
  private values: Record<string, string> = {};
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getValues = (): Record<string, string> => this.values;
  private notify() {
    for (const l of this.listeners) l();
  }

  /** Reset to a fresh session, seeded with any `defaultValue`s. */
  reset(defaults: Record<string, string> = {}) {
    this.values = { ...defaults };
    this.notify();
  }
  set(field: string, value: string) {
    if (this.values[field] === value) return;
    this.values = { ...this.values, [field]: value };
    this.notify();
  }
  get(field: string): string {
    return this.values[field] ?? "";
  }
}

export const formStore = new FormStore();

export function usePlayValues(): Record<string, string> {
  return useSyncExternalStore(formStore.subscribe, formStore.getValues);
}

/** Every input node in the doc, with its field default — seeds formStore on Play enter. */
export function inputDefaults(store: DocStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of store.all().values()) {
    if (n.input) out[n.input.field] = n.input.defaultValue ?? "";
  }
  return out;
}

/** Input nodes inside `rootId` that are visible in Play (respecting the hidden predicate). */
export function visibleInputs(
  store: DocStore,
  rootId: NodeId,
  isHidden: (id: NodeId) => boolean,
): Node[] {
  const out: Node[] = [];
  const walk = (id: NodeId) => {
    const n = store.getNode(id);
    if (!n) return;
    if (id !== rootId && isHidden(id)) return;
    if (n.input) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(rootId);
  return out;
}

/** Required input fields under `rootId` that are still empty — blocks a 'navigate'. */
export function missingRequired(
  store: DocStore,
  rootId: NodeId,
  isHidden: (id: NodeId) => boolean,
): Node[] {
  return visibleInputs(store, rootId, isHidden).filter(
    (n) => n.input!.required && formStore.get(n.input!.field).trim() === "",
  );
}

/** Top-level screens (direct children of root flagged `screen`), in document order. */
export function screensOf(store: DocStore): NodeId[] {
  const root = store.getNode(store.rootId);
  if (!root) return [];
  return root.children.filter((id) => store.getNode(id)?.screen);
}

/** The prototype entry point: the first screen, or null when the doc has none. */
export function entryScreen(store: DocStore): NodeId | null {
  return screensOf(store)[0] ?? null;
}
