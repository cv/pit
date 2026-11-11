import type { ToolExecutionApi } from "@earendil-works/pi-durable";

import type { NativeFunctionHandler } from "../host/native-dispatcher.js";
import {
  boundedIntegerValue as boundedInteger,
  recordValue as object,
  stringArrayValue as stringArray,
  stringValue as string,
} from "../shared/argument-values.js";
import type { EditTiming } from "./context/apply.js";
import { planElide, planSummarize, type PlannedEdit } from "./context/edits.js";
import { describeNotes, readNotes } from "./context/notes.js";
import type { StagedContextChanges } from "./context/staging.js";
import {
  type ContextItem,
  type ContextRole,
  type ContextView,
  type EntryRecord,
  type Message,
  readContextView,
} from "./context/view.js";
import { PitDurableUnavailableError } from "./host.js";

type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];

const ROLES: readonly ContextRole[] = ["user", "assistant", "toolResult", "custom", "summary"];
const OUTLINE_LIMITS = {
  limit: { maximum: 200, fallback: 50 },
  previewChars: { maximum: 2_000, fallback: 200 },
} as const;
const INSPECT_LIMITS = { limit: { maximum: 40_000, fallback: 20_000 }, visibleChars: 4_000 };
// pi-durable does not report the provider's cache, so receipts estimate as Pi does when unknown.
const CACHE = { state: "unknown", idleSeconds: null, ttlSeconds: null, refreshedBy: null } as const;

export interface DurableSessionServices {
  api: Pick<ToolExecutionApi, "commit" | "conversation" | "conversationId" | "callId" | "snapshot">;
  context: ToolContext;
  contextWindow: number | undefined;
  /** Where this call's edits and notes wait until the call succeeds. */
  staging: StagedContextChanges;
}

function messageText(message: Message): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  return (content as Array<Record<string, unknown>>)
    .map((block) => {
      if (block.type === "text") return String(block.text);
      if (block.type === "thinking") return String(block.thinking);
      if (block.type === "toolCall") {
        return `→ ${String(block.name)} ${JSON.stringify(block.arguments)}`;
      }
      return "[image omitted]";
    })
    .join("\n");
}

function messagesText(messages: readonly Message[]): string {
  return messages.map(messageText).join("\n");
}

function roles(value: unknown): Set<ContextRole> | undefined {
  if (value === undefined) return undefined;
  const selected = stringArray(value, "options.roles");
  const unknown = selected.find((role) => !ROLES.includes(role as ContextRole));
  if (unknown !== undefined) {
    throw new Error(
      `options.roles contains unknown role "${unknown}"; expected ${ROLES.join(", ")}`,
    );
  }
  return new Set(selected as ContextRole[]);
}

function outline(view: ContextView, args: unknown[]) {
  const options = args[0] === undefined ? {} : object(args[0]);
  const after = options.after === undefined ? undefined : string(options.after, "options.after");
  const limit = boundedInteger(options.limit, "options.limit", OUTLINE_LIMITS.limit);
  const previewChars = boundedInteger(
    options.previewChars,
    "options.previewChars",
    OUTLINE_LIMITS.previewChars,
  );
  const selectedRoles = roles(options.roles);
  const tool = options.tool === undefined ? undefined : string(options.tool, "options.tool");
  const start = after === undefined ? 0 : view.items.findIndex(({ id }) => id === after) + 1;
  if (start === 0 && after !== undefined) {
    throw new Error(`Cursor ${after} is not a model-visible entry of the active context`);
  }
  const candidates = view.items
    .slice(start)
    .filter(
      (item) =>
        (selectedRoles === undefined || selectedRoles.has(item.role)) &&
        (tool === undefined || item.tools.includes(tool)),
    );
  const page = candidates.slice(0, limit);
  const last = page.at(-1);
  return {
    leafId: view.tailId ?? null,
    contextTokens: null,
    contextWindow: null,
    estimatedTokens: view.tokens,
    cacheMode: "unknown",
    cache: CACHE,
    entries: page.map((item) => outlineEntry(view, item, previewChars)),
    ...(last && candidates.length > page.length ? { nextAfter: last.id } : {}),
    omitted: candidates.length - page.length,
  };
}

function outlineEntry(view: ContextView, item: ContextItem, previewChars: number) {
  const preview = messagesText(item.messages).replaceAll(/\s+/g, " ").trim();
  const pending = view.pending.get(item.id);
  return {
    id: item.id,
    role: item.role,
    ...(item.tools.length > 0 ? { tool: item.tools.join(", ") } : {}),
    tokens: item.tokens,
    // Without the provider's caching mode, an edit is assumed to rewrite the whole conversation.
    reprefillTokens: view.tokens,
    state: item.state,
    editable: item.protectedReason === undefined && item.state === "original" && !pending,
    ...(item.protectedReason ? { protectedReason: item.protectedReason } : {}),
    ...(pending ? { pending } : {}),
    preview: preview.length > previewChars ? `${preview.slice(0, previewChars)}…` : preview,
  };
}

async function inspectEntry(services: DurableSessionServices, view: ContextView, args: unknown[]) {
  const id = string(args[0], "id");
  const options = args[1] === undefined ? {} : object(args[1]);
  const offset = boundedInteger(options.offset, "options.offset", {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    fallback: 0,
  });
  const limit = boundedInteger(options.limit, "options.limit", INSPECT_LIMITS.limit);
  const { api, context } = services;
  const numeric = Number(id);
  const entry = Number.isSafeInteger(numeric)
    ? await api.commit(async (tx) => {
        const page = await tx.scanEntries(
          {
            conversationId: api.conversationId,
            minEntryId: numeric as EntryRecord["id"],
            maxEntryId: numeric as EntryRecord["id"],
          },
          1,
        );
        return page.items[0];
      }, context)
    : undefined;
  if (!entry) throw new Error(`Entry ${id} is not in this conversation`);
  const original = entry.model ?? [];
  if (original.length === 0)
    throw new Error(`Entry ${id} (${entry.kind}) contributes no model content`);
  const text = messagesText(original);
  const item = view.byId.get(id);
  const state = item ? item.state : view.activeIds.has(id) ? "omitted" : "compacted";
  const page = text.slice(offset, offset + limit);
  const visible = item && item.state !== "original" ? messagesText(item.messages) : undefined;
  const first = original[0] as Message;
  const tools =
    first.role === "toolResult"
      ? [first.toolName]
      : first.role === "assistant"
        ? first.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
        : [];
  const role: ContextRole =
    entry.kind === "pi.compaction"
      ? "summary"
      : first.role === "assistant" || first.role === "toolResult"
        ? first.role
        : entry.kind === "pi.user"
          ? "user"
          : "custom";
  return {
    id,
    role,
    ...(tools.length > 0 ? { tool: tools.join(", ") } : {}),
    state,
    original: {
      text: page,
      offset: Math.min(offset, text.length),
      totalChars: text.length,
      truncated: offset + page.length < text.length,
    },
    ...(visible === undefined
      ? {}
      : {
          visible: {
            text: visible.slice(0, INSPECT_LIMITS.visibleChars),
            totalChars: visible.length,
            truncated: visible.length > INSPECT_LIMITS.visibleChars,
          },
        }),
    ...(item?.covers ? { covers: [...item.covers] } : {}),
  };
}

/** As on Pi, an elide or summary applies when the run ends unless the call asks for "now". */
function timingOf(value: unknown): EditTiming {
  const when = value ?? "end";
  if (when !== "now" && when !== "end") throw new Error('options.when must be "now" or "end"');
  return when === "now" ? "turn_end" : "run_end";
}

function receipt(view: ContextView, plan: PlannedEdit, timing: EditTiming) {
  return {
    status: "staged" as const,
    appliesAt: timing,
    operation: plan.provenance.operation,
    targets: plan.provenance.targets,
    estimatedTokensFreed: plan.provenance.tokensFreed,
    estimatedReprefillTokens: view.tokens,
    cacheMode: "unknown" as const,
  };
}

/**
 * `session.*` on pi-durable: the active context read from the conversation's entries, rewritten
 * with `edits` writes, and notes kept in a conversation document. Conversations have no name, and
 * compaction is the host's, so `getName`, `setName`, and `compact` are unavailable.
 */
export function createDurableSessionHandler(
  services: DurableSessionServices,
): NativeFunctionHandler {
  const { api, context, staging } = services;
  const view = async () => staging.withPending(await readContextView(api, context, api.callId));
  return async (method, args) => {
    switch (method) {
      case "info": {
        const current = await view();
        return {
          id: String(api.conversationId),
          file: undefined,
          name: undefined,
          leafId: current.tailId ?? null,
          entryCount: current.activeIds.size,
          branchEntryCount: current.activeIds.size,
          contextTokens: current.tokens,
          contextWindow: services.contextWindow,
          contextPercent:
            services.contextWindow === undefined
              ? undefined
              : Math.round((current.tokens / services.contextWindow) * 1000) / 10,
          cache: CACHE,
        };
      }
      case "outline":
        return outline(await view(), args);
      case "inspectEntry":
        return inspectEntry(services, await view(), args);
      case "elide": {
        const current = await view();
        const options = args[1] === undefined ? {} : object(args[1]);
        const reason =
          options.reason === undefined ? undefined : string(options.reason, "options.reason");
        const plan = planElide(current, stringArray(args[0], "ids"), reason);
        const timing = timingOf(options.when);
        staging.stageEdit(plan, timing);
        return receipt(current, plan, timing);
      }
      case "summarize": {
        const current = await view();
        const input = object(args[0], "input");
        const plan = planSummarize(current, {
          from: string(input.from, "input.from"),
          to: string(input.to, "input.to"),
          summary: string(input.summary, "input.summary"),
        });
        const timing = timingOf(input.when);
        staging.stageEdit(plan, timing);
        return {
          ...receipt(current, plan, timing),
          summarizedEntries: plan.summarizedEntries,
          summaryTokens: plan.summaryTokens,
        };
      }
      case "setNote": {
        const key = string(args[0], "key");
        const content = args[1] === null ? null : string(args[1], "content");
        const result = staging.stageNote(await readNotes(api, context), {
          key,
          content,
          contextWindow: services.contextWindow,
        });
        return {
          status: "staged",
          // As on Pi, a note applies after this turn: the next request renders the section again.
          appliesAt: "turn_end",
          operation: "note",
          targets: [key],
          estimatedTokensFreed: 0,
          estimatedReprefillTokens: result.tokens,
          cacheMode: "unknown",
          key,
          action: result.action,
        };
      }
      case "notes":
        return describeNotes(
          { notes: staging.notes(await readNotes(api, context)) },
          services.contextWindow,
          staging.pendingNotes(),
        );
      default:
        throw new PitDurableUnavailableError(
          `session.${method}`,
          method === "compact"
            ? "the host compacts the conversation"
            : "pi-durable conversations have no name",
        );
    }
  };
}
