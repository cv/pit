import type { Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import type { FunctionInspection } from "./inspection.js";

type MetadataLine = {
  label?: string;
  text: string;
};

export class FunctionViewer {
  private lines: string[] = [];
  private omitted = 0;

  constructor(
    private readonly definition: FunctionInspection,
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {
    this.rebuildHighlighting();
  }

  private rebuildHighlighting(): void {
    const source = this.definition.source ?? "";
    const safeSource = sanitizeTerminalText(source);
    const width = safeSource
      .split("\n")
      .reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 1);
    const highlighted = source
      ? wrapTextWithAnsi(highlightCode(safeSource, "typescript").join("\n"), width)
      : [];
    this.lines = highlighted.slice(0, 500);
    this.omitted = highlighted.length - this.lines.length;
  }

  render(width: number): string[] {
    const definition = this.definition;
    const metadata = [
      {
        label: "Scope",
        text: `${definition.scope}${definition.effective ? " (effective)" : ` (shadowed; effective: ${definition.effectiveScope})`}`,
      },
      {
        label: "Implementation",
        text: `${definition.kind}${definition.readOnly ? "; read-only" : ""}${definition.sealed ? "; sealed" : ""}`,
      },
      { label: "Origin", text: definition.origin },
      { label: "Signature", text: definition.signature },
      ...(definition.documentation ? [{ text: definition.documentation }] : []),
      { label: "Override chain", text: "" },
      ...definition.overrideChain.map((entry) => ({
        text: `  ${entry.scope}${entry.effective ? " (effective)" : ""}${entry.available ? "" : " (invalid)"}: ${entry.origin}`,
      })),
      {
        label: "Dependencies",
        text:
          definition.resolvedDependencies
            .map((entry) => `${entry.name} [${entry.scope ?? "missing"}]`)
            .join(", ") || "none",
      },
      {
        label: "$next",
        text: definition.next
          ? `${definition.next.name} [${definition.next.scope}]${definition.next.available ? "" : " (invalid)"}`
          : "none",
      },
      { label: "Direct effects", text: definition.directEffects.join(", ") || "none" },
      {
        label: "Transitive effects",
        text: definition.error ? "unavailable" : definition.effects.join(", ") || "none",
      },
      ...(definition.error ? [{ label: "Unavailable", text: definition.error }] : []),
      ...(definition.kind === "native"
        ? [{ text: "Native-backed definition; no authored source is exposed." }]
        : []),
    ];
    const metadataLines = metadata.flatMap<MetadataLine>((line) => {
      const safeText = sanitizeTerminalText(line.text).split("\n");
      return safeText.map((text, index) => {
        const label = index === 0 && line.label ? sanitizeTerminalText(line.label) : undefined;
        return label ? { label, text } : { text };
      });
    });
    return [
      truncateToWidth(this.theme.fg("toolTitle", this.theme.bold(definition.name)), width),
      "",
      ...metadataLines.slice(0, 80).map((line) => {
        const content = line.label
          ? `${this.theme.fg("accent", `${line.label}: `)}${this.theme.fg("text", line.text)}`
          : this.theme.fg("text", line.text);
        return truncateToWidth(content, width);
      }),
      ...(metadataLines.length > 80
        ? [truncateToWidth(this.theme.fg("muted", "… metadata lines omitted"), width)]
        : []),
      "",
      ...this.lines.map((line) => truncateToWidth(line, width)),
      ...(this.omitted
        ? [truncateToWidth(this.theme.fg("muted", `… ${this.omitted} source lines omitted`), width)]
        : []),
      "",
      truncateToWidth(this.theme.fg("dim", "Enter/Esc/q to close"), width),
    ];
  }

  invalidate(): void {
    this.rebuildHighlighting();
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, "enter") ||
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data === "q"
    )
      this.close();
  }
}
