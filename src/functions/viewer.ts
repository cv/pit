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
      `Scope: ${definition.scope}${definition.effective ? " (effective)" : ` (shadowed; effective: ${definition.effectiveScope})`}`,
      `Implementation: ${definition.kind}${definition.readOnly ? "; read-only" : ""}${definition.sealed ? "; sealed" : ""}`,
      `Origin: ${definition.origin}`,
      `Signature: ${definition.signature}`,
      ...(definition.documentation ? [definition.documentation] : []),
      "Override chain:",
      ...definition.overrideChain.map(
        (entry) =>
          `  ${entry.scope}${entry.effective ? " (effective)" : ""}${entry.available ? "" : " (invalid)"}: ${entry.origin}`,
      ),
      `Dependencies: ${definition.resolvedDependencies.map((entry) => `${entry.name} [${entry.scope ?? "missing"}]`).join(", ") || "none"}`,
      `$next: ${definition.next ? `${definition.next.name} [${definition.next.scope}]${definition.next.available ? "" : " (invalid)"}` : "none"}`,
      `Direct effects: ${definition.directEffects.join(", ") || "none"}`,
      `Transitive effects: ${definition.error ? "unavailable" : definition.effects.join(", ") || "none"}`,
      ...(definition.error ? [`Unavailable: ${definition.error}`] : []),
      ...(definition.kind === "native"
        ? ["Native-backed definition; no authored source is exposed."]
        : []),
    ];
    const metadataLines = metadata.flatMap((line) => sanitizeTerminalText(line).split("\n"));
    return [
      truncateToWidth(this.theme.fg("toolTitle", this.theme.bold(definition.name)), width),
      "",
      ...metadataLines
        .slice(0, 80)
        .map((line) => truncateToWidth(this.theme.fg("dim", line), width)),
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
