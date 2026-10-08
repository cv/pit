import {
  buildSessionProjection,
  estimateTokens,
  type CompactionEntry,
  type ExtensionAPI,
  type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";

import { type CacheBasis, formatTokens, type PlannedEdit, reprefillAfter } from "./planning.js";
import {
  buildContextView,
  type ContextItem,
  type ContextSource,
  type ContextView,
  NOTE_TYPE,
  type SessionReader,
} from "./view.js";

export const NOTE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_NOTES = 32;
const MIN_NOTE_BUDGET = 4_096;
const NOTE_BUDGET_SHARE = 0.1;
const REMOVED_BODY = "Removed; earlier versions of this note no longer apply.";

/** Every visible note version shares max(4,096 tokens, 10% of the context window). */
export function noteBudget(contextWindow: number | undefined): number {
  return Math.max(MIN_NOTE_BUDGET, Math.floor((contextWindow ?? 0) * NOTE_BUDGET_SHARE));
}

/**
 * Frames a note for the model; a closing tag inside the note cannot end the frame early. A later
 * version names its number and says it replaces the earlier ones, which stay in context unchanged.
 */
export function frameNote(key: string, content: string, version = 1): string {
  const body = content.replaceAll("</model-note", "<\\/model-note");
  const marker = version > 1 ? ` version="${version}" replaces="earlier"` : "";
  return `<model-note key="${key}"${marker}>\n${body}\n</model-note>`;
}

/** Frames a removal: earlier versions stay in context unchanged, so the model is told. */
export function frameRemoval(key: string, version: number): string {
  return `<model-note key="${key}" version="${version}" removed>\n${REMOVED_BODY}\n</model-note>`;
}

function noteTokens(content: string): number {
  return estimateTokens({
    role: "custom",
    customType: NOTE_TYPE,
    content,
    display: true,
    timestamp: 0,
  });
}

function sum(items: readonly ContextItem[]): number {
  return items.reduce((total, item) => total + item.tokens, 0);
}

/** One key's visible entries, oldest first. */
export interface NoteGroup {
  key: string;
  items: ContextItem[];
  /** The newest entry is a removal, so none of the entries is live. */
  removed: boolean;
}

function noteGroups(view: ContextView): NoteGroup[] {
  const groups = new Map<string, NoteGroup>();
  for (const item of view.items) {
    if (item.role !== "note" || item.noteKey === undefined) continue;
    const group = groups.get(item.noteKey) ?? { key: item.noteKey, items: [], removed: false };
    group.items.push(item);
    group.removed = item.noteRemoved === true;
    groups.set(item.noteKey, group);
  }
  return [...groups.values()];
}

function liveNotes(groups: readonly NoteGroup[]): ContextItem[] {
  return groups.flatMap((group) => (group.removed ? [] : [group.items.at(-1) as ContextItem]));
}

/**
 * Note entries that no longer count: superseded versions of live keys, and every entry of a
 * removed key. They stay in context byte for byte until a rewrite drops them. A removed key's
 * entries come as one group, since dropping only its removal would revive an older version.
 */
export function staleNoteGroups(view: ContextView): NoteGroup[] {
  return noteGroups(view).flatMap((group) => {
    const items = group.removed ? group.items : group.items.slice(0, -1);
    return items.length === 0 ? [] : [{ ...group, items }];
  });
}

export interface NoteListing {
  notes: Array<{ key: string; entryId: string; tokens: number; pending?: boolean }>;
  tokens: number;
  /** Superseded versions and removals still in context; they count against the budget. */
  supersededTokens: number;
  budgetTokens: number;
  maxNotes: number;
}

export function listNotes(
  view: ContextView,
  input: { contextWindow: number | undefined; pending: ReadonlyMap<string, unknown> },
): NoteListing {
  const notes = liveNotes(noteGroups(view)).map((item) => {
    const note: NoteListing["notes"][number] = {
      key: item.noteKey as string,
      entryId: item.id,
      tokens: item.tokens,
    };
    if (input.pending.has(`note:${item.noteKey}`)) note.pending = true;
    return note;
  });
  return {
    notes,
    tokens: notes.reduce((total, note) => total + note.tokens, 0),
    supersededTokens: sum(staleNoteGroups(view).flatMap((group) => group.items)),
    budgetTokens: noteBudget(input.contextWindow),
    maxNotes: MAX_NOTES,
  };
}

/**
 * Appends the note's new entry without changing any earlier entry, so the provider keeps its
 * cached prefix. Once every visible version would exceed the budget, the same edit also drops the
 * superseded versions, which rewrites the prefix once.
 */
function appendNote(
  view: ContextView,
  input: {
    key: string;
    action: "created" | "replaced" | "removed";
    entry: SessionBoundaryDraft;
    entryTokens: number;
    liveTokens: number;
    superseded: ContextItem[];
    budget: number;
    basis: CacheBasis;
  },
): PlannedEdit {
  const { key, action } = input;
  const removal = action === "removed";
  const supersededTokens = sum(input.superseded);
  const prune = input.liveTokens + supersededTokens + input.entryTokens > input.budget;
  // Dropping every entry of a removed key needs no removal entry.
  const ids = prune ? input.superseded.map((item) => item.id) : [];
  const drafts: SessionBoundaryDraft[] = ids.map((targetId) => ({
    type: "context_edit",
    targetId,
    replacement: null,
  }));
  if (!(prune && removal)) drafts.push(input.entry);
  const added = prune && removal ? 0 : input.entryTokens;
  const tokensFreed = (prune ? supersededTokens : 0) - added;
  const reprefillTokens = prune ? reprefillAfter(view, ids, tokensFreed, input.basis) : added;
  return {
    operation: "note",
    // A note conflicts by key: its entries are reachable only through setNote.
    targets: [`note:${key}`],
    drafts,
    records: [{ operation: "note", targets: ids, key, action, tokensFreed, reprefillTokens }],
    tokensFreed,
    reprefillTokens,
    receipt: { key, action, ...(ids.length > 0 ? { droppedEntries: ids.length } : {}) },
  };
}

/**
 * Plans creating, replacing, or removing a keyed note. Each change appends one entry at the tail:
 * a new version that replaces the earlier ones, or a removal. Earlier entries stay unchanged until
 * the note budget or a rewrite in the same batch drops them.
 */
export function planNote(
  view: ContextView,
  input: {
    key: string;
    content: string | null;
    contextWindow: number | undefined;
    basis: CacheBasis;
  },
): PlannedEdit {
  const { key, content } = input;
  if (!NOTE_KEY.test(key)) {
    throw new Error(
      `Note key "${key}" must be 1-64 letters, digits, ".", "_", or "-", starting with a letter or digit`,
    );
  }
  const groups = noteGroups(view);
  const group = groups.find((candidate) => candidate.key === key);
  const current = group && !group.removed ? group.items.at(-1) : undefined;
  const version = (group?.items.at(-1)?.noteVersion ?? 0) + 1;
  const others = liveNotes(groups).filter((item) => item.noteKey !== key);
  // Superseded entries after this change: every stale group, plus the version this change replaces.
  const superseded = [
    ...staleNoteGroups(view).flatMap((stale) => stale.items),
    ...(current ? [current] : []),
  ];
  const budget = noteBudget(input.contextWindow);
  const common = { key, liveTokens: sum(others), superseded, budget, basis: input.basis };
  if (content === null) {
    if (!current) throw new Error(`No live note has key "${key}"`);
    const framed = frameRemoval(key, version);
    return appendNote(view, {
      ...common,
      action: "removed",
      entryTokens: noteTokens(framed),
      entry: {
        type: "custom_message",
        customType: NOTE_TYPE,
        content: framed,
        display: true,
        details: { key, version, removed: true },
      },
    });
  }
  if (content.trim() === "") {
    throw new Error("Note content must not be empty; pass null to remove the note");
  }
  if (!current && new Set(others.map((item) => item.noteKey)).size >= MAX_NOTES) {
    throw new Error(`A branch keeps at most ${MAX_NOTES} live notes; remove one first`);
  }
  const framed = frameNote(key, content, version);
  const tokens = noteTokens(framed);
  const used = common.liveTokens + tokens;
  if (used > budget) {
    throw new Error(
      `Notes would use ~${formatTokens(used)} tokens, over the ~${formatTokens(budget)}-token budget (the larger of 4,096 tokens and 10% of the context window)`,
    );
  }
  return appendNote(view, {
    ...common,
    action: current ? "replaced" : "created",
    entryTokens: tokens,
    entry: {
      type: "custom_message",
      customType: NOTE_TYPE,
      content: framed,
      display: true,
      details: version > 1 ? { key, version } : { key },
    },
  });
}

/** Live notes the compaction folded into its summary, with the content they had before. */
function notesLostTo(compaction: CompactionEntry, session: SessionReader): ContextItem[] {
  if (compaction.parentId === null) return [];
  const before = session.getBranch(compaction.parentId);
  const previous: ContextSource = {
    getBranch: () => before,
    buildSessionProjection: () => buildSessionProjection(before, compaction.parentId),
    getLeafId: () => compaction.parentId,
  };
  const kept = new Set(noteGroups(buildContextView(session)).map((group) => group.key));
  return liveNotes(noteGroups(buildContextView(previous))).filter(
    (item) => !kept.has(item.noteKey as string),
  );
}

export function registerNoteRecovery(pi: ExtensionAPI): void {
  // Notes are working memory: restore the exact notes a compaction summarized away.
  pi.on("session_compact", (event, ctx) => {
    for (const note of notesLostTo(event.compactionEntry, ctx.sessionManager)) {
      const message = note.messages[0];
      /* v8 ignore next -- live notes are custom messages. */
      if (message?.role !== "custom") continue;
      pi.sendMessage(
        {
          customType: NOTE_TYPE,
          content: message.content,
          display: true,
          details: message.details ?? { key: note.noteKey },
        },
        { triggerTurn: false },
      );
    }
  });
}
