import { LIMITS } from "../shared/bounds.js";

/** One completed host call: its trace sequence, `namespace.method`, and returned value. */
export interface CompletedCall {
  sequence: number;
  call: string;
  value: unknown;
}

export interface CompletedCallsResult {
  toolCallId: string;
  calls: CompletedCall[];
  /** Completed calls the journal did not keep: beyond its entry or byte budget, or unserializable. */
  omitted: number;
}

/** Most completed calls one program keeps. */
export const MAX_JOURNAL_CALLS = 128;
/** Failed programs whose completed calls stay recoverable. */
export const MAX_RECOVERABLE_PROGRAMS = 8;

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
