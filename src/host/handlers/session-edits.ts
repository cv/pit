import { MAX_REASON_CHARS, planElide, planRestore } from "../../context/edits.js";
import { planNote } from "../../context/notes.js";
import { MAX_EDIT_TARGETS, type PlannedEdit } from "../../context/planning.js";
import { buildContextView } from "../../context/view.js";
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
  ctx,
  toolCallId,
  contextEdits,
}: SessionContextServices): Record<string, ContextMethod> {
  const view = () =>
    buildContextView(ctx.sessionManager, toolCallId === undefined ? {} : { toolCallId });
  const stage = (planned: PlannedEdit) => {
    if (!contextEdits || toolCallId === undefined) {
      throw new Error("Context edits require a running Pit tool call");
    }
    contextEdits.stage({
      toolCallId,
      operation: planned.operation,
      targets: planned.targets,
      drafts: planned.drafts,
      records: planned.records.map((operation) => ({ toolCallId, ...operation })),
    });
    return {
      status: "staged",
      appliesAt: "turn_end",
      operation: planned.operation,
      targets: planned.targets,
      estimatedTokensFreed: planned.tokensFreed,
      estimatedReprefillTokens: planned.reprefillTokens,
      ...planned.receipt,
    };
  };
  return {
    elide: (args) => {
      const options = args[1] === undefined ? {} : record(args[1], "options");
      return stage(planElide(view(), entryIds(args[0]), reason(options.reason)));
    },
    restore: (args) => stage(planRestore(view(), ctx.sessionManager, entryIds(args[0]))),
    setNote: (args) =>
      stage(
        planNote(view(), {
          key: string(args[0], "note key"),
          content: args[1] === null ? null : string(args[1], "note content"),
          contextWindow: ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow,
        }),
      ),
  };
}
