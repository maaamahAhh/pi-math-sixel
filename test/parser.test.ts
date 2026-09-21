import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDisplayMathBlocks } from "../src/parser.js";

describe("parser", () => {
  it("finds standard $$...$$ display math", () => {
    const text = "Formula:\n$$x = \\frac{1}{2}$$\nDone.";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "x = \\frac{1}{2}");
    assert.strictEqual(blocks[0]?.raw, "$$x = \\frac{1}{2}$$");
    assert.strictEqual(blocks[0]?.start, 9);
    assert.strictEqual(blocks[0]?.end, 28);
  });

  it("finds \\[...\\] display math", () => {
    const text = "Euler:\n\\[e^{i\\pi} + 1 = 0\\]";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "e^{i\\pi} + 1 = 0");
    assert.strictEqual(blocks[0]?.raw, "\\[e^{i\\pi} + 1 = 0\\]");
  });

  it("finds multiple distinct display math blocks in sequence", () => {
    const text = "First $$a^2 + b^2 = c^2$$ then second \\[x + y = z\\] end.";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[0]?.latex, "a^2 + b^2 = c^2");
    assert.strictEqual(blocks[1]?.latex, "x + y = z");
  });

  it("handles multiline display math blocks", () => {
    const text = "$$\n\\begin{aligned}\n  a &= b + c \\\\\n  d &= e + f\n\\end{aligned}\n$$";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0]?.latex.includes("\\begin{aligned}"));
    assert.ok(blocks[0]?.latex.includes("\\end{aligned}"));
  });

  it("ignores display math inside backtick fenced code blocks", () => {
    const text = "```markdown\n$$not_math$$\n```\n$$real_math$$";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "real_math");
  });

  it("ignores display math inside tilde fenced code blocks", () => {
    const text = "~~~python\n$$not_math$$\n~~~\n$$real_math$$";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "real_math");
  });

  it("handles indented closing fences properly up to 3 spaces", () => {
    const text = "```\n$$hidden$$\n   ```\n$$visible$$";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "visible");
  });

  it("ignores display math inside inline code", () => {
    const text = "Use `$$inline$$` in docs, but $$display$$ here.";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "display");
  });

  it("ignores display math inside multi-backtick inline code", () => {
    const text = "Use ``$$not_inline$$`` in docs, but $$display$$ here.";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0]?.latex, "display");
  });

  it("ignores escaped dollar signs and escaped brackets", () => {
    const text = String.raw`Cost is \$$100 and \$$200, not \\[100\\] formula.`;
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 0);
  });

  it("ignores empty math blocks with whitespace only", () => {
    const text = "Empty: $$   $$ and \\[ \\]";
    const blocks = findDisplayMathBlocks(text);
    assert.strictEqual(blocks.length, 0);
  });
});
