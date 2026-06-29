// A committed seed document — a deliberately *scattered* hero plus empty page
// space below it. Good targets for "tidy the hero", "make this look designed",
// or "add a pricing section with 3 cards". Edit by hand to add demo cases.

import type { Node } from "./types.js";

export const SEED: { rootId: string; nodes: Node[] } = {
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
