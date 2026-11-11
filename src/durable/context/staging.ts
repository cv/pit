import type { ToolExecutionApi } from "@earendil-works/pi-durable";

import { type EditTiming, writeEdit } from "./apply.js";
import type { PlannedEdit } from "./edits.js";
import { applyNoteChanges, changeNote } from "./notes.js";
import type { ContextView } from "./view.js";

type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];
type NoteList = Parameters<typeof changeNote>[0];

/**
 * The context changes one `typescript` call staged. As on Pi, they apply only if the call
 * succeeds: the tool applies them after the program and its saved-function changes, and drops
 * them when the program fails.
 */
export class StagedContextChanges {
  readonly #edits: Array<{ plan: PlannedEdit; timing: EditTiming }> = [];
  readonly #notes: Array<{ key: string; content: string | null }> = [];

  /** The view with this call's staged targets marked pending, so a target is staged once. */
  withPending(view: ContextView): ContextView {
    const pending = new Map(view.pending);
    for (const { plan } of this.#edits) {
      for (const target of plan.provenance.covers) pending.set(target, plan.provenance.operation);
    }
    return { ...view, pending };
  }

  stageEdit(plan: PlannedEdit, timing: EditTiming): void {
    this.#edits.push({ plan, timing });
  }

  /** Validates a note change against the notes as this call left them, then stages it. */
  stageNote(
    current: Readonly<{ notes: Readonly<NoteList> }>,
    change: { key: string; content: string | null; contextWindow: number | undefined },
  ) {
    const notes = this.notes(current);
    const result = changeNote(notes, change);
    this.#notes.push({ key: change.key, content: change.content });
    return result;
  }

  /** The notes with this call's staged changes applied. */
  notes(current: Readonly<{ notes: Readonly<NoteList> }>): NoteList {
    const notes = current.notes.map((note) => ({ ...note }));
    for (const change of this.#notes) {
      changeNote(notes, { ...change, contextWindow: Number.POSITIVE_INFINITY });
    }
    return notes;
  }

  /** Keys this call staged a change for. */
  pendingNotes(): ReadonlySet<string> {
    return new Set(this.#notes.map(({ key }) => key));
  }

  /** Writes what the call staged: notes first, then each rewrite in call order. */
  async apply(
    api: Pick<ToolExecutionApi, "commit" | "conversation" | "conversationId">,
    context: ToolContext,
    contextWindow: number | undefined,
  ): Promise<void> {
    if (this.#notes.length > 0) {
      await applyNoteChanges(api, context, this.#notes, contextWindow);
    }
    for (const { plan, timing } of this.#edits) await writeEdit(api, context, plan, timing);
  }
}
