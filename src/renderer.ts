import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Resvg, type RenderedImage } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);

export interface RenderOptions {
  readonly color?: string;
  readonly maxWidthPx?: number;
  readonly zoom?: number;
  readonly cellWidthPx?: number;
  readonly cellHeightPx?: number;
}

export interface RenderResult {
  readonly sixel: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly columns: number;
  readonly rows: number;
}

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const DEFAULT_COLOR = "#e0e0e0";
const DEFAULT_RGB: RgbColor = { r: 224, g: 224, b: 224 };
const DEFAULT_MAX_WIDTH_PX = 800;
const DEFAULT_ZOOM = 2;
const DEFAULT_CELL_WIDTH_PX = 9;
const DEFAULT_CELL_HEIGHT_PX = 18;
const MAX_CACHE_SIZE = 128;

// Sixel protocol constants: 6 vertical pixels per char, base character '?' (ASCII 63).
const ALPHA_LEVELS = 15;
const SIXEL_BASE_ASCII = 63;
const SIXEL_BAND_HEIGHT = 6;
const MIN_RLE_RUN_LENGTH = 4;

class SimpleLruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

interface MathJaxContext {
  readonly adaptor: { innerHTML(node: unknown): string };
  readonly document: { convert(latex: string, options: { display: boolean }): unknown };
}

let mathJaxInstance: MathJaxContext | undefined;

// Loaded on demand so importing this extension takes < 1ms during Pi cold startup.
function initMathJaxInstance(): MathJaxContext {
  const { liteAdaptor } = require("@mathjax/src/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = require("@mathjax/src/js/handlers/html.js");
  const { TeX } = require("@mathjax/src/js/input/tex.js");
  require("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
  require("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
  require("@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js");
  require("@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js");
  require("@mathjax/src/js/input/tex/configmacros/ConfigMacrosConfiguration.js");
  const { mathjax } = require("@mathjax/src/js/mathjax.js");
  require("@mathjax/src/js/util/asyncLoad/node.js");
  const { SVG } = require("@mathjax/src/js/output/svg.js");

  const adaptor = liteAdaptor({ fontSize: 16 });
  RegisterHTMLHandler(adaptor);
  const svgOutput = new SVG({ fontCache: "local" });
  svgOutput.font.loadDynamicFilesSync();
  const texInput = new TeX({
    packages: ["base", "ams", "newcommand", "boldsymbol", "configmacros"],
  });
  const document = mathjax.document("", { InputJax: texInput, OutputJax: svgOutput });
  return { adaptor, document };
}

function getMathJax(): MathJaxContext {
  if (!mathJaxInstance) {
    mathJaxInstance = initMathJaxInstance();
  }
  return mathJaxInstance;
}

export function parseHexColor(hex: string, fallback: RgbColor = DEFAULT_RGB): RgbColor {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return fallback;
  return {
    r: Number.parseInt(match[1]!, 16),
    g: Number.parseInt(match[2]!, 16),
    b: Number.parseInt(match[3]!, 16),
  };
}

function computeCacheKey(latex: string, color: string, maxWidthPx: number, zoom: number): string {
  return createHash("sha256")
    .update(`${latex}\0${color}\0${maxWidthPx}\0${zoom}`)
    .digest("hex");
}

function convertLatexToSvg(latex: string, color: string): string {
  const { adaptor, document } = getMathJax();
  const node = document.convert(latex, { display: true });
  const rawSvg = adaptor.innerHTML(node);
  if (rawSvg.includes('data-mml-node="merror"') || rawSvg.includes("<merror>")) {
    throw new Error("MathJax produced merror node");
  }
  const cleanedSvg = rawSvg.replace(/\s*data-latex="[\s\S]*?"/g, "");
  return cleanedSvg.replace("<svg ", `<svg color="${color}" fill="currentColor" `);
}

// MathJax sets width in 'ex'. In SVG standard and Resvg (12px default font), 1ex = 6px.
function extractSvgWidthPx(svg: string): number | undefined {
  const exMatch = /width="([\d.]+)ex"/.exec(svg);
  if (exMatch) return Math.round(Number.parseFloat(exMatch[1]!) * 6);

  const vbMatch = /viewBox="[^"]*\s+([\d.]+)\s+[\d.]+"/.exec(svg);
  if (vbMatch) return Math.round((Number.parseFloat(vbMatch[1]!) / 1000) * 12);

  return undefined;
}

function rasterizeSvg(svg: string, maxWidthPx: number, zoom: number): RenderedImage {
  const naturalWidth = extractSvgWidthPx(svg);
  const targetWidth = (naturalWidth ?? 0) * zoom;

  const fitTo = targetWidth > maxWidthPx
    ? { mode: "width" as const, value: maxWidthPx }
    : { mode: "zoom" as const, value: zoom };

  return new Resvg(svg, {
    font: { loadSystemFonts: false },
    fitTo,
  }).render();
}

function appendRun(char: string, count: number): string {
  if (count >= MIN_RLE_RUN_LENGTH) return `!${count}${char}`;
  if (count > 0) return char.repeat(count);
  return "";
}

export function compressRunLength(chars: string): string {
  let result = "";
  let count = 0;
  let lastChar = "";

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i]!;
    if (char === lastChar) {
      count++;
      continue;
    }

    result += appendRun(lastChar, count);
    lastChar = char;
    count = 1;
  }

  return result + appendRun(lastChar, count);
}

function buildPaletteHeader(width: number, height: number, color: RgbColor): string {
  let header = `\x1bP0;1;0q"1;1;${width};${height}`;
  for (let level = 1; level <= ALPHA_LEVELS; level++) {
    const alphaRatio = level / ALPHA_LEVELS;
    const pr = Math.round((color.r / 255) * alphaRatio * 100);
    const pg = Math.round((color.g / 255) * alphaRatio * 100);
    const pb = Math.round((color.b / 255) * alphaRatio * 100);
    header += `#${level};2;${pr};${pg};${pb}`;
  }
  return header;
}

function buildAlphaGrid(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const alphaGrid = new Uint8Array(width * height);
  for (let i = 0; i < alphaGrid.length; i++) {
    const alpha = pixels[i * 4 + 3] ?? 0;
    alphaGrid[i] = alpha === 0 ? 0 : Math.max(1, Math.min(ALPHA_LEVELS, Math.round((alpha / 255) * ALPHA_LEVELS)));
  }
  return alphaGrid;
}

interface BandScanResult {
  readonly bandBits: Uint8Array;
  readonly levelActive: Uint8Array;
}

// Scans 6 vertical rows once, assigning bits directly to their respective alpha level.
function collectBandBitmasks(
  alphaGrid: Uint8Array,
  width: number,
  height: number,
  startY: number,
): BandScanResult {
  const maxRow = Math.min(SIXEL_BAND_HEIGHT, height - startY);
  const bandBits = new Uint8Array(ALPHA_LEVELS * width);
  const levelActive = new Uint8Array(ALPHA_LEVELS);

  for (let row = 0; row < maxRow; row++) {
    const rowOffset = (startY + row) * width;
    const bit = 1 << row;
    for (let x = 0; x < width; x++) {
      const level = alphaGrid[rowOffset + x];
      if (level > 0) {
        bandBits[(level - 1) * width + x] |= bit;
        levelActive[level - 1] = 1;
      }
    }
  }

  return { bandBits, levelActive };
}

function serializeBandLevels(bandBits: Uint8Array, levelActive: Uint8Array, width: number): string {
  let output = "";
  let isFirstColor = true;

  for (let l = 0; l < ALPHA_LEVELS; l++) {
    if (!levelActive[l]) continue;

    let chars = "";
    const offset = l * width;
    for (let x = 0; x < width; x++) {
      chars += String.fromCharCode(SIXEL_BASE_ASCII + bandBits[offset + x]!);
    }

    output += `${isFirstColor ? "" : "$" }#${l + 1}${compressRunLength(chars)}`;
    isFirstColor = false;
  }

  return output + "-";
}

function encodeBandSinglePass(
  alphaGrid: Uint8Array,
  width: number,
  height: number,
  startY: number,
): string {
  const { bandBits, levelActive } = collectBandBitmasks(alphaGrid, width, height, startY);
  return serializeBandLevels(bandBits, levelActive, width);
}

export function encodeTransparentSixel(
  pixels: Uint8Array,
  width: number,
  height: number,
  color: RgbColor,
): string {
  let output = buildPaletteHeader(width, height, color);
  const alphaGrid = buildAlphaGrid(pixels, width, height);

  for (let y = 0; y < height; y += SIXEL_BAND_HEIGHT) {
    output += encodeBandSinglePass(alphaGrid, width, height, y);
  }

  return output + "\x1b\\";
}

const renderCache = new SimpleLruCache<string, RenderResult>(MAX_CACHE_SIZE);

function buildRenderResult(
  image: RenderedImage,
  sixel: string,
  options: RenderOptions,
): RenderResult {
  const cellW = options.cellWidthPx ?? DEFAULT_CELL_WIDTH_PX;
  const cellH = options.cellHeightPx ?? DEFAULT_CELL_HEIGHT_PX;
  return {
    sixel,
    widthPx: image.width,
    heightPx: image.height,
    columns: Math.ceil(image.width / cellW),
    rows: Math.ceil(image.height / cellH),
  };
}

export function renderLatexToSixel(latex: string, options: RenderOptions = {}): RenderResult | undefined {
  const color = options.color ?? DEFAULT_COLOR;
  const maxWidthPx = options.maxWidthPx ?? DEFAULT_MAX_WIDTH_PX;
  const zoom = options.zoom ?? DEFAULT_ZOOM;

  const cacheKey = computeCacheKey(latex, color, maxWidthPx, zoom);
  const cached = renderCache.get(cacheKey);
  if (cached) return cached;

  try {
    const svg = convertLatexToSvg(latex, color);
    const image = rasterizeSvg(svg, maxWidthPx, zoom);
    const sixel = encodeTransparentSixel(image.pixels, image.width, image.height, parseHexColor(color));

    const result = buildRenderResult(image, sixel, options);
    renderCache.set(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

export function clearRenderCache(): void {
  renderCache.clear();
}

export function getRenderCacheSize(): number {
  return renderCache.size;
}
