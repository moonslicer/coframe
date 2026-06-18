# SVG Edit Tools With DOM/CSS Migration Path

Status: draft, 2026-06-18.

This spec describes how to add the nine-tool Figma-style edit palette and property inspector to the
current SVG-rendered canvas while keeping the data model compatible with a future DOM/CSS renderer.

The short version: implement the editing surface as a renderer-neutral primitive/style model, then
teach the current SVG renderer to project that model into SVG. Do not put SVG-only assumptions into
the canonical node data unless the property is truly vector-specific.

## 1. Goal

Add an edit mode with:

- Select
- Click-through
- Text
- Frame
- Rectangle
- Oval
- Arrow
- Line
- Draw
- Undo/Redo controls

The current implementation should continue to render through the single SVG stage. A later milestone
should be able to add a DOM/CSS compiler for the same document data without rewriting the tools,
inspector, undo stack, or scene graph.

## 2. Non-goals For This Milestone

- No real DOM/CSS rendering of primitives yet.
- No raw HTML export UI yet.
- No full CSS cascade, class system, inherited computed-style engine, media queries, or responsive
  constraints.
- No boolean vector operations.
- No multi-user undo semantics.
- No general-purpose path editor beyond line, arrow, and freehand creation plus bbox transforms.

## 3. Core Principle

The document model is canonical. Renderers are projections.

```text
DocStore Node tree
  -> SVG projection for current canvas, marks, and rasterization
  -> DOM/CSS projection later
```

The editor must mutate canonical node fields such as `bbox`, `style`, `text`, `layout`, and `vector`.
It must not mutate generated SVG markup. The SVG renderer reads those fields and emits the current
pixels. The future DOM/CSS renderer will read the same fields and emit real `p`, `div`, and `svg`
nodes.

## 4. Existing Foundation

The current app already has most of the editing spine:

- Stable `NodeId` values.
- Normalized node tree in `DocStore`.
- Atomic ops with server-side validation.
- Toolbar mode store.
- Selection, drag, resize, rubber-band creation, and drag-to-reparent.
- Existing node types: `FRAME`, `TEXT`, `RECT`, `ELLIPSE`, `VECTOR`.
- `VECTOR` is reserved but not rendered yet.
- One-step snapshot undo exists, but redo does not.

This milestone should extend those pieces instead of creating a parallel editor path.

## 5. Canonical Node Model

Keep the existing `Node` shape, but add renderer-neutral fields that can drive both SVG now and
DOM/CSS later.

```ts
export type PrimitiveKind =
  | "frame"
  | "text"
  | "rectangle"
  | "oval"
  | "line"
  | "arrow"
  | "draw";

export type SizeMode = "hug" | "fixed" | "fill";
export type PositionMode = "inline" | "absolute" | "fixed" | "sticky";
export type SvgScaling = "stretch" | "aspect-fit" | "fill";

export interface Node {
  id: NodeId;
  type: NodeType;
  name: string;
  bbox: [x: number, y: number, w: number, h: number];
  parent: NodeId | null;
  children: NodeId[];

  // Stable template id. For this milestone, default tid === id.
  tid?: string;

  // Renderer-neutral primitive intent.
  primitive?: PrimitiveKind;

  // Existing fields stay valid.
  style?: NodeStyle;
  text?: TextStyle;
  layout?: LayoutStyle;

  // New vector data, used only when type === "VECTOR".
  vector?: VectorStyle;

  // Future DOM/CSS projection metadata. Store it now only when useful.
  template?: TemplateProjection;
}
```

Recommended supporting types:

```ts
export interface NodeStyle {
  fills?: Paint[];
  opacity?: number;
  cornerRadius?: number;
  cornerRadiusUnit?: "px" | "%";
  stroke?: {
    color: string;
    weight?: number;
    style?: "none" | "solid" | "dashed" | "dotted" | "double";
  };
  overflow?: "visible" | "hidden" | "auto" | "scroll";
  zIndex?: number | "auto";
  boxShadow?: string;
  textShadow?: string;
  transform?: string;
  filter?: string;
}

export interface TextStyle {
  chars: string;
  fontFamily?: string;
  fontSize: number;
  fontWeight: number;
  fontStyle?: "normal" | "italic";
  textDecoration?: Array<"underline" | "line-through">;
  align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
  lineHeight?: number;
  color?: string;
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  letterSpacingEm?: number;
}

export interface LayoutStyle {
  display?: "block" | "flex" | "grid" | "inline-block" | "inline" | "none";
  mode: "NONE" | "HORIZONTAL" | "VERTICAL";
  gap?: number;
  padding?: number;
  paddingSides?: { top?: number; right?: number; bottom?: number; left?: number };
  marginSides?: { top?: number; right?: number; bottom?: number; left?: number };
  align?: "START" | "CENTER" | "END";
  wrap?: "nowrap" | "wrap" | "wrap-reverse";
  grow?: number;
  alignSelf?: "auto" | "stretch" | "flex-start" | "center" | "flex-end";
  widthMode?: SizeMode;
  heightMode?: SizeMode;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  positionMode?: PositionMode;
  inset?: { top?: number; right?: number; bottom?: number; left?: number };
}

export interface VectorStyle {
  kind: "line" | "arrow" | "draw";
  points: Array<[number, number]>; // local coordinates within bbox
  viewBox: [number, number, number, number];
  stroke: string;
  strokeWidth: number;
  fill?: string;
  linecap?: "butt" | "round" | "square";
  linejoin?: "miter" | "round" | "bevel";
  scaling?: SvgScaling;
}

export interface TemplateProjection {
  family: "text" | "box" | "vector";
  domTag: "p" | "div" | "svg";
}
```

Why this shape:

- `primitive` preserves user intent: `RECT` and `FRAME` are both box-like, but a frame starts
  transparent and is expected to contain children.
- `tid` gives the later compiler a stable `data-dc-tpl` without tying that decision to SVG.
- `template` records the future DOM family/tag without storing raw HTML.
- `vector.points` are local to the vector bbox, so drag/resize can continue to edit `bbox` without
  rewriting path coordinates.

## 6. Primitive Presets

All primitive creation should go through shared factory functions. The toolbar, agent tools, tests,
and future importers should call the same factories.

### Text

Canonical node:

- `type: "TEXT"`
- `primitive: "text"`
- `template.family: "text"`
- `template.domTag: "p"`
- `text.chars: "Text"`
- `text.fontFamily: "Karla, system-ui, sans-serif"`
- `text.fontSize: 16`
- `text.fontWeight: 400`
- `text.align: "LEFT"`
- `style.fills[0].color: "#111111"`
- `layout.positionMode: "absolute"`
- `layout.widthMode: "fixed"`
- `layout.heightMode: "hug"`

SVG projection:

- Emit `<text data-node-id data-dc-tpl>`.
- Use `x`, `y`, `font-family`, `font-size`, `font-weight`, `fill`, `text-anchor`.
- For multiline text later, emit child `<tspan>` elements.

DOM/CSS projection later:

- Emit `<p data-dc-tpl style="...">Text</p>`.

### Frame

Canonical node:

- `type: "FRAME"`
- `primitive: "frame"`
- `template.family: "box"`
- `template.domTag: "div"`
- No fill by default.
- `layout.display: "flex"`
- `layout.mode: "NONE"` initially.
- `layout.positionMode: "absolute"`

SVG projection:

- Emit a `<g data-node-id data-dc-tpl>` wrapper for hit-testing and child grouping.
- Emit a background `<rect>` only when fill, stroke, opacity, radius, or overflow clipping requires it.
- Children remain rendered by DFS order.

DOM/CSS projection later:

- Emit `<div data-dc-tpl style="display:flex; flex-direction:column; ...">`.

### Rectangle

Canonical node:

- `type: "RECT"`
- `primitive: "rectangle"`
- `template.family: "box"`
- `template.domTag: "div"`
- Fill `#B6B0A7`.
- `cornerRadius: 8`
- `cornerRadiusUnit: "px"`
- `layout.display: "flex"`
- `layout.positionMode: "absolute"`

SVG projection:

- Emit `<rect data-node-id data-dc-tpl>`.

DOM/CSS projection later:

- Emit `<div data-dc-tpl style="box-sizing:border-box; display:flex; ...">`.

### Oval

Canonical node:

- `type: "ELLIPSE"`
- `primitive: "oval"`
- `template.family: "box"`
- `template.domTag: "div"`
- Fill `#B6B0A7`.
- `cornerRadius: 50`
- `cornerRadiusUnit: "%"`
- Centering layout defaults may be stored as `layout.align: "CENTER"` for now.

SVG projection:

- Emit `<ellipse data-node-id data-dc-tpl>`.

DOM/CSS projection later:

- Emit `<div data-dc-tpl style="border-radius:50%; align-items:center; justify-content:center">`.

### Line

Canonical node:

- `type: "VECTOR"`
- `primitive: "line"`
- `template.family: "vector"`
- `template.domTag: "svg"`
- `vector.kind: "line"`
- `vector.points: [[0, h / 2], [w, h / 2]]`
- `vector.stroke: "#8A8378"`
- `vector.strokeWidth: 4`
- `vector.fill: "none"`
- `vector.linecap: "round"`
- `vector.linejoin: "round"`
- `vector.scaling: "stretch"`

SVG projection:

- Emit a path in root SVG coordinates after mapping local points into `bbox`.

DOM/CSS projection later:

- Emit nested `<svg data-dc-tpl><path ... /></svg>`.

### Arrow

Same as line, but `vector.kind: "arrow"` and the SVG projection emits the shaft plus arrowhead.

Arrowhead should be generated at render time from the final two points. Do not persist arrowhead
points; they are derived geometry.

### Draw

Canonical node:

- `type: "VECTOR"`
- `primitive: "draw"`
- `vector.kind: "draw"`
- `vector.points` captured during pointer movement, normalized into local bbox coordinates.

SVG projection:

- Emit one smooth-ish path. Start simple with `M x y L x y ...`; path smoothing can be added later.

## 7. Tool Palette Behavior

### Select

Uses current behavior:

- Click selects.
- Shift/Cmd/Ctrl click toggles selection.
- Drag moves selected nodes.
- Handles resize one selected node.
- Delete removes selection.
- Drag into a frame can reparent.

### Click-through

For the SVG milestone:

- Editor hit-testing is disabled.
- Selection outlines are hidden or inert.
- Pointer events should not create, move, resize, or select nodes.
- Because the current canvas is SVG-only, "live page interaction" is limited. Keep the mode anyway so
  the UI contract matches the future DOM milestone.

For the DOM milestone:

- Set editor overlay `pointer-events: none` and let embedded DOM controls receive interaction.

### Text, Frame, Rectangle, Oval

Use the current rubber-band creation flow:

- Pointer down stores start point and parent frame.
- Pointer move previews a rectangle.
- Pointer up creates the preset node.
- Bare click creates a default size.
- After creation, select the created node.
- Tool should return to Select unless the user has enabled a persistent-tool modifier later.

### Line And Arrow

Use a drag gesture:

- Pointer down records start point.
- Pointer move previews vector.
- Pointer up creates `VECTOR`.
- Bare click creates a default horizontal line or arrow.
- Normalize bbox to contain the two endpoints.
- Store points local to bbox.

### Draw

Use freehand capture:

- Pointer down starts a point list.
- Pointer move appends points when distance from the previous point is above a small threshold.
- Pointer up normalizes points into the smallest bbox that contains them, with padding for stroke
  width.
- If the stroke has fewer than two meaningful points, discard it.

Optional first-pass simplification:

- Drop duplicate points.
- Drop points closer than 1 to 2 canvas px.
- Do not add a heavy simplification dependency until the raw draw path is working.

## 8. Renderer Contract

The SVG renderer must remain a pure function of the store.

```ts
buildSvg(store, rootId, opts) -> { svg, markMap }
```

Every emitted editable element must include:

```html
data-node-id="{node.id}"
data-dc-tpl="{node.tid ?? node.id}"
```

SVG rendering rules:

- Root stays one `<svg>` with the root bbox as viewBox.
- Rendering order remains deterministic DFS over `children`.
- Frame may render as `<g>` plus optional background rect.
- Rect renders as `<rect>`.
- Oval renders as `<ellipse>`.
- Text renders as `<text>`.
- Vector renders as `<path>` and optional arrowhead path.
- Marks continue to use `bbox`, regardless of primitive type.

Do not store generated SVG path strings as canonical data except when a future imported SVG cannot be
represented as editable points. For line, arrow, and draw, points are canonical and path strings are
derived.

## 9. Property Inspector

The inspector should be declarative over canonical fields. Simple, Pro, and Code are three views over
the same data.

### Simple

Show a curated subset:

- Geometry: X, Y, W, H.
- Fill for text and filled shapes.
- Stroke for vectors and shapes.
- Text content and basic typography for text.
- Radius for frame, rectangle, oval.
- Layout controls for frames.

### Pro

Show all supported sections:

- Fill and stroke.
- Typography.
- Sizing.
- Position.
- Contents layout.
- Padding and margin.
- Appearance.
- Border.
- Advanced debug.

### Code

For this SVG milestone, Code mode should not pretend to be real CSS. Use a property-line format that
can later map cleanly to CSS:

```text
fill: #B6B0A7
stroke: #8A8378
stroke-width: 4
font-size: 16
font-family: Karla, system-ui, sans-serif
border-radius: 8px
position: absolute
left: 120px
top: 80px
@name: Hero title
```

Parsing rules:

- `@name` maps to node fields or attributes, not style.
- `left`, `top`, `width`, and `height` map to `bbox`.
- CSS-like names map to canonical style/layout/text/vector fields.
- Unsupported declarations are rejected with a visible validation message.
- Preserve no unknown declarations in this milestone unless there is a clear future field for them.

## 10. Property Mapping

### Fill And Stroke

Current SVG milestone:

- `fill` maps to `style.fills[0]` for box/text fills, and `vector.fill` for vectors.
- Text color maps to `style.fills[0]` and `text.color` can be treated as a denormalized convenience
  only if needed.
- `stroke` maps to `style.stroke.color` for boxes and `vector.stroke` for vectors.
- `stroke-width` maps to `style.stroke.weight` or `vector.strokeWidth`.
- `stroke-linecap` and `stroke-linejoin` apply to vectors.

Future DOM/CSS:

- Box fill maps to `background-color`.
- Text fill maps to `color`.
- Vector stroke remains SVG stroke.
- Border maps separately from vector stroke.

### Typography

Applies to `TEXT` now. Later it can apply to any text-bearing DOM node.

- Font -> `text.fontFamily`.
- Size -> `text.fontSize`.
- Color -> `style.fills[0]`.
- Weight -> `text.fontWeight`.
- Italic -> `text.fontStyle`.
- Underline/strikethrough -> `text.textDecoration`.
- Align -> `text.align`.
- Leading -> `text.lineHeight`.
- Case -> `text.textTransform`.
- Tracking -> `text.letterSpacingEm`.

### Sizing

Canonical fields:

- `bbox[2]` and `bbox[3]` remain the actual rendered size in the SVG milestone.
- `layout.widthMode` and `layout.heightMode` preserve user intent for future DOM/CSS.

SVG behavior:

- Fixed: use bbox width/height.
- Hug: for text, optionally estimate bbox from content; otherwise behave like current bbox until text
  measurement exists.
- Fill: behave like bbox now, but store the intent.

DOM/CSS behavior later:

- Hug -> `width: fit-content`, height `auto` where appropriate.
- Fixed -> explicit px.
- Fill -> `flex: 1` or `width: 100%` depending on parent layout.

### Position

SVG behavior:

- `bbox[0]` and `bbox[1]` are always the rendered position.
- Store `layout.positionMode` for future DOM/CSS.

DOM/CSS behavior later:

- Inline removes absolute positioning from compiled CSS.
- Absolute/fixed/sticky maps to CSS `position`.
- Insets map to `top/right/bottom/left`.

### Contents Layout

Current behavior:

- Continue using `layout.mode`, `gap`, `padding`, and `align`.
- `applyAutoLayout` still writes child bboxes for immediate SVG rendering.

Important migration rule:

- Auto-layout tools should store layout intent on the parent and also materialize child bboxes for
  SVG. The DOM/CSS renderer will later use the intent; the SVG renderer uses the materialized bboxes.

### Padding And Margin

SVG behavior:

- Padding affects auto-layout computations.
- Margin is stored but has no visual effect until layout tools use it.

DOM/CSS behavior later:

- Padding and margin map directly to CSS.

### Appearance

SVG behavior:

- Background maps to fill for box primitives.
- Radius maps to `rx` for rect/frame, and ellipse geometry for oval.
- Overflow can later create SVG clip paths; start by storing it and supporting `hidden` only when
  practical.
- Opacity maps to `opacity`.
- Z-index is represented by child order for now; inspector can expose it as reorder controls later.
- Shadow/filter/transform can be stored first, then selectively projected to SVG attributes.

DOM/CSS behavior later:

- Map directly to CSS properties.

### Border

SVG behavior:

- Border maps to `style.stroke`.
- Style `dashed`/`dotted` maps to `stroke-dasharray`.
- `double` can render as solid in v1 or be marked unsupported until implemented.

DOM/CSS behavior later:

- Border maps to CSS `border`.

### Advanced Debug

Show canonical serialization:

```json
{
  "tid": "node:12",
  "type": "RECT",
  "primitive": "rectangle",
  "parent": "node:1",
  "bbox": [120, 80, 240, 120],
  "style": {},
  "text": null,
  "layout": {},
  "vector": null,
  "template": { "family": "box", "domTag": "div" }
}
```

This debug view is the source of truth for persistence and migration.

## 11. Tools And Ops

Keep semantic create tools, but add one generic property patch tool.

Recommended registry additions:

```ts
createVector({
  parent,
  kind: "line" | "arrow" | "draw",
  bbox,
  points,
  stroke?,
  strokeWidth?
})

setProps({
  id,
  patch: Record<string, unknown>
})
```

`setProps` should validate allowed paths. It should not allow arbitrary mutation of `id`, `parent`,
`children`, or unknown fields.

Initial allowed paths:

- `bbox`
- `name`
- `style.fills`
- `style.opacity`
- `style.cornerRadius`
- `style.cornerRadiusUnit`
- `style.stroke`
- `style.overflow`
- `style.zIndex`
- `style.boxShadow`
- `style.textShadow`
- `style.transform`
- `style.filter`
- `text.chars`
- `text.fontFamily`
- `text.fontSize`
- `text.fontWeight`
- `text.fontStyle`
- `text.textDecoration`
- `text.align`
- `text.lineHeight`
- `text.textTransform`
- `text.letterSpacingEm`
- `layout.display`
- `layout.mode`
- `layout.gap`
- `layout.padding`
- `layout.paddingSides`
- `layout.marginSides`
- `layout.align`
- `layout.wrap`
- `layout.grow`
- `layout.alignSelf`
- `layout.widthMode`
- `layout.heightMode`
- `layout.minWidth`
- `layout.maxWidth`
- `layout.minHeight`
- `layout.maxHeight`
- `layout.positionMode`
- `layout.inset`
- `vector.stroke`
- `vector.strokeWidth`
- `vector.fill`
- `vector.linecap`
- `vector.linejoin`
- `vector.scaling`
- `vector.points`

Existing semantic tools such as `setFill` and `setTextStyle` can remain as wrappers. The inspector can
use `setProps` directly.

## 12. Undo And Redo

The current server has one snapshot undo. The edit palette needs normal Undo/Redo controls.

Use a simple snapshot ring while the product is single-user:

```ts
interface HistoryState {
  past: Snapshot[];
  future: Snapshot[];
  currentLabel?: string;
}
```

Rules:

- A committed create, delete, inspector change, drag, resize, or draw gesture creates one undo entry.
- Pointermove previews do not create history.
- A drag creates history only on pointerup.
- A freehand draw creates history only on pointerup.
- Undo restores the latest past snapshot and pushes the previous current snapshot to future.
- Redo restores the latest future snapshot and pushes current to past.
- Starting a new edit after undo clears future.
- Agent runs may continue to coalesce many tool calls into one history entry.

This is still not the future multiplayer undo model. It is acceptable for this single-user milestone.

## 13. Migration Rules For DOM/CSS

When the DOM/CSS milestone starts:

1. Keep `Node`, `primitive`, `style`, `text`, `layout`, `vector`, and `template`.
2. Add a `buildDom()` compiler beside `buildSvg()`.
3. Map canonical fields to inline CSS declarations.
4. Preserve `data-node-id` for editor hit-testing.
5. Preserve `data-dc-tpl` for template identity.
6. Keep SVG vectors as nested `<svg>` elements in the DOM output.
7. Keep the SVG renderer for marks until the DOM renderer has an equivalent screenshot/raster path.

Do not convert the canonical model into raw CSS strings. CSS strings are an output format, not the
source of truth.

## 14. Implementation Plan

### Phase 1: Model And Factories

- Add `primitive`, `tid`, `vector`, `template`, and expanded style/layout/text fields.
- Create primitive preset factories.
- Update existing create tools to use the factories.
- Add tests for factory output.

### Phase 2: Full Toolbar

- Extend `ToolMode` to all palette modes.
- Add Click-through, Oval label, Arrow, Line, Draw, Undo, and Redo controls.
- Preserve run-active locking.

### Phase 3: Vector Creation And Rendering

- Add `createVector`.
- Render `VECTOR` in `buildSvg`.
- Add line and arrow drag creation.
- Add draw point capture.
- Add smoke tests that confirm vector output includes paths and `data-dc-tpl`.

### Phase 4: Inspector Expansion

- Add `setProps`.
- Replace bespoke inspector-only controls with declarative property descriptors.
- Add Simple, Pro, and Code tiers.
- Keep existing geometry/fill/text controls working during the transition.

### Phase 5: Undo/Redo

- Replace one-snapshot undo with a snapshot ring.
- Add redo protocol messages and buttons.
- Keep agent-run coalescing.

### Phase 6: Migration Prep

- Add a non-rendering `compileTemplateNode(node)` helper that returns the intended DOM tag and style
  declarations as plain data.
- Do not ship DOM rendering yet. This helper is only a contract test for the future compiler.

## 15. Acceptance Criteria

- The toolbar exposes all nine tools plus Undo/Redo.
- Select, Text, Frame, Rectangle, Oval, Line, Arrow, and Draw work in the SVG canvas.
- Click-through is present and prevents editor selection/mutation.
- Every rendered editable SVG element includes `data-node-id` and `data-dc-tpl`.
- `VECTOR` nodes render visibly.
- Inspector can edit geometry, fill, stroke, basic typography, radius, opacity, and debug JSON.
- Undo and redo work for create, drag, resize, delete, inspector changes, and draw gestures.
- The canonical data for a rectangle, text, frame, oval, and vector contains enough information to
  compile later into `div`, `p`, and nested `svg` DOM nodes without reverse-engineering SVG output.

## 16. Risks And Guardrails

- Risk: style fields drift into SVG-only names.
  Guardrail: inspector descriptors must write canonical paths, not SVG attributes directly.

- Risk: auto-layout is visually correct in SVG but loses future DOM intent.
  Guardrail: layout tools must both materialize child bboxes and store parent layout intent.

- Risk: freehand draw stores global points and becomes hard to resize.
  Guardrail: normalize vector points into bbox-local coordinates.

- Risk: Code mode becomes a junk drawer for unsupported CSS.
  Guardrail: reject unknown declarations until the canonical model supports them.

- Risk: undo snapshots become too coarse for future collaboration.
  Guardrail: document snapshot undo as a single-user implementation detail. Keep ops as the boundary
  contract so inverse-op undo can replace snapshots later.

