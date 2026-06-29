// Shared scene-graph types. Pure data — no SDK, no rendering, no Date.now/Math.random.
// Mirrors IMPLEMENTATION.md §5.1.

export type NodeId = string; // "node:<n>" — stable, survives reorder/move (NOT an array index)
export type DocVersion = number; // monotonic integer, server-assigned

export type NodeType =
  | "FRAME"
  | "TEXT"
  | "RECT"
  | "ELLIPSE" // v1-populated
  | "VECTOR"
  | "COMPONENT"
  | "INSTANCE"
  | "GROUP"; // reserved, additive

// A paint is what fills a node. SOLID is the v1 default; GRADIENT and IMAGE are
// rendered by emitting an SVG <def> (linear/radialGradient or <pattern><image>) and
// referencing it with fill="url(#id)" — supported identically by the browser DOM and
// the resvg rasterizer, so the agent's eye matches the human's canvas.
export type GradientStop = { color: string; offset: number; opacity?: number }; // offset 0..1
export type Paint =
  | { type: "SOLID"; color: string; opacity?: number } // hex
  | {
      type: "GRADIENT";
      gradient?: "linear" | "radial"; // default "linear"
      stops: GradientStop[];
      angle?: number; // linear only — degrees, 0 = →, 90 = ↓ (default 180 = top→bottom)
      opacity?: number;
    }
  | {
      type: "IMAGE";
      src: string; // data: URI or http(s) URL embedded as <image href>
      fit?: "cover" | "contain" | "fill"; // default "cover"
      opacity?: number;
    };

/** A paint's representative hex color: SOLID's color, or a GRADIENT's first stop.
 *  Undefined for IMAGE / empty. For reading a fill back as a swatch, not for rendering. */
export const paintColor = (p?: Paint): string | undefined =>
  p == null
    ? undefined
    : p.type === "SOLID"
      ? p.color
      : p.type === "GRADIENT"
        ? p.stops?.[0]?.color
        : undefined;

// A drop shadow rendered via SVG <filter><feDropShadow>. (x,y,blur,color) are the
// rasterizable subset; spread/inset are DOM-only and ignored by the SVG/raster path.
export interface Shadow {
  x?: number;
  y?: number;
  blur?: number;
  color?: string;
  spread?: number;
  inset?: boolean;
}

export type PrimitiveKind =
  | "frame"
  | "text"
  | "rectangle"
  | "oval"
  | "line"
  | "arrow"
  | "draw"
  | "input";

export type SizeMode = "hug" | "fixed" | "fill";
export type PositionMode = "inline" | "absolute" | "fixed" | "sticky";
export type SvgScaling = "stretch" | "aspect-fit" | "fill";

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
  // Structured depth — rendered as SVG filters so they survive rasterization (the agent
  // SEES them) AND show in the browser. Prefer these over the CSS-string fields below,
  // which only the DOM applies and the raster drops.
  shadow?: Shadow | Shadow[];
  blur?: number; // gaussian blur radius (px) applied to the node
  boxShadow?: string; // CSS string — DOM-only, not rasterized (kept for back-compat)
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
  align?: "START" | "CENTER" | "END"; // cross-axis (align-items)
  // Main-axis distribution (justify-content). START/CENTER/END pack children; SPACE_BETWEEN
  // pins the ends and spreads the gaps evenly; SPACE_AROUND adds equal space around each.
  justify?: "START" | "CENTER" | "END" | "SPACE_BETWEEN" | "SPACE_AROUND";
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
  kind: "line" | "arrow" | "draw" | "icon";
  // A raw SVG path `d` string, in the vector's own viewBox coords. Set for "icon"
  // vectors (glyphs from the icon library) where polyline points can't express curves;
  // when present it renders as a single <path d=…> scaled from viewBox to bbox.
  d?: string;
  // Points are local to bbox. This keeps resize as a bbox operation instead of a
  // destructive path rewrite and gives the future DOM compiler a clean viewBox.
  points: Array<[number, number]>;
  viewBox: [x: number, y: number, w: number, h: number];
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

// ---- Prototype interactivity (multi-screen flows) ----
// A click binding that makes a design playable. Attached to ANY node; the Play-mode
// runtime walks UP from the clicked element to the nearest node carrying one and
// executes the action. Purely declarative data — no handlers, so it survives the
// store/perception/raster pipeline like every other node field.
export type InteractionAction =
  | "navigate" // go to the screen `target` (a top-level FRAME with screen:true)
  | "toggle" // flip the Play-mode visibility of node `target` (dropdowns, switches)
  | "openOverlay" // show node `target` floating over the current screen (modals, sheets)
  | "closeOverlay" // dismiss the top open overlay
  | "back"; // pop the navigation stack to the previous screen

export interface Interaction {
  trigger: "click"; // v1: tap/click only
  action: InteractionAction;
  target?: NodeId; // required for navigate / toggle / openOverlay
}

// ---- Form inputs (stateful elements that bind to a cross-screen VARIABLE) ----
// An input node is a real, typeable control in Play mode. Its `field` is a variable
// name written into the client-side form store on change; any TEXT node anywhere in
// the prototype can read it back with the `{{field}}` placeholder (e.g. a summary
// screen showing "Welcome, {{name}}!"). Inputs never mutate the doc — their VALUES
// live in Play-mode runtime state — so the single-writer / read-only-mirror guarantee
// is preserved exactly like navigation and toggle state.
export type InputKind =
  | "text"
  | "email"
  | "password"
  | "number"
  | "textarea"
  | "select"
  | "checkbox"
  | "switch";

export interface InputSpec {
  field: string; // the variable name this control reads/writes — referenced as {{field}}
  kind: InputKind;
  placeholder?: string; // empty-state hint (text-like kinds)
  required?: boolean; // a 'navigate' click is blocked until every required field on the screen is filled
  options?: string[]; // choices for kind:"select"
  defaultValue?: string; // initial value; "true"/"false" for checkbox/switch
  label?: string; // inline caption rendered beside a checkbox/switch
}

export interface Node {
  id: NodeId;
  type: NodeType;
  name: string; // semantic index — "Hero", "CTA Button"
  bbox: [x: number, y: number, w: number, h: number];
  parent: NodeId | null;
  children: NodeId[]; // ids only, NEVER inlined nodes
  tid?: string; // stable template id; defaults to id when omitted
  primitive?: PrimitiveKind;
  // --- prototype interactivity ---
  screen?: boolean; // a top-level FRAME that is a navigable page in a prototype flow
  hidden?: boolean; // initial Play-mode visibility (toggle/overlay targets start hidden);
  // the editor canvas always renders it so it stays buildable/selectable.
  interactions?: Interaction[]; // click bindings that drive navigation/toggles in Play mode
  input?: InputSpec; // makes this node a stateful form control bound to a variable
  // --- projectable fields ---
  style?: NodeStyle;
  text?: TextStyle;
  layout?: LayoutStyle;
  vector?: VectorStyle;
  template?: TemplateProjection;
}

// The unit of {ops, version}. v1 ops are DESCRIPTIVE (not guaranteed-invertible).
export type Op =
  | { kind: "add"; node: Node; index?: number }
  | { kind: "remove"; id: NodeId }
  | { kind: "set"; id: NodeId; path: string; value: unknown } // "style.fills" | "bbox" | "layout"
  | { kind: "reparent"; id: NodeId; parent: NodeId; index: number };

export type ToolOk = { ops: Op[]; version: DocVersion };
export type ToolError = {
  error: "BAD_ID" | "STALE" | "CONSTRAINT" | "UNKNOWN_TOOL";
  detail: string;
};
export type ToolResult = ToolOk | ToolError;
export const isErr = (r: ToolResult): r is ToolError => "error" in r;
