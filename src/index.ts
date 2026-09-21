import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, Markdown } from "@earendil-works/pi-tui";
import { findDisplayMathBlocks, type DisplayMathBlock } from "./parser.js";
import { renderLatexToSixel, type RenderResult } from "./renderer.js";

const DEFAULT_DARK_TEXT = "#e0e0e0";
const DEFAULT_LIGHT_TEXT = "#1e1e1e";
const DEFAULT_PADDING_X = 1;
const MIN_FORMULA_MAX_WIDTH_PX = 100;

// APC escape sequence (\x1b_G;q=2\x1b\) that signals Pi TUI to treat this line as an image.
const PI_TUI_IMAGE_PREFIX = "\x1b_G;q=2\x1b\\";

export function extractHexColorFromAnsi(ansi: string): string | undefined {
  const match = /(?:^|[;[])38;2;(\d{1,3});(\d{1,3});(\d{1,3})(?=m|;)/u.exec(ansi);
  if (!match) return undefined;

  const channels = match.slice(1).map(Number);
  if (!channels.every((val) => Number.isInteger(val) && val >= 0 && val <= 255)) {
    return undefined;
  }

  return `#${channels.map((val) => val.toString(16).padStart(2, "0")).join("")}`;
}

export function resolveTextColor(theme?: {
  getColorMode?(): string;
  getFgAnsi?(name: string): string;
}): string {
  const fallback = theme?.getColorMode?.() === "light" ? DEFAULT_LIGHT_TEXT : DEFAULT_DARK_TEXT;
  if (!theme?.getFgAnsi) return fallback;

  try {
    const fgAnsi = theme.getFgAnsi("text");
    return (fgAnsi && extractHexColorFromAnsi(fgAnsi)) || fallback;
  } catch {
    return fallback;
  }
}

export function computeLeftPrefix(
  width: number,
  columns: number,
  paddingX = DEFAULT_PADDING_X,
  align = process.env.PI_MATH_SIXEL_ALIGN,
): string {
  if (align?.toLowerCase() === "center") {
    return " ".repeat(Math.max(0, Math.floor((width - columns) / 2)));
  }
  return " ".repeat(Math.max(0, paddingX));
}

interface MarkdownInstance {
  text: string;
  paddingX?: number;
}

export interface FormulaReplacement {
  readonly marker: string;
  readonly result: RenderResult | undefined;
  readonly fallback: string;
}

interface PreparationOptions {
  readonly color: string;
  readonly width: number;
  readonly cell: { widthPx: number; heightPx: number };
}

function hasDisplayMath(source: unknown): source is string {
  return typeof source === "string" && (source.includes("$$") || source.includes("\\["));
}

function createSingleReplacement(
  block: DisplayMathBlock,
  index: number,
  options: PreparationOptions,
  maxWidthPx: number,
): FormulaReplacement {
  return {
    // Uses purely alphanumeric token to prevent Marked from treating delimiters as formatting.
    marker: `PIMATHSIXELSLOT${index}TOKEN`,
    result: renderLatexToSixel(block.latex, {
      color: options.color,
      maxWidthPx,
      cellWidthPx: options.cell.widthPx,
      cellHeightPx: options.cell.heightPx,
    }),
    fallback: block.raw,
  };
}

export function prepareFormulaReplacements(
  source: string,
  blocks: DisplayMathBlock[],
  options: PreparationOptions,
): { transformed: string; replacements: FormulaReplacement[] } {
  const maxWidthPx = Math.max(MIN_FORMULA_MAX_WIDTH_PX, options.width * options.cell.widthPx);
  const replacements: FormulaReplacement[] = [];
  let transformed = "";
  let lastIndex = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const item = createSingleReplacement(block, i, options, maxWidthPx);
    replacements.push(item);
    transformed += source.slice(lastIndex, block.start) + `\n\n${item.marker}\n\n`;
    lastIndex = block.end;
  }

  return { transformed: transformed + source.slice(lastIndex), replacements };
}

// Pre-allocates empty lines so Pi TUI reserves terminal height, then cursor-ups (\x1b[NA)
// back to the top of the reserved area before outputting the Sixel image.
export function formatFormulaLines(
  match: FormulaReplacement,
  width: number,
  paddingX: number,
): string[] {
  if (!match.result) return [match.fallback];

  const { sixel, columns, rows } = match.result;
  const rowOffset = Math.max(0, rows - 1);
  const prefix = computeLeftPrefix(width, columns, paddingX);
  const moveUp = rowOffset > 0 ? `\x1b[${rowOffset}A` : "";

  return Array.from({ length: rowOffset }, () => "").concat(
    `${prefix}${moveUp}${PI_TUI_IMAGE_PREFIX}${sixel}`,
  );
}

export function formatRenderedOutput(
  lines: string[],
  replacements: FormulaReplacement[],
  width: number,
  paddingX: number,
): string[] {
  return lines.flatMap((line) => {
    const match = replacements.find((r) => line.includes(r.marker));
    return match ? formatFormulaLines(match, width, paddingX) : line;
  });
}

function renderMathMarkdown(
  instance: MarkdownInstance,
  baseRender: (width: number) => string[],
  width: number,
  getTextColor: () => string,
): string[] {
  const source = instance.text;
  if (!hasDisplayMath(source)) return baseRender.call(instance, width);

  const blocks = findDisplayMathBlocks(source);
  if (blocks.length === 0) return baseRender.call(instance, width);

  const options = { color: getTextColor(), width, cell: getCellDimensions() };
  const { transformed, replacements } = prepareFormulaReplacements(source, blocks, options);

  instance.text = transformed;
  try {
    const pad = typeof instance.paddingX === "number" ? instance.paddingX : DEFAULT_PADDING_X;
    return formatRenderedOutput(baseRender.call(instance, width), replacements, width, pad);
  } finally {
    instance.text = source;
  }
}

export function installMarkdownPatch(getTextColor: () => string): () => void {
  const baseRender = Markdown.prototype.render;

  Markdown.prototype.render = function (width: number): string[] {
    return renderMathMarkdown(this as unknown as MarkdownInstance, baseRender, width, getTextColor);
  };

  return () => {
    Markdown.prototype.render = baseRender;
  };
}

export default function piMathSixel(pi: ExtensionAPI): void {
  let currentTextColor = DEFAULT_DARK_TEXT;

  const updateColor = (ctx?: ExtensionContext) => {
    if (!ctx?.ui?.theme) return;
    currentTextColor = resolveTextColor(ctx.ui.theme);
  };

  pi.on("session_start", (_event, ctx) => updateColor(ctx));
  pi.on("turn_start", (_event, ctx) => updateColor(ctx));

  const uninstall = installMarkdownPatch(() => currentTextColor);
  pi.on("session_shutdown", () => uninstall());
}
