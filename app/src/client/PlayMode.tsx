// Play mode: the prototype RUNTIME. A full-bleed overlay that renders the active screen
// from the SHARED draw table (buildSvg in `play` mode, so it honors hidden/toggle state)
// and turns clicks into navigation. It is read-only over the mirror — it never sends a
// tool or mutates the doc, so the single-writer guarantee is untouched.
//
// One coordinate space: the base screen svg is sized to boundsOf(screen); each open
// overlay is rendered as its own svg positioned at its real canvas coords RELATIVE to the
// screen origin, so overlays land exactly where they sit in the design. A uniform scale
// fits the screen into the viewport.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X, ChevronLeft } from "lucide-react";
import { buildSvg } from "../render/svg-build.js";
import { boundsOf, type DocStore } from "../shared/store.js";
import type { Node, NodeId } from "../shared/types.js";
import {
  docMirror,
  formStore,
  inputDefaults,
  missingRequired,
  playStore,
  useDocVersion,
  usePlayState,
  usePlayValues,
  visibleInputs,
} from "./stores.js";

const VIEWPORT_PADDING = 48;

// A real, typeable HTML control overlaid on the input node's SVG box, positioned in raw
// canvas coords inside the (already scaled) stage. Writing to formStore re-renders the
// screen SVG so every {{field}} reference updates live. Read-only over the doc.
function InputControl({ node, invalid }: { node: Node; invalid: boolean }) {
  const inp = node.input!;
  const values = usePlayValues();
  const value = values[inp.field] ?? "";
  const checked = value === "true";
  const set = (v: string) => formStore.set(inp.field, v);

  const base: React.CSSProperties = {
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    border: `1px solid ${invalid ? "#EF4444" : "#CBD5E1"}`,
    borderRadius: node.style?.cornerRadius ?? 10,
    padding: "0 14px",
    font: "16px Inter, system-ui, sans-serif",
    color: "#111827",
    background: "#FFFFFF",
    outline: "none",
  };

  if (inp.kind === "checkbox" || inp.kind === "switch") {
    return (
      <label
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", height: "100%", cursor: "pointer", font: "16px Inter, system-ui, sans-serif", color: "#111827" }}
      >
        <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked ? "true" : "false")} style={{ width: 20, height: 20, accentColor: "#4F46E5" }} />
        {inp.label ?? inp.placeholder ?? inp.field}
      </label>
    );
  }
  if (inp.kind === "select") {
    return (
      <select value={value} onChange={(e) => set(e.target.value)} style={base}>
        <option value="" disabled>
          {inp.placeholder ?? "Select…"}
        </option>
        {(inp.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (inp.kind === "textarea") {
    return (
      <textarea
        value={value}
        placeholder={inp.placeholder}
        onChange={(e) => set(e.target.value)}
        style={{ ...base, padding: "10px 14px", resize: "none" }}
      />
    );
  }
  const htmlType = inp.kind === "password" ? "password" : inp.kind === "email" ? "email" : inp.kind === "number" ? "number" : "text";
  return (
    <input
      type={htmlType}
      value={value}
      placeholder={inp.placeholder}
      onChange={(e) => set(e.target.value)}
      style={base}
    />
  );
}

/** Position+render the real controls for every visible input under `rootId`. */
function InputOverlayLayer({
  store,
  rootId,
  originX,
  originY,
  isHidden,
  invalid,
}: {
  store: DocStore;
  rootId: NodeId;
  originX: number;
  originY: number;
  isHidden: (id: NodeId) => boolean;
  invalid: Set<NodeId>;
}) {
  return (
    <>
      {visibleInputs(store, rootId, isHidden).map((n) => {
        const [x, y, w, h] = n.bbox;
        return (
          <div
            key={n.id}
            style={{ position: "absolute", left: x - originX, top: y - originY, width: w, height: h }}
            onClick={(e) => e.stopPropagation()}
          >
            <InputControl node={n} invalid={invalid.has(n.id)} />
          </div>
        );
      })}
    </>
  );
}

export function PlayMode() {
  const play = usePlayState();
  const version = useDocVersion(); // re-render if the mirror ever changes underneath us
  const values = usePlayValues(); // live form state — drives {{field}} interpolation
  const viewportRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [invalid, setInvalid] = useState<Set<NodeId>>(new Set()); // required fields flashed red

  // Measure the available viewport so we can scale the screen to fit.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewport({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [play.active]);

  // Esc exits play; Backspace/← acts as Back (unless typing, which never happens here).
  useEffect(() => {
    if (!play.active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        playStore.exit();
      } else if (e.key === "Backspace" || e.key === "ArrowLeft") {
        e.preventDefault();
        playStore.back();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play.active]);

  const screenId = play.currentScreen;
  const store = docMirror.store;

  // Each Play session starts with a fresh form, seeded with input defaults.
  useEffect(() => {
    if (play.active) formStore.reset(inputDefaults(store));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play.active]);

  // Clear any "required" flash once the user starts typing, and on screen change.
  useEffect(() => setInvalid(new Set()), [screenId]);
  useEffect(() => {
    if (invalid.size) setInvalid(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  // A node is hidden in Play when its `hidden` default (flipped by a toggle) holds, OR it
  // is an open overlay (those are drawn in a separate top layer, not inline on the screen).
  const isHidden = useMemo(() => {
    const toggled = new Set(play.toggled);
    const overlays = new Set(play.overlays);
    return (id: NodeId): boolean => {
      if (overlays.has(id)) return true; // drawn on top instead
      const base = !!store.getNode(id)?.hidden;
      return toggled.has(id) ? !base : base;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play.toggled, play.overlays, version]);

  const screen = screenId ? store.getNode(screenId) : null;
  const [sx, sy, sw, sh] = screen ? boundsOf(store, screenId!) : [0, 0, 0, 0];

  const screenSvg = useMemo(
    () => (screenId ? buildSvg(store, screenId, { play: { isHidden, values } }).svg : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screenId, isHidden, version, values],
  );

  // Scale the screen to fit the viewport with breathing room (never upscale past 1).
  const scale =
    sw && sh && viewport.w && viewport.h
      ? Math.min((viewport.w - VIEWPORT_PADDING) / sw, (viewport.h - VIEWPORT_PADDING) / sh, 1)
      : 1;

  if (!play.active) return null;

  function onStageClick(e: React.MouseEvent) {
    const el = (e.target as Element).closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    const target = el.getAttribute("data-target") as NodeId | null;
    if (action === "navigate" && target) {
      // Gate forward navigation on the current screen's required fields being filled.
      const missing = screenId ? missingRequired(store, screenId, isHidden) : [];
      if (missing.length) {
        setInvalid(new Set(missing.map((n) => n.id)));
        return;
      }
      playStore.navigate(target);
    }
    else if (action === "toggle" && target) playStore.toggle(target);
    else if (action === "openOverlay" && target) playStore.openOverlay(target);
    else if (action === "closeOverlay") playStore.closeOverlay();
    else if (action === "back") playStore.back();
  }

  return (
    <div className="play-root">
      <header className="play-bar">
        <button
          className="play-btn"
          onClick={() => playStore.back()}
          disabled={play.navStack.length === 0 && play.overlays.length === 0}
          title="Back"
          aria-label="Back"
        >
          <ChevronLeft size={16} /> Back
        </button>
        <span className="play-title">{screen?.name ?? "Prototype"}</span>
        <button className="play-btn play-exit" onClick={() => playStore.exit()} title="Exit play (Esc)">
          <X size={16} /> Exit
        </button>
      </header>

      <div ref={viewportRef} className="play-viewport">
        {screen ? (
          <div
            onClick={onStageClick}
            style={{
              position: "relative",
              width: sw,
              height: sh,
              transform: `scale(${scale})`,
              transformOrigin: "center center",
              boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
              borderRadius: 4,
              overflow: "hidden",
              cursor: "default",
            }}
          >
            {/* Base screen. */}
            <div dangerouslySetInnerHTML={{ __html: screenSvg }} />

            {/* Real, typeable controls over the base screen's input boxes. */}
            <InputOverlayLayer store={store} rootId={screenId!} originX={sx} originY={sy} isHidden={isHidden} invalid={invalid} />

            {/* Scrim under any open overlay — clicking it dismisses the top overlay. */}
            {play.overlays.length > 0 && (
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  playStore.closeOverlay();
                }}
                style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.4)" }}
              />
            )}

            {/* Open overlays, each at its real canvas position relative to the screen. */}
            {play.overlays.map((ovId) => {
              const ov = store.getNode(ovId);
              if (!ov) return null;
              const [ox, oy] = boundsOf(store, ovId);
              const svg = buildSvg(store, ovId, { play: { isHidden, values } }).svg;
              // An overlay's own inputs are visible even though the overlay root reads as
              // "hidden" (it is drawn on this top layer) — treat only its root as shown.
              const ovHidden = (id: NodeId) => id !== ovId && isHidden(id);
              return (
                <div key={ovId} style={{ position: "absolute", left: ox - sx, top: oy - sy }}>
                  <div dangerouslySetInnerHTML={{ __html: svg }} />
                  <InputOverlayLayer store={store} rootId={ovId} originX={ox} originY={oy} isHidden={ovHidden} invalid={invalid} />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="play-empty">This design has no screens to play yet.</div>
        )}
      </div>
    </div>
  );
}
