export interface DesignSystemColor {
  name: string;
  value: string;
  count: number;
}

export interface DesignSystemComponent {
  name: string;
  kind: string;
  details: string[];
}

export interface DesignSystemProfile {
  id: string;
  name: string;
  source: string;
  importedAt: string;
  colors: DesignSystemColor[];
  fonts: string[];
  fontSizes: string[];
  fontWeights: string[];
  spacing: string[];
  radii: string[];
  shadows: string[];
  components: DesignSystemComponent[];
  principles: string[];
  promptSummary: string;
  stats: {
    htmlBytes: number;
    colorCount: number;
    componentCount: number;
  };
}

export interface DesignSystemImportOptions {
  source?: string;
  importedAt?: string;
}

const MAX_BRIEF_CHARS = 2800;
const SYSTEM_FONTS = new Set([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "-apple-system",
  "blinkmacsystemfont",
  "inherit",
  "ui-sans-serif",
  "ui-monospace",
]);

export function importDesignSystemFromHtml(
  html: string,
  options: DesignSystemImportOptions = {},
): DesignSystemProfile {
  const importedAt = options.importedAt ?? new Date().toISOString();
  const expanded = expandBundledTemplate(html);
  const source = options.source?.trim() || "Imported HTML";
  const text = normalizeText(stripTags(expanded));
  const name = inferName(expanded, text, source);
  const colors = extractColors(expanded);
  const fonts = extractFonts(expanded);
  const fontSizes = rankedPxValues(expanded, /font-size\s*:\s*([0-9.]+px)/gi, 10);
  const fontWeights = rankedValues(expanded, /font-weight\s*:\s*([0-9]{3}|bold|semibold|medium)/gi, 8);
  const spacing = extractSpacing(expanded);
  const radii = rankedPxValues(expanded, /border-radius\s*:\s*([0-9.]+px|999px|50%)/gi, 8);
  const shadows = extractShadows(expanded);
  const components = extractComponents(expanded, text);
  const principles = extractPrinciples(text);
  const promptSummary = buildPromptSummary({
    name,
    source,
    colors,
    fonts,
    fontSizes,
    fontWeights,
    spacing,
    radii,
    shadows,
    components,
    principles,
  });

  return {
    id: stableId(name, source, importedAt),
    name,
    source,
    importedAt,
    colors,
    fonts,
    fontSizes,
    fontWeights,
    spacing,
    radii,
    shadows,
    components,
    principles,
    promptSummary,
    stats: {
      htmlBytes: html.length,
      colorCount: colors.length,
      componentCount: components.length,
    },
  };
}

function expandBundledTemplate(html: string): string {
  const parts = [html];
  const templateRe = /<script\b[^>]*type=["']__bundler\/template["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = templateRe.exec(html))) {
    const raw = decodeEntities(m[1].trim());
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "string") parts.push(parsed);
    } catch {
      parts.push(raw);
    }
  }
  return parts.join("\n");
}

function inferName(html: string, text: string, source: string): string {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title && !/^(bundled page|untitled|document)$/i.test(normalizeText(title))) {
    return normalizeText(stripTags(title)).slice(0, 80);
  }

  const sourceName = decodeURIComponent(source.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "");
  if (/\bdesign system\b/i.test(sourceName)) return normalizeText(sourceName).slice(0, 80);

  const designSystemName =
    firstMatch(text, /\b([A-Z][A-Za-z0-9& -]{2,64}\s+Design System)\b/) ??
    firstMatch(text, /\b([A-Z][A-Za-z0-9& -]{2,40}\s+(?:UI|Component|Pattern)\s+System)\b/);
  if (designSystemName) return normalizeText(designSystemName).slice(0, 80);

  const brand = firstMatch(text, /\b([A-Z][A-Za-z0-9&-]{2,24})\s+is\s+a\s+[^.]{10,120}design/i);
  if (brand) return `${brand} Design System`;

  return sourceName ? sourceName.slice(0, 80) : "Imported Design System";
}

function extractColors(html: string): DesignSystemColor[] {
  const map = new Map<string, { count: number; names: Map<string, number> }>();
  const add = (value: string, name?: string) => {
    const color = normalizeHex(value);
    if (!color) return;
    const entry = map.get(color) ?? { count: 0, names: new Map<string, number>() };
    entry.count += 1;
    if (name) {
      const clean = cleanTokenName(name);
      if (clean) entry.names.set(clean, (entry.names.get(clean) ?? 0) + 1);
    }
    map.set(color, entry);
  };
  const addName = (value: string, name: string, weight = 1) => {
    const color = normalizeHex(value);
    const clean = cleanTokenName(name);
    if (!color || !clean) return;
    const entry = map.get(color) ?? { count: 0, names: new Map<string, number>() };
    entry.names.set(clean, (entry.names.get(clean) ?? 0) + weight);
    map.set(color, entry);
  };

  for (const match of html.matchAll(/#[0-9a-f]{3,8}\b/gi)) add(match[0]);
  for (const match of html.matchAll(/--([a-z0-9-_]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi)) {
    add(match[2], match[1]);
  }
  for (const match of html.matchAll(/(?:name|role|token|label)\s*:\s*['"]([^'"]{1,40})['"][^{}]{0,140}?hex\s*:\s*['"](#[0-9a-f]{3,8})['"]/gi)) {
    add(match[2], match[1]);
  }
  for (const match of html.matchAll(/hex\s*:\s*['"](#[0-9a-f]{3,8})['"][^{}]{0,140}?(?:name|role|token|label)\s*:\s*['"]([^'"]{1,40})['"]/gi)) {
    add(match[1], match[2]);
  }
  for (const match of html.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*\[([\s\S]*?)\];/g)) {
    const family = familyNameForTokenArray(match[1]);
    if (!family) continue;
    for (const item of match[2].matchAll(/(?:name|role|token|label)\s*:\s*['"]([^'"]{1,40})['"][^{}]{0,140}?hex\s*:\s*['"](#[0-9a-f]{3,8})['"]/gi)) {
      addName(item[2], `${family} ${item[1]}`, 4);
    }
  }

  const candidates = [...map.entries()]
    .map(([value, entry]) => {
      const names = [...entry.names.entries()].sort((a, b) => b[1] - a[1]);
      const tokenName = names[0]?.[0];
      return {
        name: tokenName ?? roleForColor(value, entry.count),
        value,
        count: entry.count,
      };
    })
    .sort((a, b) => colorRank(b) - colorRank(a));
  return selectBalancedColors(candidates, 18);
}

function extractFonts(html: string): string[] {
  const counts = new Map<string, number>();
  const primary = new Set<string>();
  const add = (raw: string) => {
    for (const part of raw.split(",")) {
      const font = part.trim().replace(/^['"]|['"]$/g, "");
      const key = font.toLowerCase();
      if (!font || SYSTEM_FONTS.has(key)) continue;
      counts.set(font, (counts.get(font) ?? 0) + 1);
    }
  };

  for (const match of html.matchAll(/font-family\s*:\s*([^;"'}]+)/gi)) add(match[1]);
  for (const match of html.matchAll(/font-family\s*:\s*['"]([^'"]+)['"]/gi)) add(match[1]);
  for (const match of html.matchAll(/\bbody\s*\{[^}]*font-family\s*:\s*([^;"}]+)/gi)) {
    for (const part of match[1].split(",")) {
      const font = part.trim().replace(/^['"]|['"]$/g, "");
      if (font && !SYSTEM_FONTS.has(font.toLowerCase())) primary.add(font);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => (primary.has(b[0]) ? 1000 : 0) + b[1] - ((primary.has(a[0]) ? 1000 : 0) + a[1]))
    .map(([font]) => font)
    .slice(0, 6);
}

function extractSpacing(html: string): string[] {
  const values = new Map<string, number>();
  const add = (v: string) => {
    if (!v.endsWith("px")) return;
    const n = Number(v.replace("px", ""));
    if (!Number.isFinite(n) || n < 0 || n > 128) return;
    values.set(v, (values.get(v) ?? 0) + 1);
  };

  for (const match of html.matchAll(/\b(?:gap|padding|margin(?:-[a-z]+)?)\s*:\s*([^;"'}]+)/gi)) {
    for (const part of match[1].split(/\s+/)) add(part.trim());
  }
  for (const match of html.matchAll(/\bpx\s*:\s*['"]([0-9.]+px)['"]/gi)) add(match[1]);

  return [...values.entries()]
    .sort((a, b) => numericPx(a[0]) - numericPx(b[0]))
    .filter((entry, index, arr) => index === 0 || entry[0] !== arr[index - 1][0])
    .sort((a, b) => b[1] - a[1] || numericPx(a[0]) - numericPx(b[0]))
    .slice(0, 10)
    .map(([v]) => v);
}

function extractShadows(html: string): string[] {
  const values = rankedValues(html, /box-shadow\s*:\s*([^;"'}]+)/gi, 4);
  return values.map((v) => v.replace(/\s+/g, " ").trim()).filter((v) => v !== "none");
}

function extractComponents(html: string, text: string): DesignSystemComponent[] {
  const components: DesignSystemComponent[] = [];
  const buttonStyles = [...html.matchAll(/<button\b[^>]*style=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi)]
    .slice(0, 2)
    .map((m) => styleDetail(m[1], stripTags(m[2])));
  if (buttonStyles.length || /\bbuttons?\b/i.test(text)) {
    components.push({
      name: "Buttons",
      kind: "button",
      details: buttonStyles.length ? buttonStyles : ["Use clear primary and secondary action treatments."],
    });
  }

  const hasInput = /<input\b|<textarea\b|<select\b|\bforms?\b|\bfield\b/i.test(html);
  if (hasInput) {
    components.push({
      name: "Forms",
      kind: "form",
      details: ["Pair labels with fields; use imported input colors, radii, and spacing."],
    });
  }

  const rules: Array<[RegExp, DesignSystemComponent]> = [
    [/\bcalendar\b|calDays|weekdays/i, { name: "Calendar", kind: "calendar", details: ["Use selected-range, weekday, and date-cell patterns from the import."] }],
    [/\blistings?\b|\blist rows?\b|\bcards?\b/i, { name: "Cards & lists", kind: "list", details: ["Use repeated cards/rows with imported surface, border, and gap rhythm."] }],
    [/\btabs?\b|\bfilters?\b|\bchips?\b/i, { name: "Tabs & filters", kind: "tabs", details: ["Use active/inactive chip and tab contrast from the system."] }],
    [/\bmodal\b|\bsheet\b|\boverlay\b/i, { name: "Overlays", kind: "overlay", details: ["Use imported modal/sheet radius, backdrop, and elevation."] }],
    [/\btoast\b|\balerts?\b|\bfeedback\b/i, { name: "Feedback", kind: "feedback", details: ["Use calm semantic alert and toast treatments."] }],
    [/\bratings?\b|\breviews?\b|\bstars?\b/i, { name: "Ratings", kind: "rating", details: ["Use star/rating summary patterns where relevant."] }],
    [/\bnav\b|navigation|top nav/i, { name: "Navigation", kind: "navigation", details: ["Use compact navigation with imported typography and active states."] }],
    [/\bprice\b|\btotal\b|\bcheckout\b|\bbooking\b/i, { name: "Booking details", kind: "commerce", details: ["Use price, total, and reservation summary patterns when building booking flows."] }],
  ];

  const seen = new Set(components.map((c) => c.kind));
  for (const [re, component] of rules) {
    if (!seen.has(component.kind) && re.test(`${html}\n${text}`)) {
      components.push(component);
      seen.add(component.kind);
    }
  }
  return components.slice(0, 12);
}

function extractPrinciples(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.length >= 24 && s.length <= 180);
  const scored = sentences
    .map((s) => ({
      s,
      score: [
        /\bwarm\b/i,
        /\bcalm\b/i,
        /\bsoft\b/i,
        /\bgenerous\b/i,
        /\baccent\b/i,
        /\bprimary action\b/i,
        /\bbooking\b/i,
        /\bdesign language\b/i,
      ].filter((re) => re.test(s)).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return unique(scored.map((x) => x.s)).slice(0, 4);
}

function buildPromptSummary(profile: Omit<DesignSystemProfile, "id" | "importedAt" | "promptSummary" | "stats">): string {
  const lines = [
    `Active imported design system: ${profile.name} (${profile.source}).`,
    "Use this design system by default for new apps, screens, and components unless the user explicitly asks for a different visual direction.",
  ];
  if (profile.principles.length) lines.push(`Principles: ${profile.principles.join(" ")}`);
  if (profile.colors.length)
    lines.push(`Colors: ${profile.colors.slice(0, 12).map((c) => `${c.name} ${c.value}`).join(", ")}.`);
  if (profile.fonts.length || profile.fontSizes.length || profile.fontWeights.length) {
    lines.push(
      `Typography: ${[
        profile.fonts.length ? `families ${profile.fonts.join(", ")}` : "",
        profile.fontSizes.length ? `sizes ${profile.fontSizes.join(", ")}` : "",
        profile.fontWeights.length ? `weights ${profile.fontWeights.join(", ")}` : "",
      ].filter(Boolean).join("; ")}.`,
    );
  }
  if (profile.spacing.length || profile.radii.length || profile.shadows.length) {
    lines.push(
      `Shape and spacing: ${[
        profile.spacing.length ? `spacing ${profile.spacing.join(", ")}` : "",
        profile.radii.length ? `radii ${profile.radii.join(", ")}` : "",
        profile.shadows.length ? `shadows/elevation present` : "",
      ].filter(Boolean).join("; ")}.`,
    );
  }
  if (profile.components.length) {
    lines.push(
      `Component families: ${profile.components
        .map((c) => `${c.name} (${c.details.slice(0, 2).join("; ")})`)
        .join("; ")}.`,
    );
  }
  lines.push(
    "When composing UI, reuse these tokens and component families for forms, buttons, colors, lists, calendars, navigation, overlays, and feedback patterns instead of inventing a generic style.",
  );
  const out = lines.join("\n");
  return out.length <= MAX_BRIEF_CHARS ? out : `${out.slice(0, MAX_BRIEF_CHARS - 1)}…`;
}

function rankedPxValues(html: string, re: RegExp, limit: number): string[] {
  return rankedValues(html, re, limit)
    .sort((a, b) => numericPx(b) - numericPx(a))
    .slice(0, limit);
}

function rankedValues(html: string, re: RegExp, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(re)) {
    const value = normalizeText(match[1]);
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value]) => value)
    .slice(0, limit);
}

function styleDetail(style: string, label: string): string {
  const props = ["background", "color", "border", "border-radius", "padding", "box-shadow", "font-weight", "font-size"];
  const details = props
    .map((prop) => {
      const value = firstMatch(style, new RegExp(`${prop}\\s*:\\s*([^;]+)`, "i"));
      return value ? `${prop} ${value.trim()}` : "";
    })
    .filter(Boolean);
  const prefix = normalizeText(label).slice(0, 36);
  return `${prefix ? `"${prefix}": ` : ""}${details.slice(0, 5).join(", ")}`;
}

function colorRank(color: DesignSystemColor): number {
  const neutralPenalty = /^(#fff(?:fff)?|#000(?:000)?)$/i.test(color.value) ? -120 : 0;
  const nameBonus = /primary|accent|brand/i.test(color.name)
    ? 150
    : /success|warning|error|info/i.test(color.name)
      ? 80
      : /text|background|neutral|surface/i.test(color.name)
        ? 30
        : 0;
  return color.count + nameBonus + neutralPenalty;
}

function selectBalancedColors(colors: DesignSystemColor[], limit: number): DesignSystemColor[] {
  const out: DesignSystemColor[] = [];
  const familyCounts = new Map<string, number>();
  for (const color of colors) {
    const family = color.name.split(/\s+/)[0]?.toLowerCase() || "color";
    const maxForFamily = family === "primary" ? 6 : 4;
    const count = familyCounts.get(family) ?? 0;
    if (count >= maxForFamily) continue;
    out.push(color);
    familyCounts.set(family, count + 1);
    if (out.length >= limit) return out;
  }
  for (const color of colors) {
    if (!out.includes(color)) out.push(color);
    if (out.length >= limit) break;
  }
  return out;
}

function roleForColor(value: string, count: number): string {
  const v = value.toUpperCase();
  if (v === "#FFFFFF" || v === "#FFF") return "white";
  if (v === "#000000" || v === "#000") return "black";
  if (count > 8 && relativeLuminance(v) < 0.18) return "text";
  if (count > 8 && relativeLuminance(v) > 0.86) return "surface";
  if (count > 12) return "core";
  return "color";
}

function relativeLuminance(hex: string): number {
  const m = /^#([0-9A-F]{6})$/i.exec(hex);
  if (!m) return 0.5;
  const rgb = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function familyNameForTokenArray(name: string): string | null {
  if (/brand|primary|accent/i.test(name)) return "primary";
  if (/neutral|sand|cream|surface/i.test(name)) return "neutral";
  if (/semantic/i.test(name)) return "";
  return null;
}

function normalizeHex(value: string): string | null {
  const raw = value.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(raw);
  if (!m) return null;
  const hex = m[1];
  if (hex.length === 3) return `#${hex.split("").map((c) => c + c).join("")}`.toUpperCase();
  return `#${hex.slice(0, 6)}`.toUpperCase();
}

function cleanTokenName(value: string): string {
  return normalizeText(value)
    .replace(/^[0-9]+\s*[·.-]\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 36);
}

function stableId(name: string, source: string, importedAt: string): string {
  const slug = `${name}-${source}-${importedAt}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return slug || "imported-design-system";
}

function numericPx(value: string): number {
  if (value === "50%") return 50;
  const n = Number(value.replace("px", ""));
  return Number.isFinite(n) ? n : 0;
}

function firstMatch(input: string, re: RegExp): string | null {
  return re.exec(input)?.[1] ?? null;
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function normalizeText(value: string): string {
  return decodeEntities(value).replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
