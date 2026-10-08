import { MAX_REASON_CHARS, planElide } from "../../context/edits.js";
import { planNote } from "../../context/notes.js";
import {
  cacheBasis,
  type CacheBasis,
  MAX_EDIT_TARGETS,
  type PlannedEdit,
} from "../../context/planning.js";
import { planSummarize, summaryTokenCap } from "../../context/summarize.js";
import { buildContextView, type ContextView } from "../../context/view.js";
import {
  recordValue as record,
  stringArrayValue as stringArray,
  stringValue as string,
} from "../../shared/argument-values.js";
import { sanitizeTerminalText } from "../../shared/text-sanitization.js";
import type { ContextMethod, SessionContextServices } from "./session-context.js";

function entryIds(value: unknown): string[] {
  const ids = stringArray(value, "ids");
  if (ids.length === 0 || ids.length > MAX_EDIT_TARGETS) {
    throw new Error(`ids must list 1-${MAX_EDIT_TARGETS} entry IDs; received ${ids.length}`);
  }
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) throw new Error(`ids lists ${duplicate} more than once`);
  return ids;
}

/** When a staged elide or summary applies: when the run ends by default, or after this turn. */
function timing(value: unknown, label: string): "end" | undefined {
  if (value === undefined || value === "end") return "end";
  if (value === "now") return undefined;
  throw new Error(`${label} must be "now" or "end"`);
}

/** One sanitized line: a reason is repeated in each stub the call writes. */
function reason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = sanitizeTerminalText(string(value, "options.reason")).replace(/\s+/g, " ").trim();
  if (text.length > MAX_REASON_CHARS) {
    throw new Error(`options.reason must be at most ${MAX_REASON_CHARS} characters`);
  }
  return text || undefined;
}

export function createSessionEditHandlers({
  pi,
  ctx,
  toolCallId,
  contextEdits,
}: SessionContextServices): Record<string, ContextMethod> {
  const view = () =>
    buildContextView(ctx.sessionManager, toolCallId === undefined ? {} : { toolCallId });
  const basisOf = (current: ContextView) =>
    cacheBasis(ctx.model, current, ctx.getContextUsage()?.tokens);
  const stage = (planned: PlannedEdit, { mode: cacheMode }: CacheBasis, when?: "end") => {
    if (!contextEdits || toolCallId === undefined) {
      throw new Error("Context edits require a running Pit tool call");
    }
    contextEdits.stage({
      toolCallId,
      operation: planned.operation,
      targets: planned.targets,
      drafts: planned.drafts,
      records: planned.records.map((operation) => ({ toolCallId, ...operation, cacheMode })),
      ...(when ? { when } : {}),
    });
    return {
      status: "staged",
      appliesAt: when === "end" ? "run_end" : "turn_end",
      operation: planned.operation,
      targets: planned.targets,
      estimatedTokensFreed: planned.tokensFreed,
      estimatedReprefillTokens: planned.reprefillTokens,
      cacheMode,
      ...planned.receipt,
    };
  };
  return {
    elide: (args) => {
      const options = args[1] === undefined ? {} : record(args[1], "options");
      const current = view();
      const basis = basisOf(current);
      return stage(
        planElide(current, entryIds(args[0]), reason(options.reason), basis),
        basis,
        timing(options.when, "options.when"),
      );
    },
    summarize: (args) => {
      const input = record(args[0], "input");
      const current = view();
      const basis = basisOf(current);
      return stage(
        planSummarize(current, {
          from: string(input.from, "input.from"),
          to: string(input.to, "input.to"),
          summary: string(input.summary, "input.summary"),
          capTokens: summaryTokenCap(pi.getSettings(), ctx.model),
          basis,
        }),
        basis,
        timing(input.when, "input.when"),
      );
    },
    setNote: (args) => {
      const current = view();
      const basis = basisOf(current);
      return stage(
        planNote(current, {
          key: string(args[0], "note key"),
          content: args[1] === null ? null : string(args[1], "note content"),
          contextWindow: ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow,
          basis,
        }),
        basis,
      );
    },
  };
}
