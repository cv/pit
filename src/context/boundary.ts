import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
  SessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { registerNoteRecovery, staleNoteGroups } from "./notes.js";
import { NOTICE_LEVELS, pressureNotice } from "./notices.js";
import type { ContextEditQueue, StagedEdit } from "./queue.js";
import {
  buildContextView,
  type ContextItem,
  PROVENANCE_TYPE,
  type ProvenanceData,
  type ProvenanceOperation,
} from "./view.js";

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

/**
 * Superseded note entries that an elide or summarize in the same batch makes free to drop. A
 * breakpoint or unknown cache rewrites the whole conversation after any earlier change; a prefix
 * cache rewrites only from the earliest changed entry, so only entries after it are free. A removed
 * key's entries drop together, since dropping only its removal would revive an older version.
 */
function prunedNotes(
  applied: readonly StagedEdit[],
  ctx: ExtensionContext,
): { drafts: SessionBoundaryDraft[]; record: ProvenanceOperation } | undefined {
  const rewrites = applied
    .flatMap((edit) => edit.records)
    .filter((record) => record.operation === "elide" || record.operation === "summarize");
  const first = rewrites[0];
  if (!first) return undefined;
  const view = buildContextView(ctx.sessionManager);
  const position = new Map(view.items.map((item, index) => [item.id, index]));
  const changed = new Set(
    rewrites.flatMap((record) => [...record.targets, ...(record.covers ?? [])]),
  );
  const earliest = rewrites.every((record) => record.cacheMode === "prefix")
    ? view.items.findIndex((item) => changed.has(item.id))
    : 0;
  const targeted = new Set(
    applied.flatMap((edit) =>
      edit.drafts.flatMap((draft) => (draft.type === "context_edit" ? [draft.targetId] : [])),
    ),
  );
  const free = (item: ContextItem) =>
    (position.get(item.id) as number) >= earliest && !targeted.has(item.id);
  const items = staleNoteGroups(view).flatMap((group) =>
    group.removed ? (group.items.every(free) ? group.items : []) : group.items.filter(free),
  );
  if (items.length === 0) return undefined;
  return {
    drafts: items.map((item) => ({ type: "context_edit", targetId: item.id, replacement: null })),
    record: {
      toolCallId: first.toolCallId,
      operation: "note",
      targets: items.map((item) => item.id),
      action: "pruned",
      tokensFreed: items.reduce((total, item) => total + item.tokens, 0),
      // The rewrite that made these free already pays for the re-prefill.
      reprefillTokens: 0,
      cacheMode: first.cacheMode,
    },
  };
}

/** Deferred edits apply at once from this share of the window, where notices ask for cleanup. */
export const DEFERRED_PRESSURE_PERCENT = Math.min(...NOTICE_LEVELS);

/** Entries for edits whose calls succeeded and whose targets remain, then their provenance. */
function editEntries(
  edits: readonly StagedEdit[],
  ctx: ExtensionContext,
  failed: number,
): SessionBoundaryDraft[] {
  const branch = new Map(ctx.sessionManager.getBranch().map((entry) => [entry.id, entry]));
  const applied = edits.filter((edit) => applicable(edit, branch));
  if (failed > 0 || applied.length < edits.length) {
    reportDiscarded(ctx, failed, edits.length - applied.length);
  }
  if (applied.length === 0) return [];
  const pruned = prunedNotes(applied, ctx);
  const provenance: ProvenanceData = {
    version: 1,
    operations: [...applied.flatMap((edit) => edit.records), ...(pruned ? [pruned.record] : [])],
  };
  const drafts: SessionBoundaryDraft[] = [
    ...applied.flatMap((edit) => edit.drafts),
    ...(pruned?.drafts ?? []),
  ];
  drafts.push({ type: "custom", customType: PROVENANCE_TYPE, data: provenance });
  return drafts;
}

/**
 * The entries this turn's successful session.* calls staged, followed by their provenance.
 * Deferred edits wait for the run to end, unless context has reached the pressure threshold.
 */
export function contextBoundaryEntries(
  event: Pick<TurnEndEvent, "outcome" | "toolResults">,
  ctx: ExtensionContext,
  queue: ContextEditQueue,
): SessionBoundaryDraft[] {
  const staged = queue.take();
  const succeeded = new Set(
    event.outcome === "completed"
      ? event.toolResults.filter((result) => !result.isError).map((result) => result.toolCallId)
      : [],
  );
  const completed = staged.filter((edit) => succeeded.has(edit.toolCallId));
  const failed = staged.length - completed.length;
  const percent = ctx.getContextUsage()?.percent;
  const urgent = typeof percent === "number" && percent >= DEFERRED_PRESSURE_PERCENT;
  const later = completed.filter((edit) => edit.when === "end");
  const now = completed.filter((edit) => edit.when !== "end");
  if (urgent) now.unshift(...queue.takeDeferred(), ...later);
  else queue.defer(later);
  if (now.length === 0) {
    if (failed > 0) reportDiscarded(ctx, failed, 0);
    return [];
  }
  return editEntries(now, ctx, failed);
}

/** Deferred edits, applied when the run ends so their rewrite lands on the next prompt. */
export function deferredBoundaryEntries(
  ctx: ExtensionContext,
  queue: ContextEditQueue,
): SessionBoundaryDraft[] {
  const deferred = queue.takeDeferred();
  return deferred.length === 0 ? [] : editEntries(deferred, ctx, 0);
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
    // Nudge only when the model can act on it and is not already editing its context.
    if (
      entries.length === 0 &&
      !queue.hasDeferred() &&
      event.outcome === "completed" &&
      pi.getActiveTools().includes("typescript")
    ) {
      entries.push(...pressureNotice(ctx));
    }
    // Boundary handlers chain: keep the entries earlier handlers proposed.
    return entries.length === 0 ? undefined : { entries: [...event.entries, ...entries] };
  });
  // The next request after the run follows the user's reply, often after the cache expired.
  pi.on("agent_before_settle", (event, ctx) => {
    const entries = deferredBoundaryEntries(ctx, queue);
    return entries.length === 0 ? undefined : { entries: [...event.entries, ...entries] };
  });
}
