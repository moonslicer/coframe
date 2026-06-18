// Committed seed documents — the curated demo substrate (§2.1 F10). Demo
// reliability beats generality: a small set of hand-picked docs paired with
// known-good prompts so the wow lands every time.
//
// Conventions every seed MUST follow (so the loop + store stay correct):
//   - NAMED, non-numeric ids ("node:page", "node:hero") — NEVER "node:<int>".
//     The store mints run-created ids as `node:<n>` (idSeq starts at
//     seed.nodes.length), so a numeric-suffix seed id could collide.
//   - Single-line TEXT (resvg == browser wrap; §5.2 fidelity).
//   - A clear working FRAME as a child of the page root.
//   - Realistic but small (~6–12 nodes).

import type { Node } from "./types.js";

export interface Seed {
  rootId: string;
  nodes: Node[];
}

// ---------------------------------------------------------------------------
// Seed 1 — the landing page. Hero frame with logo/headline/subtitle/CTA and
// empty page space below. Sets up "add a pricing section" and "tidy the hero".
// ---------------------------------------------------------------------------
export const LANDING_SEED: Seed = {
  rootId: "node:page",
  nodes: [
    {
      id: "node:page",
      type: "FRAME",
      name: "Page",
      bbox: [0, 0, 1440, 1024],
      parent: null,
      children: ["node:hero"],
      style: { fills: [{ type: "SOLID", color: "#FFFFFF" }] },
      layout: { mode: "NONE" },
    },
    {
      id: "node:hero",
      type: "FRAME",
      name: "Hero",
      bbox: [80, 80, 1280, 280],
      parent: "node:page",
      children: ["node:logo", "node:headline", "node:subtitle", "node:cta"],
      style: { fills: [{ type: "SOLID", color: "#F4F1EA" }], cornerRadius: 16 },
      layout: { mode: "NONE" },
    },
    {
      id: "node:logo",
      type: "RECT",
      name: "Logo",
      bbox: [120, 110, 72, 72],
      parent: "node:hero",
      children: [],
      style: { fills: [{ type: "SOLID", color: "#4F46E5" }], cornerRadius: 12 },
    },
    {
      id: "node:headline",
      type: "TEXT",
      name: "Headline",
      bbox: [430, 130, 560, 44],
      parent: "node:hero",
      children: [],
      text: { chars: "Build faster with Acme", fontSize: 34, fontWeight: 700, align: "LEFT" },
      style: { fills: [{ type: "SOLID", color: "#111111" }] },
    },
    {
      id: "node:subtitle",
      type: "TEXT",
      name: "Subtitle",
      bbox: [650, 250, 420, 26],
      parent: "node:hero",
      children: [],
      text: {
        chars: "The all-in-one platform for shipping product",
        fontSize: 18,
        fontWeight: 400,
        align: "LEFT",
      },
      style: { fills: [{ type: "SOLID", color: "#555555" }] },
    },
    {
      id: "node:cta",
      type: "RECT",
      name: "CTA Button",
      bbox: [1080, 150, 180, 52],
      parent: "node:hero",
      children: [],
      style: { fills: [{ type: "SOLID", color: "#4F46E5" }], cornerRadius: 10 },
    },
  ],
};

// ---------------------------------------------------------------------------
// Seed 2 — a "loose / misaligned cards" board. A board frame holds three cards
// at deliberately ragged x/y positions and slightly different widths. Sets up
// the align + distribute + tidy beat ("line these up and even out the spacing").
// ---------------------------------------------------------------------------
export const SCATTERED_SEED: Seed = {
  rootId: "node:page",
  nodes: [
    {
      id: "node:page",
      type: "FRAME",
      name: "Page",
      bbox: [0, 0, 1440, 1024],
      parent: null,
      children: ["node:board"],
      style: { fills: [{ type: "SOLID", color: "#FFFFFF" }] },
      layout: { mode: "NONE" },
    },
    {
      id: "node:board",
      type: "FRAME",
      name: "Board",
      bbox: [80, 80, 1280, 520],
      parent: "node:page",
      children: ["node:cardA", "node:cardB", "node:cardC"],
      style: { fills: [{ type: "SOLID", color: "#F8FAFC" }], cornerRadius: 16 },
      layout: { mode: "NONE" },
    },
    {
      id: "node:cardA",
      type: "FRAME",
      name: "Card A",
      bbox: [130, 140, 300, 200],
      parent: "node:board",
      children: ["node:cardAtitle"],
      style: { fills: [{ type: "SOLID", color: "#FFFFFF" }], cornerRadius: 12 },
      layout: { mode: "NONE" },
    },
    {
      id: "node:cardAtitle",
      type: "TEXT",
      name: "Card A Title",
      bbox: [150, 160, 220, 28],
      parent: "node:cardA",
      children: [],
      text: { chars: "Discover", fontSize: 22, fontWeight: 600, align: "LEFT" },
      style: { fills: [{ type: "SOLID", color: "#111111" }] },
    },
    {
      id: "node:cardB",
      type: "FRAME",
      name: "Card B",
      bbox: [470, 220, 320, 190],
      parent: "node:board",
      children: ["node:cardBtitle"],
      style: { fills: [{ type: "SOLID", color: "#FFFFFF" }], cornerRadius: 12 },
      layout: { mode: "NONE" },
    },
    {
      id: "node:cardBtitle",
      type: "TEXT",
      name: "Card B Title",
      bbox: [490, 240, 220, 28],
      parent: "node:cardB",
      children: [],
      text: { chars: "Organize", fontSize: 22, fontWeight: 600, align: "LEFT" },
      style: { fills: [{ type: "SOLID", color: "#111111" }] },
    },
    {
      id: "node:cardC",
      type: "FRAME",
      name: "Card C",
      bbox: [880, 170, 290, 210],
      parent: "node:board",
      children: ["node:cardCtitle"],
      style: { fills: [{ type: "SOLID", color: "#FFFFFF" }], cornerRadius: 12 },
      layout: { mode: "NONE" },
    },
    {
      id: "node:cardCtitle",
      type: "TEXT",
      name: "Card C Title",
      bbox: [900, 190, 220, 28],
      parent: "node:cardC",
      children: [],
      text: { chars: "Ship", fontSize: 22, fontWeight: 600, align: "LEFT" },
      style: { fills: [{ type: "SOLID", color: "#111111" }] },
    },
  ],
};

// ---------------------------------------------------------------------------
// Seed 3 — a toolbar of three INCONSISTENT buttons (different fills, the labels
// sit at ragged y). Sets up the Day-8 selection-scoped restyle/distribute
// repeat-use beat ("make these match the primary one and even out the spacing").
// ---------------------------------------------------------------------------
export const BUTTONS_SEED: Seed = {
  rootId: "node:page",
  nodes: [
    {
      id: "node:page",
      type: "FRAME",
      name: "Page",
      bbox: [0, 0, 1440, 1024],
      parent: null,
      children: ["node:bar"],
      style: { fills: [{ type: "SOLID", color: "#FFFFFF" }] },
      layout: { mode: "NONE" },
    },
    {
      id: "node:bar",
      type: "FRAME",
      name: "Toolbar",
      bbox: [80, 120, 1000, 220],
      parent: "node:page",
      children: ["node:btnPrimary", "node:btnSecondary", "node:btnTertiary"],
      style: { fills: [{ type: "SOLID", color: "#F4F1EA" }], cornerRadius: 16 },
      layout: { mode: "NONE" },
    },
    {
      id: "node:btnPrimary",
      type: "RECT",
      name: "Primary Button",
      bbox: [120, 170, 200, 56],
      parent: "node:bar",
      children: [],
      style: { fills: [{ type: "SOLID", color: "#4F46E5" }], cornerRadius: 10 },
    },
    {
      id: "node:btnSecondary",
      type: "RECT",
      name: "Secondary Button",
      bbox: [380, 210, 180, 48],
      parent: "node:bar",
      children: [],
      style: { fills: [{ type: "SOLID", color: "#9CA3AF" }], cornerRadius: 6 },
    },
    {
      id: "node:btnTertiary",
      type: "RECT",
      name: "Tertiary Button",
      bbox: [640, 150, 220, 60],
      parent: "node:bar",
      children: [],
      style: { fills: [{ type: "SOLID", color: "#10B981" }], cornerRadius: 4 },
    },
  ],
};

// The registry. Seeds are loadable by id; the client picks chips by the active id.
export const SEEDS: Record<string, Seed> = {
  landing: LANDING_SEED,
  scattered: SCATTERED_SEED,
  buttons: BUTTONS_SEED,
};

export const DEFAULT_SEED_ID = "landing";

// Back-compat default (the original single seed export).
export const SEED: Seed = LANDING_SEED;

/** Look up a seed by id, falling back to the default. */
export function getSeed(id: string | undefined): { id: string; seed: Seed } {
  if (id && SEEDS[id]) return { id, seed: SEEDS[id] };
  return { id: DEFAULT_SEED_ID, seed: SEEDS[DEFAULT_SEED_ID] };
}

// ---------------------------------------------------------------------------
// Curated known-good prompts per seed (the suggestion chips). ONE source of
// truth — App.tsx renders chips for the active seed from here, no duplication.
// ---------------------------------------------------------------------------
export const SEED_PROMPTS: Record<string, string[]> = {
  landing: [
    "Add a pricing section with three tiers below the hero, aligned and evenly spaced.",
    "Tidy the hero: left-align the logo, headline, and subtitle.",
  ],
  scattered: [
    "Line up the three cards in a row with even spacing.",
    "Top-align the three cards and even out the spacing.",
  ],
  buttons: [
    "Make the three buttons match the primary one and even out the spacing.",
    "Lay the three buttons out in a row with even spacing.",
  ],
};
