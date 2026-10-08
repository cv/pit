import { Type } from "typebox";

import { CACHE_BASIS, formatTokens } from "../context/planning.js";
import { CLOSED, shapeGuard } from "../shared/shape-guard.js";
import { sanitizeTerminalText } from "../shared/text-sanitization.js";
import { elidedTargets, plural } from "./shared.js";
import type { RenderContext, RenderedResultValue } from "./types.js";

/** For example `warm · idle 45s of 4m 30s` or `unknown lifetime · idle 2m`. */
function describeCache(cache: {
  state: "warm" | "cold" | "unknown";
  idleSeconds: number | null;
  ttlSeconds: number | null;
  refreshedBy: "request" | "warming" | null;
}): string {
  const state = cache.state === "unknown" ? "unknown lifetime" : cache.state;
  if (cache.idleSeconds === null) return `${state} · nothing cached yet`;
  const of = cache.ttlSeconds === null ? "" : ` of ${seconds(cache.ttlSeconds)}`;
  const by = cache.refreshedBy === "warming" ? " since Pi refreshed it" : "";
  return `${state} · idle ${seconds(cache.idleSeconds)}${of}${by}`;
}

function seconds(total: number): string {
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = Math.round(total % 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
}

const CACHE_MODE = Type.Union([
  Type.Literal("breakpoints"),
  Type.Literal("prefix"),
  Type.Literal("unknown"),
]);

const isReceipt = shapeGuard(
  Type.Object(
    {
      status: Type.Literal("staged"),
      appliesAt: Type.Union([Type.Literal("turn_end"), Type.Literal("run_end")]),
      operation: Type.Union([
        Type.Literal("elide"),
        Type.Literal("summarize"),
        Type.Literal("note"),
      ]),
      targets: Type.Array(Type.String()),
      estimatedTokensFreed: Type.Number(),
      estimatedReprefillTokens: Type.Number(),
      key: Type.Optional(Type.String()),
      action: Type.Optional(Type.String()),
      summarizedEntries: Type.Optional(Type.Number()),
      summaryTokens: Type.Optional(Type.Number()),
      toolCallEntries: Type.Optional(Type.Number()),
      droppedEntries: Type.Optional(Type.Number()),
      cacheMode: CACHE_MODE,
    },
    CLOSED,
  ),
);

const isOutline = shapeGuard(
  Type.Object(
    {
      leafId: Type.Union([Type.String(), Type.Null()]),
      contextTokens: Type.Union([Type.Number(), Type.Null()]),
      contextWindow: Type.Union([Type.Number(), Type.Null()]),
      estimatedTokens: Type.Number(),
      cacheMode: Type.Optional(CACHE_MODE),
      cache: Type.Optional(
        Type.Object({
          state: Type.Union([Type.Literal("warm"), Type.Literal("cold"), Type.Literal("unknown")]),
          idleSeconds: Type.Union([Type.Number(), Type.Null()]),
          ttlSeconds: Type.Union([Type.Number(), Type.Null()]),
          refreshedBy: Type.Union([Type.Literal("request"), Type.Literal("warming"), Type.Null()]),
        }),
      ),
      entries: Type.Array(
        Type.Object(
          {
            id: Type.String(),
            role: Type.String(),
            tool: Type.Optional(Type.String()),
            key: Type.Optional(Type.String()),
            tokens: Type.Number(),
            reprefillTokens: Type.Number(),
            state: Type.String(),
            editable: Type.Boolean(),
            protectedReason: Type.Optional(Type.String()),
            pending: Type.Optional(Type.String()),
            superseded: Type.Optional(Type.Boolean()),
            preview: Type.String(),
          },
          CLOSED,
        ),
      ),
      nextAfter: Type.Optional(Type.String()),
      omitted: Type.Number(),
    },
    CLOSED,
  ),
);

const isNoteListing = shapeGuard(
  Type.Object(
    {
      notes: Type.Array(
        Type.Object(
          {
            key: Type.String(),
            entryId: Type.String(),
            tokens: Type.Number(),
            pending: Type.Optional(Type.Boolean()),
          },
          CLOSED,
        ),
      ),
      tokens: Type.Number(),
      // Optional: listings from before old note versions stayed in context still render.
      supersededTokens: Type.Optional(Type.Number()),
      budgetTokens: Type.Number(),
      maxNotes: Type.Number(),
    },
    CLOSED,
  ),
);

const clean = (text: string) => sanitizeTerminalText(text);

function effect(tokensFreed: number): string {
  return tokensFreed >= 0
    ? `~${formatTokens(tokensFreed)} tokens freed`
    : `~${formatTokens(-tokensFreed)} tokens added`;
}

function receiptSubject(receipt: {
  operation: string;
  targets: string[];
  key?: string;
  action?: string;
  summarizedEntries?: number;
  toolCallEntries?: number;
  droppedEntries?: number;
}): string {
  switch (receipt.operation) {
    case "elide":
      return `elide of ${elidedTargets(receipt.targets.length, receipt.toolCallEntries)}`;
    case "summarize":
      return `summary of ${plural(receipt.summarizedEntries ?? receipt.targets.length, "entry", "entries")}`;
    default:
      return `note "${clean(receipt.key ?? "?")}" ${clean(receipt.action ?? "change")}${
        receipt.droppedEntries
          ? `, dropping ${plural(receipt.droppedEntries, "old note entry", "old note entries")}`
          : ""
      }`;
  }
}

/** A staged session.* edit: say plainly that it applies later, and only if the call succeeds. */
export function renderContextReceipt(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (!isReceipt(value)) return undefined;
  const subject = receiptSubject(value);
  const tokens = effect(value.estimatedTokensFreed);
  const when =
    value.appliesAt === "run_end" ? "applies when the run ends" : "applies after this turn";
  return {
    kind: "staged",
    lines: [
      `${theme.fg("toolTitle", theme.bold("session"))} staged ${subject} ${theme.fg("dim", `(${tokens} · ${when})`)}`,
    ],
    summary: `${subject} · ${tokens} · ${when}`,
    detailLines: [
      ...(value.targets.length > 0 ? [`targets: ${clean(value.targets.join(", "))}`] : []),
      `re-prefill: ~${formatTokens(value.estimatedReprefillTokens)} tokens${
        // A note that only appends re-prefills its own size whatever the cache.
        value.cacheMode && !(value.operation === "note" && !value.droppedEntries)
          ? ` · ${CACHE_BASIS[value.cacheMode]}`
          : ""
      }`,
      ...(value.summaryTokens === undefined
        ? []
        : [`summary: ~${formatTokens(value.summaryTokens)} tokens`]),
    ],
  };
}

function usageText(value: { contextTokens: number | null; contextWindow: number | null }): string {
  if (value.contextTokens === null) return "";
  const window = value.contextWindow === null ? "" : ` of ${formatTokens(value.contextWindow)}`;
  return ` · ${formatTokens(value.contextTokens)}${window} in context`;
}

/** session.outline(): one readable row per entry instead of nested JSON. */
export function renderContextOutline(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (!isOutline(value)) return undefined;
  const more = value.omitted > 0 ? ` · ${value.omitted} more` : "";
  const summary = `${plural(value.entries.length, "entry", "entries")} · ~${formatTokens(value.estimatedTokens)} tokens listed${usageText(value)}${more}`;
  const detailLines = value.entries.flatMap((entry) => {
    const facts = [
      `${formatTokens(entry.tokens)} tokens`,
      `re-prefill ${formatTokens(entry.reprefillTokens)}`,
      entry.state,
      ...(entry.pending ? [`pending ${entry.pending}`] : []),
      ...(entry.protectedReason ? [`protected: ${entry.protectedReason}`] : []),
    ];
    const label = [
      entry.role,
      entry.tool,
      entry.key === undefined ? undefined : `"${entry.key}"`,
      entry.superseded ? "superseded" : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return [
      `${theme.fg("accent", entry.id)} ${clean(label)} ${theme.fg("dim", `· ${clean(facts.join(" · "))}`)}`,
      ...(entry.preview ? [`  ${clean(entry.preview)}`] : []),
    ];
  });
  detailLines.push(theme.fg("dim", `leaf: ${value.leafId ?? "none"}`));
  if (value.cacheMode) {
    detailLines.push(theme.fg("dim", `re-prefill: ${CACHE_BASIS[value.cacheMode]}`));
  }
  if (value.cache) detailLines.push(theme.fg("dim", `cache: ${describeCache(value.cache)}`));
  if (value.nextAfter) {
    detailLines.push(theme.fg("dim", `next page: after ${value.nextAfter}`));
  }
  return {
    kind: "context",
    lines: [
      `${theme.fg("toolTitle", theme.bold("session outline"))} ${theme.fg("dim", `(${summary})`)}`,
    ],
    summary,
    detailLines,
  };
}

/** session.notes(): live notes and how much of the note budget they and superseded versions use. */
export function renderNoteListing(
  value: unknown,
  { theme }: RenderContext,
): RenderedResultValue | undefined {
  if (!isNoteListing(value)) return undefined;
  const superseded = value.supersededTokens
    ? ` + ~${formatTokens(value.supersededTokens)} superseded`
    : "";
  const summary = `${plural(value.notes.length, "live note")} · ~${formatTokens(value.tokens)}${superseded} of ~${formatTokens(value.budgetTokens)} note tokens`;
  return {
    kind: "context",
    lines: [
      `${theme.fg("toolTitle", theme.bold("session notes"))} ${theme.fg("dim", `(${summary})`)}`,
    ],
    summary,
    detailLines: [
      ...value.notes.map(
        (note) =>
          `${clean(note.key)} · ${note.entryId} · ~${formatTokens(note.tokens)} tokens${note.pending ? " · change staged" : ""}`,
      ),
      theme.fg("dim", `limit: ${value.maxNotes} notes`),
    ],
  };
}
