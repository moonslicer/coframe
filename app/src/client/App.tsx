// The app shell (§5.6): a thin, deterministic React front-end over the read-only
// mirror. It never calls the Anthropic API and never mutates the doc directly —
// it ships prompts/undo over the WS and renders the two stores. Two stores, never
// conflated: the renderer subscribes to docMirror, the chrome to runStore.

import { useEffect, useRef, useState } from "react";
import {
  CircleCheck,
  CircleX,
  Link2,
  Loader2,
  MessageCircleQuestion,
  Palette,
  Play,
  Redo2,
  SendHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { Canvas } from "./Canvas.js";
import { Toolbar } from "./Toolbar.js";
import { Inspector } from "./Inspector.js";
import { TreeView } from "./TreeView.js";
import { PlayMode } from "./PlayMode.js";
import { docMirror, entryScreen, playStore, useDocVersion, useRunState } from "./stores.js";
import type { ActivityEntry } from "./stores.js";
import { connect, send } from "./ws.js";
import { SEEDS, SEED_PROMPTS } from "../shared/seed.js";

export function App() {
  const run = useRunState();
  useDocVersion(); // keep the shell live to selection + active-seed changes in the mirror
  const [text, setText] = useState("");

  // Chips come from the single SEED_PROMPTS source, keyed by the active seed.
  const activeSeed = docMirror.seedDocId;
  const SUGGESTIONS = SEED_PROMPTS[activeSeed] ?? [];

  // Open the socket once.
  useEffect(() => {
    connect();
  }, []);

  const runActive =
    run.phase !== "IDLE" && run.phase !== "DONE" && run.phase !== "ESCALATED";

  // The prototype is playable once at least one screen exists. (Reads the live mirror;
  // useDocVersion above keeps this fresh as the agent adds screens.)
  const playEntry = entryScreen(docMirror.store);

  // Cmd-Z / Ctrl-Z undo; Cmd-Shift-Z / Ctrl-Shift-Z and Ctrl-Y redo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) {
          if (!runActive && run.canRedo) send({ t: "redo" });
        } else if (!runActive && run.canUndo) {
          send({ t: "undo" });
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        if (!runActive && run.canRedo) send({ t: "redo" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runActive, run.canUndo, run.canRedo]);

  function submit(prompt: string) {
    const t = prompt.trim();
    if (!t || runActive) return;
    if (run.clarification) {
      send({
        t: "clarification-answer",
        original: run.clarification.original,
        answers: t,
        selection: docMirror.selection,
      });
    } else {
      send({ t: "prompt", text: t, selection: docMirror.selection });
    }
    setText("");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Sparkles size={16} strokeWidth={2.2} />
          </span>
          <div className="brand-copy">
            <strong>Canvas Agent</strong>
            <span>Prompt-driven design studio</span>
          </div>
        </div>
        <select
          className="seed-select"
          aria-label="Seed document"
          value={activeSeed}
          onChange={(e) => send({ t: "loadSeed", seedDocId: e.target.value })}
          disabled={runActive}
        >
          {Object.keys(SEEDS).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <PhaseBadge phase={run.phase} />
        {run.banner && (
          <span className="run-banner">{run.banner}</span>
        )}
        <div className="topbar-actions">
          <button
            className="play-action"
            onClick={() => playEntry && playStore.enter(playEntry)}
            disabled={runActive || !playEntry}
            title={playEntry ? "Play prototype" : "Add screens to play"}
            aria-label="Play prototype"
          >
            <Play size={15} />
            <span>Play</span>
          </button>
          <button
            className="icon-button"
            onClick={() => send({ t: "undo" })}
            disabled={runActive || !run.canUndo}
            title="Undo"
            aria-label="Undo"
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            onClick={() => send({ t: "redo" })}
            disabled={runActive || !run.canRedo}
            title="Redo"
            aria-label="Redo"
          >
            <Redo2 size={16} />
          </button>
        </div>
      </header>

      <main className="canvas-area">
        <Canvas />
        <div className="toolbar-dock">
          <Toolbar />
        </div>
      </main>

      <aside className="side-panel">
        <Section title="Layers">
          <TreeView />
        </Section>
        <Section title="Properties">
          <Inspector />
        </Section>
        <Section title="Design System">
          <DesignSystemPanel
            profile={run.designSystem}
            error={run.designSystemError}
            runActive={runActive}
          />
        </Section>
        <Section title="Activity">
          <ActivityLog activity={run.activity} phase={run.phase} />
        </Section>
        <Section title="History" grow>
          <History history={run.history} />
        </Section>
      </aside>

      <footer className="prompt-dock">
        <SelectionChips runActive={runActive} />
        {run.clarification && (
          <ClarificationCard
            questions={run.clarification.questions}
            assumptions={run.clarification.assumptions}
            onUseAssumptions={() => submit(run.clarification!.assumptions.join(" "))}
          />
        )}
        <div className="suggestion-row">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="suggestion-chip"
              onClick={() => submit(s)}
              disabled={runActive}
              title={s}
            >
              {s}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
          className="prompt-form"
        >
          <input
            className="prompt-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              run.clarification
                ? "Answer the design questions…"
                : docMirror.selection.length
                ? `${docMirror.selection.length} selected — describe the edit…`
                : "Describe the design edit…"
            }
            disabled={runActive}
          />
          <button
            className="primary-action"
            type="submit"
            disabled={runActive || !text.trim()}
          >
            {runActive ? <Loader2 size={16} className="spin" /> : <SendHorizontal size={16} />}
            <span>{runActive ? "Running" : "Send"}</span>
          </button>
        </form>
      </footer>

      {/* Prototype runtime — a full-bleed overlay; renders nothing unless playing. */}
      <PlayMode />
    </div>
  );
}

function DesignSystemPanel({
  profile,
  error,
  runActive,
}: {
  profile: ReturnType<typeof useRunState>["designSystem"];
  error: string | null;
  runActive: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sourceUrl, setSourceUrl] = useState("");

  function importUrl() {
    const url = sourceUrl.trim();
    if (!url || runActive) return;
    send({ t: "importDesignSystem", sourceUrl: url, sourceName: url });
  }

  async function importFile(file: File) {
    const html = await file.text();
    send({ t: "importDesignSystem", html, sourceName: file.name });
  }

  return (
    <div className="design-system-panel">
      <div className="ds-import-row">
        <input
          className="ds-url-input"
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") importUrl();
          }}
          placeholder="file:///path/to/your-design-system.html"
          disabled={runActive}
          aria-label="Design system file URL"
        />
        <button
          className="icon-button ds-mini-action"
          type="button"
          onClick={importUrl}
          disabled={runActive || !sourceUrl.trim()}
          title="Import from URL"
          aria-label="Import from URL"
        >
          <Link2 size={15} />
        </button>
        <button
          className="icon-button ds-mini-action"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={runActive}
          title="Import HTML file"
          aria-label="Import HTML file"
        >
          <Upload size={15} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".html,text/html"
          hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>

      {error && <div className="ds-error">{error}</div>}

      {!profile ? (
        <div className="empty-state">No design system imported.</div>
      ) : (
        <div className="ds-summary">
          <div className="ds-summary-head">
            <span className="ds-summary-icon">
              <Palette size={15} />
            </span>
            <div className="ds-title-block">
              <strong>{profile.name}</strong>
              <span title={profile.source}>{profile.source}</span>
            </div>
            <button
              className="icon-button ds-mini-action"
              type="button"
              onClick={() => send({ t: "clearDesignSystem" })}
              disabled={runActive}
              title="Clear design system"
              aria-label="Clear design system"
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div className="ds-swatch-row">
            {profile.colors.slice(0, 10).map((c) => (
              <span
                key={c.value}
                className="ds-swatch"
                style={{ background: c.value }}
                title={`${c.name} ${c.value}`}
              />
            ))}
          </div>

          <div className="ds-facts">
            {profile.fonts.length > 0 && (
              <div>
                <span>Type</span>
                <strong>{profile.fonts.slice(0, 2).join(", ")}</strong>
              </div>
            )}
            {profile.radii.length > 0 && (
              <div>
                <span>Radii</span>
                <strong>{profile.radii.slice(0, 3).join(", ")}</strong>
              </div>
            )}
            {profile.spacing.length > 0 && (
              <div>
                <span>Space</span>
                <strong>{profile.spacing.slice(0, 4).join(", ")}</strong>
              </div>
            )}
          </div>

          <div className="ds-component-row">
            {profile.components.slice(0, 8).map((c) => (
              <span key={c.kind} className="ds-component-chip" title={c.details.join(" ")}>
                {c.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClarificationCard({
  questions,
  assumptions,
  onUseAssumptions,
}: {
  questions: string[];
  assumptions: string[];
  onUseAssumptions: () => void;
}) {
  return (
    <div className="clarification-card">
      <div className="clarification-title">
        <MessageCircleQuestion size={15} />
        <span>A little direction first</span>
      </div>
      <ol className="clarification-list">
        {questions.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ol>
      <button
        className="clarification-assume"
        type="button"
        onClick={onUseAssumptions}
        title={assumptions.join(" ")}
      >
        Use smart assumptions
      </button>
    </div>
  );
}

// A subtle chip row showing the resolved selection (names) the agent will target —
// so the viewer sees exactly which nodes the next prompt is scoped to (F9).
function SelectionChips({ runActive }: { runActive: boolean }) {
  const sel = docMirror.selection;
  if (runActive || sel.length === 0) return null;
  const names = sel.map(
    (id) => docMirror.store.getNode(id)?.name ?? id,
  );
  return (
    <div className="selection-row">
      <span className="selection-label">
        Targeting {sel.length}:
      </span>
      {names.map((n, i) => (
        <span key={i} className="selection-chip">
          {n}
        </span>
      ))}
      <button
        className="chip-clear"
        onClick={() => {
          docMirror.setSelection([]);
          send({ t: "select", ids: [] });
        }}
      >
        Clear
      </button>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  const active = phase !== "IDLE" && phase !== "DONE" && phase !== "ESCALATED";
  return (
    <span className={`phase-badge phase-${phase.toLowerCase()}`}>
      {active && <span className="pulse-dot" />} {phase.toLowerCase()}
    </span>
  );
}

function Section({
  title,
  children,
  grow,
}: {
  title: string;
  children: React.ReactNode;
  grow?: boolean;
}) {
  return (
    <div className={`panel-section${grow ? " panel-section-grow" : ""}`}>
      <div className="panel-title">{title}</div>
      <div className="panel-body">
        {children}
      </div>
    </div>
  );
}

function ActivityLog({
  activity,
  phase,
}: {
  activity: ActivityEntry[];
  phase: string;
}) {
  const endRef = useRef<HTMLLIElement>(null);
  // Auto-scroll to the newest line as the run streams.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [activity.length, activity[activity.length - 1]?.status]);

  if (!activity.length && phase === "IDLE")
    return <div className="empty-state">No run yet.</div>;
  if (!activity.length && phase === "PLANNING")
    return (
      <ul className="activity-list">
        <li className="activity-item">
          <span className="pulse-dot" /> Planning…
        </li>
      </ul>
    );
  return (
    <ul className="activity-list">
      {activity.map((a) => (
        <li
          key={a.id}
          className={`activity-item activity-${a.status}`}
        >
          <StatusIcon status={a.status} />
          <span>
            {a.text}
            {a.status === "failed" && a.detail && (
              <span className="activity-detail"> — couldn’t ({a.detail})</span>
            )}
          </span>
        </li>
      ))}
      <li ref={endRef} aria-hidden style={{ height: 0 }} />
    </ul>
  );
}

function StatusIcon({ status }: { status: ActivityEntry["status"] }) {
  if (status === "ok")
    return <CircleCheck className="status-icon status-ok" size={14} />;
  if (status === "failed")
    return <CircleX className="status-icon status-failed" size={14} />;
  return <span className="pulse-dot" style={{ marginTop: 5 }} />;
}

function History({ history }: { history: ReturnType<typeof useRunState>["history"] }) {
  if (!history.length)
    return <div className="empty-state">No runs yet.</div>;
  return (
    <ul className="history-list">
      {history
        .slice()
        .reverse()
        .map((h, i) => (
          <li
            key={i}
            className={`history-card history-${h.status}`}
          >
            <div className="history-title">
              {h.status === "escalated" ? "Couldn’t complete" : "Agent: design edit"}
            </div>
            <div className="history-summary">{h.summary}</div>
            {h.status === "done" && (
              <div className="history-meta">
                v{h.fromVersion} → v{h.toVersion} · ⌘Z to revert
              </div>
            )}
          </li>
        ))}
    </ul>
  );
}
