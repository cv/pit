import { cacheState } from "../../context/cache-state.js";
import {
  INSPECT_LIMITS,
  inspectContextEntry,
  OUTLINE_LIMITS,
  outlineContext,
} from "../../context/inspect.js";
import { listNotes } from "../../context/notes.js";
import { cacheBasis } from "../../context/planning.js";
import type { ContextEditQueue } from "../../context/queue.js";
import { buildContextView, CONTEXT_ROLES, type ContextRole } from "../../context/view.js";
import {
  boundedIntegerValue as boundedInteger,
  recordValue as record,
  stringArrayValue as stringArray,
  stringValue as string,
} from "../../shared/argument-values.js";
import type { PiControlServices } from "./services.js";

export interface SessionContextServices extends PiControlServices {
  /** The tool call running this program; its turn is protected from edits. */
  toolCallId?: string;
  /** Edits staged by the running turn; absent outside the TypeScript tool. */
  contextEdits?: ContextEditQueue;
}

export type ContextMethod = (args: unknown[]) => unknown;

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function roles(value: unknown): Set<ContextRole> | undefined {
  if (value === undefined) return undefined;
  const selected = stringArray(value, "options.roles");
  const unknown = selected.find((role) => !CONTEXT_ROLES.includes(role as ContextRole));
  if (unknown !== undefined) {
    throw new Error(
      `options.roles contains unknown role "${unknown}"; expected ${CONTEXT_ROLES.join(", ")}`,
    );
  }
  return new Set(selected as ContextRole[]);
}

export function createSessionContextHandlers({
  ctx,
  toolCallId,
  contextEdits,
}: SessionContextServices): Record<string, ContextMethod> {
  const view = () =>
    buildContextView(ctx.sessionManager, toolCallId === undefined ? {} : { toolCallId });
  return {
    outline: (args) => {
      const options = args[0] === undefined ? {} : record(args[0], "options");
      const usage = ctx.getContextUsage();
      const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
      const after = optionalString(options.after, "options.after");
      const tool = optionalString(options.tool, "options.tool");
      const selectedRoles = roles(options.roles);
      const current = view();
      return outlineContext(current, {
        ...(after === undefined ? {} : { after }),
        ...(tool === undefined ? {} : { tool }),
        ...(selectedRoles === undefined ? {} : { roles: selectedRoles }),
        ...(contextEdits ? { pending: contextEdits.pending() } : {}),
        basis: cacheBasis(ctx.model, current, usage?.tokens),
        cache: cacheState(ctx.sessionManager.getBranch(), ctx.model),
        limit: boundedInteger(options.limit, "options.limit", OUTLINE_LIMITS.limit),
        previewChars: boundedInteger(options.previewChars, "options.previewChars", {
          minimum: 0,
          ...OUTLINE_LIMITS.previewChars,
        }),
        ...(contextWindow === undefined
          ? {}
          : { usage: { tokens: usage?.tokens ?? null, contextWindow } }),
      });
    },
    notes: () =>
      listNotes(view(), {
        contextWindow: ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow,
        pending: contextEdits?.pending() ?? new Map(),
      }),
    inspectEntry: (args) => {
      const options = args[1] === undefined ? {} : record(args[1], "options");
      return inspectContextEntry(view(), ctx.sessionManager, {
        id: string(args[0], "entry id"),
        offset: boundedInteger(options.offset, "options.offset", {
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          fallback: 0,
        }),
        limit: boundedInteger(options.limit, "options.limit", INSPECT_LIMITS.limit),
      });
    },
  };
}
