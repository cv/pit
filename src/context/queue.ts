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
  /** `end`: hold the edit until the run ends, so its rewrite lands on the next prompt's request. */
  readonly when?: "end";
}

/**
 * Context edits staged by the running turn. Pi applies them at `turn_end` when the call that
 * staged them succeeded, except deferred edits, which wait for the run to end. A tree change or
 * session start discards both.
 */
export class ContextEditQueue {
  #staged: StagedEdit[] = [];
  #deferred: StagedEdit[] = [];

  pending(): Map<string, ContextOperation> {
    const pending = new Map<string, ContextOperation>();
    for (const edit of [...this.#deferred, ...this.#staged]) {
      for (const target of edit.targets) pending.set(target, edit.operation);
    }
    return pending;
  }

  stage(edit: StagedEdit): void {
    const pending = this.pending();
    const conflicts = edit.targets.filter((target) => pending.has(target));
    if (conflicts.length > 0) {
      const shown = conflicts
        .slice(0, 5)
        .map((target) => (target.startsWith("note:") ? `Note "${target.slice(5)}"` : target))
        .join(", ");
      const more = conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : "";
      throw new Error(
        `${shown}${more} already ${conflicts.length === 1 ? "has" : "have"} a staged ${pending.get(conflicts[0] as string)} in this turn`,
      );
    }
    this.#staged.push(edit);
  }

  /** Removes and returns every edit the running turn staged. */
  take(): StagedEdit[] {
    const staged = this.#staged;
    this.#staged = [];
    return staged;
  }

  /** Holds edits from succeeded calls until the run ends. */
  defer(edits: readonly StagedEdit[]): void {
    this.#deferred.push(...edits);
  }

  /** Removes and returns every deferred edit. */
  takeDeferred(): StagedEdit[] {
    const deferred = this.#deferred;
    this.#deferred = [];
    return deferred;
  }

  clear(): number {
    return this.take().length + this.takeDeferred().length;
  }
}
