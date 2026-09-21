export interface DisplayMathBlock {
  readonly latex: string;
  readonly raw: string;
  readonly start: number;
  readonly end: number;
}

const MAX_FENCE_INDENT = 3;
// Sticky (/y) regexes match in-place at lastIndex without substring memory allocation.
const CODE_FENCE_PATTERN = /(`{3,}|~{3,})/y;
const INLINE_CODE_PATTERN = /(`+)/y;

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findClosingIndex(text: string, delimiter: string, startIndex: number): number {
  let cursor = startIndex;
  while (cursor < text.length) {
    const found = text.indexOf(delimiter, cursor);
    if (found === -1) return -1;
    if (!isEscaped(text, found)) return found;
    cursor = found + delimiter.length;
  }
  return -1;
}

function isClosingFenceLine(line: string, char: string, minLength: number): boolean {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  if (indent > MAX_FENCE_INDENT || trimmed.length < minLength) return false;

  let charCount = 0;
  while (charCount < trimmed.length && trimmed[charCount] === char) {
    charCount++;
  }
  if (charCount < minLength) return false;

  return trimmed.slice(charCount).trim().length === 0;
}

function findClosingFenceOffset(text: string, startIndex: number, char: string, minLength: number): number {
  let lineStart = startIndex;
  while (lineStart < text.length) {
    const nextLineEnd = text.indexOf("\n", lineStart);
    const line = nextLineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, nextLineEnd);

    if (isClosingFenceLine(line, char, minLength)) {
      return nextLineEnd === -1 ? text.length : nextLineEnd + 1;
    }
    if (nextLineEnd === -1) break;
    lineStart = nextLineEnd + 1;
  }
  return text.length;
}

function skipCodeFence(text: string, startIndex: number): number {
  CODE_FENCE_PATTERN.lastIndex = startIndex;
  const match = CODE_FENCE_PATTERN.exec(text);
  if (!match) return startIndex + 1;

  const fence = match[1]!;
  const firstNewline = text.indexOf("\n", startIndex);
  if (firstNewline === -1) return text.length;

  return findClosingFenceOffset(text, firstNewline + 1, fence[0]!, fence.length);
}

function skipInlineCode(text: string, startIndex: number): number {
  INLINE_CODE_PATTERN.lastIndex = startIndex;
  const match = INLINE_CODE_PATTERN.exec(text);
  if (!match) return startIndex + 1;

  const len = match[1]!.length;
  const closing = text.indexOf(match[1]!, startIndex + len);
  return (closing === -1 ? startIndex : closing) + len;
}

function getDelimiterPair(text: string, index: number): { opening: string; closing: string } | undefined {
  if (text.startsWith("$$", index)) {
    return { opening: "$$", closing: "$$" };
  }
  if (text.startsWith("\\[", index)) {
    return { opening: "\\[", closing: "\\]" };
  }
  return undefined;
}

function extractDisplayMathAt(text: string, index: number): DisplayMathBlock | undefined {
  if (isEscaped(text, index)) return undefined;

  const delimiters = getDelimiterPair(text, index);
  if (!delimiters) return undefined;

  const contentStart = index + delimiters.opening.length;
  const closingIndex = findClosingIndex(text, delimiters.closing, contentStart);
  if (closingIndex === -1) return undefined;

  const latex = text.slice(contentStart, closingIndex).trim();
  if (latex.length === 0) return undefined;

  const end = closingIndex + delimiters.closing.length;
  return { latex, raw: text.slice(index, end), start: index, end };
}

function trySkipCode(markdown: string, index: number): number | undefined {
  if (markdown.startsWith("```", index) || markdown.startsWith("~~~", index)) {
    return skipCodeFence(markdown, index);
  }
  if (markdown[index] === "`") {
    return skipInlineCode(markdown, index);
  }
  return undefined;
}

export function findDisplayMathBlocks(markdown: string): DisplayMathBlock[] {
  const blocks: DisplayMathBlock[] = [];
  let index = 0;

  while (index < markdown.length) {
    const skipped = trySkipCode(markdown, index);
    if (skipped !== undefined) {
      index = skipped;
      continue;
    }

    const block = extractDisplayMathAt(markdown, index);
    if (block) {
      blocks.push(block);
      index = block.end;
      continue;
    }

    index++;
  }

  return blocks;
}
