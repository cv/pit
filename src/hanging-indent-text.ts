import {
  type Component,
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PREFIX_STYLE_RESET = "\u001b[22m\u001b[39m";

function stripSgrCodes(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      let end = index + 2;
      while (end < value.length) {
        const code = value.charCodeAt(end);
        if (!((code >= 48 && code <= 57) || code === 59)) {
          break;
        }
        end += 1;
      }
      if (value.charAt(end) === "m") {
        index = end;
        continue;
      }
    }
    result += value.charAt(index);
  }
  return result;
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
        const content = stripSgrCodes(
          sliceByColumn(line, hangingIndent, Math.max(0, lineWidth - hangingIndent)),
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
