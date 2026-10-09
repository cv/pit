import { LIMITS } from "../shared/bounds.js";

/** One completed host call: its trace sequence, `namespace.method`, and returned value. */
interface CompletedCall {
  sequence: number;
  call: string;
  value: unknown;
}

interface CompletedCallsResult {
  toolCallId: string;
  calls: CompletedCall[];
  /** Completed calls the journal did not keep: beyond its entry or byte budget, or unserializable. */
  omitted: number;
}

/** Most completed calls one program keeps. */
const MAX_JOURNAL_CALLS = 128;
/** Most applied file edits one program's result records. */
const MAX_APPLIED_EDITS = 32;

/**
 * A file edit a program applied: what `session.elide` names when it stubs the arguments of the
 * call that made it, so the trail says which files changed and at which revision.
 */
export interface AppliedEdit {
  file: string;
  revision: string | null;
  applied: number;
  deleted?: true;
}

/** What `workspace.edit` returns, and each edit result in a `workspace.batch`. */
interface EditResult {
  file: string;
  revision: string | null;
  applied: number;
  deleted: boolean;
}

function appliedEdit({ file, revision, applied, deleted }: EditResult): AppliedEdit {
  return { file, revision, applied, ...(deleted ? { deleted: true as const } : {}) };
}

/** The edits a `workspace.edit` or `workspace.batch` call applied, from Pit's own results. */
function appliedEdits(call: string, value: unknown): AppliedEdit[] {
  if (call === "workspace.edit") return [appliedEdit(value as EditResult)];
  if (call !== "workspace.batch") return [];
  // Edit batches are atomic, so every edit result in one was applied.
  const { results } = value as { results: Array<{ kind: string; value: EditResult }> };
  return results.flatMap((result) => (result.kind === "edit" ? [appliedEdit(result.value)] : []));
}
/** Failed programs whose completed calls stay recoverable. */
const MAX_RECOVERABLE_PROGRAMS = 8;

interface JournalEntry {
  sequence: number;
  call: string;
  /** The value as JSON, so later mutation by the program cannot change it. */
  json: string;
  bytes: number;
}

/**
 * Results of host calls that one program completed, newest kept. A failed program's journal
 * lets a later program recover data whose call consumed its input, such as a feed or queue.
 */
export class CompletedCallJournal {
  readonly #entries: JournalEntry[] = [];
  readonly #edits: AppliedEdit[] = [];
  #editsOmitted = 0;
  #bytes = 0;
  #omitted = 0;

  private readonly maxCalls: number;
  private readonly maxBytes: number;

  constructor(
    maxCalls: number = MAX_JOURNAL_CALLS,
    maxBytes: number = LIMITS.programData.maxBytes,
  ) {
    this.maxCalls = maxCalls;
    this.maxBytes = maxBytes;
  }

  record(sequence: number | undefined, call: string, value: unknown): void {
    // Edits are kept apart from the journal's budget, so later large reads cannot evict them.
    for (const edit of appliedEdits(call, value)) {
      if (this.#edits.length < MAX_APPLIED_EDITS) this.#edits.push(edit);
      else this.#editsOmitted++;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify(value === undefined ? null : value);
    } catch {
      json = undefined;
    }
    const bytes = json === undefined ? 0 : Buffer.byteLength(json);
    if (sequence === undefined || json === undefined || bytes > this.maxBytes) {
      this.#omitted++;
      return;
    }
    this.#entries.push({ sequence, call, json, bytes });
    this.#bytes += bytes;
    while (this.#entries.length > this.maxCalls || this.#bytes > this.maxBytes) {
      const dropped = this.#entries.shift() as JournalEntry;
      this.#bytes -= dropped.bytes;
      this.#omitted++;
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  /** File edits the program applied, in order, and how many past the cap were not kept. */
  edits(): { edits: AppliedEdit[]; omitted: number } {
    return { edits: this.#edits.map((edit) => ({ ...edit })), omitted: this.#editsOmitted };
  }

  get omitted(): number {
    return this.#omitted;
  }

  /** Kept calls in completion order, optionally only the one with a trace sequence. */
  calls(sequence?: number): CompletedCall[] {
    return this.#entries
      .filter((entry) => sequence === undefined || entry.sequence === sequence)
      .map(({ sequence: kept, call, json }) => ({
        sequence: kept,
        call,
        value: JSON.parse(json) as unknown,
      }));
  }
}

/** Journals of the most recent failed programs in this Pi session, keyed by tool call ID. */
export class RecoverableCallStore {
  readonly #journals = new Map<string, CompletedCallJournal>();

  private readonly maxPrograms: number;

  constructor(maxPrograms: number = MAX_RECOVERABLE_PROGRAMS) {
    this.maxPrograms = maxPrograms;
  }

  /** Keeps a failed program's journal, evicting the oldest kept program. */
  retain(toolCallId: string, journal: CompletedCallJournal): void {
    if (journal.size === 0) return;
    this.#journals.delete(toolCallId);
    this.#journals.set(toolCallId, journal);
    while (this.#journals.size > this.maxPrograms) {
      const oldest = this.#journals.keys().next().value as string;
      this.#journals.delete(oldest);
    }
  }

  read(toolCallId: string, sequence?: number): CompletedCallsResult {
    const journal = this.#journals.get(toolCallId);
    if (!journal) {
      throw new Error(
        `No recoverable calls for ${toolCallId}: Pit keeps them only for the ${this.maxPrograms} most recent failed programs in this Pi session.`,
      );
    }
    const calls = journal.calls(sequence);
    if (sequence !== undefined && calls.length === 0) {
      throw new Error(`${toolCallId} kept no completed call with sequence ${sequence}`);
    }
    return { toolCallId, calls, omitted: journal.omitted };
  }

  clear(): void {
    this.#journals.clear();
  }
}
