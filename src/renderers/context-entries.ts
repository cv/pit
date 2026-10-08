import type {
  CustomEntry,
  ExtensionAPI,
  MessageRenderer,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";

import type { NoticeDetails } from "../context/notices.js";
import { CACHE_BASIS, formatTokens, textTokens } from "../context/planning.js";
import {
  NOTE_TYPE,
  NOTICE_TYPE,
  PROVENANCE_TYPE,
  type ProvenanceOperation,
} from "../context/view.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { elidedTargets } from "./shared.js";

type CustomMessage = Parameters<MessageRenderer>[0];

const COLLAPSED_NOTE_LINES = 6;
const NOTE_FRAME = /^<model-note key="[^"]*">\n([\s\S]*)\n<\/model-note>$/;

function clean(text: string): string {
  return sanitizeTerminalText(text);
}

function messageText(message: CustomMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

/** The note as the model wrote it, without the frame Pit adds for the model. */
export function noteBody(content: string): string {
  const framed = NOTE_FRAME.exec(content);
  return framed ? (framed[1] as string).replaceAll("<\\/model-note", "</model-note") : content;
}

export function renderNote(
  message: CustomMessage,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const text = messageText(message);
  const key = (message.details as { key?: unknown } | undefined)?.key;
  const lines = clean(noteBody(text)).split("\n");
  const shown = options.expanded ? lines : lines.slice(0, COLLAPSED_NOTE_LINES);
  const omitted = lines.length - shown.length;
  const label = [
    theme.fg("customMessageLabel", theme.bold("Model note")),
    ...(typeof key === "string" ? [theme.fg("customMessageText", clean(key))] : []),
    theme.fg("dim", `~${formatTokens(textTokens(text))} tokens`),
  ].join(theme.fg("dim", " · "));
  const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
  box.addChild(new Text(label, 0, 0));
  box.addChild(new Text(theme.fg("customMessageText", shown.join("\n")), 0, 1));
  if (omitted > 0) {
    box.addChild(new Text(theme.fg("dim", `… ${plural(omitted, "more line")}`), 0, 0));
  }
  return box;
}

function noticeDetails(details: unknown): NoticeDetails | undefined {
  const value = details as Partial<NoticeDetails> | undefined;
  return typeof value?.percent === "number" &&
    typeof value.tokens === "number" &&
    typeof value.contextWindow === "number"
    ? (value as NoticeDetails)
    : undefined;
}

export function renderNotice(
  message: CustomMessage,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = noticeDetails(message.details);
  // A percentage threshold shows in the usage; a token threshold, such as 200K, needs naming.
  const absolute =
    details && typeof details.threshold === "string" && !details.threshold.endsWith("%")
      ? ` · passed ${clean(details.threshold)}`
      : "";
  const summary = details
    ? `Context ${details.percent}% full · ~${formatTokens(details.tokens)} of ${formatTokens(details.contextWindow)} tokens${absolute}`
    : "Context pressure notice";
  const lines = [theme.fg("warning", `▲ ${summary}`)];
  if (options.expanded || !details) lines.push(theme.fg("dim", clean(messageText(message))));
  return new Text(lines.join("\n"), 1, 0);
}

function tokensPhrase(tokensFreed: number): string {
  return tokensFreed >= 0
    ? `~${formatTokens(tokensFreed)} tokens freed`
    : `~${formatTokens(-tokensFreed)} tokens added`;
}

function operationSummary(operation: ProvenanceOperation): string {
  const count = operation.targets.length;
  switch (operation.operation) {
    case "elide":
      return `elided ${elidedTargets(count, operation.toolCallEntries)}`;
    case "summarize":
      return `summarized ${plural(operation.covers?.length ?? count, "entry", "entries")}`;
    case "restore":
      return `restored ${plural(count, "entry", "entries")}`;
    default:
      return `note "${operation.key ?? "?"}" ${operation.action ?? "changed"}`;
  }
}

function isOperation(value: unknown): value is ProvenanceOperation {
  const operation = value as Partial<ProvenanceOperation> | undefined;
  return (
    typeof operation?.operation === "string" &&
    Array.isArray(operation.targets) &&
    operation.targets.every((target) => typeof target === "string") &&
    typeof operation.tokensFreed === "number" &&
    typeof operation.reprefillTokens === "number"
  );
}

function operationLines(operation: ProvenanceOperation, expanded: boolean, theme: Theme): string[] {
  const parts = [
    theme.fg("accent", "Context edit"),
    clean(operationSummary(operation)),
    tokensPhrase(operation.tokensFreed),
    ...(operation.reason ? [`reason: ${clean(operation.reason)}`] : []),
  ];
  const lines = [parts.join(theme.fg("dim", " · "))];
  if (expanded) {
    if (operation.targets.length > 0) {
      lines.push(theme.fg("dim", `  entries: ${clean(operation.targets.join(", "))}`));
    }
    // Older records lack the mode, and a new note has no targets: its estimate is its own size.
    const mode = operation.cacheMode;
    const basis =
      mode && Object.hasOwn(CACHE_BASIS, mode) && operation.targets.length > 0
        ? ` · ${CACHE_BASIS[mode]}`
        : "";
    lines.push(
      theme.fg("dim", `  re-prefill: ~${formatTokens(operation.reprefillTokens)} tokens${basis}`),
    );
  }
  return lines;
}

export function renderProvenance(
  entry: CustomEntry,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const operations = (entry.data as { operations?: unknown } | undefined)?.operations;
  if (!Array.isArray(operations) || !operations.every(isOperation)) {
    const lines = [theme.fg("warning", "Context edit record in an unrecognized format")];
    if (options.expanded && entry.data !== undefined) {
      lines.push(theme.fg("dim", clean(JSON.stringify(entry.data))));
    }
    return new Text(lines.join("\n"), 1, 0);
  }
  return new Text(
    operations
      .flatMap((operation) => operationLines(operation, options.expanded, theme))
      .join("\n"),
    1,
    0,
  );
}

export function registerContextRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(NOTE_TYPE, renderNote);
  pi.registerMessageRenderer(NOTICE_TYPE, renderNotice);
  pi.registerEntryRenderer(PROVENANCE_TYPE, renderProvenance);
}
