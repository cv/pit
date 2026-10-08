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

/** Live notes share max(4,096 tokens, 10% of the context window). */
export function noteBudget(contextWindow: number | undefined): number {
  return Math.max(MIN_NOTE_BUDGET, Math.floor((contextWindow ?? 0) * NOTE_BUDGET_SHARE));
}

/** Frames a note for the model; a closing tag inside the note cannot end the frame early. */
export function frameNote(key: string, content: string): string {
  const body = content.replaceAll("</model-note", "<\\/model-note");
  return `<model-note key="${key}">\n${body}\n</model-note>`;
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

function liveNotes(view: ContextView): ContextItem[] {
  return view.items.filter((item) => item.role === "note" && item.noteKey !== undefined);
}

export interface NoteListing {
  notes: Array<{ key: string; entryId: string; tokens: number; pending?: boolean }>;
  tokens: number;
  budgetTokens: number;
  maxNotes: number;
}

export function listNotes(
  view: ContextView,
  input: { contextWindow: number | undefined; pending: ReadonlyMap<string, unknown> },
): NoteListing {
  const notes = liveNotes(view).map((item) => {
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
    tokens: notes.reduce((sum, note) => sum + note.tokens, 0),
    budgetTokens: noteBudget(input.contextWindow),
    maxNotes: MAX_NOTES,
  };
}

function removal(
  key: string,
  previous: ContextItem[],
  view: ContextView,
  basis: CacheBasis,
): PlannedEdit {
  if (previous.length === 0) throw new Error(`No live note has key "${key}"`);
  const ids = previous.map((item) => item.id);
  const tokensFreed = previous.reduce((sum, item) => sum + item.tokens, 0);
  const reprefillTokens = reprefillAfter(view, ids, tokensFreed, basis);
  return {
    operation: "note",
    // A note conflicts by key: its entries are reachable only through setNote.
    targets: [`note:${key}`],
    drafts: ids.map((targetId) => ({ type: "context_edit", targetId, replacement: null })),
    records: [
      { operation: "note", targets: ids, key, action: "removed", tokensFreed, reprefillTokens },
    ],
    tokensFreed,
    reprefillTokens,
    receipt: { key, action: "removed" },
  };
}

/**
 * Plans creating, replacing, or removing a keyed note. A replacement appends the new note at
 * the tail and omits the previous one. A prefix cache then re-prefills only context after the old
 * note; a breakpoint cache rewrites the whole conversation.
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
  const notes = liveNotes(view);
  const previous = notes.filter((item) => item.noteKey === key);
  if (content === null) return removal(key, previous, view, input.basis);
  if (content.trim() === "") {
    throw new Error("Note content must not be empty; pass null to remove the note");
  }
  const others = notes.filter((item) => item.noteKey !== key);
  if (previous.length === 0 && new Set(others.map((item) => item.noteKey)).size >= MAX_NOTES) {
    throw new Error(`A branch keeps at most ${MAX_NOTES} live notes; remove one first`);
  }
  const framed = frameNote(key, content);
  const tokens = noteTokens(framed);
  const used = others.reduce((sum, item) => sum + item.tokens, 0) + tokens;
  const budget = noteBudget(input.contextWindow);
  if (used > budget) {
    throw new Error(
      `Notes would use ~${formatTokens(used)} tokens, over the ~${formatTokens(budget)}-token budget (the larger of 4,096 tokens and 10% of the context window)`,
    );
  }
  const ids = previous.map((item) => item.id);
  const tokensFreed = previous.reduce((sum, item) => sum + item.tokens, 0) - tokens;
  const reprefillTokens =
    ids.length > 0 ? reprefillAfter(view, ids, tokensFreed, input.basis) : tokens;
  const action = ids.length > 0 ? "replaced" : "created";
  const drafts: SessionBoundaryDraft[] = ids.map((targetId) => ({
    type: "context_edit",
    targetId,
    replacement: null,
  }));
  drafts.push({
    type: "custom_message",
    customType: NOTE_TYPE,
    content: framed,
    display: true,
    details: { key },
  });
  return {
    operation: "note",
    targets: [`note:${key}`],
    drafts,
    records: [{ operation: "note", targets: ids, key, action, tokensFreed, reprefillTokens }],
    tokensFreed,
    reprefillTokens,
    receipt: { key, action },
  };
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
  const kept = new Set(liveNotes(buildContextView(session)).map((item) => item.noteKey));
  return liveNotes(buildContextView(previous)).filter((item) => !kept.has(item.noteKey));
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
          details: { key: note.noteKey },
        },
        { triggerTurn: false },
      );
    }
  });
}
