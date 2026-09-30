import type { SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";

import type { ContextOperation, ProvenanceOperation } from "./view.js";

/** Entries one successful session.* call adds at the end of its turn. */
export interface StagedEdit {
  readonly toolCallId: string;
  readonly operation: ContextOperation;
  /** Entry IDs, or `note:<key>`, that this edit changes. A turn stages each target once. */
  readonly targets: readonly string[];
  readonly drafts: readonly SessionBoundaryDraft[];
  readonly records: readonly ProvenanceOperation[];
}

/**
 * Context edits staged by the running turn. Pi applies them at `turn_end` when the call that
 * staged them succeeded; a tree change or session start discards them.
 */
export class ContextEditQueue {
  #staged: StagedEdit[] = [];

  pending(): Map<string, ContextOperation> {
    const pending = new Map<string, ContextOperation>();
    for (const edit of this.#staged) {
      for (const target of edit.targets) pending.set(target, edit.operation);
    }
    return pending;
  }

  stage(edit: StagedEdit): void {
    const pending = this.pending();
    const conflicts = edit.targets.filter((target) => pending.has(target));
    if (conflicts.length > 0) {
      const shown = conflicts.slice(0, 5).join(", ");
      const more = conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "";
      throw new Error(
        `${shown}${more} already ${conflicts.length === 1 ? "has" : "have"} a staged ${pending.get(conflicts[0] as string)} in this turn`,
      );
    }
    this.#staged.push(edit);
  }

  /** Removes and returns every staged edit. */
  take(): StagedEdit[] {
    const staged = this.#staged;
    this.#staged = [];
    return staged;
  }

  clear(): number {
    return this.take().length;
  }
}
