// The app shell (§5.6): a thin, deterministic React front-end over the read-only
// mirror. It never calls the Anthropic API and never mutates the doc directly —
// it ships prompts/undo over the WS and renders the two stores. Two stores, never
// conflated: the renderer subscribes to docMirror, the chrome to runStore.

import { useEffect, useRef, useState } from "react";
import { Canvas } from "./Canvas.js";
import { docMirror, useDocVersion, useRunState } from "./stores.js";
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

  // Cmd-Z / Ctrl-Z -> one-key undo (mic drop). One level; a second is a no-op.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!runActive && run.canUndo) send({ t: "undo" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runActive, run.canUndo]);

  function submit(prompt: string) {
    const t = prompt.trim();
    if (!t || runActive) return;
    send({ t: "prompt", text: t, selection: docMirror.selection });
    setText("");
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateColumns: "1fr 340px",
        gridTemplateRows: "auto 1fr auto",
        gridTemplateAreas: `"header header" "canvas side" "prompt side"`,
        fontFamily: "Inter, system-ui, sans-serif",
        background: "#f3f4f6",
      }}
    >
      <header
        style={{
          gridArea: "header",
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 16px",
          borderBottom: "1px solid #e5e7eb",
          background: "#fff",
        }}
      >
        <strong>Canvas Agent</strong>
        <select
          value={activeSeed}
          onChange={(e) => send({ t: "loadSeed", seedDocId: e.target.value })}
          disabled={runActive}
          style={{
            fontSize: 13,
            padding: "4px 8px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: runActive ? "#f3f4f6" : "#fff",
            color: "#111",
            cursor: runActive ? "default" : "pointer",
          }}
        >
          {Object.keys(SEEDS).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <PhaseBadge phase={run.phase} />
        {run.banner && (
          <span style={{ color: "#b45309", fontSize: 13 }}>{run.banner}</span>
        )}
        <button
          onClick={() => send({ t: "undo" })}
          disabled={runActive || !run.canUndo}
          style={{
            marginLeft: "auto",
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid #d1d5db",
            background: !runActive && run.canUndo ? "#fff" : "#f3f4f6",
            color: !runActive && run.canUndo ? "#111" : "#9ca3af",
            cursor: !runActive && run.canUndo ? "pointer" : "default",
            fontSize: 13,
          }}
        >
          Undo run (⌘Z)
        </button>
      </header>

      <main style={{ gridArea: "canvas", minHeight: 0, position: "relative" }}>
        <Canvas />
      </main>

      <aside
        style={{
          gridArea: "side",
          borderLeft: "1px solid #e5e7eb",
          background: "#fff",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <Section title="Activity">
          <ActivityLog activity={run.activity} phase={run.phase} />
        </Section>
        <Section title="History" grow>
          <History history={run.history} />
        </Section>
      </aside>

      <footer
        style={{
          gridArea: "prompt",
          borderTop: "1px solid #e5e7eb",
          background: "#fff",
          padding: 12,
        }}
      >
        <SelectionChips runActive={runActive} />
        <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => submit(s)}
              disabled={runActive}
              title={s}
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 999,
                border: "1px solid #ddd6fe",
                background: runActive ? "#f3f4f6" : "#f5f3ff",
                color: runActive ? "#9ca3af" : "#5b21b6",
                cursor: runActive ? "default" : "pointer",
                maxWidth: 320,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
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
          style={{ display: "flex", gap: 8 }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              docMirror.selection.length
                ? `${docMirror.selection.length} selected — describe the edit…`
                : "Describe the design edit…"
            }
            disabled={runActive}
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              fontSize: 14,
              fontFamily: "inherit",
            }}
          />
          <button
            type="submit"
            disabled={runActive || !text.trim()}
            style={{
              padding: "10px 18px",
              borderRadius: 8,
              border: "none",
              background: runActive || !text.trim() ? "#c4b5fd" : "#7c3aed",
              color: "#fff",
              fontWeight: 600,
              cursor: runActive || !text.trim() ? "default" : "pointer",
            }}
          >
            {runActive ? "Running…" : "Send"}
          </button>
        </form>
      </footer>
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 8,
        flexWrap: "wrap",
        fontSize: 12,
      }}
    >
      <span style={{ color: "#6b7280", fontWeight: 600 }}>
        Targeting {sel.length}:
      </span>
      {names.map((n, i) => (
        <span
          key={i}
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "#eff6ff",
            color: "#1d4ed8",
            border: "1px solid #bfdbfe",
          }}
        >
          {n}
        </span>
      ))}
      <button
        onClick={() => {
          docMirror.setSelection([]);
          send({ t: "select", ids: [] });
        }}
        style={{
          marginLeft: 2,
          padding: "2px 8px",
          borderRadius: 999,
          border: "1px solid #e5e7eb",
          background: "#fff",
          color: "#6b7280",
          cursor: "pointer",
        }}
      >
        Clear
      </button>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: string }) {
  const active = phase !== "IDLE" && phase !== "DONE" && phase !== "ESCALATED";
  const color =
    phase === "ESCALATED" ? "#b91c1c" : phase === "DONE" ? "#15803d" : "#6d28d9";
  return (
    <span
      style={{
        fontSize: 12,
        padding: "2px 8px",
        borderRadius: 999,
        background: "#f5f3ff",
        color,
        fontWeight: 600,
      }}
    >
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: grow ? 1 : "none",
        minHeight: 0,
        borderBottom: grow ? "none" : "1px solid #f3f4f6",
      }}
    >
      <div
        style={{
          padding: "10px 14px 6px",
          fontSize: 12,
          fontWeight: 700,
          color: "#6b7280",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      <div style={{ overflow: "auto", padding: "0 14px 12px", flex: grow ? 1 : "none" }}>
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
    return <div style={{ color: "#9ca3af", fontSize: 13 }}>No run yet.</div>;
  if (!activity.length && phase === "PLANNING")
    return (
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        <li
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 0",
            fontSize: 13,
          }}
        >
          <span className="pulse-dot" /> Planning…
        </li>
      </ul>
    );
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {activity.map((a) => (
        <li
          key={a.id}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "4px 0",
            fontSize: 13,
            color: a.status === "failed" ? "#b91c1c" : "#111",
          }}
        >
          <StatusIcon status={a.status} />
          <span>
            {a.text}
            {a.status === "failed" && a.detail && (
              <span style={{ color: "#b91c1c" }}> — couldn’t ({a.detail})</span>
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
    return <span style={{ color: "#15803d", width: 14 }}>✓</span>;
  if (status === "failed")
    return <span style={{ color: "#b91c1c", width: 14 }}>✕</span>;
  return <span className="pulse-dot" style={{ marginTop: 5 }} />;
}

function History({ history }: { history: ReturnType<typeof useRunState>["history"] }) {
  if (!history.length)
    return <div style={{ color: "#9ca3af", fontSize: 13 }}>No runs yet.</div>;
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {history
        .slice()
        .reverse()
        .map((h, i) => (
          <li
            key={i}
            style={{
              padding: "8px 10px",
              marginBottom: 6,
              borderRadius: 8,
              border: "1px solid #e5e7eb",
              background: h.status === "escalated" ? "#fef2f2" : "#f8fafc",
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600 }}>
              {h.status === "escalated" ? "Couldn’t complete" : "Agent: design edit"}
            </div>
            <div style={{ color: "#6b7280", marginTop: 2 }}>{h.summary}</div>
            {h.status === "done" && (
              <div style={{ color: "#9ca3af", fontSize: 11, marginTop: 2 }}>
                v{h.fromVersion} → v{h.toVersion} · ⌘Z to revert
              </div>
            )}
          </li>
        ))}
    </ul>
  );
}
