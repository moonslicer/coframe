// The property Inspector (§5.6, Step 6): the primary DIRECT-EDIT surface. It reads
// the selected node(s) off the read-only docMirror and ships semantic tool calls
// (setBBox / setFill / setTextStyle / setText) on commit — exactly like the agent.
// Editing is LOCKED while the agent runs (runActive), mirroring the rest of the chrome.
//
// CONTROLLED-INPUT pattern: each field keeps a local draft seeded from the node, and
// commits on blur/Enter. The field group is keyed by `selectionId + ":" + version`, so
// switching selection OR an ops-applied echo (version bump) remounts the fields and
// re-seeds them from the fresh node — no stale draft, no render loop.

import { useState } from "react";
import { docMirror, useDocVersion, useRunState } from "./stores.js";
import { sendTool } from "./ws.js";
import type { Node, NodeId } from "../shared/types.js";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function Inspector() {
  useDocVersion(); // re-render on selection AND doc (version) changes
  const run = useRunState();
  const runActive =
    run.phase !== "IDLE" && run.phase !== "DONE" && run.phase !== "ESCALATED";

  const sel = docMirror.selection;
  const version = docMirror.version;

  if (sel.length === 0) {
    return <div style={hint}>No selection.</div>;
  }

  // Resolve the selected nodes off the mirror; drop any stale ids that no longer exist.
  const nodes = sel
    .map((id) => docMirror.store.getNode(id))
    .filter((n): n is Node => !!n);
  if (nodes.length === 0) {
    return <div style={hint}>No selection.</div>;
  }

  // ---- Multi-selection ----
  if (nodes.length > 1) {
    const ids = nodes.map((n) => n.id);
    const allText = nodes.every((n) => n.type === "TEXT");
    // Seed shared controls from the first node (a reasonable "representative" value).
    const first = nodes[0];
    // Key on the joined id set + version so external echoes re-seed the group.
    const groupKey = ids.join(",") + ":" + version;
    return (
      <div>
        <div style={header}>{nodes.length} selected</div>
        <div key={groupKey}>
          <FillField node={first} ids={ids} disabled={runActive} />
          {allText && <TypographyFields node={first} ids={ids} disabled={runActive} />}
        </div>
      </div>
    );
  }

  // ---- Single selection ----
  const node = nodes[0];
  const isText = node.type === "TEXT";
  // Key on id + version: a different node OR an applied edit re-seeds every field.
  const fieldKey = node.id + ":" + version;
  return (
    <div>
      <div style={header}>
        {node.name}
        <span style={{ color: "#9ca3af", fontWeight: 400 }}> · {node.type}</span>
      </div>
      <div key={fieldKey}>
        <GeometryFields node={node} disabled={runActive} />
        <FillField node={node} ids={[node.id]} disabled={runActive} />
        {isText && (
          <>
            <TextCharsField node={node} disabled={runActive} />
            <TypographyFields node={node} ids={[node.id]} disabled={runActive} />
          </>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Geometry — X / Y / W / H. Commit re-sends the FULL tuple with the one edited
// component swapped in (the other three carried from the node's current bbox).
// --------------------------------------------------------------------------
function GeometryFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const [x, y, w, h] = node.bbox;
  const commit = (i: 0 | 1 | 2 | 3, raw: string) => {
    const v = Number(raw);
    if (raw.trim() === "" || Number.isNaN(v)) return; // ignore NaN / empty
    const next: [number, number, number, number] = [...node.bbox];
    if (next[i] === v) return; // no-op if unchanged
    next[i] = v;
    sendTool("setBBox", { id: node.id, bbox: next });
  };
  return (
    <Row label="Geometry">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <NumField label="X" initial={x} disabled={disabled} onCommit={(r) => commit(0, r)} />
        <NumField label="Y" initial={y} disabled={disabled} onCommit={(r) => commit(1, r)} />
        <NumField label="W" initial={w} disabled={disabled} onCommit={(r) => commit(2, r)} />
        <NumField label="H" initial={h} disabled={disabled} onCommit={(r) => commit(3, r)} />
      </div>
    </Row>
  );
}

// --------------------------------------------------------------------------
// Fill — hex text + color swatch. Validates /^#[0-9a-fA-F]{6}$/ before sending.
// --------------------------------------------------------------------------
function FillField({
  node,
  ids,
  disabled,
}: {
  node: Node;
  ids: NodeId[];
  disabled: boolean;
}) {
  const current = node.style?.fills?.[0]?.color ?? "#000000";
  const [draft, setDraft] = useState(current);

  const commit = (val: string) => {
    if (!HEX_RE.test(val)) return; // ignore invalid hex
    if (val.toLowerCase() === current.toLowerCase()) return;
    sendTool("setFill", { ids, color: val });
  };

  return (
    <Row label="Fill">
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="color"
          value={HEX_RE.test(draft) ? draft : "#000000"}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          style={{
            width: 28,
            height: 28,
            padding: 0,
            border: "1px solid #d1d5db",
            borderRadius: 6,
            background: disabled ? "#f3f4f6" : "#fff",
            cursor: disabled ? "default" : "pointer",
          }}
        />
        <input
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="#000000"
          style={{ ...input, flex: 1 }}
        />
      </div>
    </Row>
  );
}

// --------------------------------------------------------------------------
// Text content (chars) — single TEXT node only.
// --------------------------------------------------------------------------
function TextCharsField({ node, disabled }: { node: Node; disabled: boolean }) {
  const current = node.text?.chars ?? "";
  const [draft, setDraft] = useState(current);
  const commit = (val: string) => {
    if (val === current) return;
    sendTool("setText", { id: node.id, chars: val });
  };
  return (
    <Row label="Text">
      <input
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{ ...input, width: "100%" }}
      />
    </Row>
  );
}

// --------------------------------------------------------------------------
// Typography — font size / weight / align. Each commits ONLY its own field.
// --------------------------------------------------------------------------
function TypographyFields({
  node,
  ids,
  disabled,
}: {
  node: Node;
  ids: NodeId[];
  disabled: boolean;
}) {
  const t = node.text;
  const size = t?.fontSize ?? 16;
  const weight = t?.fontWeight ?? 400;
  const align = t?.align ?? "LEFT";

  const commitSize = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() === "" || Number.isNaN(v) || v === size) return;
    sendTool("setTextStyle", { ids, fontSize: v });
  };
  const commitWeight = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() === "" || Number.isNaN(v) || v === weight) return;
    sendTool("setTextStyle", { ids, fontWeight: v });
  };

  return (
    <>
      <Row label="Font">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <NumField label="Size" initial={size} disabled={disabled} onCommit={commitSize} />
          <NumField label="Weight" initial={weight} disabled={disabled} onCommit={commitWeight} />
        </div>
      </Row>
      <Row label="Align">
        <select
          value={align}
          disabled={disabled}
          onChange={(e) => {
            const v = e.target.value as "LEFT" | "CENTER" | "RIGHT";
            if (v !== align) sendTool("setTextStyle", { ids, align: v });
          }}
          style={{ ...input, width: "100%", cursor: disabled ? "default" : "pointer" }}
        >
          <option value="LEFT">Left</option>
          <option value="CENTER">Center</option>
          <option value="RIGHT">Right</option>
        </select>
      </Row>
    </>
  );
}

// --------------------------------------------------------------------------
// Small primitives.
// --------------------------------------------------------------------------
function NumField({
  label,
  initial,
  disabled,
  onCommit,
}: {
  label: string;
  initial: number;
  disabled: boolean;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(String(Math.round(initial * 100) / 100));
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <span style={{ width: 16, color: "#9ca3af", fontSize: 11 }}>{label}</span>
      <input
        type="number"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{ ...input, width: "100%", minWidth: 0 }}
      />
    </label>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "#6b7280",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

const input: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid #d1d5db",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const header: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "#111",
  marginBottom: 10,
};

const hint: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: 13,
};
