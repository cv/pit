import {
  type Component,
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PREFIX_STYLE_RESET = "\u001b[22m\u001b[39m";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences start with ESC.
const SGR_CODE_PATTERN = /\u001b\[[0-9;]*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI SGR sequences start with ESC.
const LEADING_SGR_PATTERN = /^(?:\u001b\[[0-9;]*m)*/;

function removeInheritedPrefixStyles(value: string, prefix: string): string {
  const prefixStyles = prefix.match(SGR_CODE_PATTERN) ?? [];
  const leading = value.match(LEADING_SGR_PATTERN)?.[0] ?? "";
  let sanitized = leading;
  for (const style of prefixStyles) {
    const index = sanitized.lastIndexOf(style);
    if (index >= 0) {
      sanitized = sanitized.slice(0, index) + sanitized.slice(index + style.length);
    }
  }
  return sanitized + value.slice(leading.length);
}

export class HangingIndentText implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly text: string,
    private readonly hangingIndents: Readonly<Record<number, number>>,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    if (!this.text || this.text.trim() === "") {
      return [];
    }

    const rendered: string[] = [];
    const logicalLines = this.text.replace(/\t/g, "   ").split("\n");
    for (const [index, line] of logicalLines.entries()) {
      const hangingIndent = this.hangingIndents[index];
      if (hangingIndent !== undefined && hangingIndent > 0 && hangingIndent < width) {
        const lineWidth = visibleWidth(line);
        const prefix = sliceByColumn(line, 0, hangingIndent);
        const content = removeInheritedPrefixStyles(
          sliceByColumn(line, hangingIndent, Math.max(0, lineWidth - hangingIndent)),
          prefix,
        );
        const wrapped = wrapTextWithAnsi(content, Math.max(1, width - hangingIndent));
        const [first = "", ...continuations] = wrapped;
        const styleReset = prefix.includes("\u001b[") ? PREFIX_STYLE_RESET : "";
        rendered.push(prefix + styleReset + first);
        rendered.push(
          ...continuations.map((continuation) => `${" ".repeat(hangingIndent)}${continuation}`),
        );
      } else {
        rendered.push(...wrapTextWithAnsi(line, Math.max(1, width)));
      }
    }

    this.cachedWidth = width;
    this.cachedLines = rendered.map((line) => {
      const padding = Math.max(0, width - visibleWidth(line));
      return line + " ".repeat(padding);
    });
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
