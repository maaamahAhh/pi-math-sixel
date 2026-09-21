import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
  extractHexColorFromAnsi,
  resolveTextColor,
  computeLeftPrefix,
  formatFormulaLines,
  installMarkdownPatch,
  type FormulaReplacement,
} from "../src/index.js";

const mockTheme: MarkdownTheme = {
  heading: (s: string) => s,
  bold: (s: string) => s,
  italic: (s: string) => s,
  code: (s: string) => s,
  codeBlock: (s: string) => s,
  codeBlockBorder: (s: string) => s,
  link: (s: string) => s,
  linkUrl: (s: string) => s,
  quote: (s: string) => s,
  quoteBorder: (s: string) => s,
  listBullet: (s: string) => s,
  underline: (s: string) => s,
  strikethrough: (s: string) => s,
  hr: (s: string) => s,
};

describe("extension", () => {
  describe("color resolution", () => {
    it("extracts hex color from 24-bit ANSI escape codes", () => {
      const ansi = "\x1b[38;2;255;128;64m";
      const hex = extractHexColorFromAnsi(ansi);
      assert.strictEqual(hex, "#ff8040");
    });

    it("returns undefined for non-24-bit ANSI codes", () => {
      assert.strictEqual(extractHexColorFromAnsi("\x1b[31m"), undefined);
      assert.strictEqual(extractHexColorFromAnsi("plain text"), undefined);
    });

    it("resolves dark mode text color", () => {
      const theme = {
        getColorMode: () => "dark",
        getFgAnsi: () => "\x1b[38;2;200;200;200m",
      };
      assert.strictEqual(resolveTextColor(theme), "#c8c8c8");
    });

    it("resolves light mode text color", () => {
      const theme = {
        getColorMode: () => "light",
        getFgAnsi: () => "\x1b[38;2;40;40;40m",
      };
      assert.strictEqual(resolveTextColor(theme), "#282828");
    });
  });

  describe("prefix and alignment", () => {
    it("computes left prefix correctly for alignment options", () => {
      assert.strictEqual(computeLeftPrefix(80, 20), " ");
      assert.strictEqual(computeLeftPrefix(80, 20, 1, "left"), " ");
      assert.strictEqual(computeLeftPrefix(80, 20, 1, undefined), " ");
      assert.strictEqual(computeLeftPrefix(80, 20, 0), "");
      assert.strictEqual(computeLeftPrefix(80, 20, 2), "  ");
      assert.strictEqual(computeLeftPrefix(80, 20, 1, "center"), " ".repeat(30));
      assert.strictEqual(computeLeftPrefix(80, 90, 1, "center"), "");
    });
  });

  describe("physical row reservation geometry", () => {
    it("reserves zero empty lines for a 1-row formula", () => {
      const mockMatch: FormulaReplacement = {
        marker: "MARKER_0",
        fallback: "$$x$$",
        result: {
          sixel: "\x1bP0;1;0q#0...SixelData\x1b\\",
          widthPx: 50,
          heightPx: 16,
          columns: 5,
          rows: 1,
        },
      };

      const lines = formatFormulaLines(mockMatch, 80, 1);
      assert.strictEqual(lines.length, 1);
      // No cursor up sequence needed for 1-row formulas
      assert.ok(!lines[0]?.includes("\x1b["));
      assert.ok(lines[0]?.includes("\x1b_G;q=2\x1b\\"));
    });

    it("reserves exact N-1 empty lines and moves cursor up for N-row formula", () => {
      const mockMatch: FormulaReplacement = {
        marker: "MARKER_0",
        fallback: "$$matrix$$",
        result: {
          sixel: "\x1bP0;1;0q#0...SixelData\x1b\\",
          widthPx: 100,
          heightPx: 72,
          columns: 12,
          rows: 4,
        },
      };

      const lines = formatFormulaLines(mockMatch, 80, 1);
      // Must produce exactly 3 empty lines + 1 sixel line = 4 physical terminal rows
      assert.strictEqual(lines.length, 4);
      assert.strictEqual(lines[0], "");
      assert.strictEqual(lines[1], "");
      assert.strictEqual(lines[2], "");

      // The final line must contain cursor-up \x1b[3A to position cursor before drawing
      const finalLine = lines[3]!;
      assert.ok(finalLine.includes("\x1b[3A"));
      assert.ok(finalLine.includes("\x1b_G;q=2\x1b\\"));
      assert.ok(finalLine.startsWith(" "));
    });

    it("returns raw fallback text when rendering fails", () => {
      const mockMatch: FormulaReplacement = {
        marker: "MARKER_0",
        fallback: "$$\\broken$$",
        result: undefined,
      };

      const lines = formatFormulaLines(mockMatch, 80, 1);
      assert.deepStrictEqual(lines, ["$$\\broken$$"]);
    });
  });

  describe("markdown integration", () => {
    it("renders display math left-aligned matching paddingX by default", () => {
      const uninstall = installMarkdownPatch(() => "#ffffff");

      try {
        const input = String.raw`Here is formula:
$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$
Done.`;

        const md = new Markdown(input, 1, 0, mockTheme);
        const lines = md.render(80);

        // Must contain Sixel sequence with P2=1 (transparent background) and Pi TUI APC prefix
        assert.ok(lines.some((line) => line.includes("\x1b_G;q=2\x1b\\") && line.includes("\x1bP0;1;0q")));

        // Sixel line must start with 1 space indent
        const sixelLine = lines.find((line) => line.includes("\x1bP0;1;0q"));
        assert.ok(sixelLine && sixelLine.startsWith(" "));

        // Post-formula text must be present after the formula rows
        assert.ok(lines.some((line) => line.includes("Done.")));

        // Source markdown must not be mutated
        assert.strictEqual((md as unknown as { text: string }).text, input);
      } finally {
        uninstall();
      }
    });

    it("renders multiple formulas in a single document without collision", () => {
      const uninstall = installMarkdownPatch(() => "#ffffff");

      try {
        const input = String.raw`First:
$$a^2 + b^2 = c^2$$
Middle text.
$$E = mc^2$$
End.`;

        const md = new Markdown(input, 1, 0, mockTheme);
        const lines = md.render(80);

        const sixelLines = lines.filter((line) => line.includes("\x1bP0;1;0q"));
        assert.strictEqual(sixelLines.length, 2);

        // Markers must be completely cleared from the rendered output
        assert.ok(!lines.some((line) => line.includes("PIMATHSIXELSLOT")));
      } finally {
        uninstall();
      }
    });

    it("passes through non-math markdown completely unchanged", () => {
      const uninstall = installMarkdownPatch(() => "#ffffff");

      try {
        const input = "This is a simple markdown without any math.";
        const md = new Markdown(input, 1, 0, mockTheme);
        const lines = md.render(80);

        assert.ok(!lines.some((line) => line.includes("\x1bP0;1;0q")));
        assert.ok(lines.some((line) => line.includes("This is a simple markdown")));
      } finally {
        uninstall();
      }
    });

    it("restores original render method on uninstall", () => {
      const beforeRender = Markdown.prototype.render;
      const uninstall = installMarkdownPatch(() => "#ffffff");

      assert.notStrictEqual(Markdown.prototype.render, beforeRender);
      uninstall();
      assert.strictEqual(Markdown.prototype.render, beforeRender);
    });
  });
});
