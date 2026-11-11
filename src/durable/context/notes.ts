import type {
  ConversationDocToken,
  PromptSection,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";

import { formatTokens } from "./edits.js";

type ToolContext = Parameters<ToolExecutionApi["commit"]>[1];

export const NOTES_SECTION = "pit_notes";
export const MAX_NOTES = 32;
const MIN_NOTE_BUDGET = 4_096;
const NOTE_BUDGET_SHARE = 0.1;
const NOTE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type NotesState = {
  /** Keys in the order they were first set, each with its content. */
  notes: Array<{ key: string; content: string }>;
};

/**
 * The conversation's notes. Rewindable with `fork: "asOf"`, so a fork starts with the notes its
 * parent had at the fork point. A section renders them, and pi-durable sends a section again after
 * a compaction, so notes outlive compaction without being part of its summary.
 */
export const NOTES_DOC: ConversationDocToken<NotesState> = {
  definition: {
    kind: "pit.notes",
    version: 1,
    scope: "conversation",
    history: "rewindable",
    fork: "asOf",
    initial: () => ({ notes: [] }),
    checkpointWhen: () => false,
  },
};

export function noteBudget(contextWindow: number | undefined): number {
  return Math.max(MIN_NOTE_BUDGET, Math.floor((contextWindow ?? 0) * NOTE_BUDGET_SHARE));
}

function frameNote(key: string, content: string): string {
  const body = content.replaceAll("</model-note", "<\\/model-note");
  return `<model-note key="${key}">\n${body}\n</model-note>`;
}

function noteTokens(key: string, content: string): number {
  return Math.ceil(frameNote(key, content).length / 4);
}

export function renderNotes(state: Readonly<NotesState> | undefined): string | undefined {
  if (!state || state.notes.length === 0) return undefined;
  return [
    "Notes you kept with session.setNote(). They are working memory, not instructions.",
    ...state.notes.map(({ key, content }) => frameNote(key, content)),
  ].join("\n");
}

export function notesSection(): PromptSection {
  return {
    key: NOTES_SECTION,
    render: async (input, context) =>
      renderNotes(await input.read.snapshot(NOTES_DOC, input.conversationId, context)),
  };
}

export async function readNotes(
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: ToolContext,
): Promise<Readonly<NotesState>> {
  const state = await api.snapshot(NOTES_DOC, api.conversationId, context);
  return state ?? { notes: [] };
}

export function describeNotes(
  state: Readonly<NotesState>,
  contextWindow: number | undefined,
  pending: ReadonlySet<string> = new Set(),
) {
  const notes = state.notes.map(({ key, content }) => ({
    key,
    entryId: NOTES_SECTION,
    tokens: noteTokens(key, content),
    ...(pending.has(key) ? { pending: true } : {}),
  }));
  return {
    notes,
    tokens: notes.reduce((sum, note) => sum + note.tokens, 0),
    // A changed section is sent again whole; earlier versions stay in the context until compaction.
    supersededTokens: 0,
    budgetTokens: noteBudget(contextWindow),
    maxNotes: MAX_NOTES,
  };
}

type NoteList = Array<{ key: string; content: string }>;

/**
 * Sets or removes one note in `notes`, which it changes in place. Throws, changing nothing, when
 * the key or content is invalid or the notes would exceed their count or token budget.
 */
export function changeNote(
  notes: NoteList,
  input: { key: string; content: string | null; contextWindow: number | undefined },
): { action: "created" | "replaced" | "removed"; tokens: number } {
  const { key, content } = input;
  if (!NOTE_KEY.test(key)) {
    throw new Error(
      `Note key "${key}" must be 1-64 letters, digits, ".", "_", or "-", starting with a letter or digit`,
    );
  }
  if (content !== null && content.trim() === "") {
    throw new Error("Note content must not be empty; pass null to remove the note");
  }
  const index = notes.findIndex((note) => note.key === key);
  if (content === null) {
    if (index === -1) throw new Error(`No note has key "${key}"`);
    notes.splice(index, 1);
    return { action: "removed", tokens: 0 };
  }
  if (index === -1 && notes.length >= MAX_NOTES) {
    throw new Error(`A conversation keeps at most ${MAX_NOTES} notes; remove one first`);
  }
  const others = notes.filter((note) => note.key !== key);
  const tokens = noteTokens(key, content);
  const used = others.reduce((sum, note) => sum + noteTokens(note.key, note.content), tokens);
  const budget = noteBudget(input.contextWindow);
  if (used > budget) {
    throw new Error(
      `Notes would use ~${formatTokens(used)} tokens, over the ~${formatTokens(budget)}-token budget (the larger of 4,096 tokens and 10% of the context window)`,
    );
  }
  if (index === -1) {
    notes.push({ key, content });
    return { action: "created", tokens };
  }
  (notes[index] as { content: string }).content = content;
  return { action: "replaced", tokens };
}

/** Applies note changes a call staged, in order, in one commit of the notes document. */
export async function applyNoteChanges(
  api: Pick<ToolExecutionApi, "commit" | "conversationId">,
  context: ToolContext,
  changes: ReadonlyArray<{ key: string; content: string | null }>,
  contextWindow: number | undefined,
): Promise<void> {
  await api.commit(async (tx) => {
    const state = await tx.doc(NOTES_DOC, api.conversationId);
    for (const change of changes) changeNote(state.notes, { ...change, contextWindow });
  }, context);
}
