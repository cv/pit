import {
  type Component,
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PREFIX_STYLE_RESET = "\u001b[22m\u001b[39m";

const SGR_START = "\u001b[";

function readSgrCode(value: string, start: number): string | undefined {
  if (!value.startsWith(SGR_START, start)) {
    return undefined;
  }
  let end = start + SGR_START.length;
  while (end < value.length) {
    const character = value.charAt(end);
    if (character === "m") {
      return value.slice(start, end + 1);
    }
    if (character !== ";" && (character < "0" || character > "9")) {
      return undefined;
    }
    end += 1;
  }
  return undefined;
}

function sgrCodes(value: string): string[] {
  const codes: string[] = [];
  for (let index = 0; index < value.length; ) {
    const start = value.indexOf(SGR_START, index);
    if (start < 0) {
      break;
    }
    const code = readSgrCode(value, start);
    if (code) {
      codes.push(code);
      index = start + code.length;
    } else {
      index = start + SGR_START.length;
    }
  }
  return codes;
}

function leadingSgr(value: string): string {
  let end = 0;
  for (;;) {
    const code = readSgrCode(value, end);
    if (!code) {
      return value.slice(0, end);
    }
    end += code.length;
  }
}

function removeInheritedPrefixStyles(value: string, prefix: string): string {
  const prefixStyles = sgrCodes(prefix);
  const leading = leadingSgr(value);
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
