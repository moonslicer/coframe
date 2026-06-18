// SVG -> PNG rasterizer (IMPLEMENTATION.md §5.2, §8 risk #3).
//
// SINGLE SOURCE OF PIXELS: this consumes the EXACT svg string produced by
// `buildSvg` (the shared draw table). There is no parallel renderer. The PNG the
// model "sees" is rasterized from the same string the browser injects into the DOM,
// so server pixels == browser composition (modulo the documented font-fidelity
// residual — see FONT NOTE below).
//
// Native binding: @resvg/resvg-js ships a prebuilt per-platform optional dep
// (here: @resvg/resvg-js-darwin-arm64). On import failure we DO NOT throw at module
// load — we degrade to a flag (`rasterAvailable === false`) so later milestones can
// still get the markMap + svg string and the run is not blocked.
//
// FONT NOTE (§8 risk #3): both sides reference the SAME Inter faces shipped in
// src/assets. resvg loads the static TTFs (Regular/Medium/SemiBold/Bold); the
// browser loads InterVariable.woff2 via @font-face (see src/client/fonts.css).
// Static weights are bundled for resvg because variable-font weight selection in
// resvg 2.6.x is less reliable than discrete faces. Pixel-exactness is NOT
// guaranteed (hinting / sub-pixel rounding differ between resvg's resvg/usvg
// pipeline and the browser's text shaper); the residual risk is that long TEXT
// wraps differently. Mitigation per spec: seed-doc TEXT is single-line. Verify
// visually on the densest seed before recording.

import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { DocStore } from "../shared/store.js";
import type { NodeId } from "../shared/types.js";
import { buildSvg } from "./svg-build.js";

export interface RenderPngOpts {
  marks?: boolean;
  /** Long-edge pixel cap; pins image tokens (~1,050 at 1024). */
  maxPx?: number;
}

export interface RenderPngOk {
  png: Buffer;
  /** PNG pixel dimensions actually produced. */
  width: number;
  height: number;
  svg: string;
  markMap: Record<string, NodeId>;
  version: number;
}

export interface RenderPngUnavailable {
  /** raster could not run on this platform; svg + markMap still returned. */
  rasterAvailable: false;
  reason: string;
  svg: string;
  markMap: Record<string, NodeId>;
  version: number;
}

export type RenderPngResult = (RenderPngOk & { rasterAvailable: true }) | RenderPngUnavailable;

// ---- font files bundled for resvg (same faces the browser uses) ----
const FONT_FILES = [
  "../assets/Inter-Regular.ttf",
  "../assets/Inter-Medium.ttf",
  "../assets/Inter-SemiBold.ttf",
  "../assets/Inter-Bold.ttf",
].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));

export const DEFAULT_FONT_FAMILY = "Inter";

// ---- lazy, fail-soft native binding load ----
// Typed loosely: the module is optional and may be absent on non-arm64 hosts.
type ResvgCtor = new (
  svg: string,
  options?: unknown,
) => { render(): { asPng(): Buffer; width: number; height: number } };

let _resvg: ResvgCtor | null = null;
let _loadError: string | null = null;
let _loaded = false;

async function loadResvg(): Promise<ResvgCtor | null> {
  if (_loaded) return _resvg;
  _loaded = true;
  try {
    const mod = (await import("@resvg/resvg-js")) as { Resvg: ResvgCtor };
    _resvg = mod.Resvg;
  } catch (e) {
    _resvg = null;
    _loadError = e instanceof Error ? e.message : String(e);
  }
  return _resvg;
}

/** True iff the native binding loaded AND the bundled fonts are present. */
export async function isRasterAvailable(): Promise<boolean> {
  const r = await loadResvg();
  return r != null;
}

/**
 * Rasterize the working frame to a PNG. Consumes buildSvg's exact svg string.
 * Returns the PNG (+ dims) when resvg is available, or a fail-soft result that
 * still carries the svg string + markMap + version when it is not.
 */
export async function renderPng(
  store: DocStore,
  rootId: NodeId,
  opts: RenderPngOpts = {},
): Promise<RenderPngResult> {
  const maxPx = opts.maxPx ?? 1024;
  const { svg, markMap } = buildSvg(store, rootId, { marks: opts.marks ?? false, maxPx });
  const version = store.version;

  const Resvg = await loadResvg();
  if (!Resvg) {
    return {
      rasterAvailable: false,
      reason: `@resvg/resvg-js unavailable: ${_loadError ?? "not installed"}`,
      svg,
      markMap,
      version,
    };
  }

  const fontFiles = FONT_FILES.filter((p) => existsSync(p));
  const renderer = new Resvg(svg, {
    // Pin the long edge to ~maxPx to cap image tokens. The svg's viewBox is the
    // working frame; "width" fit scales the whole composition to maxPx wide.
    fitTo: { mode: "width", value: maxPx },
    font: {
      // Deterministic vision channel: do NOT pull in host system fonts (would let
      // the rasterized image silently diverge from the browser on a different Mac).
      loadSystemFonts: false,
      fontFiles,
      defaultFontFamily: DEFAULT_FONT_FAMILY,
    },
    background: "white",
  });
  const rendered = renderer.render();
  const png = rendered.asPng();

  return {
    rasterAvailable: true,
    png,
    width: rendered.width,
    height: rendered.height,
    svg,
    markMap,
    version,
  };
}
