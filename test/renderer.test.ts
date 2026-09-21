import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  renderLatexToSixel,
  clearRenderCache,
  getRenderCacheSize,
  encodeTransparentSixel,
  compressRunLength,
  parseHexColor,
} from "../src/renderer.js";

describe("renderer", () => {
  beforeEach(() => {
    clearRenderCache();
  });

  describe("hex color parsing", () => {
    it("parses valid 6-character hex colors", () => {
      assert.deepStrictEqual(parseHexColor("#ffffff"), { r: 255, g: 255, b: 255 });
      assert.deepStrictEqual(parseHexColor("#123456"), { r: 18, g: 52, b: 86 });
      assert.deepStrictEqual(parseHexColor("00ff00"), { r: 0, g: 255, b: 0 });
    });

    it("returns fallback for invalid hex colors", () => {
      const fallback = { r: 100, g: 100, b: 100 };
      assert.deepStrictEqual(parseHexColor("invalid", fallback), fallback);
      assert.deepStrictEqual(parseHexColor("#fff", fallback), fallback);
    });
  });

  describe("sixel run-length compression", () => {
    it("leaves runs shorter than 4 uncompressed", () => {
      assert.strictEqual(compressRunLength("A"), "A");
      assert.strictEqual(compressRunLength("AA"), "AA");
      assert.strictEqual(compressRunLength("AAA"), "AAA");
    });

    it("compresses runs of 4 or more with !count syntax", () => {
      assert.strictEqual(compressRunLength("AAAA"), "!4A");
      assert.strictEqual(compressRunLength("AAAAAAAAAA"), "!10A");
    });

    it("handles mixed repeating and non-repeating sequences", () => {
      assert.strictEqual(compressRunLength("AABBBBBCC"), "AA!5BCC");
    });
  });

  describe("transparent sixel encoding protocol", () => {
    it("does not emit drawing characters for completely transparent pixels", () => {
      // 2x6 image, all pixels transparent (alpha = 0)
      const pixels = new Uint8Array(2 * 6 * 4);
      const color = { r: 255, g: 255, b: 255 };
      const sixel = encodeTransparentSixel(pixels, 2, 6, color);

      // Must start with sixel header and end with ST (\x1b\)
      assert.ok(sixel.startsWith("\x1bP0;1;0q"));
      assert.ok(sixel.endsWith("\x1b\\"));

      // For transparent pixels, no drawing characters (#level followed by bits) should be emitted
      const paletteEnd = sixel.lastIndexOf(";100;100;100") + ";100;100;100".length;
      const dataSection = sixel.slice(paletteEnd);
      // Data section should only contain end-of-band '-' and escape '\x1b\'
      assert.strictEqual(dataSection.replace(/[-$\x1b\\]/g, ""), "");
    });

    it("encodes precise 6-bit vertical slices into correct ASCII characters", () => {
      // 1 column by 6 rows
      // y=0: opaque white (alpha 255) -> bit 0 set (1 << 0 = 1) -> ASCII 63 + 1 = 64 ('@')
      // y=1: transparent (alpha 0)
      // y=2: transparent (alpha 0)
      // y=3: transparent (alpha 0)
      // y=4: transparent (alpha 0)
      // y=5: transparent (alpha 0)
      const pixels = new Uint8Array(1 * 6 * 4);
      // y=0 RGBA
      pixels[0] = 255;
      pixels[1] = 255;
      pixels[2] = 255;
      pixels[3] = 255;

      const color = { r: 255, g: 255, b: 255 };
      const sixel = encodeTransparentSixel(pixels, 1, 6, color);

      // Color level 15 (fully opaque) must contain '@' (63 + 1)
      assert.ok(sixel.includes("#15@"));
    });

    it("encodes multiple bits in the same vertical slice correctly", () => {
      // 1 column by 6 rows
      // y=0: opaque -> bit 0 (value 1)
      // y=1: opaque -> bit 1 (value 2)
      // Sixel character = 63 + 1 + 2 = 66 ('B')
      const pixels = new Uint8Array(1 * 6 * 4);
      // row 0
      pixels[0] = 255; pixels[1] = 255; pixels[2] = 255; pixels[3] = 255;
      // row 1
      pixels[4] = 255; pixels[5] = 255; pixels[6] = 255; pixels[7] = 255;

      const color = { r: 255, g: 255, b: 255 };
      const sixel = encodeTransparentSixel(pixels, 1, 6, color);

      // Color level 15 must contain 'B' (63 + 3)
      assert.ok(sixel.includes("#15B"));
    });
  });

  describe("latex rendering pipeline", () => {
    it("renders basic LaTeX to Sixel string with rows and columns", () => {
      const result = renderLatexToSixel(String.raw`x = \frac{1}{2}`);
      assert.ok(result);
      assert.ok(result.widthPx > 0);
      assert.ok(result.heightPx > 0);
      assert.ok(result.columns > 0);
      assert.ok(result.rows > 0);
      assert.ok(result.sixel.startsWith("\x1bP0;1;0q"));
      assert.ok(result.sixel.endsWith("\x1b\\"));
    });

    it("scales down over-wide formulas to maxWidthPx in a single pass", () => {
      const longFormula = String.raw`x_1 + x_2 + x_3 + x_4 + x_5 + x_6 + x_7 + x_8 + x_9 + x_{10} + x_{11} + x_{12}`;
      const constrained = renderLatexToSixel(longFormula, { maxWidthPx: 200 });

      assert.ok(constrained);
      assert.ok(constrained.widthPx <= 200);
      assert.ok(constrained.columns > 0);
      assert.ok(constrained.rows > 0);
    });

    it("handles adversarial piecewise cases with inequalities without XML crash", () => {
      const casesFormula = String.raw`\begin{cases} -1, & x < 0 \\ 0, & x = 0 \\ 1, & x > 0 \end{cases}`;
      const result = renderLatexToSixel(casesFormula);

      assert.ok(result);
      assert.ok(result.sixel.startsWith("\x1bP0;1;0q"));
      assert.ok(result.rows >= 2);
    });

    it("handles matrices with column alignments and vectors", () => {
      const matrixFormula = String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix} \begin{pmatrix} x \\ y \end{pmatrix} = \boldsymbol{0}`;
      const result = renderLatexToSixel(matrixFormula);

      assert.ok(result);
      assert.ok(result.sixel.startsWith("\x1bP0;1;0q"));
    });

    it("handles calculus integrals and summations with limits", () => {
      const calculusFormula = String.raw`\int_{-\infty}^{\infty} e^{-x^2} \, dx = \sqrt{\pi}`;
      const result = renderLatexToSixel(calculusFormula);

      assert.ok(result);
      assert.ok(result.rows > 0);
    });

    it("returns undefined gracefully on malformed LaTeX", () => {
      const malformed = String.raw`\unknownMacro{xyz`;
      const result = renderLatexToSixel(malformed);
      assert.strictEqual(result, undefined);
    });
  });

  describe("render caching", () => {
    it("uses cache on identical formula calls", () => {
      const formula = "E = mc^2";
      const first = renderLatexToSixel(formula);
      assert.strictEqual(getRenderCacheSize(), 1);

      const second = renderLatexToSixel(formula);
      assert.strictEqual(getRenderCacheSize(), 1);
      assert.strictEqual(first?.sixel, second?.sixel);
    });

    it("clears cache correctly", () => {
      renderLatexToSixel("a^2 + b^2 = c^2");
      assert.strictEqual(getRenderCacheSize(), 1);
      clearRenderCache();
      assert.strictEqual(getRenderCacheSize(), 0);
    });
  });
});
