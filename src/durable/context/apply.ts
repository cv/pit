import type {
  HookApi,
  HookRegistration,
  RunSummary,
  Task,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";

import type { PlannedEdit } from "./edits.js";
import {
  type ContextEdit,
  EDIT_KIND,
  type EntryId,
  type EntryRecord,
  PENDING_EDIT_KIND,
} from "./view.js";

type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];

export type EditTiming = "turn_end" | "run_end";

/**
 * Write a planned rewrite. `turn_end` writes it now: pi-durable places a write with edits at the
 * next boundary, so it lands after this tool round and the run's next request sees it. `run_end`
 * stages it as a data-only entry, which pi-durable appends at once without changing the context;
 * the `afterRun` hook applies what the run staged once it answers.
 */
export async function writeEdit(
  api: Pick<ToolExecutionApi, "conversation" | "conversationId">,
  context: ToolContext,
  plan: PlannedEdit,
  timing: EditTiming,
): Promise<void> {
  const conversation = await api.conversation(api.conversationId, context);
  /* v8 ignore next -- a running call's own conversation exists. */
  if (!conversation) throw new Error(`Conversation ${api.conversationId} is unavailable`);
  const data = { operations: [plan.provenance] } as unknown as NonNullable<EntryRecord["data"]>;
  if (timing === "turn_end") {
    await conversation.submit(
      { type: "write", entry: { kind: EDIT_KIND, data, edits: plan.edits } },
      context,
    );
    return;
  }
  await conversation.submit(
    {
      type: "write",
      entry: {
        kind: PENDING_EDIT_KIND,
        data: { operations: [plan.provenance], edits: plan.edits } as unknown as typeof data,
      },
    },
    context,
  );
}

interface ApplyInput {
  /** The staged entries to apply, oldest first. */
  pending: number[];
}

// Staged entries are Pit's own writes, so their data has this shape.
function stagedEdits(entry: EntryRecord): ContextEdit[] {
  return (entry.data as { edits: ContextEdit[] }).edits;
}

type Json = NonNullable<EntryRecord["data"]>;

function stagedOperations(entry: EntryRecord): Json[] {
  return (entry.data as { operations: Json[] }).operations;
}

/** Applies the rewrites a run staged, once it answered: one write, before the next input. */
export const APPLY_STAGED_EDITS: Task<ApplyInput, { phase: "apply" }, null, object> = {
  definition: {
    name: "pit.apply-staged-edits",
    version: 1,
    initial: () => ({ phase: "apply" }),
    phases: {
      apply: async (task, runtime, context) => {
        const handle = await runtime.conversation(runtime.conversationId, context);
        await runtime.commit(async (tx) => {
          const staged = await Promise.all(task.input.pending.map((id) => tx.entry(id as EntryId)));
          const entries = staged.filter((entry): entry is EntryRecord => entry !== undefined);
          const edits = entries.flatMap(stagedEdits);
          if (handle && edits.length > 0) {
            await handle.submit(tx, {
              type: "write",
              entry: {
                kind: EDIT_KIND,
                data: {
                  operations: entries.flatMap(stagedOperations),
                  pending: task.input.pending,
                },
                edits,
              },
            });
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    /* v8 ignore next 2 -- runs only when the host aborts a conversation while this task waits. */
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  },
};

const SCAN_PAGE = 256;

/** After a run answers, applies the rewrites it staged; a failed or aborted run drops them. */
export const APPLY_STAGED_EDITS_HOOK: HookRegistration = {
  task: "pi.generation",
  handlers: {
    afterRun: async (run: RunSummary, api: HookApi, context: ToolContext) => {
      const pending: number[] = [];
      const range = { minEntryId: run.first, maxEntryId: run.last, order: "ascending" } as const;
      let page = await api.entries(range, SCAN_PAGE, undefined, context);
      for (;;) {
        for (const entry of page.items) {
          if (entry.kind === PENDING_EDIT_KIND) pending.push(entry.id);
        }
        if (page.next === undefined) break;
        page = await api.entries(range, SCAN_PAGE, page.next, context);
      }
      if (pending.length === 0) return undefined;
      const input: ApplyInput = { pending };
      return { tasks: [{ task: APPLY_STAGED_EDITS, input }] };
    },
  },
};
