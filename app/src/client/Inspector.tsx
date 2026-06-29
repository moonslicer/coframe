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
import { paintColor } from "../shared/types.js";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
type InspectorTier = "simple" | "pro" | "code";

export function Inspector() {
  useDocVersion(); // re-render on selection AND doc (version) changes
  const [tier, setTier] = useState<InspectorTier>("simple");
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
        <GroupActions kind="group" ids={ids} disabled={runActive} />
        <TierTabs tier={tier} setTier={setTier} />
        <div key={groupKey}>
          {tier === "code" ? (
            <div style={hint}>Code editing is available for a single selected node.</div>
          ) : (
            <>
              <FillField node={first} ids={ids} disabled={runActive} />
              {allText && <TypographyFields node={first} ids={ids} disabled={runActive} />}
            </>
          )}
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
      <TierTabs tier={tier} setTier={setTier} />
      <div key={fieldKey}>
        {tier === "code" ? (
          <CodeFields node={node} disabled={runActive} />
        ) : (
          <>
            {node.type === "GROUP" && <GroupActions kind="ungroup" ids={[node.id]} disabled={runActive} />}
            <GeometryFields node={node} disabled={runActive} />
            {(node.type === "FRAME" || node.type === "GROUP") && (
              <AutoLayoutFields node={node} disabled={runActive} />
            )}
            <FillField node={node} ids={[node.id]} disabled={runActive} />
            {isText && (
              <>
                <TextCharsField node={node} disabled={runActive} />
                <TypographyFields node={node} ids={[node.id]} disabled={runActive} />
              </>
            )}
            {tier === "pro" && (
              <>
                <StrokeField node={node} disabled={runActive} />
                <AppearanceFields node={node} disabled={runActive} />
                <LayoutFields node={node} disabled={runActive} />
                <SelfLayoutFields node={node} disabled={runActive} />
                {node.type === "VECTOR" && <VectorFields node={node} disabled={runActive} />}
                <DebugFields node={node} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TierTabs({
  tier,
  setTier,
}: {
  tier: InspectorTier;
  setTier: (tier: InspectorTier) => void;
}) {
  const tiers: InspectorTier[] = ["simple", "pro", "code"];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 10 }}>
      {tiers.map((t) => {
        const active = tier === t;
        return (
          <button
            key={t}
            onClick={() => setTier(t)}
            style={{
              ...tabButton,
              background: active ? "var(--text)" : "#fff",
              color: active ? "#fff" : "var(--muted)",
              borderColor: active ? "var(--text)" : "var(--border)",
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        );
      })}
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
  const current = node.type === "VECTOR" ? node.vector?.fill ?? "#000000" : paintColor(node.style?.fills?.[0]) ?? "#000000";
  const [draft, setDraft] = useState(current);

  const commit = (val: string) => {
    if (!HEX_RE.test(val)) return; // ignore invalid hex
    if (val.toLowerCase() === current.toLowerCase()) return;
    if (node.type === "VECTOR" && ids.length === 1) {
      sendTool("setProps", { id: node.id, patch: { "vector.fill": val } });
    } else {
      sendTool("setFill", { ids, color: val });
    }
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
            const v = e.target.value as "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
            if (v !== align) sendTool("setTextStyle", { ids, align: v });
          }}
          style={{ ...input, width: "100%", cursor: disabled ? "default" : "pointer" }}
        >
          <option value="LEFT">Left</option>
          <option value="CENTER">Center</option>
          <option value="RIGHT">Right</option>
          <option value="JUSTIFY">Justify</option>
        </select>
      </Row>
    </>
  );
}

function StrokeField({ node, disabled }: { node: Node; disabled: boolean }) {
  const isVector = node.type === "VECTOR";
  const currentColor = isVector ? node.vector?.stroke ?? "#8A8378" : node.style?.stroke?.color ?? "#000000";
  const currentWidth = isVector ? node.vector?.strokeWidth ?? 4 : node.style?.stroke?.weight ?? 1;
  const currentStyle = node.style?.stroke?.style ?? "solid";
  const [colorDraft, setColorDraft] = useState(currentColor);

  const commitColor = (val: string) => {
    if (!HEX_RE.test(val) || val.toLowerCase() === currentColor.toLowerCase()) return;
    if (isVector) sendTool("setProps", { id: node.id, patch: { "vector.stroke": val } });
    else
      sendTool("setProps", {
        id: node.id,
        patch: { "style.stroke": { ...(node.style?.stroke ?? {}), color: val, weight: currentWidth, style: currentStyle } },
      });
  };
  const commitWidth = (raw: string) => {
    const v = Number(raw);
    if (raw.trim() === "" || Number.isNaN(v) || v === currentWidth) return;
    if (isVector) sendTool("setProps", { id: node.id, patch: { "vector.strokeWidth": v } });
    else
      sendTool("setProps", {
        id: node.id,
        patch: { "style.stroke": { ...(node.style?.stroke ?? {}), color: currentColor, weight: v, style: currentStyle } },
      });
  };

  return (
    <Row label={isVector ? "Stroke" : "Border"}>
      <div style={{ display: "grid", gridTemplateColumns: "28px 1fr 72px", gap: 6 }}>
        <input
          type="color"
          value={HEX_RE.test(colorDraft) ? colorDraft : "#000000"}
          disabled={disabled}
          onChange={(e) => {
            setColorDraft(e.target.value);
            commitColor(e.target.value);
          }}
          style={{ width: 28, height: 28, padding: 0, border: "1px solid #d1d5db", borderRadius: 6 }}
        />
        <input
          type="text"
          value={colorDraft}
          disabled={disabled}
          onChange={(e) => setColorDraft(e.target.value)}
          onBlur={(e) => commitColor(e.target.value)}
          style={{ ...input, minWidth: 0 }}
        />
        <NumField label="W" initial={currentWidth} disabled={disabled} onCommit={commitWidth} />
      </div>
      {!isVector && (
        <select
          value={currentStyle}
          disabled={disabled}
          onChange={(e) =>
            sendTool("setProps", {
              id: node.id,
              patch: {
                "style.stroke": {
                  ...(node.style?.stroke ?? {}),
                  color: currentColor,
                  weight: currentWidth,
                  style: e.target.value,
                },
              },
            })
          }
          style={{ ...input, width: "100%", marginTop: 6 }}
        >
          <option value="none">None</option>
          <option value="solid">Solid</option>
          <option value="dashed">Dashed</option>
          <option value="dotted">Dotted</option>
          <option value="double">Double</option>
        </select>
      )}
    </Row>
  );
}

function AppearanceFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const radius = node.style?.cornerRadius ?? 0;
  const opacityValue = node.style?.opacity ?? 1;
  const overflow = node.style?.overflow ?? "visible";
  return (
    <Row label="Appearance">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
        <NumField
          label="R"
          initial={radius}
          disabled={disabled}
          onCommit={(raw) => {
            const v = Number(raw);
            if (raw.trim() !== "" && !Number.isNaN(v) && v !== radius)
              sendTool("setProps", { id: node.id, patch: { "style.cornerRadius": v } });
          }}
        />
        <NumField
          label="O"
          initial={opacityValue}
          disabled={disabled}
          onCommit={(raw) => {
            const v = Number(raw);
            if (raw.trim() !== "" && !Number.isNaN(v) && v !== opacityValue)
              sendTool("setProps", { id: node.id, patch: { "style.opacity": Math.max(0, Math.min(1, v)) } });
          }}
        />
      </div>
      <select
        value={overflow}
        disabled={disabled}
        onChange={(e) => sendTool("setProps", { id: node.id, patch: { "style.overflow": e.target.value } })}
        style={{ ...input, width: "100%" }}
      >
        <option value="visible">Visible</option>
        <option value="hidden">Hidden</option>
        <option value="auto">Auto</option>
        <option value="scroll">Scroll</option>
      </select>
    </Row>
  );
}

// Group a multi-selection into a GROUP, or dissolve a selected GROUP. The button row
// mirrors the ⌘G / ⌘⇧G canvas shortcuts so the action is discoverable in the panel.
function GroupActions({
  kind,
  ids,
  disabled,
}: {
  kind: "group" | "ungroup";
  ids: NodeId[];
  disabled: boolean;
}) {
  return (
    <Row label={kind === "group" ? "Group" : "Group"}>
      {kind === "group" ? (
        <button
          disabled={disabled}
          onClick={() => sendTool("groupNodes", { ids })}
          style={{ ...tabButton, width: "100%", borderColor: "var(--border)" }}
        >
          Group selection ⌘G
        </button>
      ) : (
        <button
          disabled={disabled}
          onClick={() => sendTool("ungroupNodes", { id: ids[0] })}
          style={{ ...tabButton, width: "100%", borderColor: "var(--border)" }}
        >
          Ungroup ⌘⇧G
        </button>
      )}
    </Row>
  );
}

// Auto-layout (baked): pick a direction + distribution and the children re-flow into
// absolute positions via applyAutoLayout. Each control re-bakes immediately, reading the
// node's current layout so unrelated settings persist. Children stay freely draggable.
function AutoLayoutFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const L = node.layout;
  const mode = L?.mode ?? "NONE";
  const dir: "H" | "V" = mode === "VERTICAL" ? "V" : "H";
  const gap = L?.gap ?? 16;
  const padding = L?.padding ?? 24;
  const align = L?.align ?? "START";
  const justify = L?.justify ?? "START";
  const noKids = node.children.length === 0;
  const off = disabled || noKids;

  // Re-bake with the current settings, overriding just the changed field.
  const reflow = (patch: Partial<{ dir: "H" | "V"; gap: number; padding: number; align: string; justify: string }>) => {
    sendTool("applyAutoLayout", {
      frame: node.id,
      dir: patch.dir ?? dir,
      gap: patch.gap ?? gap,
      padding: patch.padding ?? padding,
      align: patch.align ?? align,
      justify: patch.justify ?? justify,
    });
  };

  return (
    <Row label="Auto Layout">
      {noKids && <div style={{ ...hint, marginBottom: 6 }}>Add children to lay out.</div>}
      {/* Direction: None keeps positions; Row / Column re-flow the children. */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 6 }}>
        {(["NONE", "H", "V"] as const).map((d) => {
          const active = d === "NONE" ? mode === "NONE" : dir === d && mode !== "NONE";
          return (
            <button
              key={d}
              disabled={disabled || (d !== "NONE" && noKids)}
              onClick={() => {
                if (d === "NONE") sendTool("setProps", { id: node.id, patch: { "layout.mode": "NONE" } });
                else reflow({ dir: d });
              }}
              style={{
                ...tabButton,
                background: active ? "var(--text)" : "#fff",
                color: active ? "#fff" : "var(--muted)",
                borderColor: active ? "var(--text)" : "var(--border)",
              }}
            >
              {d === "NONE" ? "None" : d === "H" ? "Row" : "Column"}
            </button>
          );
        })}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
        <select
          value={justify}
          disabled={off}
          onChange={(e) => reflow({ justify: e.target.value })}
          style={{ ...input, width: "100%" }}
          title="Distribute along the main axis (justify-content)"
        >
          <option value="START">Justify: Start</option>
          <option value="CENTER">Justify: Center</option>
          <option value="END">Justify: End</option>
          <option value="SPACE_BETWEEN">Space between</option>
          <option value="SPACE_AROUND">Space around</option>
        </select>
        <select
          value={align}
          disabled={off}
          onChange={(e) => reflow({ align: e.target.value })}
          style={{ ...input, width: "100%" }}
          title="Cross-axis alignment (align-items)"
        >
          <option value="START">Align: Start</option>
          <option value="CENTER">Align: Center</option>
          <option value="END">Align: End</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <NumField label="Gap" initial={gap} disabled={off} onCommit={(r) => {
          const v = Number(r);
          if (r.trim() !== "" && !Number.isNaN(v) && v !== gap) reflow({ gap: v });
        }} />
        <NumField label="Pad" initial={padding} disabled={off} onCommit={(r) => {
          const v = Number(r);
          if (r.trim() !== "" && !Number.isNaN(v) && v !== padding) reflow({ padding: v });
        }} />
      </div>
    </Row>
  );
}

function LayoutFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const display = node.layout?.display ?? (node.type === "FRAME" ? "flex" : "block");
  const mode = node.layout?.mode ?? "NONE";
  const gap = node.layout?.gap ?? 0;
  const padding = node.layout?.padding ?? 0;
  return (
    <>
      <Row label="Contents Layout">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <select
            value={display}
            disabled={disabled}
            onChange={(e) => sendTool("setProps", { id: node.id, patch: { "layout.display": e.target.value } })}
            style={{ ...input, width: "100%" }}
          >
            <option value="block">Block</option>
            <option value="flex">Flex</option>
            <option value="grid">Grid</option>
            <option value="inline-block">Inline-block</option>
            <option value="inline">Inline</option>
            <option value="none">None</option>
          </select>
          <select
            value={mode}
            disabled={disabled}
            onChange={(e) => sendTool("setProps", { id: node.id, patch: { "layout.mode": e.target.value } })}
            style={{ ...input, width: "100%" }}
          >
            <option value="NONE">None</option>
            <option value="HORIZONTAL">Row</option>
            <option value="VERTICAL">Column</option>
          </select>
        </div>
      </Row>
      <Row label="Spacing">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <NumField
            label="G"
            initial={gap}
            disabled={disabled}
            onCommit={(raw) => {
              const v = Number(raw);
              if (raw.trim() !== "" && !Number.isNaN(v) && v !== gap)
                sendTool("setProps", { id: node.id, patch: { "layout.gap": v } });
            }}
          />
          <NumField
            label="P"
            initial={padding}
            disabled={disabled}
            onCommit={(raw) => {
              const v = Number(raw);
              if (raw.trim() !== "" && !Number.isNaN(v) && v !== padding)
                sendTool("setProps", { id: node.id, patch: { "layout.padding": v } });
            }}
          />
        </div>
      </Row>
    </>
  );
}

function SelfLayoutFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const widthMode = node.layout?.widthMode ?? "fixed";
  const heightMode = node.layout?.heightMode ?? "fixed";
  const alignSelf = node.layout?.alignSelf ?? "auto";
  const grow = node.layout?.grow ?? 0;
  const parent = node.parent ? docMirror.store.getNode(node.parent) : null;
  const parentMode = parent?.layout?.mode;
  const snapsParent = !!parent && (parentMode === "HORIZONTAL" || parentMode === "VERTICAL");

  const commit = (patch: {
    widthMode?: string;
    heightMode?: string;
    alignSelf?: string;
    grow?: number;
  }) => {
    if (snapsParent) {
      sendTool("snapIntoLayout", {
        id: node.id,
        parent: parent!.id,
        index: parent!.children.indexOf(node.id),
        ...patch,
      });
      return;
    }
    const propPatch: Record<string, unknown> = {};
    if (patch.widthMode != null) propPatch["layout.widthMode"] = patch.widthMode;
    if (patch.heightMode != null) propPatch["layout.heightMode"] = patch.heightMode;
    if (patch.alignSelf != null) propPatch["layout.alignSelf"] = patch.alignSelf;
    if (patch.grow != null) propPatch["layout.grow"] = patch.grow;
    if (Object.keys(propPatch).length) sendTool("setProps", { id: node.id, patch: propPatch });
  };

  return (
    <Row label="Self Layout">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
        <select
          value={widthMode}
          disabled={disabled}
          onChange={(e) => commit({ widthMode: e.target.value })}
          style={{ ...input, width: "100%" }}
          title="Width sizing"
        >
          <option value="fixed">W: Fixed</option>
          <option value="hug">W: Hug</option>
          <option value="fill">W: Fill</option>
        </select>
        <select
          value={heightMode}
          disabled={disabled}
          onChange={(e) => commit({ heightMode: e.target.value })}
          style={{ ...input, width: "100%" }}
          title="Height sizing"
        >
          <option value="fixed">H: Fixed</option>
          <option value="hug">H: Hug</option>
          <option value="fill">H: Fill</option>
        </select>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        <select
          value={alignSelf}
          disabled={disabled}
          onChange={(e) => commit({ alignSelf: e.target.value })}
          style={{ ...input, width: "100%" }}
          title="Cross-axis self alignment"
        >
          <option value="auto">Self: Auto</option>
          <option value="stretch">Stretch</option>
          <option value="flex-start">Start</option>
          <option value="center">Center</option>
          <option value="flex-end">End</option>
        </select>
        <NumField
          label="Grow"
          initial={grow}
          disabled={disabled}
          onCommit={(raw) => {
            const v = Number(raw);
            if (raw.trim() !== "" && !Number.isNaN(v) && v >= 0 && v !== grow) commit({ grow: v });
          }}
        />
      </div>
    </Row>
  );
}

function VectorFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const linecap = node.vector?.linecap ?? "round";
  const linejoin = node.vector?.linejoin ?? "round";
  const scaling = node.vector?.scaling ?? "stretch";
  return (
    <Row label="Vector">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 6 }}>
        <select
          value={linecap}
          disabled={disabled}
          onChange={(e) => sendTool("setProps", { id: node.id, patch: { "vector.linecap": e.target.value } })}
          style={{ ...input, width: "100%" }}
        >
          <option value="butt">Butt</option>
          <option value="round">Round</option>
          <option value="square">Square</option>
        </select>
        <select
          value={linejoin}
          disabled={disabled}
          onChange={(e) => sendTool("setProps", { id: node.id, patch: { "vector.linejoin": e.target.value } })}
          style={{ ...input, width: "100%" }}
        >
          <option value="miter">Miter</option>
          <option value="round">Round</option>
          <option value="bevel">Bevel</option>
        </select>
      </div>
      <select
        value={scaling}
        disabled={disabled}
        onChange={(e) => sendTool("setProps", { id: node.id, patch: { "vector.scaling": e.target.value } })}
        style={{ ...input, width: "100%" }}
      >
        <option value="stretch">Stretch</option>
        <option value="aspect-fit">Aspect fit</option>
        <option value="fill">Fill</option>
      </select>
    </Row>
  );
}

function CodeFields({ node, disabled }: { node: Node; disabled: boolean }) {
  const [draft, setDraft] = useState(nodeToDeclarations(node));
  const commit = (raw: string) => {
    const patch = parseDeclarations(node, raw);
    if (Object.keys(patch).length) sendTool("setProps", { id: node.id, patch });
  };
  return (
    <>
      <Row label="Code">
        <textarea
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          spellCheck={false}
          style={{ ...input, width: "100%", minHeight: 220, resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: 1.45 }}
        />
      </Row>
      <DebugFields node={node} />
    </>
  );
}

function DebugFields({ node }: { node: Node }) {
  return (
    <Row label="Debug">
      <pre
        style={{
          margin: 0,
          padding: 8,
          borderRadius: 6,
          background: "#f9fafb",
          border: "1px solid #e5e7eb",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontSize: 11,
        }}
      >
        {JSON.stringify(node, null, 2)}
      </pre>
    </Row>
  );
}

function nodeToDeclarations(node: Node): string {
  const [x, y, w, h] = node.bbox;
  const lines = [`@name: ${node.name}`, `left: ${x}px`, `top: ${y}px`, `width: ${w}px`, `height: ${h}px`];
  const fill = node.type === "VECTOR" ? node.vector?.fill : paintColor(node.style?.fills?.[0]);
  if (fill) lines.push(`fill: ${fill}`);
  const stroke = node.type === "VECTOR" ? node.vector?.stroke : node.style?.stroke?.color;
  if (stroke) lines.push(`stroke: ${stroke}`);
  const strokeWidth = node.type === "VECTOR" ? node.vector?.strokeWidth : node.style?.stroke?.weight;
  if (strokeWidth != null) lines.push(`stroke-width: ${strokeWidth}px`);
  if (node.style?.cornerRadius != null) lines.push(`border-radius: ${node.style.cornerRadius}${node.style.cornerRadiusUnit ?? "px"}`);
  if (node.style?.opacity != null) lines.push(`opacity: ${node.style.opacity}`);
  if (node.text) {
    lines.push(`@text: ${node.text.chars}`);
    lines.push(`font-family: ${node.text.fontFamily ?? "Inter, system-ui, sans-serif"}`);
    lines.push(`font-size: ${node.text.fontSize}px`);
    lines.push(`font-weight: ${node.text.fontWeight}`);
    lines.push(`text-align: ${node.text.align.toLowerCase()}`);
  }
  if (node.layout?.display) lines.push(`display: ${node.layout.display}`);
  if (node.layout?.gap != null) lines.push(`gap: ${node.layout.gap}px`);
  if (node.layout?.padding != null) lines.push(`padding: ${node.layout.padding}px`);
  return lines.join("\n");
}

function parseDeclarations(node: Node, raw: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const bbox: [number, number, number, number] = [...node.bbox];
  let bboxChanged = false;
  const stroke = { ...(node.style?.stroke ?? {}) };
  let strokeChanged = false;
  for (const line of raw.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const i = trimmed.indexOf(":");
    if (i < 0) continue;
    const key = trimmed.slice(0, i).trim().toLowerCase();
    const value = trimmed.slice(i + 1).trim();
    const px = parsePx(value);
    if (key === "@name") patch.name = value;
    else if (key === "@text" && node.type === "TEXT") patch["text.chars"] = value;
    else if (key === "left" && px != null) {
      bbox[0] = px;
      bboxChanged = true;
    } else if (key === "top" && px != null) {
      bbox[1] = px;
      bboxChanged = true;
    } else if (key === "width" && px != null) {
      bbox[2] = px;
      bboxChanged = true;
    } else if (key === "height" && px != null) {
      bbox[3] = px;
      bboxChanged = true;
    } else if (key === "fill" && (HEX_RE.test(value) || value === "none")) {
      if (node.type === "VECTOR") patch["vector.fill"] = value;
      else patch["style.fills"] = value === "none" ? [] : [{ type: "SOLID", color: value }];
    } else if (key === "stroke" && HEX_RE.test(value)) {
      if (node.type === "VECTOR") patch["vector.stroke"] = value;
      else {
        stroke.color = value;
        strokeChanged = true;
      }
    } else if (key === "stroke-width" && px != null) {
      if (node.type === "VECTOR") patch["vector.strokeWidth"] = px;
      else {
        stroke.weight = px;
        strokeChanged = true;
      }
    } else if (key === "border-radius" && px != null) patch["style.cornerRadius"] = px;
    else if (key === "opacity") {
      const n = Number(value);
      if (!Number.isNaN(n)) patch["style.opacity"] = Math.max(0, Math.min(1, n));
    } else if (key === "font-size" && px != null && node.type === "TEXT") patch["text.fontSize"] = px;
    else if (key === "font-weight" && node.type === "TEXT") {
      const n = Number(value);
      if (!Number.isNaN(n)) patch["text.fontWeight"] = n;
    } else if (key === "font-family" && node.type === "TEXT") patch["text.fontFamily"] = value;
    else if (key === "text-align" && node.type === "TEXT") {
      const align = value.toUpperCase();
      if (["LEFT", "CENTER", "RIGHT", "JUSTIFY"].includes(align)) patch["text.align"] = align;
    } else if (key === "display") patch["layout.display"] = value;
    else if (key === "gap" && px != null) patch["layout.gap"] = px;
    else if (key === "padding" && px != null) patch["layout.padding"] = px;
  }
  if (bboxChanged) patch.bbox = bbox;
  if (strokeChanged) patch["style.stroke"] = stroke;
  return patch;
}

function parsePx(raw: string): number | null {
  const n = Number(raw.replace(/px$/i, "").trim());
  return Number.isNaN(n) ? null : n;
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
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "#fff",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const tabButton: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid",
  fontSize: 12,
  fontFamily: "inherit",
  cursor: "pointer",
};

const header: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
  marginBottom: 10,
};

const hint: React.CSSProperties = {
  color: "var(--muted-2)",
  fontSize: 13,
};
