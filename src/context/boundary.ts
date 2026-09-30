import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { registerNoteRecovery } from "./notes.js";
import type { ContextEditQueue, StagedEdit } from "./queue.js";
import { PROVENANCE_TYPE, type ProvenanceData } from "./view.js";

/** Mirrors Pi's `appendContextEdit` target rule, so one stale edit cannot void the boundary. */
function editable(entry: SessionEntry | undefined): boolean {
  if (entry?.type === "custom_message") return true;
  return (
    entry?.type === "message" &&
    (entry.message.role === "user" ||
      entry.message.role === "assistant" ||
      entry.message.role === "toolResult")
  );
}

function applicable(edit: StagedEdit, branch: ReadonlyMap<string, SessionEntry>): boolean {
  return edit.drafts.every(
    (draft) => draft.type !== "context_edit" || editable(branch.get(draft.targetId)),
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function reportDiscarded(ctx: ExtensionContext, failed: number, stale: number): void {
  if (!ctx.hasUI) return;
  const reasons = [
    ...(failed > 0 ? [`${plural(failed, "edit")} whose tool call did not succeed`] : []),
    ...(stale > 0 ? [`${plural(stale, "edit")} whose targets left the active branch`] : []),
  ];
  ctx.ui.notify(`Pit discarded staged context edits: ${reasons.join("; ")}.`, "warning");
}

/** The entries this turn's successful session.* calls staged, followed by their provenance. */
export function contextBoundaryEntries(
  event: Pick<TurnEndEvent, "outcome" | "toolResults">,
  ctx: ExtensionContext,
  queue: ContextEditQueue,
): SessionBoundaryDraft[] {
  const staged = queue.take();
  if (staged.length === 0) return [];
  const succeeded = new Set(
    event.outcome === "completed"
      ? event.toolResults.filter((result) => !result.isError).map((result) => result.toolCallId)
      : [],
  );
  const completed = staged.filter((edit) => succeeded.has(edit.toolCallId));
  const branch = new Map(ctx.sessionManager.getBranch().map((entry) => [entry.id, entry]));
  const applied = completed.filter((edit) => applicable(edit, branch));
  if (applied.length < staged.length) {
    reportDiscarded(ctx, staged.length - completed.length, completed.length - applied.length);
  }
  if (applied.length === 0) return [];
  const provenance: ProvenanceData = {
    version: 1,
    operations: applied.flatMap((edit) => edit.records),
  };
  const drafts: SessionBoundaryDraft[] = applied.flatMap((edit) => edit.drafts);
  drafts.push({ type: "custom", customType: PROVENANCE_TYPE, data: provenance });
  return drafts;
}

export function registerContextBoundary(pi: ExtensionAPI, queue: ContextEditQueue): void {
  registerNoteRecovery(pi);
  // Staged edits belong to the running turn on the current branch.
  pi.on("session_start", () => {
    queue.clear();
  });
  pi.on("session_tree", () => {
    queue.clear();
  });
  pi.on("turn_end", (event, ctx) => {
    const entries = contextBoundaryEntries(event, ctx, queue);
    // Boundary handlers chain: keep the entries earlier handlers proposed.
    return entries.length === 0 ? undefined : { entries: [...event.entries, ...entries] };
  });
}
