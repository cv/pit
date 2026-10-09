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
import { CATALOG_UPDATE_TYPE, type CatalogUpdateDetails } from "../functions/catalog-sections.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { elidedTargets } from "./shared.js";

type CustomMessage = Parameters<MessageRenderer>[0];

const COLLAPSED_NOTE_LINES = 6;
const NOTE_FRAME = /^<model-note key="[^"]*"[^>]*>\n([\s\S]*)\n<\/model-note>$/;

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
function noteBody(content: string): string {
  const framed = NOTE_FRAME.exec(content);
  return framed ? (framed[1] as string).replaceAll("<\\/model-note", "</model-note") : content;
}

export function renderNote(
  message: CustomMessage,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const text = messageText(message);
  const details = message.details as
    | { key?: unknown; version?: unknown; removed?: unknown }
    | undefined;
  const key = details?.key;
  const status =
    details?.removed === true
      ? "removed"
      : typeof details?.version === "number" && details.version > 1
        ? `v${details.version}`
        : undefined;
  const lines = clean(noteBody(text)).split("\n");
  const shown = options.expanded ? lines : lines.slice(0, COLLAPSED_NOTE_LINES);
  const omitted = lines.length - shown.length;
  const label = [
    theme.fg("customMessageLabel", theme.bold("Model note")),
    ...(typeof key === "string" ? [theme.fg("customMessageText", clean(key))] : []),
    ...(status ? [theme.fg("dim", status)] : []),
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

/** Saved-function changes the system prompt does not list yet: counts, then each change. */
export function renderCatalogUpdate(
  message: CustomMessage,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const details = message.details as Partial<CatalogUpdateDetails> | undefined;
  const counts = [
    details?.added ? `+${details.added}` : "",
    details?.removed ? `−${details.removed}` : "",
  ].filter(Boolean);
  const summary = [
    "Saved functions changed",
    ...(counts.length > 0 ? [counts.join(" ")] : []),
    "the system prompt lists them when the cache expires",
  ].join(" · ");
  const lines = [theme.fg("accent", summary)];
  if (options.expanded) {
    // The first line is the model-facing explanation the summary already gives.
    lines.push(
      ...clean(messageText(message))
        .split("\n")
        .slice(1)
        .map((line) => theme.fg("dim", line)),
    );
  }
  return new Text(lines.join("\n"), 1, 0);
}

function tokensPhrase(tokensFreed: number): string {
  return tokensFreed >= 0
    ? `~${formatTokens(tokensFreed)} tokens freed`
    : `~${formatTokens(-tokensFreed)} tokens added`;
}

function noteSummary(operation: ProvenanceOperation, count: number): string {
  const entries = plural(count, "old note entry", "old note entries");
  if (operation.action === "pruned") return `dropped ${entries}`;
  const dropped = count > 0 ? `, dropping ${entries}` : "";
  return `note "${operation.key}" ${operation.action}${dropped}`;
}

function operationSummary(operation: ProvenanceOperation): string {
  const count = operation.targets.length;
  switch (operation.operation) {
    case "elide":
      return `elided ${elidedTargets(count, operation.toolCallEntries)}`;
    case "summarize":
      return `summarized ${plural(operation.covers?.length ?? count, "entry", "entries")}`;
    default:
      return noteSummary(operation, count);
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
    // A new note has no targets: its estimate is its own size.
    const basis = operation.targets.length > 0 ? ` · ${CACHE_BASIS[operation.cacheMode]}` : "";
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
  pi.registerMessageRenderer(CATALOG_UPDATE_TYPE, renderCatalogUpdate);
  pi.registerEntryRenderer(PROVENANCE_TYPE, renderProvenance);
}
